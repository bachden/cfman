import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import { pool } from "../lib/database.js";
import { appendNameFilter, nameFilterFields, validateNameFilter } from "../lib/name-filter.js";
import { latestEnrollmentJoin, onboardingStatusExpression } from "./tunnels.js";

const auditListQuerySchema = z.object(nameFilterFields).superRefine(validateNameFilter);

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard", { preHandler: requireAuth }, async () => {
    const [stats, accountCapacity, recentTunnels, audit] = await Promise.all([
      pool.query(`
        SELECT (SELECT count(*)::int FROM tunnels) AS "totalTunnels",
               (SELECT count(*)::int FROM tunnels WHERE cf_tunnel_status = 'healthy') AS "healthyTunnels",
               (SELECT count(*)::int FROM tunnels s ${latestEnrollmentJoin}
                 WHERE ${onboardingStatusExpression} IN ('url_issued', 'waiting_for_new_enrollment', 'claimed', 'provisioning', 'connector_online')
               ) AS "onboardingTunnels",
               (SELECT count(*)::int FROM tunnels s ${latestEnrollmentJoin}
                 WHERE ${onboardingStatusExpression} = 'failed' OR s.cf_tunnel_status IN ('down', 'degraded') OR s.rdp_status = 'failed'
               ) AS "attentionTunnels",
               (SELECT count(*)::int FROM cloudflare_accounts WHERE status = 'active') AS "activeAccounts",
               (SELECT count(*)::int FROM zones WHERE status = 'active') AS "activeZones"
      `),
      pool.query(`
        SELECT a.id, a.name, a.soft_tunnel_limit AS "softLimit",
               (SELECT count(*)::int FROM tunnels s WHERE s.account_id = a.id) AS "tunnelCount",
               (SELECT count(*)::int FROM zones z WHERE z.account_id = a.id AND z.status = 'active') AS "zoneCount",
               a.status
          FROM cloudflare_accounts a ORDER BY a.created_at ASC
      `),
      pool.query(`
        SELECT s.id, s.display_name AS "displayName", s.tunnel_code AS "tunnelCode", s.hostname,
               ${onboardingStatusExpression} AS "onboardingStatus", s.cf_tunnel_status AS "cfTunnelStatus", s.created_at AS "createdAt"
          FROM tunnels s
          ${latestEnrollmentJoin}
         ORDER BY s.created_at DESC LIMIT 6
      `),
      pool.query(`
        SELECT id, action, entity_type AS "entityType", entity_id AS "entityId", details, created_at AS "createdAt"
          FROM audit_logs ORDER BY created_at DESC LIMIT 8
      `)
    ]);
    return {
      stats: stats.rows[0],
      accountCapacity: accountCapacity.rows,
      recentTunnels: recentTunnels.rows,
      recentActivity: audit.rows
    };
  });

  app.get("/api/audit", { preHandler: requireAuth }, async (request) => {
    const query = auditListQuerySchema.parse(request.query);
    const conditions: string[] = [];
    const values: unknown[] = [];
    appendNameFilter(conditions, values, "l.action", query);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(`
      SELECT l.id, l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.details,
             l.ip_address AS "ipAddress", l.created_at AS "createdAt", u.username
        FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
       ${where}
       ORDER BY l.created_at DESC LIMIT 250
    `, values);
    return { entries: result.rows };
  });
}
