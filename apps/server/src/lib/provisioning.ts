import { writeAudit } from "./audit.js";
import type { PoolClient } from "pg";
import { CloudflareClient, type CloudflareIngressRule } from "./cloudflare.js";
import { pool, withTransaction } from "./database.js";
import { decryptSecret } from "./security.js";
import { slugifyLabel } from "./tunnels.js";
import { COMMAND_AGENT_SERVICE_URL } from "./command-agent.js";
import { reconcileZoneWaf } from "./route-waf.js";

type PublicationRoute = {
  id: string;
  path: string;
  serviceUrl: string;
  routeKind: "service" | "command_agent";
  sortOrder: number;
  wafEnabled: boolean;
  wafAllowedIps: string[];
  wafRulesetId: string | null;
  wafRuleId: string | null;
};
type Publication = { id: string; hostname: string; dnsRecordId: string | null; routes: PublicationRoute[] };
type TunnelConnectivity = {
  id: string;
  tenant_code: string;
  tunnel_code: string;
  cf_tunnel_id: string | null;
  account_row_id: string;
  provider_mode: "live" | "mock";
  cf_account_id: string | null;
  api_token_encrypted: string | null;
  zone_id: string;
  cf_zone_id: string | null;
};

type ProvisioningResult = {
  tunnelToken: string;
  cfTunnelId: string;
  hostname: string;
  providerMode: "live" | "mock";
};

type DeprovisionRoute = {
  id: string;
  hostname: string;
  path: string;
  wafRulesetId: string | null;
  wafRuleId: string | null;
};

type DeprovisionTunnel = TunnelConnectivity & {
  rdpRouteId: string | null;
  rdpTargetId: string | null;
  rdpVnetId: string | null;
  publications: Array<{ id: string; dnsRecordId: string | null }>;
  routes: DeprovisionRoute[];
};

// Cloudflare Tunnel's ingress `path` field is an unanchored regular
// expression, not a literal prefix - per Cloudflare's own docs, "anchors are
// not included" by default. Passing a raw path like "/exec" through
// unescaped means it matches that substring ANYWHERE in the URL, so a
// command_agent route at "/exec" was silently also swallowing requests like
// "/api/tunnels/{id}/execution-variables/resolve" or ".../commands/execute"
// on any hostname that also carries that route (in particular CFMan's own
// self-hosted hostname, which is also its own command-agent target) -
// routing them to the local command agent instead of the CFMan app, which
// then rejected them with its own "Invalid command agent token" error.
// Anchoring at the start and requiring either end-of-path or a "/" boundary
// after the configured path keeps this a true prefix match, mirroring the
// same "exact path or subpath" semantics the WAF expression already uses.
export function pathPrefixPattern(path: string): string | undefined {
  if (path === "/") return undefined;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}(?:$|/)`;
}

function ingressRules(publications: Publication[]): CloudflareIngressRule[] {
  return publications.flatMap((publication) => publication.routes
    .slice()
    .sort((left, right) => {
      if (left.path === "/") return 1;
      if (right.path === "/") return -1;
      return left.sortOrder - right.sortOrder;
    })
    .map((route) => {
      const path = pathPrefixPattern(route.path);
      return {
        hostname: publication.hostname,
        service: route.serviceUrl,
        ...(path ? { path } : {})
      };
    }));
}

async function loadPublications(tunnelId: string): Promise<Publication[]> {
  const publicationRows = await pool.query(
    `SELECT p.id, p.hostname, p.dns_record_id, r.id AS route_id, r.path, r.service_url, r.sort_order,
              r.route_kind, r.waf_enabled, r.waf_allowed_ips, r.waf_ruleset_id, r.waf_rule_id
       FROM tunnel_publications p
       JOIN tunnel_routes r ON r.publication_id = p.id
      WHERE p.tunnel_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [tunnelId]
  );
  const byPublication = new Map<string, Publication>();
  for (const row of publicationRows.rows) {
    const publication: Publication = byPublication.get(row.id) ?? {
      id: row.id,
      hostname: row.hostname,
      dnsRecordId: row.dns_record_id,
      routes: []
    };
    publication.routes.push({
      id: row.route_id,
      path: row.path,
      serviceUrl: row.route_kind === "command_agent" ? COMMAND_AGENT_SERVICE_URL : row.service_url,
      routeKind: row.route_kind,
      sortOrder: row.sort_order,
      wafEnabled: row.waf_enabled,
      wafAllowedIps: row.waf_allowed_ips ?? [],
      wafRulesetId: row.waf_ruleset_id,
      wafRuleId: row.waf_rule_id
    });
    byPublication.set(row.id, publication);
  }
  return [...byPublication.values()];
}

