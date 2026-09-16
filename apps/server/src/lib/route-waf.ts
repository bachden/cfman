import { isIP } from "node:net";
import { config } from "../config.js";
import { getPublicBaseUrl } from "./app-settings.js";
import { CloudflareClient } from "./cloudflare.js";
import { pool } from "./database.js";
import { decryptSecret } from "./security.js";

const configuredWafIps = config.CFMAN_WAF_ALLOWED_IPS.split(",").map((value) => value.trim()).filter(Boolean);

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export async function cloudflareManPublicHostname(): Promise<string> {
  return normalizeHostname(new URL(await getPublicBaseUrl()).hostname);
}

export function isCloudflareManPublicHostname(hostname: string, publicHostname: string): boolean {
  return normalizeHostname(hostname) === normalizeHostname(publicHostname);
}

// The paths CFMan automatically carves out on its own public hostname for
// traffic sent by *remote enrolled machines*, not the operator's browser:
// script bootstrap downloads (/e install|unenroll, /d diagnose) and the JSON
// callbacks a running enrollment/unenroll/diagnostic/script-execution reports
// its progress and log stream to (/api/public/...). Unlike every other path
// on CFMan's own hostname (always forced off - see isCloudflareManPublicHostname
// callers below), these default off but can be switched on: a remote
// machine's source IP can't be predicted ahead of time, so enabling WAF here
// risks silently dropping enrollment/unenroll/diagnostic/execute_script log
// callbacks - real, but a risk the operator can knowingly accept.
export const CFMAN_REMOTE_AGENT_PATHS = ["/api/public", "/e", "/d"] as const;

export function isCfmanRemoteAgentPath(hostname: string, path: string, publicHostname: string): boolean {
  return isCloudflareManPublicHostname(hostname, publicHostname) && (CFMAN_REMOTE_AGENT_PATHS as readonly string[]).includes(path);
}

export const CFMAN_REMOTE_AGENT_WAF_WARNING =
  "WAF is enabled on a CFMan remote-agent path - enrollment, unenroll, diagnostic, or script-execution log callbacks from enrolled machines may be blocked.";

export function isValidIpOrCidr(value: string): boolean {
  const [address, prefix] = value.split("/");
  const version = isIP(address ?? "");
  if (!version) return false;
  if (prefix === undefined) return true;
  const numericPrefix = Number(prefix);
  return Number.isInteger(numericPrefix) && numericPrefix >= 0 && numericPrefix <= (version === 4 ? 32 : 128);
}

async function fetchPublicIp(): Promise<string> {
  const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Unable to detect CFMan public IP; set CFMAN_WAF_ALLOWED_IPS and retry");
  const payload = await response.json() as { ip?: string };
  if (!payload.ip || !isIP(payload.ip)) throw new Error("Public IP detection returned an invalid address; set CFMAN_WAF_ALLOWED_IPS and retry");
  return `${payload.ip}/${payload.ip.includes(":") ? 128 : 32}`;
}

export async function defaultWafAllowedIps(providerMode: "live" | "mock"): Promise<string[]> {
  if (configuredWafIps.length) return configuredWafIps;
  if (providerMode === "mock") return ["127.0.0.1/32"];
  return [await fetchPublicIp()];
}

// CFMAN_WAF_ALLOWED_IPS is a static, operator-set value and can silently
// drift from this machine's actual outbound IP (ISP/NAT change, moving to a
// new host, ...). Unlike defaultWafAllowedIps, this never throws - it's only
// ever used to supplement an already-resolved allow-list, so an ipify hiccup
// here should never block route provisioning that already succeeded via the
// configured IP.
async function detectActualPublicIp(): Promise<string | null> {
  try {
    return await fetchPublicIp();
  } catch {
    return null;
  }
}

export async function resolveWafAllowedIps(values: string[], providerMode: "live" | "mock"): Promise<string[]> {
  const allowedIps = values.length ? values : await defaultWafAllowedIps(providerMode);
  const invalid = allowedIps.find((value) => !isValidIpOrCidr(value));
  if (invalid) throw new Error(`Invalid WAF allowed IP or CIDR: ${invalid}`);
  return [...new Set(allowedIps)];
}

type ZoneWafRouteRow = {
  routeId: string;
  tunnelId: string;
  path: string;
  routeKind: "service" | "command_agent";
  wafEnabled: boolean;
  wafAllowedIps: string[] | null;
  wafRulesetId: string | null;
  hostname: string;
};

