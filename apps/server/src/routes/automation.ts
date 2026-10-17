import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../lib/auth.js";
import { AUTOMATION_CONTEXT_DOCS, automationTypeDefinitions } from "../lib/automation/context.js";
import { describeCron, nextRuns, scheduleSchema, serverTimezone } from "../lib/automation/cron.js";
import { runAutomationRule } from "../lib/automation/runner.js";
import { refreshRuleSchedule } from "../lib/automation/scheduler.js";
import { insertRuleVersion, saveRuleScript } from "../lib/automation/versions.js";
import { channelKeySchema } from "../lib/notifications.js";
import { pool, withTransaction } from "../lib/database.js";

const ruleKeySchema = channelKeySchema;

const ruleBodySchema = z.object({
  key: ruleKeySchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(""),
  enabled: z.boolean().default(true),
  schedule: scheduleSchema,
  scriptSource: z.string().min(1).max(262_144),
  scriptTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000)
});

const ruleUpdateSchema = ruleBodySchema.partial().omit({ key: true });

const ruleSummaryColumns = `r.id, r.key, r.name, r.description, r.enabled,
       jsonb_build_object('cron', r.cron, 'timezone', r.timezone) AS schedule,
       r.script_timeout_ms AS "scriptTimeoutMs",
       r.next_run_at AS "nextRunAt", r.last_run_at AS "lastRunAt", r.last_run_status AS "lastRunStatus",
       r.created_at AS "createdAt", r.updated_at AS "updatedAt", u.username AS "createdBy",
       latest.id AS "latestVersionId", latest.version AS "latestVersion",
       COALESCE(latest."versionCount", 0) AS "versionCount"`;

// The newest version is the rule's current script, and the window count rides
// along so a caller knows how much history there is without a second query.
const latestVersionJoin = `LEFT JOIN LATERAL (
         SELECT v.id, v.version, count(*) OVER()::int AS "versionCount"
           FROM automation_rule_versions v
          WHERE v.rule_id = r.id
          ORDER BY v.version DESC
          LIMIT 1
       ) latest ON TRUE`;

