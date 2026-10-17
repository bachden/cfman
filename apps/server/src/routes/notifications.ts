import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../lib/auth.js";
import {
  channelKeySchema,
  channelTypeCatalog,
  encryptChannelSecrets,
  getChannelById,
  listChannels,
  parseChannelConfig,
  parseChannelSecrets,
  sendChannelMessage,
  toChannelSummary,
  ChannelSendError,
  type ChannelType
} from "../lib/notifications.js";
import { pool } from "../lib/database.js";

const channelTypeSchema = z.enum(["telegram"]);

const createChannelSchema = z.object({
  key: channelKeySchema,
  name: z.string().trim().min(1).max(120),
  type: channelTypeSchema,
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.unknown()).default({})
});

const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  // Only the secrets present here are replaced; the others keep their stored
  // value, so an edit never forces the operator to retype a bot token.
  secrets: z.record(z.string(), z.unknown()).optional()
});

const sendSchema = z.object({ body: z.string().min(1).max(20_000) });

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notifications/channels", { preHandler: requireAuth }, async () => ({
    channels: await listChannels(),
    types: channelTypeCatalog()
  }));

  app.get("/api/notifications/channels/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const channel = await getChannelById(id);
    if (!channel) return reply.code(404).send({ error: "Channel not found" });
    return { channel: toChannelSummary(channel) };
  });

  app.post("/api/notifications/channels", { preHandler: requireAuth }, async (request, reply) => {
    const body = createChannelSchema.parse(request.body);
    const type = body.type as ChannelType;
    const config = parseChannelConfig(type, body.config);
    const secrets = parseChannelSecrets(type, body.secrets, { partial: false });
    const inserted = await pool.query(
      `INSERT INTO notification_channels(key, name, type, description, enabled, config, secrets, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       RETURNING id`,
      [
        body.key,
        body.name,
        type,
        body.description,
        body.enabled,
        JSON.stringify(config),
        JSON.stringify(encryptChannelSecrets(secrets)),
        request.authUser!.id
      ]
    );
    const id = inserted.rows[0].id as string;
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "notification.channel_created",
      entityType: "notification_channel",
      entityId: id,
      details: { key: body.key, type }
    });
    const channel = await getChannelById(id);
    return reply.code(201).send({ channel: channel ? toChannelSummary(channel) : null });
  });

  app.patch("/api/notifications/channels/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = updateChannelSchema.parse(request.body);
    const existing = await getChannelById(id);
    if (!existing) return reply.code(404).send({ error: "Channel not found" });
    const config = body.config === undefined ? existing.config : parseChannelConfig(existing.type, body.config);
    const secrets = body.secrets === undefined
      ? existing.secrets
      : { ...existing.secrets, ...encryptChannelSecrets(parseChannelSecrets(existing.type, body.secrets, { partial: true })) };
    await pool.query(
      `UPDATE notification_channels
          SET name = COALESCE($1, name), description = COALESCE($2, description),
              enabled = COALESCE($3, enabled), config = $4::jsonb, secrets = $5::jsonb, updated_at = now()
        WHERE id = $6`,
      [
        body.name ?? null,
        body.description ?? null,
        body.enabled ?? null,
        JSON.stringify(config),
        JSON.stringify(secrets),
        id
      ]
    );
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "notification.channel_updated",
      entityType: "notification_channel",
      entityId: id,
      details: { key: existing.key, fields: Object.keys(body), secretsRotated: Object.keys(body.secrets ?? {}) }
    });
    const channel = await getChannelById(id);
    return { channel: channel ? toChannelSummary(channel) : null };
  });

  app.delete("/api/notifications/channels/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = await getChannelById(id);
    if (!existing) return reply.code(404).send({ error: "Channel not found" });
    // Rule scripts address a channel by its key, so a delete that leaves a
    // cfman.sendMessage pointing at a missing key would only fail later, at
    // send time. The key is a distinctive slug, so naming it anywhere in a
    // rule's current script is taken as using it; older versions no longer
    // run, so they do not hold a channel hostage.
    const referencing = await pool.query(
      `SELECT r.key
         FROM automation_rules r
         JOIN LATERAL (
           SELECT v.script_source
             FROM automation_rule_versions v
            WHERE v.rule_id = r.id
            ORDER BY v.version DESC
            LIMIT 1
         ) latest ON TRUE
        WHERE strpos(latest.script_source, $1) > 0
        ORDER BY r.key`,
      [existing.key]
    );
    if (referencing.rowCount) {
      return reply.code(409).send({
        error: `This channel is still named by ${referencing.rowCount} automation rule script(s): ${referencing.rows.map((row) => row.key).join(", ")}`
      });
    }
    await pool.query("DELETE FROM notification_channels WHERE id = $1", [id]);
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "notification.channel_deleted",
      entityType: "notification_channel",
      entityId: id,
      details: { key: existing.key, type: existing.type }
    });
    return { success: true, key: existing.key };
  });

  app.post("/api/notifications/channels/:id/send", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = sendSchema.parse(request.body);
    const channel = await getChannelById(id);
    if (!channel) return reply.code(404).send({ error: "Channel not found" });
    try {
      const result = await sendChannelMessage({
        channel,
        body: body.body,
        requestedBy: request.authUser!.id,
        requestedVia: request.authUser!.sessionId === null ? "mcp" : "web"
      });
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "notification.message_sent",
        entityType: "notification_channel",
        entityId: id,
        details: { key: channel.key, messageId: result.messageId, bodyLength: result.bodyLength }
      });
      return result;
    } catch (error) {
      if (error instanceof ChannelSendError) {
        return reply.code(502).send({ error: error.message, ...(error.messageId ? { messageId: error.messageId } : {}) });
      }
      throw error;
    }
  });

  app.get("/api/notifications/channels/:id/messages", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(5).max(100).default(20)
    }).parse(request.query);
    const channel = await getChannelById(id);
    if (!channel) return reply.code(404).send({ error: "Channel not found" });
    const offset = (query.page - 1) * query.pageSize;
    const [messages, count] = await Promise.all([
      pool.query(
        `SELECT m.id, m.body, m.status, m.error, m.provider_message_id AS "providerMessageId",
                m.automation_run_id AS "automationRunId", r.key AS "ruleKey", r.name AS "ruleName",
                m.requested_via AS "requestedVia", u.username AS "requestedBy", m.created_at AS "createdAt"
           FROM notification_messages m
           LEFT JOIN users u ON u.id = m.requested_by
           LEFT JOIN automation_runs run ON run.id = m.automation_run_id
           LEFT JOIN automation_rules r ON r.id = run.rule_id
          WHERE m.channel_id = $1
          ORDER BY m.created_at DESC
          LIMIT $2 OFFSET $3`,
        [id, query.pageSize, offset]
      ),
      pool.query("SELECT count(*)::int AS total FROM notification_messages WHERE channel_id = $1", [id])
    ]);
    const total = count.rows[0].total as number;
    return {
      messages: messages.rows,
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) }
    };
  });
}