// Even bin-packed as tightly as the 4096-character-per-rule limit allows
// (see CloudflareClient.packRouteConditions), a zone can still run out of
// custom rule slots - that ceiling is set by the Cloudflare plan (5 on Free,
// more on paid tiers) and isn't discoverable ahead of time, only by
// Cloudflare rejecting the request. When that specific error comes back,
// tell the operator plainly that packing is already maximized and the fix is
// a plan upgrade (or freeing up unrelated custom rules in the zone) rather
// than leaving them with Cloudflare's raw API error text.
function describeZoneWafError(error: unknown): string {
  const message = error instanceof Error ? error.message : "WAF rule could not be applied";
  if (/maximum number of rules/i.test(message)) {
    return `${message} - CFMan already packs every protected route as tightly as the 4096-character rule limit allows, but this zone has no custom WAF rule slots left. Upgrade this Cloudflare zone's plan (or remove unrelated custom rules) to protect additional routes.`;
  }
  return message;
}

// A zone's merged WAF rule is read-modify-written: read every route that
// should be protected, then PUT the whole rule back. Two concurrent
// reconciles for the same zone (two operators, or two tunnels in the same
// zone provisioning at once) would otherwise race - whichever Cloudflare PUT
// lands last wins and can silently drop the other caller's route from the
// rule. A Postgres advisory lock keyed by zone serializes reconciles for the
// same zone so each one always starts from the previous one's committed
// result, mirroring the per-tunnel lock provisioning.ts already uses for the
// same class of race (withTunnelCloudflareLock).
async function withZoneWafLock<T>(zoneId: string, operation: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  const lockKey = `cfman:zone-waf:${zoneId}`;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    return await operation();
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    lockClient.release();
  }
}

// Rebuilds the single Cloudflare custom rule that protects every WAF-enabled
// route in a zone (see CloudflareClient.configureZoneWaf) from the current
// tunnel_routes state, then writes the outcome back. Effective WAF state per
// route, in priority order:
//  1. route_kind = 'command_agent' -> always enabled, regardless of the
//     stored waf_enabled flag. It's the highest-value target (remote code
//     execution) a tunnel exposes, so it isn't something an operator should
//     be able to silently turn off, or a rule-limit conflict quietly drop.
//  2. a CFMan remote-agent path (see isCfmanRemoteAgentPath) -> follows the
//     operator's own waf_enabled choice (default off), but contributes a
//     standing warning while enabled, since it risks dropping enrollment/
//     unenroll/diagnostic/execute_script log callbacks from enrolled
//     machines.
//  3. any other route on CFMan's own public hostname -> always disabled, so
//     the admin server can never accidentally WAF itself out of its own UI.
//  4. anything else -> follows the operator's own waf_enabled choice.
// If applying the merged rule fails (or an allow-list IP can't be resolved),
// that failure is folded into the same warning, and every tunnel in the zone
// that has at least one route needing protection is marked with it instead
// of failing the caller - a single Cloudflare rule slot now serves the whole
// zone, so a failure there is a zone-wide condition, not one route's problem.
export async function reconcileZoneWaf(
  client: CloudflareClient,
  zoneId: string,
  cfZoneId: string | null,
  providerMode: "live" | "mock",
  options: { excludeTunnelId?: string } = {}
): Promise<{ warning: string | null }> {
  return withZoneWafLock(zoneId, () => reconcileZoneWafUnlocked(client, zoneId, cfZoneId, providerMode, options));
}