function cloudflareClient(tunnel: TunnelConnectivity): CloudflareClient {
  return new CloudflareClient(
    tunnel.cf_account_id ?? tunnel.account_row_id,
    tunnel.api_token_encrypted ? decryptSecret(tunnel.api_token_encrypted) : "mock",
    tunnel.provider_mode
  );
}

export async function tunnelHasActiveCfTunnel(tunnelId: string, expectedCfTunnelId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.tunnel_code, s.cf_tunnel_id, s.zone_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [tunnelId]
  );
  const tunnelRow = result.rows[0] as TunnelConnectivity | undefined;
  if (!tunnelRow || tunnelRow.cf_tunnel_id !== expectedCfTunnelId) return false;
  if (tunnelRow.provider_mode === "mock") return true;
  if (!tunnelRow.api_token_encrypted) return false;
  const cfTunnel = (await cloudflareClient(tunnelRow).listTunnels()).find((candidate) => candidate.id === expectedCfTunnelId);
  return cfTunnel?.status === "healthy" || cfTunnel?.status === "degraded";
}

async function applyConnectivity(
  tunnelId: string,
  tunnel: TunnelConnectivity,
  client: CloudflareClient,
  cfTunnelId: string,
  publications: Publication[]
): Promise<void> {
  const primary = publications[0];
  if (!primary) throw new Error("Tunnel has no published endpoints");
  const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
  if (!primaryRoute) throw new Error(`Published endpoint ${primary.hostname} has no routes`);
  await client.configureTunnel(cfTunnelId, ingressRules(publications));
  // WAF for every route in this zone (across every tunnel, not just this
  // one) is rebuilt as a single merged Cloudflare rule - see reconcileZoneWaf.
  // A failure there (e.g. an allow-list IP couldn't be resolved) is recorded
  // as a non-blocking warning on the affected tunnels instead of failing this
  // provisioning attempt: the ingress/DNS below still make the tunnel
  // reachable, just without WAF protection until the next successful reconcile.
  await reconcileZoneWaf(client, tunnel.zone_id, tunnel.cf_zone_id, tunnel.provider_mode);
  for (const publication of publications) {
    // Always upsert instead of trusting a cached dns_record_id: Cloudflare is
    // the source of truth, and a record can disappear out-of-band (deleted
    // directly on the dashboard, a failed prior cleanup, etc.) without this
    // column ever being cleared. createDnsRecord looks the record up by name
    // and recreates it if missing, self-healing that drift on every
    // provision/reconfigure instead of silently marking the publication
    // "active" against a record that no longer exists.
    const record = await client.createDnsRecord(tunnel.cf_zone_id ?? "mock-zone", publication.hostname, cfTunnelId);
    publication.dnsRecordId = record.id;
    await pool.query(
      `UPDATE tunnel_publications
          SET dns_record_id = $1, status = 'active', last_error = null, updated_at = now()
        WHERE id = $2`,
      [publication.dnsRecordId, publication.id]
    );
  }
  await pool.query(
    "UPDATE tunnels SET dns_record_id = $1, hostname = $2, origin_url = $3, last_error = null, updated_at = now() WHERE id = $4",
    [primary.dnsRecordId, primary.hostname, primaryRoute.serviceUrl, tunnelId]
  );
}

