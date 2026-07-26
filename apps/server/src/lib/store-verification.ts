import { writeAudit } from "./audit.js";
import { pool } from "./database.js";
import { checkStoreEndpoint, type EndpointCheck } from "./monitor.js";

export type StoreEndpointVerification = {
  publicationId: string | null;
  routeId?: string | null;
  hostname: string;
  path?: string;
  check: EndpointCheck;
};

export type StoreVerificationResult = {
  success: boolean;
  check: EndpointCheck;
  checks: StoreEndpointVerification[];
};

type VerificationOptions = {
  actorUserId?: string;
  publicationId?: string;
  routeId?: string;
  attempts?: number;
  retryDelayMs?: number;
};

export async function verifyStoreEndpoints(
  storeId: string,
  options: VerificationOptions = {}
): Promise<StoreVerificationResult | null> {
  const store = await pool.query(
    `SELECT s.id, s.hostname, s.tunnel_status, a.provider_mode
       FROM stores s LEFT JOIN cloudflare_accounts a ON a.id = s.account_id
      WHERE s.id = $1`,
    [storeId]
  );
  if (!store.rowCount) return null;
  const tunnelStatus = store.rows[0].tunnel_status as string;
  // Cloudflare's own tunnel connector status is authoritative for "is the
  // tunnel up at all" on live accounts. When it already says the tunnel has
  // no connector, probing the published hostname is guaranteed to time out,
  // so skip it. Mock accounts have no real tunnel and never update this
  // column, so this only applies to live accounts.
  const tunnelDisconnected = store.rows[0].provider_mode === "live"
    && (tunnelStatus === "not_created" || tunnelStatus === "inactive" || tunnelStatus === "down");

  const publications = options.routeId
    ? await pool.query("SELECT p.id, p.hostname, r.id AS route_id, r.path FROM store_publications p JOIN store_routes r ON r.publication_id = p.id WHERE p.store_id = $1 AND r.id = $2", [storeId, options.routeId])
    : options.publicationId
      ? await pool.query("SELECT id, hostname, null::uuid AS route_id, '/' AS path FROM store_publications WHERE store_id = $1 AND id = $2", [storeId, options.publicationId])
      : await pool.query("SELECT id, hostname, null::uuid AS route_id, '/' AS path FROM store_publications WHERE store_id = $1 ORDER BY created_at", [storeId]);
  if ((options.routeId || options.publicationId) && !publications.rowCount) return null;
  const targets = publications.rowCount ? publications.rows : [{ id: null, route_id: null, hostname: store.rows[0].hostname, path: "/" }];
  const checks = await Promise.all(targets.map(async (target) => ({
    publicationId: target.id as string | null,
    routeId: target.route_id as string | null,
    hostname: target.hostname as string,
    path: target.path as string,
    check: tunnelDisconnected
      ? {
          reachable: false,
          statusCode: null,
          latencyMs: 0,
          attempts: 0,
          error: `Cloudflare reports the tunnel is ${tunnelStatus}`
        }
      : await checkStoreEndpoint(target.hostname, {
          path: target.path as string,
          attempts: options.attempts,
          retryDelayMs: options.retryDelayMs
        })
  })));

  await Promise.all(checks.filter((item) => item.publicationId).map((item) => pool.query(
    "UPDATE store_publications SET status = $1, last_error = $2, updated_at = now() WHERE id = $3",
    [item.check.reachable ? "active" : "failed", item.check.error ?? null, item.publicationId]
  )));
  const success = checks.every((item) => item.check.reachable);
  if (success) {
    const remainingFailed = options.publicationId || options.routeId
      ? await pool.query("SELECT 1 FROM store_publications WHERE store_id = $1 AND status <> 'active' LIMIT 1", [storeId])
      : { rowCount: 0 };
    await pool.query(
      (options.publicationId || options.routeId) && remainingFailed.rowCount
        ? "UPDATE stores SET last_verified_at = now(), last_error = null, updated_at = now() WHERE id = $1"
        : `UPDATE stores SET last_verified_at = now(), last_error = null,
                onboarding_status = CASE WHEN onboarding_status IN ('connector_online', 'verified') THEN 'verified' ELSE onboarding_status END,
                updated_at = now() WHERE id = $1`,
      [storeId]
    );
  } else {
    const failed = checks.filter((item) => !item.check.reachable);
    await pool.query(
      "UPDATE stores SET last_error = $1, updated_at = now() WHERE id = $2",
      [`${failed.length} published endpoint${failed.length === 1 ? " is" : "s are"} unreachable`, storeId]
    );
  }
  await writeAudit({
    ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
    action: success ? "store.verified" : "store.verification_failed",
    entityType: "store",
    entityId: storeId,
    details: { checks }
  });
  return { success, check: checks[0]!.check, checks };
}

export function scheduleStoreVerification(storeId: string): void {
  const timer = setTimeout(() => {
    void verifyStoreEndpoints(storeId, { attempts: 4, retryDelayMs: 5_000 }).catch(() => undefined);
  }, 15_000);
  timer.unref();
}