async function reconcileZoneWafUnlocked(
  client: CloudflareClient,
  zoneId: string,
  cfZoneId: string | null,
  providerMode: "live" | "mock",
  options: { excludeTunnelId?: string } = {}
): Promise<{ warning: string | null }> {
  const publicHostname = await cloudflareManPublicHostname();
  const rows = (await pool.query(
    `SELECT r.id AS "routeId", t.id AS "tunnelId", r.path, r.route_kind AS "routeKind",
            r.waf_enabled AS "wafEnabled", r.waf_allowed_ips AS "wafAllowedIps", r.waf_ruleset_id AS "wafRulesetId",
            p.hostname
       FROM tunnel_routes r
       JOIN tunnel_publications p ON p.id = r.publication_id
       JOIN tunnels t ON t.id = p.tunnel_id
      WHERE t.zone_id = $1
        AND ($2::uuid IS NULL OR t.id <> $2)`,
    [zoneId, options.excludeTunnelId ?? null]
  )).rows as ZoneWafRouteRow[];

  const protectedRouteIds = new Set<string>();
  const routesForRule: Array<{ hostname: string; path: string; allowedIps: string[] }> = [];
  const routeIdsForRule: string[] = [];
  let defaultAllowedIpsPromise: Promise<string[]> | undefined;
  let riskyPathWarning: string | null = null;
  let applyWarning: string | null = null;

  for (const row of rows) {
    const remoteAgentPath = isCfmanRemoteAgentPath(row.hostname, row.path, publicHostname);
    const protectsCloudflareMan = !remoteAgentPath && isCloudflareManPublicHostname(row.hostname, publicHostname);
    const effectiveEnabled = row.routeKind === "command_agent"
      ? true
      : protectsCloudflareMan
        ? false
        : row.wafEnabled;
    if (!effectiveEnabled) continue;
    protectedRouteIds.add(row.routeId);
    if (remoteAgentPath) riskyPathWarning = CFMAN_REMOTE_AGENT_WAF_WARNING;
    if (applyWarning) continue;
    try {
      const storedIps = row.wafAllowedIps ?? [];
      const allowedIps = storedIps.length
        ? await resolveWafAllowedIps(storedIps, providerMode)
        : await (defaultAllowedIpsPromise ??= resolveWafAllowedIps([], providerMode));
      routesForRule.push({ hostname: row.hostname, path: row.path, allowedIps });
      routeIdsForRule.push(row.routeId);
    } catch (error) {
      applyWarning = error instanceof Error ? error.message : "WAF rule could not be applied";
    }
  }

  const existingRulesetId = rows.find((row) => row.wafRulesetId)?.wafRulesetId ?? null;
  let rulesetIdResult = existingRulesetId;
  const ruleIdByRouteId = new Map<string, string | null>();
  if (!applyWarning) {
    try {
      const applied = await client.configureZoneWaf({ zoneId: cfZoneId ?? "mock-zone", routes: routesForRule, rulesetId: existingRulesetId });
      rulesetIdResult = applied.rulesetId;
      routeIdsForRule.forEach((routeId, index) => ruleIdByRouteId.set(routeId, applied.ruleIds[index] ?? null));
    } catch (error) {
      applyWarning = describeZoneWafError(error);
    }
  }

  const warning = [applyWarning, riskyPathWarning].filter(Boolean).join("; ") || null;

  for (const row of rows) {
    const effectiveEnabled = protectedRouteIds.has(row.routeId);
    const ruleApplied = effectiveEnabled && !applyWarning;
    await pool.query(
      `UPDATE tunnel_routes SET waf_enabled = $1, waf_ruleset_id = $2, waf_rule_id = $3, updated_at = now() WHERE id = $4`,
      [effectiveEnabled, ruleApplied ? rulesetIdResult : null, ruleApplied ? ruleIdByRouteId.get(row.routeId) ?? null : null, row.routeId]
    );
  }

  const tunnelIds = [...new Set(rows.map((row) => row.tunnelId))];
  for (const tunnelId of tunnelIds) {
    const tunnelNeedsProtection = rows.some((row) => row.tunnelId === tunnelId && protectedRouteIds.has(row.routeId));
    await pool.query(
      "UPDATE tunnels SET waf_warning = $1, updated_at = now() WHERE id = $2",
      [tunnelNeedsProtection ? warning : null, tunnelId]
    );
  }

  return { warning };
}

// Called after a successful install so a tunnel's command agent endpoint never
// silently locks the CFMan server out of its own WAF allow-list - e.g. after
// the server's public IP changes - without the operator having to remember
// to open the WAF dialog and click "Add CFMan origin". Live-detects this
// machine's actual outbound IP and folds it in alongside whatever
// defaultWafAllowedIps resolves (a configured CFMAN_WAF_ALLOWED_IPS wins
// there and is never overridden - only supplemented - since it can go stale).
// Only touches the route when WAF protection is already enabled there, and
// only writes back when an IP is actually missing.
export async function ensureCommandAgentWafAllowsCloudflareMan(tunnelId: string): Promise<void> {
  const result = await pool.query(
    `SELECT r.id AS "routeId", r.waf_allowed_ips AS "wafAllowedIps",
            s.zone_id AS "zoneId", z.cf_zone_id AS "cfZoneId",
            a.id AS "accountRowId", a.cf_account_id AS "cfAccountId", a.api_token_encrypted AS "apiTokenEncrypted", a.provider_mode AS "providerMode"
       FROM tunnel_routes r
       JOIN tunnel_publications p ON p.id = r.publication_id
       JOIN tunnels s ON s.id = p.tunnel_id
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1 AND r.route_kind = 'command_agent'
      LIMIT 1`,
    [tunnelId]
  );
  const route = result.rows[0];
  if (!route) return;
  const cloudflareManIps = await defaultWafAllowedIps(route.providerMode);
  const actualIp = route.providerMode === "live" ? await detectActualPublicIp() : null;
  const effectiveCloudflareManIps = actualIp && !cloudflareManIps.includes(actualIp)
    ? [...cloudflareManIps, actualIp]
    : cloudflareManIps;
  const currentIps = (route.wafAllowedIps ?? []) as string[];
  const missing = effectiveCloudflareManIps.filter((ip) => !currentIps.includes(ip));
  if (!missing.length) return;
  const allowedIps = [...new Set([...currentIps, ...missing])];
  await pool.query(
    `UPDATE tunnel_routes SET waf_allowed_ips = $1, updated_at = now() WHERE id = $2`,
    [allowedIps, route.routeId]
  );
  const client = new CloudflareClient(
    route.cfAccountId ?? route.accountRowId,
    route.apiTokenEncrypted ? decryptSecret(route.apiTokenEncrypted) : "mock",
    route.providerMode
  );
  await reconcileZoneWaf(client, route.zoneId, route.cfZoneId, route.providerMode);
}