export async function reconfigureTunnel(
  tunnelId: string,
  removedDnsRecordIds: string[] = []
): Promise<boolean> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.tunnel_code, s.cf_tunnel_id, s.zone_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [tunnelId]
  );
  const tunnel = result.rows[0] as TunnelConnectivity | undefined;
  if (!tunnel) throw new Error("Tunnel not found");
  if (!tunnel.cf_tunnel_id) return false;
  if (tunnel.provider_mode === "live" && (!tunnel.cf_zone_id || !tunnel.api_token_encrypted)) {
    throw new Error("Cloudflare account or zone is not fully configured");
  }
  const publications = await loadPublications(tunnelId);
  if (publications.length === 0) throw new Error("Tunnel has no published endpoints");
  const client = cloudflareClient(tunnel);
  try {
    // Routes no longer present in tunnel_routes are already excluded from the
    // next reconcileZoneWaf rebuild inside applyConnectivity - nothing extra
    // to disable for them here.
    await applyConnectivity(tunnelId, tunnel, client, tunnel.cf_tunnel_id, publications);
    for (const recordId of removedDnsRecordIds) {
      await client.deleteDnsRecord(tunnel.cf_zone_id ?? "mock-zone", recordId);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connectivity update failed";
    await pool.query(
      "UPDATE tunnel_publications SET status = 'failed', last_error = $1, updated_at = now() WHERE tunnel_id = $2",
      [message, tunnelId]
    );
    await pool.query("UPDATE tunnels SET last_error = $1, updated_at = now() WHERE id = $2", [message, tunnelId]);
    throw error;
  }
}

/**
 * Remove every Cloudflare resource owned by a tunnel while retaining the
 * connectivity definitions in Postgres for a future enrollment.
 *
 * Every delete is idempotent in CloudflareClient (404 is ignored). We still
 * attempt all resources after an individual failure so a missing permission
 * on one API family cannot hide DNS/tunnel resources that can be removed.
 */
export async function withTunnelCloudflareLock<T>(tunnelId: string, operation: (lockClient: PoolClient) => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  const lockKey = `cfman:cloudflare-tunnel:${tunnelId}`;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    return await operation(lockClient);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    lockClient.release();
  }
}

