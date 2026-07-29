import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export function slugifyLabel(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) throw new Error("Tenant and tunnel codes must contain letters or numbers");
  if (normalized.length <= 63) return normalized;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${normalized.slice(0, 54).replace(/-+$/g, "")}-${suffix}`;
}

export async function selectZone(
  client: PoolClient,
  requestedZoneId?: string
): Promise<{ accountId: string; zoneId: string; zoneName: string }> {
  if (requestedZoneId) {
    const result = await client.query(
      `SELECT z.id AS zone_id, z.name AS zone_name, a.id AS account_id,
              z.soft_tunnel_limit AS zone_soft_tunnel_limit, a.soft_tunnel_limit AS account_soft_tunnel_limit,
              (SELECT count(*)::int FROM tunnels s WHERE s.zone_id = z.id) AS zone_count,
              (SELECT count(*)::int FROM tunnels s WHERE s.account_id = a.id) AS account_count
         FROM zones z JOIN cloudflare_accounts a ON a.id = z.account_id
        WHERE z.id = $1 AND z.status = 'active' AND a.status = 'active'
        FOR UPDATE OF z`,
      [requestedZoneId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Selected zone is unavailable");
    if (row.zone_count >= row.zone_soft_tunnel_limit) throw new Error("Selected zone reached its soft tunnel limit");
    if (row.account_count >= row.account_soft_tunnel_limit) throw new Error("Selected account reached its soft tunnel limit");
    return { accountId: row.account_id, zoneId: row.zone_id, zoneName: row.zone_name };
  }

  const result = await client.query(`
    WITH capacity AS (
      SELECT z.id AS zone_id, z.name AS zone_name, a.id AS account_id,
             z.soft_tunnel_limit AS zone_soft_tunnel_limit, a.soft_tunnel_limit AS account_soft_tunnel_limit,
             (SELECT count(*)::int FROM tunnels s WHERE s.zone_id = z.id) AS zone_count,
             (SELECT count(*)::int FROM tunnels s WHERE s.account_id = a.id) AS account_count
        FROM zones z JOIN cloudflare_accounts a ON a.id = z.account_id
       WHERE z.status = 'active' AND a.status = 'active'
    )
    SELECT c.*, z.id AS locked_zone
      FROM capacity c JOIN zones z ON z.id = c.zone_id
     WHERE c.zone_count < c.zone_soft_tunnel_limit AND c.account_count < c.account_soft_tunnel_limit
     ORDER BY (c.account_count::numeric / c.account_soft_tunnel_limit) ASC,
              (c.zone_count::numeric / c.zone_soft_tunnel_limit) ASC,
              c.zone_name ASC
     FOR UPDATE OF z SKIP LOCKED
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error("No account and zone have available capacity");
  return { accountId: row.account_id, zoneId: row.zone_id, zoneName: row.zone_name };
}

