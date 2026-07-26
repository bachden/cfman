import { isIP } from "node:net";
import { config } from "../config.js";
import { CloudflareClient } from "./cloudflare.js";
import { pool } from "./database.js";
import { decryptSecret } from "./security.js";

const configuredWafIps = config.CFMAN_WAF_ALLOWED_IPS.split(",").map((value) => value.trim()).filter(Boolean);

export function isValidIpOrCidr(value: string): boolean {
  const [address, prefix] = value.split("/");
  const version = isIP(address ?? "");
  if (!version) return false;
  if (prefix === undefined) return true;
  const numericPrefix = Number(prefix);
  return Number.isInteger(numericPrefix) && numericPrefix >= 0 && numericPrefix <= (version === 4 ? 32 : 128);
}

export async function defaultWafAllowedIps(providerMode: "live" | "mock"): Promise<string[]> {
  if (configuredWafIps.length) return configuredWafIps;
  if (providerMode === "mock") return ["127.0.0.1/32"];
  const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Unable to detect Cloudflare Man public IP; set CFMAN_WAF_ALLOWED_IPS and retry");
  const payload = await response.json() as { ip?: string };
  if (!payload.ip || !isIP(payload.ip)) throw new Error("Public IP detection returned an invalid address; set CFMAN_WAF_ALLOWED_IPS and retry");
  return [`${payload.ip}/${payload.ip.includes(":") ? 128 : 32}`];
}

export async function resolveWafAllowedIps(values: string[], providerMode: "live" | "mock"): Promise<string[]> {
  const allowedIps = values.length ? values : await defaultWafAllowedIps(providerMode);
  const invalid = allowedIps.find((value) => !isValidIpOrCidr(value));
  if (invalid) throw new Error(`Invalid WAF allowed IP or CIDR: ${invalid}`);
  return [...new Set(allowedIps)];
}

// Called after a successful install so a store's command agent endpoint never
// silently locks the Cloudflare Man server out of its own WAF allow-list -
// e.g. after the server's public IP changes - without the operator having to
// remember to open the WAF dialog and click "Add Cloudflare Man origin".
// Only touches the route when WAF protection is already enabled there, and
// only writes back when an IP is actually missing.
export async function ensureCommandAgentWafAllowsCloudflareMan(storeId: string): Promise<void> {
  const result = await pool.query(
    `SELECT r.id AS "routeId", r.path, r.waf_enabled AS "wafEnabled", r.waf_allowed_ips AS "wafAllowedIps", r.waf_ruleset_id AS "wafRulesetId",
            p.hostname, z.cf_zone_id AS "cfZoneId",
            a.id AS "accountRowId", a.cf_account_id AS "cfAccountId", a.api_token_encrypted AS "apiTokenEncrypted", a.provider_mode AS "providerMode"
       FROM store_routes r
       JOIN store_publications p ON p.id = r.publication_id
       JOIN stores s ON s.id = p.store_id
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1 AND r.route_kind = 'command_agent'
      LIMIT 1`,
    [storeId]
  );
  const route = result.rows[0];
  if (!route || !route.wafEnabled) return;
  const cloudflareManIps = await defaultWafAllowedIps(route.providerMode);
  const currentIps = (route.wafAllowedIps ?? []) as string[];
  const missing = cloudflareManIps.filter((ip) => !currentIps.includes(ip));
  if (!missing.length) return;
  const allowedIps = [...new Set([...currentIps, ...missing])];
  const client = new CloudflareClient(
    route.cfAccountId ?? route.accountRowId,
    route.apiTokenEncrypted ? decryptSecret(route.apiTokenEncrypted) : "mock",
    route.providerMode
  );
  const applied = await client.configureRouteWaf({
    zoneId: route.cfZoneId ?? "mock-zone",
    hostname: route.hostname,
    path: route.path,
    enabled: true,
    allowedIps,
    rulesetId: route.wafRulesetId
  });
  await pool.query(
    `UPDATE store_routes SET waf_allowed_ips = $1, waf_ruleset_id = $2, waf_rule_id = $3, updated_at = now() WHERE id = $4`,
    [allowedIps, applied.rulesetId, applied.ruleId, route.routeId]
  );
}