// Idempotently creates CFMan's own remote-agent routes (see
// CFMAN_REMOTE_AGENT_PATHS) on every publication currently using the given
// hostname, defaulting them to WAF-off. Cheap and safe to call any time a
// publication's hostname could newly be CFMan's own: on tunnel creation, on
// a connectivity edit, and whenever the public base URL setting changes.
export type CfmanRemoteAgentRouteStatus = { path: string; created: boolean };

export async function ensureCloudflareManRemoteAgentRoutes(hostname: string): Promise<CfmanRemoteAgentRouteStatus[]> {
  const publications = await pool.query(
    `SELECT p.id AS "publicationId",
            (SELECT r.service_url FROM tunnel_routes r WHERE r.publication_id = p.id ORDER BY (r.path = '/') DESC, r.sort_order LIMIT 1) AS "serviceUrl",
            (SELECT COALESCE(MAX(r.sort_order), -1) FROM tunnel_routes r WHERE r.publication_id = p.id) AS "maxSortOrder"
       FROM tunnel_publications p
      WHERE lower(trim(trailing '.' FROM p.hostname)) = $1`,
    [normalizeHostname(hostname)]
  );
  const statuses: CfmanRemoteAgentRouteStatus[] = [];
  for (const publication of publications.rows as Array<{ publicationId: string; serviceUrl: string | null; maxSortOrder: number }>) {
    if (!publication.serviceUrl) continue;
    for (const [index, path] of CFMAN_REMOTE_AGENT_PATHS.entries()) {
      const inserted = await pool.query(
        `INSERT INTO tunnel_routes(publication_id, path, service_url, route_kind, sort_order, waf_enabled)
         VALUES ($1, $2, $3, 'service', $4, false)
         ON CONFLICT (publication_id, path) DO NOTHING
         RETURNING id`,
        [publication.publicationId, path, publication.serviceUrl, publication.maxSortOrder + 1 + index]
      );
      statuses.push({ path, created: Boolean(inserted.rowCount) });
    }
  }
  return statuses;
}

export async function disableCloudflareManPublicHostnameWaf(
  publicHostname?: string
): Promise<{ disabled: number; failures: Array<{ zoneId: string; error: string }> }> {
  const resolvedPublicHostname = publicHostname ?? await cloudflareManPublicHostname();
  // reconcileZoneWaf already excludes any route on CFMan's own public
  // hostname from the merged rule dynamically, so disabling it here is just
  // finding which zones have such a route and re-running the zone-wide
  // rebuild for each - there's nothing route-specific left to do.
  const result = await pool.query(
    `SELECT DISTINCT s.zone_id AS "zoneId", z.cf_zone_id AS "cfZoneId",
            a.id AS "accountRowId", a.cf_account_id AS "cfAccountId",
            a.api_token_encrypted AS "apiTokenEncrypted", a.provider_mode AS "providerMode"
       FROM tunnel_publications p
       JOIN tunnels s ON s.id = p.tunnel_id
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE lower(trim(trailing '.' FROM p.hostname)) = $1`,
    [normalizeHostname(resolvedPublicHostname)]
  );
  let disabled = 0;
  const failures: Array<{ zoneId: string; error: string }> = [];
  for (const zone of result.rows as Array<{
    zoneId: string;
    cfZoneId: string | null;
    accountRowId: string;
    cfAccountId: string | null;
    apiTokenEncrypted: string | null;
    providerMode: "live" | "mock";
  }>) {
    try {
      if (zone.providerMode === "live" && (!zone.cfZoneId || !zone.apiTokenEncrypted)) {
        throw new Error("Cloudflare account or zone credentials are incomplete");
      }
      const client = new CloudflareClient(
        zone.cfAccountId ?? zone.accountRowId,
        zone.apiTokenEncrypted ? decryptSecret(zone.apiTokenEncrypted) : "mock",
        zone.providerMode
      );
      const { warning } = await reconcileZoneWaf(client, zone.zoneId, zone.cfZoneId, zone.providerMode);
      if (warning) throw new Error(warning);
      disabled += 1;
    } catch (error) {
      failures.push({ zoneId: zone.zoneId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { disabled, failures };
}
