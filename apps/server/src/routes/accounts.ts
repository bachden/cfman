import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../lib/auth.js";
import { CloudflareClient } from "../lib/cloudflare.js";
import { pool, withTransaction } from "../lib/database.js";
import { appendNameFilter, nameFilterFields, validateNameFilter } from "../lib/name-filter.js";
import { executionVariablesSchema } from "../lib/execution-variables.js";
import { decryptSecret, encryptSecret } from "../lib/security.js";

const domainName = z.string().trim().toLowerCase().min(3).max(253).regex(
  /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Enter a valid DNS zone name"
);
const operatorEmails = z.array(z.string().trim().toLowerCase().email()).min(1).max(50);

const accountSchema = z.object({
  name: z.string().trim().min(2).max(100),
  providerMode: z.enum(["live", "mock"]).default("live"),
  cfAccountId: z.string().trim().max(100).optional(),
  apiToken: z.string().trim().max(1000).optional(),
  softTunnelLimit: z.number().int().min(1).max(1000).default(750),
  initialZoneName: domainName.optional(),
  rdpAllowedEmails: z.array(z.string().trim().toLowerCase().email()).max(50).default([])
}).superRefine((data, context) => {
  if (data.providerMode === "live" && (!data.cfAccountId || !data.apiToken)) {
    context.addIssue({ code: "custom", message: "Account ID and API token are required for live accounts" });
  }
  if (data.providerMode === "mock" && !data.initialZoneName) {
    context.addIssue({ code: "custom", message: "An initial zone is required for mock accounts" });
  }
  if (data.providerMode === "live" && data.rdpAllowedEmails.length === 0) {
    context.addIssue({ code: "custom", message: "At least one RDP operator email is required for live accounts" });
  }
});

const rdpSettingsSchema = z.object({ rdpAllowedEmails: operatorEmails });

const tokenValidationSchema = z.object({
  cfAccountId: z.string().trim().min(1).max(100),
  apiToken: z.string().trim().min(1).max(1000)
});

const zoneSchema = z.object({
  name: domainName,
  cfZoneId: z.string().trim().max(100).optional(),
  dnsRecordLimit: z.number().int().min(1).max(1_000_000).default(200),
  softStoreLimit: z.number().int().min(1).max(1_000_000).default(150)
}).refine((data) => data.softStoreLimit <= data.dnsRecordLimit, {
  message: "Soft store limit must not exceed DNS record limit"
});

const accountListQuerySchema = z.object(nameFilterFields).superRefine(validateNameFilter);
const executionVariablesUpdateSchema = z.object({ variables: executionVariablesSchema });

async function accountList(filter: z.infer<typeof accountListQuerySchema>) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  appendNameFilter(conditions, values, "a.name", filter);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(`
    SELECT a.id, a.name, a.provider_mode AS "providerMode", a.cf_account_id AS "cfAccountId",
           a.status, a.tunnel_limit AS "tunnelLimit", a.soft_tunnel_limit AS "softTunnelLimit",
           a.rdp_allowed_emails AS "rdpAllowedEmails", a.execution_variables AS "executionVariables",
           a.last_synced_at AS "lastSyncedAt", a.last_error AS "lastError", a.created_at AS "createdAt",
           COALESCE((SELECT count(*)::int FROM stores s WHERE s.account_id = a.id), 0) AS "storeCount",
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'id', z.id,
               'name', z.name,
               'cfZoneId', z.cf_zone_id,
               'status', z.status,
               'dnsRecordLimit', z.dns_record_limit,
               'softStoreLimit', z.soft_store_limit,
               'executionVariables', z.execution_variables,
               'storeCount', (SELECT count(*) FROM stores s WHERE s.zone_id = z.id)
             ) ORDER BY z.name)
             FROM zones z WHERE z.account_id = a.id
           ), '[]'::jsonb) AS zones
      FROM cloudflare_accounts a
      ${where}
     ORDER BY a.created_at ASC
  `, values);
  return result.rows;
}

export type AccountSyncResult = {
  id: string;
  success: boolean;
  zones?: number;
  tunnels?: number;
  error?: string;
};

// Multiple stores usually share one Cloudflare account. When a caller (e.g. the
// stores list refreshing several rows at once) triggers a sync per store rather
// than once per account, concurrent calls for the SAME account share one
// in-flight request instead of hitting Cloudflare's API redundantly.
const inFlightAccountSyncs = new Map<string, Promise<AccountSyncResult>>();

export async function synchronizeAccount(id: string): Promise<AccountSyncResult> {
  const existing = inFlightAccountSyncs.get(id);
  if (existing) return existing;
  const promise = synchronizeAccountOnce(id).finally(() => inFlightAccountSyncs.delete(id));
  inFlightAccountSyncs.set(id, promise);
  return promise;
}

