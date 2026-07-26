import { writeAudit } from "./audit.js";
import type { PoolClient } from "pg";
import { CloudflareClient, type CloudflareIngressRule } from "./cloudflare.js";
import { pool, withTransaction } from "./database.js";
import { decryptSecret } from "./security.js";
import { slugifyLabel } from "./stores.js";
import { COMMAND_AGENT_SERVICE_URL } from "./command-agent.js";
import { resolveWafAllowedIps } from "./route-waf.js";

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
type StoreConnectivity = {
  id: string;
  tenant_code: string;
  store_code: string;
  tunnel_id: string | null;
  account_row_id: string;
  provider_mode: "live" | "mock";
  cf_account_id: string | null;
  api_token_encrypted: string | null;
  cf_zone_id: string | null;
};

type ProvisioningResult = {
  tunnelToken: string;
  tunnelId: string;
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

type DeprovisionStore = StoreConnectivity & {
  rdpRouteId: string | null;
  rdpTargetId: string | null;
  rdpVnetId: string | null;
  publications: Array<{ id: string; dnsRecordId: string | null }>;
  routes: DeprovisionRoute[];
};

export function pathPrefixPattern(path: string): string | undefined {
  if (path === "/") return undefined;
  return path;
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

async function loadPublications(storeId: string): Promise<Publication[]> {
  const publicationRows = await pool.query(
    `SELECT p.id, p.hostname, p.dns_record_id, r.id AS route_id, r.path, r.service_url, r.sort_order,
              r.route_kind, r.waf_enabled, r.waf_allowed_ips, r.waf_ruleset_id, r.waf_rule_id
       FROM store_publications p
       JOIN store_routes r ON r.publication_id = p.id
      WHERE p.store_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [storeId]
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

function cloudflareClient(store: StoreConnectivity): CloudflareClient {
  return new CloudflareClient(
    store.cf_account_id ?? store.account_row_id,
    store.api_token_encrypted ? decryptSecret(store.api_token_encrypted) : "mock",
    store.provider_mode
  );
}

export async function isStoreTunnelActive(storeId: string, expectedTunnelId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.store_code, s.tunnel_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [storeId]
  );
  const store = result.rows[0] as StoreConnectivity | undefined;
  if (!store || store.tunnel_id !== expectedTunnelId) return false;
  if (store.provider_mode === "mock") return true;
  if (!store.api_token_encrypted) return false;
  const tunnel = (await cloudflareClient(store).listTunnels()).find((candidate) => candidate.id === expectedTunnelId);
  return tunnel?.status === "healthy" || tunnel?.status === "degraded";
}

async function applyConnectivity(
  storeId: string,
  store: StoreConnectivity,
  client: CloudflareClient,
  tunnelId: string,
  publications: Publication[]
): Promise<void> {
  const primary = publications[0];
  if (!primary) throw new Error("Store has no published endpoints");
  const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
  if (!primaryRoute) throw new Error(`Published endpoint ${primary.hostname} has no routes`);
  await client.configureTunnel(tunnelId, ingressRules(publications));
  let defaultAllowedIps: Promise<string[]> | undefined;
  for (const publication of publications) {
    for (const route of publication.routes) {
      if (!route.wafEnabled && !route.wafRuleId) continue;
      const allowedIps = route.wafEnabled
        ? route.wafAllowedIps.length
          ? await resolveWafAllowedIps(route.wafAllowedIps, store.provider_mode)
          : await (defaultAllowedIps ??= resolveWafAllowedIps([], store.provider_mode))
        : route.wafAllowedIps;
      const applied = await client.configureRouteWaf({
        zoneId: store.cf_zone_id ?? "mock-zone",
        hostname: publication.hostname,
        path: route.path,
        enabled: route.wafEnabled,
        allowedIps,
        rulesetId: route.wafRulesetId
      });
      route.wafAllowedIps = allowedIps;
      route.wafRulesetId = applied.rulesetId;
      route.wafRuleId = applied.ruleId;
      await pool.query(
        `UPDATE store_routes
            SET waf_allowed_ips = $1, waf_ruleset_id = $2, waf_rule_id = $3, updated_at = now()
          WHERE id = $4`,
        [allowedIps, applied.rulesetId, applied.ruleId, route.id]
      );
    }
  }
  for (const publication of publications) {
    // Always upsert instead of trusting a cached dns_record_id: Cloudflare is
    // the source of truth, and a record can disappear out-of-band (deleted
    // directly on the dashboard, a failed prior cleanup, etc.) without this
    // column ever being cleared. createDnsRecord looks the record up by name
    // and recreates it if missing, self-healing that drift on every
    // provision/reconfigure instead of silently marking the publication
    // "active" against a record that no longer exists.
    const record = await client.createDnsRecord(store.cf_zone_id ?? "mock-zone", publication.hostname, tunnelId);
    publication.dnsRecordId = record.id;
    await pool.query(
      `UPDATE store_publications
          SET dns_record_id = $1, status = 'active', last_error = null, updated_at = now()
        WHERE id = $2`,
      [publication.dnsRecordId, publication.id]
    );
  }
  await pool.query(
    "UPDATE stores SET dns_record_id = $1, hostname = $2, origin_url = $3, last_error = null, updated_at = now() WHERE id = $4",
    [primary.dnsRecordId, primary.hostname, primaryRoute.serviceUrl, storeId]
  );
}

export async function reconfigureStore(
  storeId: string,
  removedDnsRecordIds: string[] = [],
  removedWafRoutes: Array<{ hostname: string; path: string; rulesetId: string | null }> = []
): Promise<boolean> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.store_code, s.tunnel_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [storeId]
  );
  const store = result.rows[0] as StoreConnectivity | undefined;
  if (!store) throw new Error("Store not found");
  if (!store.tunnel_id) return false;
  if (store.provider_mode === "live" && (!store.cf_zone_id || !store.api_token_encrypted)) {
    throw new Error("Cloudflare account or zone is not fully configured");
  }
  const publications = await loadPublications(storeId);
  if (publications.length === 0) throw new Error("Store has no published endpoints");
  const client = cloudflareClient(store);
  try {
    for (const route of removedWafRoutes) {
      await client.configureRouteWaf({
        zoneId: store.cf_zone_id ?? "mock-zone",
        hostname: route.hostname,
        path: route.path,
        enabled: false,
        allowedIps: [],
        rulesetId: route.rulesetId
      });
    }
    await applyConnectivity(storeId, store, client, store.tunnel_id, publications);
    for (const recordId of removedDnsRecordIds) {
      await client.deleteDnsRecord(store.cf_zone_id ?? "mock-zone", recordId);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connectivity update failed";
    await pool.query(
      "UPDATE store_publications SET status = 'failed', last_error = $1, updated_at = now() WHERE store_id = $2",
      [message, storeId]
    );
    await pool.query("UPDATE stores SET last_error = $1, updated_at = now() WHERE id = $2", [message, storeId]);
    throw error;
  }
}

/**
 * Remove every Cloudflare resource owned by a store while retaining the
 * connectivity definitions in Postgres for a future enrollment.
 *
 * Every delete is idempotent in CloudflareClient (404 is ignored). We still
 * attempt all resources after an individual failure so a missing permission
 * on one API family cannot hide DNS/tunnel resources that can be removed.
 */
export async function withStoreCloudflareLock<T>(storeId: string, operation: (lockClient: PoolClient) => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  const lockKey = `cloudflare-man:cloudflare-store:${storeId}`;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    return await operation(lockClient);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    lockClient.release();
  }
}

export async function deprovisionStore(
  storeId: string,
  reason: "unenroll" | "override" | "delete" = "unenroll",
  lockClient?: PoolClient
): Promise<void> {
  if (!lockClient) {
    return withStoreCloudflareLock(storeId, (client) => deprovisionStore(storeId, reason, client));
  }
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.store_code, s.tunnel_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id,
            s.rdp_route_id AS "rdpRouteId", s.rdp_target_id AS "rdpTargetId", s.rdp_vnet_id AS "rdpVnetId"
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [storeId]
  );
  const store = result.rows[0] as DeprovisionStore | undefined;
  if (!store) throw new Error("Store not found");

  const publicationResult = await pool.query(
    `SELECT p.id, p.dns_record_id AS "dnsRecordId", p.hostname,
            r.id AS route_id, r.path, r.waf_ruleset_id AS "wafRulesetId", r.waf_rule_id AS "wafRuleId"
       FROM store_publications p
       LEFT JOIN store_routes r ON r.publication_id = p.id
      WHERE p.store_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [storeId]
  );
  store.publications = [];
  store.routes = [];
  const publicationById = new Map<string, { id: string; dnsRecordId: string | null }>();
  for (const row of publicationResult.rows) {
    let publication = publicationById.get(row.id);
    if (!publication) {
      publication = { id: row.id, dnsRecordId: row.dnsRecordId };
      publicationById.set(row.id, publication);
      store.publications.push(publication);
    }
    if (row.route_id) {
      store.routes.push({
        id: row.route_id,
        hostname: row.hostname,
        path: row.path,
        wafRulesetId: row.wafRulesetId,
        wafRuleId: row.wafRuleId
      });
    }
  }

  const client = cloudflareClient(store);
  const failures: string[] = [];
  const attempt = async (label: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const zoneId = store.cf_zone_id ?? "mock-zone";
  for (const route of store.routes) {
    if (!route.wafRuleId) continue;
    if (!store.cf_zone_id && store.provider_mode === "live") {
      failures.push(`WAF ${route.hostname}${route.path}: Cloudflare zone ID is missing`);
      continue;
    }
    await attempt(`WAF ${route.hostname}${route.path}`, () => client.configureRouteWaf({
      zoneId,
      hostname: route.hostname,
      path: route.path,
      enabled: false,
      allowedIps: [],
      rulesetId: route.wafRulesetId
    }));
  }

  const deletedDnsRecords = new Set<string>();
  for (const publication of store.publications) {
    if (!publication.dnsRecordId || deletedDnsRecords.has(publication.dnsRecordId)) continue;
    deletedDnsRecords.add(publication.dnsRecordId);
    if (!store.cf_zone_id && store.provider_mode === "live") {
      failures.push(`DNS ${publication.dnsRecordId}: Cloudflare zone ID is missing`);
      continue;
    }
    await attempt(`DNS ${publication.dnsRecordId}`, () => client.deleteDnsRecord(zoneId, publication.dnsRecordId!));
  }
  if (store.rdpRouteId) await attempt(`RDP route ${store.rdpRouteId}`, () => client.deleteTunnelRoute(store.rdpRouteId!));
  if (store.rdpTargetId) await attempt(`RDP target ${store.rdpTargetId}`, () => client.deleteInfrastructureTarget(store.rdpTargetId!));
  if (store.rdpVnetId) await attempt(`RDP virtual network ${store.rdpVnetId}`, () => client.deleteVirtualNetwork(store.rdpVnetId!));
  if (store.tunnel_id) {
    await attempt(`Tunnel connections ${store.tunnel_id}`, () => client.deleteTunnelConnections(store.tunnel_id!));
    await attempt(`Tunnel ${store.tunnel_id}`, () => client.deleteTunnel(store.tunnel_id!));
  }

  if (failures.length) {
    const message = `Cloudflare cleanup failed during ${reason}: ${failures.join("; ")}`;
    await pool.query("UPDATE stores SET last_error = $1, updated_at = now() WHERE id = $2", [message, storeId]);
    throw new Error(message);
  }

  await withTransaction(async (database) => {
    await database.query(
      `UPDATE store_publications
          SET dns_record_id = null, status = 'pending', last_error = null, updated_at = now()
        WHERE store_id = $1`,
      [storeId]
    );
    await database.query(
      `UPDATE store_routes r
          SET waf_ruleset_id = null, waf_rule_id = null, updated_at = now()
        FROM store_publications p
        WHERE r.publication_id = p.id AND p.store_id = $1`,
      [storeId]
    );
    await database.query(
      `UPDATE stores
          SET tunnel_id = null, tunnel_name = null, dns_record_id = null,
              tunnel_status = 'not_created', rdp_status = 'pending',
              rdp_target_ip = null, rdp_target_hostname = null,
              rdp_vnet_id = null, rdp_route_id = null, rdp_target_id = null,
              rdp_url = null, rdp_last_error = null, last_error = null, updated_at = now()
        WHERE id = $1`,
      [storeId]
    );
    await database.query(
      `UPDATE store_command_agents
          SET status = 'pending', last_error = null, updated_at = now()
        WHERE store_id = $1`,
      [storeId]
    );
    await writeAudit({
      action: "store.cloudflare_deprovisioned",
      entityType: "store",
      entityId: storeId,
      details: {
        reason,
        tunnelId: store.tunnel_id,
        dnsRecordCount: deletedDnsRecords.size,
        routeCount: store.routes.length,
        rdpResources: [store.rdpRouteId, store.rdpTargetId, store.rdpVnetId].filter(Boolean).length
      }
    }, database);
  });
}

export async function provisionStore(storeId: string): Promise<ProvisioningResult> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.store_code, s.origin_url, s.hostname, s.tunnel_id, s.dns_record_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [storeId]
  );
  const store = result.rows[0] as StoreConnectivity | undefined;
  if (!store) throw new Error("Store not found");
  if (store.provider_mode === "live" && (!store.cf_zone_id || !store.api_token_encrypted)) {
    throw new Error("Cloudflare account or zone is not fully configured");
  }

  const client = cloudflareClient(store);
  const publications = await loadPublications(storeId);
  if (publications.length === 0) throw new Error("Store has no published endpoints");

  await pool.query(
    "UPDATE stores SET onboarding_status = 'provisioning', last_error = null, updated_at = now() WHERE id = $1",
    [storeId]
  );

  try {
    let tunnelId = store.tunnel_id as string | null;
    let tunnelToken: string;
    if (!tunnelId) {
      const tunnelName = slugifyLabel(`dcorp-${store.tenant_code}-${store.store_code}-${store.id.slice(0, 8)}`);
      const tunnel = await client.ensureTunnel(tunnelName);
      tunnelId = tunnel.id;
      tunnelToken = tunnel.token ?? await client.getTunnelToken(tunnel.id);
      await pool.query(
        `UPDATE stores SET tunnel_id = $1, tunnel_name = $2, tunnel_status = 'inactive', updated_at = now()
         WHERE id = $3`,
        [tunnel.id, tunnelName, storeId]
      );
    } else {
      tunnelToken = await client.getTunnelToken(tunnelId);
    }

    await applyConnectivity(storeId, store, client, tunnelId, publications);

    await pool.query(
      `UPDATE stores SET onboarding_status = 'claimed', last_error = null, updated_at = now() WHERE id = $1`,
      [storeId]
    );
    await writeAudit({
      action: "store.provisioned",
      entityType: "store",
      entityId: storeId,
      details: {
        tunnelId,
        hostnames: publications.map((publication) => publication.hostname),
        routeCount: publications.reduce((total, publication) => total + publication.routes.length, 0),
        providerMode: store.provider_mode
      }
    });
    return { tunnelToken, tunnelId, hostname: publications[0]!.hostname, providerMode: store.provider_mode };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Store provisioning failed";
    await pool.query(
      "UPDATE store_publications SET status = 'failed', last_error = $1, updated_at = now() WHERE store_id = $2",
      [message, storeId]
    );
    await pool.query(
      "UPDATE stores SET onboarding_status = 'failed', last_error = $1, updated_at = now() WHERE id = $2",
      [message, storeId]
    );
    throw error;
  }
}
