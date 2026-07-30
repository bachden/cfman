import { randomUUID } from "node:crypto";

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  result_info?: { page: number; total_pages: number };
};

export type CloudflareZone = {
  id: string;
  name: string;
  status: string;
};

export type CfTunnelStatus = "inactive" | "healthy" | "degraded" | "down";

export type CloudflareTunnel = {
  id: string;
  name: string;
  status?: CfTunnelStatus;
  token?: string;
  conns_active_at?: string;
};

type CloudflareDnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
};

export type CloudflareVirtualNetwork = {
  id: string;
  name: string;
  is_default_network?: boolean;
};

export type CloudflareTunnelRoute = {
  id: string;
  network: string;
  tunnel_id: string;
  virtual_network_id?: string;
};

export type CloudflareInfrastructureTarget = {
  id: string;
  hostname: string;
  ip: { ipv4?: { ip_addr: string; virtual_network_id?: string } };
};

export type CloudflareAccessPolicy = {
  id: string;
  name: string;
};

export type CloudflareAccessApplication = {
  id: string;
  name: string;
  domain: string;
  type: string;
};

export type CloudflareTokenVerification = {
  id: string;
  status: string;
  not_before?: string;
  expires_on?: string;
};

export type CloudflareIngressRule = {
  hostname: string;
  service: string;
  path?: string;
};

type CloudflareRulesetRule = {
  id?: string;
  action: string;
  expression: string;
  description?: string;
  enabled?: boolean;
};

type CloudflareRuleset = {
  id: string;
  name: string;
  kind?: string;
  phase?: string;
  rules?: CloudflareRulesetRule[];
};

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 250), 5_000);
  return Math.min(250 * 2 ** attempt, 5_000);
}

function statusOfTunnel(value: string | undefined): CfTunnelStatus {
  if (value === "healthy" || value === "degraded" || value === "down" || value === "inactive") return value;
  return "inactive";
}