const runColumns = `run.id, run.rule_id AS "ruleId", run.sequence, run.trigger_source AS "trigger",
       run.status, run.trigger_payload AS "triggerPayload",
       run.script_version_id AS "scriptVersionId", run_version.version AS "scriptVersion",
       run.output_body AS "outputBody", run.output_mime_type AS "outputMimeType",
       run.output_truncated AS "outputTruncated", run.logs, run.error,
       run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.elapsed_ms AS "elapsedMs",
       u.username AS "triggeredBy",
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', p.id, 'channelKey', c.key, 'body', p.body, 'buttons', p.buttons,
           'status', p.status, 'answerLabel', p.answer_label, 'answerValue', p.answer_value,
           'answeredBy', p.answered_by, 'answeredAt', p.answered_at, 'error', p.error,
           'createdAt', p.created_at
         ) ORDER BY p.created_at)
           FROM notification_prompts p
           JOIN notification_channels c ON c.id = p.channel_id
          WHERE p.automation_run_id = run.id
       ), '[]'::jsonb) AS prompts`;

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/automation/capabilities", { preHandler: requireAuth }, async () => ({
    context: AUTOMATION_CONTEXT_DOCS,
    defaultTimezone: serverTimezone,
    // Loaded into the rule editor so `cfman.` completes to exactly the calls
    // the sandbox provides.
    typeDefinitions: automationTypeDefinitions()
  }));

  app.post("/api/automation/cron/preview", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = scheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: issue?.message ?? "Invalid schedule" });
    }
    return {
      cron: parsed.data.cron,
      timezone: parsed.data.timezone,
      description: describeCron(parsed.data.cron),
      nextRuns: nextRuns(parsed.data, 5)
    };
  });

  app.get("/api/automation/rules", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ search: z.string().trim().max(160).optional() }).parse(request.query);
    const values: unknown[] = [];
    const conditions: string[] = ["TRUE"];
    if (query.search) {
      values.push(`%${query.search}%`);
      conditions.push(`(r.key ILIKE $${values.length} OR r.name ILIKE $${values.length} OR r.description ILIKE $${values.length})`);
    }
    const result = await pool.query(
      `SELECT ${ruleSummaryColumns}
         FROM automation_rules r
         LEFT JOIN users u ON u.id = r.created_by
         ${latestVersionJoin}
        WHERE ${conditions.join(" AND ")}
        ORDER BY r.name`,
      values
    );
    return { rules: result.rows };
  });

  app.get("/api/automation/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [ruleResult, versionsResult] = await Promise.all([
      pool.query(
        `SELECT ${ruleSummaryColumns}
           FROM automation_rules r
           LEFT JOIN users u ON u.id = r.created_by
           ${latestVersionJoin}
          WHERE r.id = $1`,
        [id]
      ),
      pool.query(
        `SELECT v.id, v.version, v.script_source AS "scriptSource",
                v.created_at AS "createdAt", u.username AS "createdBy"
           FROM automation_rule_versions v
           LEFT JOIN users u ON u.id = v.created_by
          WHERE v.rule_id = $1
          ORDER BY v.version DESC`,
        [id]
      )
    ]);
    if (!ruleResult.rowCount) return reply.code(404).send({ error: "Automation rule not found" });
    return { rule: { ...ruleResult.rows[0], versions: versionsResult.rows } };
  });

  app.post("/api/automation/rules", { preHandler: requireAuth }, async (request, reply) => {
    const body = ruleBodySchema.parse(request.body);
    const created = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO automation_rules(key, name, description, enabled, cron, timezone,
                                      script_timeout_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          body.key,
          body.name,
          body.description,
          body.enabled,
          body.schedule.cron,
          body.schedule.timezone,
          body.scriptTimeoutMs,
          request.authUser!.id
        ]
      );
      const ruleId = inserted.rows[0].id as string;
      const version = await insertRuleVersion(client, {
        ruleId,
        scriptSource: body.scriptSource,
        createdBy: request.authUser!.id
      });
      return { ruleId, ...version };
    });
    const nextRunAt = await refreshRuleSchedule(created.ruleId);
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "automation.rule_created",
      entityType: "automation_rule",
      entityId: created.ruleId,
      details: { key: body.key, schedule: body.schedule, version: created.version }
    });
    return reply.code(201).send({ id: created.ruleId, key: body.key, nextRunAt, version: created.version, versionId: created.versionId });
  });

  app.patch("/api/automation/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ruleUpdateSchema.parse(request.body);
    const existing = await pool.query("SELECT key FROM automation_rules WHERE id = $1", [id]);
    if (!existing.rowCount) return reply.code(404).send({ error: "Automation rule not found" });
    await pool.query(
      `UPDATE automation_rules
          SET name = COALESCE($1, name), description = COALESCE($2, description),
              enabled = COALESCE($3, enabled),
              cron = COALESCE($4, cron), timezone = COALESCE($5, timezone),
              script_timeout_ms = COALESCE($6, script_timeout_ms),
              updated_at = now()
        WHERE id = $7`,
      [
        body.name ?? null,
        body.description ?? null,
        body.enabled ?? null,
        body.schedule?.cron ?? null,
        body.schedule?.timezone ?? null,
        body.scriptTimeoutMs ?? null,
        id
      ]
    );
    // An edited script is saved as a new version; an unchanged one keeps the
    // version it already has.
    const saved = body.scriptSource === undefined
      ? null
      : await saveRuleScript({ ruleId: id, scriptSource: body.scriptSource, createdBy: request.authUser!.id });
    const nextRunAt = await refreshRuleSchedule(id);
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "automation.rule_updated",
      entityType: "automation_rule",
      entityId: id,
      details: { key: existing.rows[0].key, fields: Object.keys(body), ...(saved?.created ? { version: saved.version } : {}) }
    });
    return { success: true, nextRunAt, version: saved?.version ?? null, versionCreated: saved?.created ?? false };
  });

  app.delete("/api/automation/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await pool.query("DELETE FROM automation_rules WHERE id = $1 RETURNING key", [id]);
    if (!deleted.rowCount) return reply.code(404).send({ error: "Automation rule not found" });
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "automation.rule_deleted",
      entityType: "automation_rule",
      entityId: id,
      details: { key: deleted.rows[0].key }
    });
    return { success: true, key: deleted.rows[0].key };
  });

  app.post("/api/automation/rules/:id/run", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const exists = await pool.query("SELECT key FROM automation_rules WHERE id = $1", [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: "Automation rule not found" });
    const summary = await runAutomationRule({
      ruleId: id,
      trigger: request.authUser!.sessionId === null ? "mcp" : "manual",
      triggeredBy: request.authUser!.id
    });
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "automation.rule_run",
      entityType: "automation_rule",
      entityId: id,
      details: { key: exists.rows[0].key, runId: summary.runId, status: summary.status }
    });
    return summary;
  });

  app.get("/api/automation/rules/:id/runs", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({
      status: z.enum(["running", "succeeded", "failed", "timed_out"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(5).max(100).default(20)
    }).parse(request.query);
    const exists = await pool.query("SELECT 1 FROM automation_rules WHERE id = $1", [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: "Automation rule not found" });
    const values: unknown[] = [id];
    const conditions = ["run.rule_id = $1"];
    if (query.status) {
      values.push(query.status);
      conditions.push(`run.status = $${values.length}`);
    }
    const offset = (query.page - 1) * query.pageSize;
    const [runs, count] = await Promise.all([
      pool.query(
        `SELECT ${runColumns}
           FROM automation_runs run
           LEFT JOIN users u ON u.id = run.triggered_by
           LEFT JOIN automation_rule_versions run_version ON run_version.id = run.script_version_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY run.started_at DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, query.pageSize, offset]
      ),
      pool.query(`SELECT count(*)::int AS total FROM automation_runs run WHERE ${conditions.join(" AND ")}`, values)
    ]);
    const total = count.rows[0].total as number;
    return {
      runs: runs.rows,
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) }
    };
  });

  app.get("/api/automation/runs/:runId", { preHandler: requireAuth }, async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `SELECT ${runColumns}, r.key AS "ruleKey", r.name AS "ruleName"
         FROM automation_runs run
         JOIN automation_rules r ON r.id = run.rule_id
         LEFT JOIN users u ON u.id = run.triggered_by
         LEFT JOIN automation_rule_versions run_version ON run_version.id = run.script_version_id
        WHERE run.id = $1`,
      [runId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Automation run not found" });
    return { run: result.rows[0] };
  });
}