async function synchronizeAccountOnce(id: string): Promise<AccountSyncResult> {
  const result = await pool.query(
    "SELECT provider_mode, cf_account_id, api_token_encrypted FROM cloudflare_accounts WHERE id = $1",
    [id]
  );
  const account = result.rows[0];
  if (!account) return { id, success: false, error: "Account not found" };
  if (account.provider_mode === "mock") {
    await pool.query("UPDATE cloudflare_accounts SET last_synced_at = now(), last_error = null WHERE id = $1", [id]);
    return { id, success: true, zones: 0, tunnels: 0 };
  }

  try {
    const client = new CloudflareClient(account.cf_account_id, decryptSecret(account.api_token_encrypted), "live");
    await client.verifyAccount();
    const [zones, tunnels] = await Promise.all([client.listZones(), client.listTunnels()]);
    await withTransaction(async (db) => {
      for (const zone of zones) {
        await db.query(
          `INSERT INTO zones(account_id, name, cf_zone_id, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, name) DO UPDATE
           SET cf_zone_id = EXCLUDED.cf_zone_id, status = EXCLUDED.status, updated_at = now()`,
          [id, zone.name, zone.id, zone.status === "active" ? "active" : "pending"]
        );
      }
      for (const tunnel of tunnels) {
        const status = tunnel.status ?? "unknown";
        await db.query(
          `UPDATE stores
              SET tunnel_status = $1, last_connected_at = $2, updated_at = now(),
                  rdp_status = CASE WHEN $1 <> 'healthy' AND rdp_status = 'ready' THEN 'failed' ELSE rdp_status END
            WHERE account_id = $3 AND tunnel_id = $4`,
          [status, tunnel.conns_active_at ?? null, id, tunnel.id]
        );
      }
      await db.query(
        "UPDATE cloudflare_accounts SET status = 'active', last_synced_at = now(), last_error = null, updated_at = now() WHERE id = $1",
        [id]
      );
    });
    return { id, success: true, zones: zones.length, tunnels: tunnels.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudflare sync failed";
    await pool.query(
      "UPDATE cloudflare_accounts SET status = 'invalid', last_error = $1, updated_at = now() WHERE id = $2",
      [message, id]
    );
    return { id, success: false, error: message };
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/accounts", { preHandler: requireAuth }, async (request) => {
    const query = accountListQuerySchema.parse(request.query);
    return { accounts: await accountList(query) };
  });

  app.put("/api/accounts/:id/execution-variables", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = executionVariablesUpdateSchema.parse(request.body);
    const result = await pool.query(
      "UPDATE cloudflare_accounts SET execution_variables = $1, updated_at = now() WHERE id = $2 RETURNING name",
      [body.variables, id]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Account not found" });
    await writeAudit({ actorUserId: request.authUser!.id, action: "account.execution_variables_updated", entityType: "cloudflare_account", entityId: id, details: { variableNames: Object.keys(body.variables) } });
    return { variables: body.variables };
  });

  app.put("/api/accounts/:accountId/zones/:zoneId/execution-variables", { preHandler: requireAuth }, async (request, reply) => {
    const { accountId, zoneId } = z.object({ accountId: z.string().uuid(), zoneId: z.string().uuid() }).parse(request.params);
    const body = executionVariablesUpdateSchema.parse(request.body);
    const result = await pool.query(
      "UPDATE zones SET execution_variables = $1, updated_at = now() WHERE id = $2 AND account_id = $3 RETURNING name",
      [body.variables, zoneId, accountId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Zone not found" });
    await writeAudit({ actorUserId: request.authUser!.id, action: "zone.execution_variables_updated", entityType: "zone", entityId: zoneId, details: { accountId, variableNames: Object.keys(body.variables) } });
    return { variables: body.variables };
  });

  app.post("/api/accounts/validate-token", {
    preHandler: requireAuth,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = tokenValidationSchema.parse(request.body);
    try {
      const client = new CloudflareClient(body.cfAccountId, body.apiToken, "live");
      const verification = await client.verifyToken();
      if (verification.status !== "active") {
        return reply.code(400).send({ error: `Cloudflare token is ${verification.status}` });
      }
      return { valid: true, status: verification.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cloudflare rejected the token";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/accounts", { preHandler: requireAuth }, async (request, reply) => {
    const body = accountSchema.parse(request.body);
    if (body.providerMode === "mock" && !config.ALLOW_MOCK_ACCOUNTS) {
      return reply.code(403).send({ error: "Mock accounts are disabled" });
    }

    let syncedZones: Array<{ id: string; name: string; status: string }> = [];
    if (body.providerMode === "live") {
      const client = new CloudflareClient(body.cfAccountId!, body.apiToken!, "live");
      await client.verifyAccount();
      syncedZones = await client.listZones();
    }

    const account = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO cloudflare_accounts(name, provider_mode, cf_account_id, api_token_encrypted, status, soft_tunnel_limit, rdp_allowed_emails, last_synced_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, now()) RETURNING id`,
        [
          body.name,
          body.providerMode,
          body.cfAccountId ?? null,
          body.apiToken ? encryptSecret(body.apiToken) : null,
          body.softTunnelLimit,
          body.rdpAllowedEmails
        ]
      );
      const accountId = inserted.rows[0].id as string;
      if (body.providerMode === "mock") {
        await client.query(
          `INSERT INTO zones(account_id, name, status, dns_record_limit, soft_store_limit)
           VALUES ($1, $2, 'active', 200, 150)`,
          [accountId, body.initialZoneName]
        );
      } else {
        for (const zone of syncedZones) {
          await client.query(
            `INSERT INTO zones(account_id, name, cf_zone_id, status)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (account_id, name) DO UPDATE SET cf_zone_id = EXCLUDED.cf_zone_id, status = EXCLUDED.status`,
            [accountId, zone.name, zone.id, zone.status === "active" ? "active" : "pending"]
          );
        }
      }
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "account.created",
        entityType: "cloudflare_account",
        entityId: accountId,
        details: { name: body.name, providerMode: body.providerMode }
      }, client);
      return accountId;
    });
    return reply.code(201).send({ id: account });
  });

  app.delete("/api/accounts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const outcome = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT id, name, provider_mode,
                (SELECT count(*)::int FROM stores WHERE account_id = cloudflare_accounts.id) AS store_count,
                (SELECT count(*)::int FROM zones WHERE account_id = cloudflare_accounts.id) AS zone_count
           FROM cloudflare_accounts
          WHERE id = $1
          FOR UPDATE`,
        [id]
      );
      const account = result.rows[0];
      if (!account) return { status: "not_found" as const };
      if (account.store_count > 0) {
        return { status: "in_use" as const, storeCount: account.store_count as number };
      }

      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "account.deleted",
        entityType: "cloudflare_account",
        entityId: id,
        details: {
          name: account.name,
          providerMode: account.provider_mode,
          zoneCount: account.zone_count,
          cloudflareResourcesDeleted: false
        }
      }, client);
      await client.query("DELETE FROM cloudflare_accounts WHERE id = $1", [id]);
      return { status: "deleted" as const };
    });

    if (outcome.status === "not_found") return reply.code(404).send({ error: "Account not found" });
    if (outcome.status === "in_use") {
      return reply.code(409).send({
        error: `Account is assigned to ${outcome.storeCount} store${outcome.storeCount === 1 ? "" : "s"}. Reassign or delete them first.`
      });
    }
    return reply.code(204).send();
  });

  app.post("/api/accounts/:id/zones", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = zoneSchema.parse(request.body);
    const account = await pool.query("SELECT provider_mode FROM cloudflare_accounts WHERE id = $1", [id]);
    if (!account.rowCount) return reply.code(404).send({ error: "Account not found" });
    if (account.rows[0].provider_mode === "live" && !body.cfZoneId) {
      return reply.code(400).send({ error: "Cloudflare Zone ID is required for live accounts" });
    }
    const result = await pool.query(
      `INSERT INTO zones(account_id, name, cf_zone_id, dns_record_limit, soft_store_limit)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, body.name, body.cfZoneId ?? null, body.dnsRecordLimit, body.softStoreLimit]
    );
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "zone.created",
      entityType: "zone",
      entityId: result.rows[0].id,
      details: { accountId: id, name: body.name }
    });
    return reply.code(201).send({ id: result.rows[0].id });
  });

  app.patch("/api/accounts/:id/rdp-settings", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = rdpSettingsSchema.parse(request.body);
    const result = await pool.query(
      `SELECT provider_mode, cf_account_id, api_token_encrypted, rdp_access_policy_id
         FROM cloudflare_accounts WHERE id = $1`,
      [id]
    );
    const account = result.rows[0];
    if (!account) return reply.code(404).send({ error: "Account not found" });

    let policyId = account.rdp_access_policy_id as string | null;
    if (account.provider_mode === "live" && policyId) {
      const client = new CloudflareClient(account.cf_account_id, decryptSecret(account.api_token_encrypted), "live");
      const policy = await client.ensureRdpAccessPolicy(policyId, body.rdpAllowedEmails);
      policyId = policy.id;
    }
    await pool.query(
      "UPDATE cloudflare_accounts SET rdp_allowed_emails = $1, rdp_access_policy_id = $2, updated_at = now() WHERE id = $3",
      [body.rdpAllowedEmails, policyId, id]
    );
    await writeAudit({
      actorUserId: request.authUser!.id,
      action: "account.rdp_settings_updated",
      entityType: "cloudflare_account",
      entityId: id,
      details: { operatorCount: body.rdpAllowedEmails.length }
    });
    return { success: true };
  });

  app.post("/api/accounts/:id/sync", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await synchronizeAccount(id);
    if (!result.success && result.error === "Account not found") return reply.code(404).send({ error: result.error });
    if (!result.success) return reply.code(502).send({ error: result.error ?? "Cloudflare sync failed" });
    return result;
  });

  app.post("/api/accounts/sync-all", { preHandler: requireAuth }, async () => {
    const accounts = await pool.query("SELECT id FROM cloudflare_accounts ORDER BY created_at ASC");
    const results: AccountSyncResult[] = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < accounts.rows.length) {
        const account = accounts.rows[nextIndex++]!;
        results.push(await synchronizeAccount(account.id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, accounts.rows.length) }, () => worker()));
    return { success: results.every((result) => result.success), results };
  });
}