export async function deprovisionTunnel(
  tunnelId: string,
  reason: "unenroll" | "override" | "delete" = "unenroll",
  lockClient?: PoolClient
): Promise<void> {
  if (!lockClient) {
    return withTunnelCloudflareLock(tunnelId, (client) => deprovisionTunnel(tunnelId, reason, client));
  }
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.tunnel_code, s.cf_tunnel_id, s.zone_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id,
            s.rdp_route_id AS "rdpRouteId", s.rdp_target_id AS "rdpTargetId", s.rdp_vnet_id AS "rdpVnetId"
       FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [tunnelId]
  );
  const tunnel = result.rows[0] as DeprovisionTunnel | undefined;
  if (!tunnel) throw new Error("Tunnel not found");

  const publicationResult = await pool.query(
    `SELECT p.id, p.dns_record_id AS "dnsRecordId", p.hostname,
            r.id AS route_id, r.path, r.waf_ruleset_id AS "wafRulesetId", r.waf_rule_id AS "wafRuleId"
       FROM tunnel_publications p
       LEFT JOIN tunnel_routes r ON r.publication_id = p.id
      WHERE p.tunnel_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [tunnelId]
  );
  tunnel.publications = [];
  tunnel.routes = [];
  const publicationById = new Map<string, { id: string; dnsRecordId: string | null }>();
  for (const row of publicationResult.rows) {
    let publication = publicationById.get(row.id);
    if (!publication) {
      publication = { id: row.id, dnsRecordId: row.dnsRecordId };
      publicationById.set(row.id, publication);
      tunnel.publications.push(publication);
    }
    if (row.route_id) {
      tunnel.routes.push({
        id: row.route_id,
        hostname: row.hostname,
        path: row.path,
        wafRulesetId: row.wafRulesetId,
        wafRuleId: row.wafRuleId
      });
    }
  }

  const client = cloudflareClient(tunnel);
  const failures: string[] = [];
  const attempt = async (label: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const zoneId = tunnel.cf_zone_id ?? "mock-zone";
  if (tunnel.routes.some((route) => route.wafRuleId)) {
    if (!tunnel.cf_zone_id && tunnel.provider_mode === "live") {
      failures.push("WAF: Cloudflare zone ID is missing");
    } else {
      // Excludes this tunnel's own routes so the merged zone rule is rebuilt
      // without them, instead of disabling each one individually.
      await attempt("WAF zone reconcile", async () => {
        const { warning } = await reconcileZoneWaf(client, tunnel.zone_id, tunnel.cf_zone_id, tunnel.provider_mode, { excludeTunnelId: tunnelId });
        if (warning) throw new Error(warning);
      });
    }
  }

  const deletedDnsRecords = new Set<string>();
  for (const publication of tunnel.publications) {
    if (!publication.dnsRecordId || deletedDnsRecords.has(publication.dnsRecordId)) continue;
    deletedDnsRecords.add(publication.dnsRecordId);
    if (!tunnel.cf_zone_id && tunnel.provider_mode === "live") {
      failures.push(`DNS ${publication.dnsRecordId}: Cloudflare zone ID is missing`);
      continue;
    }
    await attempt(`DNS ${publication.dnsRecordId}`, () => client.deleteDnsRecord(zoneId, publication.dnsRecordId!));
  }
  if (tunnel.rdpRouteId) await attempt(`RDP route ${tunnel.rdpRouteId}`, () => client.deleteTunnelRoute(tunnel.rdpRouteId!));
  if (tunnel.rdpTargetId) await attempt(`RDP target ${tunnel.rdpTargetId}`, () => client.deleteInfrastructureTarget(tunnel.rdpTargetId!));
  if (tunnel.rdpVnetId) await attempt(`RDP virtual network ${tunnel.rdpVnetId}`, () => client.deleteVirtualNetwork(tunnel.rdpVnetId!));
  if (tunnel.cf_tunnel_id) {
    await attempt(`Tunnel connections ${tunnel.cf_tunnel_id}`, () => client.deleteTunnelConnections(tunnel.cf_tunnel_id!));
    await attempt(`Tunnel ${tunnel.cf_tunnel_id}`, () => client.deleteTunnel(tunnel.cf_tunnel_id!));
  }

  if (failures.length) {
    const message = `Cloudflare cleanup failed during ${reason}: ${failures.join("; ")}`;
    await pool.query("UPDATE tunnels SET last_error = $1, updated_at = now() WHERE id = $2", [message, tunnelId]);
    throw new Error(message);
  }

  await withTransaction(async (database) => {
    await database.query(
      `UPDATE tunnel_publications
          SET dns_record_id = null, status = 'pending', last_error = null, updated_at = now()
        WHERE tunnel_id = $1`,
      [tunnelId]
    );
    await database.query(
      `UPDATE tunnel_routes r
          SET waf_ruleset_id = null, waf_rule_id = null, updated_at = now()
        FROM tunnel_publications p
        WHERE r.publication_id = p.id AND p.tunnel_id = $1`,
      [tunnelId]
    );
    await database.query(
      `UPDATE tunnels
          SET cf_tunnel_id = null, cf_tunnel_name = null, dns_record_id = null,
              cf_tunnel_status = 'not_created', rdp_status = 'pending',
              rdp_target_ip = null, rdp_target_hostname = null,
              rdp_vnet_id = null, rdp_route_id = null, rdp_target_id = null,
              rdp_url = null, rdp_last_error = null, last_error = null, waf_warning = null, updated_at = now()
        WHERE id = $1`,
      [tunnelId]
    );
    await database.query(
      `UPDATE tunnel_command_agents
          SET status = 'pending', last_error = null, updated_at = now()
        WHERE tunnel_id = $1`,
      [tunnelId]
    );
    await writeAudit({
      action: "tunnel.cloudflare_deprovisioned",
      entityType: "tunnel",
      entityId: tunnelId,
      details: {
        reason,
        cfTunnelId: tunnel.cf_tunnel_id,
        dnsRecordCount: deletedDnsRecords.size,
        routeCount: tunnel.routes.length,
        rdpResources: [tunnel.rdpRouteId, tunnel.rdpTargetId, tunnel.rdpVnetId].filter(Boolean).length
      }
    }, database);
  });
}

export async function provisionTunnel(tunnelId: string): Promise<ProvisioningResult> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.tunnel_code, s.origin_url, s.hostname, s.cf_tunnel_id, s.dns_record_id, s.zone_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [tunnelId]
  );
  const tunnelRow = result.rows[0] as TunnelConnectivity | undefined;
  if (!tunnelRow) throw new Error("Tunnel not found");
  if (tunnelRow.provider_mode === "live" && (!tunnelRow.cf_zone_id || !tunnelRow.api_token_encrypted)) {
    throw new Error("Cloudflare account or zone is not fully configured");
  }

  const client = cloudflareClient(tunnelRow);
  const publications = await loadPublications(tunnelId);
  if (publications.length === 0) throw new Error("Tunnel has no published endpoints");

  await pool.query(
    "UPDATE tunnels SET onboarding_status = 'provisioning', last_error = null, updated_at = now() WHERE id = $1",
    [tunnelId]
  );

  try {
    let cfTunnelId = tunnelRow.cf_tunnel_id as string | null;
    let tunnelToken: string;
    if (!cfTunnelId) {
      const cfTunnelName = slugifyLabel(`cfman-${tunnelRow.tenant_code}-${tunnelRow.tunnel_code}-${tunnelRow.id.slice(0, 8)}`);
      const cfTunnel = await client.ensureTunnel(cfTunnelName);
      cfTunnelId = cfTunnel.id;
      tunnelToken = cfTunnel.token ?? await client.getTunnelToken(cfTunnel.id);
      await pool.query(
        `UPDATE tunnels SET cf_tunnel_id = $1, cf_tunnel_name = $2, cf_tunnel_status = 'inactive', updated_at = now()
         WHERE id = $3`,
        [cfTunnel.id, cfTunnelName, tunnelId]
      );
    } else {
      tunnelToken = await client.getTunnelToken(cfTunnelId);
    }

    await applyConnectivity(tunnelId, tunnelRow, client, cfTunnelId, publications);

    await pool.query(
      `UPDATE tunnels SET onboarding_status = 'claimed', last_error = null, updated_at = now() WHERE id = $1`,
      [tunnelId]
    );
    await writeAudit({
      action: "tunnel.provisioned",
      entityType: "tunnel",
      entityId: tunnelId,
      details: {
        cfTunnelId,
        hostnames: publications.map((publication) => publication.hostname),
        routeCount: publications.reduce((total, publication) => total + publication.routes.length, 0),
        providerMode: tunnelRow.provider_mode
      }
    });
    return { tunnelToken, cfTunnelId, hostname: publications[0]!.hostname, providerMode: tunnelRow.provider_mode };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tunnel provisioning failed";
    await pool.query(
      "UPDATE tunnel_publications SET status = 'failed', last_error = $1, updated_at = now() WHERE tunnel_id = $2",
      [message, tunnelId]
    );
    await pool.query(
      "UPDATE tunnels SET onboarding_status = 'failed', last_error = $1, updated_at = now() WHERE id = $2",
      [message, tunnelId]
    );
    throw error;
  }
}