export class CloudflareClient {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly mode: "live" | "mock"
  ) {}

  private async requestPage<T>(path: string, init?: RequestInit): Promise<CloudflareEnvelope<T>> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.apiToken}`);
    headers.set("Content-Type", "application/json");
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(20_000)
        });
      } catch (error) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 5_000)));
          continue;
        }
        throw error;
      }
      const payload = (await response.json().catch(() => ({}))) as CloudflareEnvelope<T>;
      if (response.ok && payload.success) return payload;
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      const message = payload.errors?.map((error) => error.message).join("; ") || `Cloudflare API returned ${response.status}`;
      const requestError = new Error(message) as Error & { status?: number };
      requestError.status = response.status;
      throw requestError;
    }
    throw new Error("Cloudflare request failed after retries");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const payload = await this.requestPage<T>(path, init);
    return payload.result;
  }

  private async listPages<T>(path: string, query: URLSearchParams): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      query.set("page", String(page));
      const payload = await this.requestPage<T[]>(`${path}?${query.toString()}`);
      values.push(...payload.result);
      if (!payload.result_info || page >= payload.result_info.total_pages) break;
    }
    return values;
  }

  async verifyAccount(): Promise<void> {
    if (this.mode === "mock") return;
    await this.request(`/accounts/${this.accountId}`);
  }

  async verifyToken(): Promise<CloudflareTokenVerification> {
    if (this.mode === "mock") return { id: randomUUID(), status: "active" };
    return this.request<CloudflareTokenVerification>(`/accounts/${this.accountId}/tokens/verify`);
  }

  async listZones(): Promise<CloudflareZone[]> {
    if (this.mode === "mock") return [];
    const query = new URLSearchParams({ "account.id": this.accountId, per_page: "50" });
    return this.listPages<CloudflareZone>("/zones", query);
  }

  async listTunnels(): Promise<CloudflareTunnel[]> {
    if (this.mode === "mock") return [];
    const query = new URLSearchParams({ is_deleted: "false", per_page: "1000" });
    const tunnels = await this.listPages<CloudflareTunnel>(`/accounts/${this.accountId}/cfd_tunnel`, query);
    return tunnels.map((tunnel) => ({ ...tunnel, status: statusOfTunnel(tunnel.status) }));
  }

  async createTunnel(name: string): Promise<CloudflareTunnel> {
    if (this.mode === "mock") {
      return { id: randomUUID(), name, status: "inactive", token: `mock-${randomUUID()}` };
    }
    return this.request<CloudflareTunnel>(`/accounts/${this.accountId}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name, config_src: "cloudflare" })
    });
  }

  async renameTunnel(cfTunnelId: string, name: string): Promise<CloudflareTunnel> {
    if (this.mode === "mock") return { id: cfTunnelId, name, status: "inactive" };
    return this.request<CloudflareTunnel>(`/accounts/${this.accountId}/cfd_tunnel/${cfTunnelId}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
  }

  async ensureTunnel(name: string): Promise<CloudflareTunnel> {
    if (this.mode === "mock") return this.createTunnel(name);
    const findExisting = async () => {
      const query = new URLSearchParams({ name, is_deleted: "false", per_page: "100" });
      const tunnels = await this.request<CloudflareTunnel[]>(`/accounts/${this.accountId}/cfd_tunnel?${query}`);
      return tunnels.find((tunnel) => tunnel.name === name);
    };
    const existing = await findExisting();
    if (existing) return existing;
    try {
      return await this.createTunnel(name);
    } catch (error) {
      // Recover when another retry created the tunnel after the initial lookup.
      const raced = await findExisting().catch(() => undefined);
      if (raced) return raced;
      throw error;
    }
  }

  async getTunnelToken(cfTunnelId: string): Promise<string> {
    if (this.mode === "mock") return `mock-${cfTunnelId}`;
    return this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${cfTunnelId}/token`);
  }

  async configureTunnel(cfTunnelId: string, ingress: CloudflareIngressRule[]): Promise<void> {
    if (this.mode === "mock") return;
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${cfTunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({
        config: {
          "warp-routing": { enabled: true },
          ingress: [
            ...ingress,
            { service: "http_status:404" }
          ]
        }
      })
    });
  }

  // All of cfman's WAF-protected routes in a zone are folded into as few
  // Cloudflare custom rules as possible - a "rule pool" - instead of one rule
  // per route. Two independent Cloudflare limits are in play on
  // http_request_firewall_custom: a cap on the number of custom rules per
  // zone (5 on Free, higher on paid plans) and a 4096-character cap on a
  // single rule's expression. We control the second one precisely (we build
  // the expression text), so routes are bin-packed into rules that each stay
  // under that limit, maximizing how many routes share one rule slot. The
  // first limit is plan-dependent and only discoverable by Cloudflare
  // rejecting the request; when that happens the caller (reconcileZoneWaf)
  // turns it into a "upgrade your Cloudflare plan" warning instead of an
  // opaque failure - packing tighter only delays that ceiling, it can't
  // remove it.
  static readonly ZONE_WAF_DESCRIPTION = "cfman managed WAF";
  static readonly MAX_RULE_EXPRESSION_LENGTH = 4096;

  private poolRuleDescription(poolIndex: number): string {
    return `${CloudflareClient.ZONE_WAF_DESCRIPTION} #${poolIndex + 1}`;
  }

  private isPoolRuleDescription(description: string | undefined): boolean {
    return description?.startsWith(CloudflareClient.ZONE_WAF_DESCRIPTION) ?? false;
  }

  // Greedily bin-packs each route's condition into the current pool rule
  // until adding one more would push that rule's expression past the
  // character cap, then starts a new rule. Returns groups of route indices,
  // one group per pool rule, in the order rules should be created.
  private packRouteConditions(conditions: string[]): number[][] {
    const groups: number[][] = [];
    let currentGroup: number[] = [];
    let currentLength = 0;
    const separatorLength = " or ".length;
    conditions.forEach((condition, index) => {
      const additionalLength = currentGroup.length ? condition.length + separatorLength : condition.length;
      if (currentGroup.length && currentLength + additionalLength > CloudflareClient.MAX_RULE_EXPRESSION_LENGTH) {
        groups.push(currentGroup);
        currentGroup = [index];
        currentLength = condition.length;
      } else {
        currentGroup.push(index);
        currentLength += additionalLength;
      }
    });
    if (currentGroup.length) groups.push(currentGroup);
    return groups;
  }

  async configureZoneWaf(input: {
    zoneId: string;
    routes: Array<{ hostname: string; path: string; allowedIps: string[] }>;
    rulesetId?: string | null;
  }): Promise<{ rulesetId: string | null; ruleIds: Array<string | null> }> {
    const enabled = input.routes.length > 0;
    if (this.mode === "mock") {
      if (!enabled) return { rulesetId: input.rulesetId ?? null, ruleIds: [] };
      return { rulesetId: input.rulesetId ?? randomUUID(), ruleIds: input.routes.map(() => randomUUID()) };
    }

    let ruleset: CloudflareRuleset | undefined;
    if (input.rulesetId) {
      try {
        const candidate = await this.request<CloudflareRuleset>(`/zones/${input.zoneId}/rulesets/${input.rulesetId}`);
        if (candidate.kind === "zone" && candidate.phase === "http_request_firewall_custom") ruleset = candidate;
      } catch (error) {
        if (!enabled && (error as Error & { status?: number }).status === 404) {
          return { rulesetId: null, ruleIds: [] };
        }
        throw error;
      }
    }
    if (!ruleset) {
      const summaries = await this.request<CloudflareRuleset[]>(
        `/zones/${input.zoneId}/rulesets?${new URLSearchParams({ per_page: "50" }).toString()}`
      );
      const entrypoint = summaries.find((candidate) => candidate.kind === "zone" && candidate.phase === "http_request_firewall_custom");
      if (entrypoint) {
        ruleset = await this.request<CloudflareRuleset>(`/zones/${input.zoneId}/rulesets/${entrypoint.id}`);
      }
    }
    const existingRules = (ruleset?.rules ?? []).filter((rule) => !this.isPoolRuleDescription(rule.description));
    let groups: number[][] = [];
    if (enabled) {
      const conditions = input.routes.map((route) => {
        const escapedHostname = route.hostname.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const escapedPath = route.path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const pathExpression = route.path === "/"
          ? `http.request.uri.path eq "${escapedPath}"`
          : `(http.request.uri.path eq "${escapedPath}" or starts_with(http.request.uri.path, "${escapedPath}/"))`;
        const sourceExpression = route.allowedIps.length ? `not ip.src in { ${route.allowedIps.join(" ")} }` : "true";
        return `(http.host eq "${escapedHostname}" and ${pathExpression} and ${sourceExpression})`;
      });
      groups = this.packRouteConditions(conditions);
      groups.forEach((group, poolIndex) => {
        existingRules.push({
          action: "block",
          expression: group.map((index) => conditions[index]).join(" or "),
          description: this.poolRuleDescription(poolIndex),
          enabled: true
        });
      });
    }
    if (!ruleset && !enabled) return { rulesetId: null, ruleIds: [] };
    if (!ruleset) {
      ruleset = await this.request<CloudflareRuleset>(`/zones/${input.zoneId}/rulesets`, {
        method: "POST",
        body: JSON.stringify({
          name: "zone",
          description: "Zone-level phase entry point",
          kind: "zone",
          phase: "http_request_firewall_custom",
          rules: existingRules
        })
      });
    } else {
      ruleset = await this.request<CloudflareRuleset>(`/zones/${input.zoneId}/rulesets/${ruleset.id}`, {
        method: "PUT",
        body: JSON.stringify({
          description: ruleset.name === "zone" ? "Zone-level phase entry point" : undefined,
          rules: existingRules
        })
      });
    }
    const ruleIdByDescription = new Map((ruleset.rules ?? []).map((rule) => [rule.description, rule.id]));
    const ruleIds = new Array<string | null>(input.routes.length).fill(null);
    groups.forEach((group, poolIndex) => {
      const ruleId = ruleIdByDescription.get(this.poolRuleDescription(poolIndex)) ?? null;
      for (const routeIndex of group) ruleIds[routeIndex] = ruleId;
    });
    return { rulesetId: ruleset.id, ruleIds };
  }

  async createDnsRecord(zoneId: string, hostname: string, cfTunnelId: string): Promise<{ id: string }> {
    if (this.mode === "mock") return { id: randomUUID() };
    return this.upsertDnsRecord(zoneId, hostname, "CNAME", `${cfTunnelId}.cfargotunnel.com`);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.deleteResource(`/zones/${zoneId}/dns_records/${recordId}`);
  }

  async deleteTunnelConnections(cfTunnelId: string): Promise<void> {
    await this.deleteResource(`/accounts/${this.accountId}/cfd_tunnel/${cfTunnelId}/connections`);
  }

  async deleteTunnel(cfTunnelId: string): Promise<void> {
    await this.deleteResource(`/accounts/${this.accountId}/cfd_tunnel/${cfTunnelId}`);
  }

  async deleteTunnelRoute(routeId: string): Promise<void> {
    await this.deleteResource(`/accounts/${this.accountId}/teamnet/routes/${routeId}`);
  }

  async deleteInfrastructureTarget(targetId: string): Promise<void> {
    await this.deleteResource(`/accounts/${this.accountId}/infrastructure/targets/${targetId}`);
  }

  async deleteVirtualNetwork(networkId: string): Promise<void> {
    await this.deleteResource(`/accounts/${this.accountId}/teamnet/virtual_networks/${networkId}`);
  }

  async deleteAccessApplication(applicationId: string): Promise<void> {
    await this.deleteResource(`/accounts/${this.accountId}/access/apps/${applicationId}`);
  }

  async ensureBrowserRdpDnsRecord(zoneId: string, hostname: string): Promise<{ id: string }> {
    if (this.mode === "mock") return { id: randomUUID() };
    return this.upsertDnsRecord(zoneId, hostname, "A", "240.0.0.0");
  }

  private async upsertDnsRecord(zoneId: string, hostname: string, type: "A" | "CNAME", content: string): Promise<{ id: string }> {
    const existing = await this.request<CloudflareDnsRecord[]>(
      `/zones/${zoneId}/dns_records?${new URLSearchParams({ name: hostname, per_page: "100" }).toString()}`
    );
    const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();
    const record = existing.find((candidate) => normalizeName(candidate.name) === normalizeName(hostname));
    const body = {
      type,
      name: hostname,
      content,
      proxied: true,
      ttl: 1,
      comment: "Managed by cfman"
    };
    if (record && record.type !== type) {
      throw new Error(`DNS record ${hostname} already exists as ${record.type}`);
    }
    // Accepts the pre-rename comment too: records created before the
    // cloudflare-man -> cfman rename still carry the old marker in
    // Cloudflare, and this check must keep recognizing them as ours.
    if (record && record.content !== content && record.comment !== "Managed by cfman" && record.comment !== "Managed by cloudflare-man") {
      throw new Error(`DNS record ${hostname} already exists and is not managed by cfman`);
    }
    if (record) {
      return this.request<{ id: string }>(`/zones/${zoneId}/dns_records/${record.id}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    }
    return this.request<{ id: string }>(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  private async deleteResource(path: string): Promise<void> {
    if (this.mode === "mock") return;
    try {
      await this.requestPage<unknown>(path, { method: "DELETE" });
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) return;
      throw error;
    }
  }

  async ensureVirtualNetwork(name: string): Promise<CloudflareVirtualNetwork> {
    if (this.mode === "mock") return { id: randomUUID(), name };
    const query = new URLSearchParams({ name, is_deleted: "false" });
    const existing = await this.request<CloudflareVirtualNetwork[]>(
      `/accounts/${this.accountId}/teamnet/virtual_networks?${query.toString()}`
    );
    const match = existing.find((network) => network.name === name);
    if (match) return match;
    return this.request<CloudflareVirtualNetwork>(`/accounts/${this.accountId}/teamnet/virtual_networks`, {
      method: "POST",
      body: JSON.stringify({ name, comment: "Managed by cfman", is_default_network: false })
    });
  }

  async ensureTunnelRoute(cfTunnelId: string, virtualNetworkId: string, targetIp: string): Promise<CloudflareTunnelRoute> {
    if (this.mode === "mock") {
      return { id: randomUUID(), network: `${targetIp}/32`, tunnel_id: cfTunnelId, virtual_network_id: virtualNetworkId };
    }
    const network = `${targetIp}/32`;
    const query = new URLSearchParams({
      network_subset: network,
      network_superset: network,
      virtual_network_id: virtualNetworkId,
      is_deleted: "false",
      per_page: "100"
    });
    const routes = await this.request<CloudflareTunnelRoute[]>(
      `/accounts/${this.accountId}/teamnet/routes?${query.toString()}`
    );
    const existing = routes.find((route) => route.network === network && route.virtual_network_id === virtualNetworkId);
    if (existing) {
      if (existing.tunnel_id !== cfTunnelId) throw new Error(`RDP route ${network} is assigned to another tunnel`);
      return existing;
    }
    // Cloudflare's Tunnel Routes API (POST /accounts/{account}/teamnet/routes)
    // requires the field named `tunnel_id` - not `cf_tunnel_id`, which is only
    // this codebase's own column/variable naming convention for a Cloudflare
    // tunnel id. Sending the wrong key here previously produced a 400 from
    // Cloudflare: "Json deserialize error: missing field `tunnel_id`".
    return this.request<CloudflareTunnelRoute>(`/accounts/${this.accountId}/teamnet/routes`, {
      method: "POST",
      body: JSON.stringify({
        network,
        tunnel_id: cfTunnelId,
        virtual_network_id: virtualNetworkId,
        comment: "Managed by cfman"
      })
    });
  }

  async ensureInfrastructureTarget(
    hostname: string,
    targetIp: string,
    virtualNetworkId: string
  ): Promise<CloudflareInfrastructureTarget> {
    if (this.mode === "mock") {
      return { id: randomUUID(), hostname, ip: { ipv4: { ip_addr: targetIp, virtual_network_id: virtualNetworkId } } };
    }
    const query = new URLSearchParams({
      hostname,
      ip_v4: targetIp,
      virtual_network_id: virtualNetworkId,
      per_page: "1000"
    });
    const targets = await this.request<CloudflareInfrastructureTarget[]>(
      `/accounts/${this.accountId}/infrastructure/targets?${query.toString()}`
    );
    const existing = targets.find((target) =>
      target.hostname === hostname &&
      target.ip.ipv4?.ip_addr === targetIp &&
      target.ip.ipv4?.virtual_network_id === virtualNetworkId
    );
    if (existing) return existing;
    return this.request<CloudflareInfrastructureTarget>(`/accounts/${this.accountId}/infrastructure/targets`, {
      method: "POST",
      body: JSON.stringify({
        hostname,
        ip: { ipv4: { ip_addr: targetIp, virtual_network_id: virtualNetworkId } }
      })
    });
  }

  async ensureRdpAccessPolicy(existingId: string | null, allowedEmails: string[]): Promise<CloudflareAccessPolicy> {
    if (this.mode === "mock") return { id: existingId ?? randomUUID(), name: "cfman RDP operators" };
    const name = "cfman RDP operators";
    const body = {
      name,
      decision: "allow",
      include: allowedEmails.map((email) => ({ email: { email } })),
      session_duration: "8h",
      connection_rules: {
        rdp: {
          allowed_clipboard_local_to_remote_formats: ["text"],
          allowed_clipboard_remote_to_local_formats: ["text"]
        }
      }
    };
    let policyId = existingId;
    if (!policyId) {
      const policies = await this.listPages<CloudflareAccessPolicy>(
        `/accounts/${this.accountId}/access/policies`,
        new URLSearchParams({ per_page: "100" })
      );
      policyId = policies.find((policy) => policy.name === name)?.id ?? null;
    }
    if (policyId) {
      return this.request<CloudflareAccessPolicy>(`/accounts/${this.accountId}/access/policies/${policyId}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    }
    return this.request<CloudflareAccessPolicy>(`/accounts/${this.accountId}/access/policies`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async ensureBrowserRdpApplication(input: {
    existingId: string | null;
    name: string;
    domain: string;
    policyId: string;
    targetHostnames: string[];
  }): Promise<CloudflareAccessApplication> {
    if (this.mode === "mock") {
      return { id: input.existingId ?? randomUUID(), name: input.name, domain: input.domain, type: "rdp" };
    }
    const body = {
      name: input.name,
      type: "rdp",
      domain: input.domain,
      destinations: [{ type: "public", uri: input.domain }],
      target_criteria: [{
        target_attributes: { hostname: input.targetHostnames },
        port: 3389,
        protocol: "RDP"
      }],
      policies: [{ id: input.policyId, precedence: 1 }],
      session_duration: "8h",
      app_launcher_visible: true
    };
    let applicationId = input.existingId;
    if (!applicationId) {
      const query = new URLSearchParams({ domain: input.domain, exact: "true", per_page: "50" });
      const applications = await this.request<CloudflareAccessApplication[]>(
        `/accounts/${this.accountId}/access/apps?${query.toString()}`
      );
      applicationId = applications.find((application) => application.type === "rdp" && application.domain === input.domain)?.id ?? null;
    }
    if (applicationId) {
      return this.request<CloudflareAccessApplication>(`/accounts/${this.accountId}/access/apps/${applicationId}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    }
    return this.request<CloudflareAccessApplication>(`/accounts/${this.accountId}/access/apps`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async ensureSshAccessPolicy(existingId: string | null, allowedEmails: string[], usernames: string[]): Promise<CloudflareAccessPolicy> {
    if (this.mode === "mock") return { id: existingId ?? randomUUID(), name: "cfman SSH operators" };
    const name = "cfman SSH operators";
    const body = {
      name,
      decision: "allow",
      include: allowedEmails.map((email) => ({ email: { email } })),
      session_duration: "8h",
      connection_rules: {
        ssh: {
          usernames,
          allow_email_alias: true
        }
      }
    };
    let policyId = existingId;
    if (!policyId) {
      const policies = await this.listPages<CloudflareAccessPolicy>(
        `/accounts/${this.accountId}/access/policies`,
        new URLSearchParams({ per_page: "100" })
      );
      policyId = policies.find((policy) => policy.name === name)?.id ?? null;
    }
    if (policyId) {
      return this.request<CloudflareAccessPolicy>(`/accounts/${this.accountId}/access/policies/${policyId}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    }
    return this.request<CloudflareAccessPolicy>(`/accounts/${this.accountId}/access/policies`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async ensureBrowserSshApplication(input: {
    existingId: string | null;
    name: string;
    domain: string;
    policyId: string;
  }): Promise<CloudflareAccessApplication> {
    if (this.mode === "mock") {
      return { id: input.existingId ?? randomUUID(), name: input.name, domain: input.domain, type: "ssh" };
    }
    // Unlike "rdp" applications, "ssh" applications reject any target-binding
    // field at all - both `target_criteria` ("target contexts are not
    // available for ssh applications") and a private `destinations` entry
    // ("private destinations are not supported for ssh apps"), confirmed
    // live against a real account. The only way Cloudflare can tell which
    // backend to proxy to is for `domain` to already be a real hostname with
    // a working tunnel ingress behind it - so this must be the tunnel's own
    // ssh:// ingress hostname (see ensureSshIngressRoute), never a shared
    // zone-wide placeholder domain the way the RDP flow uses one.
    const body = {
      name: input.name,
      type: "ssh",
      domain: input.domain,
      destinations: [{ type: "public", uri: input.domain }],
      policies: [{ id: input.policyId, precedence: 1 }],
      session_duration: "8h",
      app_launcher_visible: true
    };
    let applicationId = input.existingId;
    if (!applicationId) {
      const query = new URLSearchParams({ domain: input.domain, exact: "true", per_page: "50" });
      const applications = await this.request<CloudflareAccessApplication[]>(
        `/accounts/${this.accountId}/access/apps?${query.toString()}`
      );
      applicationId = applications.find((application) => application.type === "ssh" && application.domain === input.domain)?.id ?? null;
    }
    if (applicationId) {
      return this.request<CloudflareAccessApplication>(`/accounts/${this.accountId}/access/apps/${applicationId}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    }
    return this.request<CloudflareAccessApplication>(`/accounts/${this.accountId}/access/apps`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }
}
