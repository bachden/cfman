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
  cf_tunnel_id: string;
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

  async configureRouteWaf(input: {
    zoneId: string;
    hostname: string;
    path: string;
    enabled: boolean;
    allowedIps: string[];
    rulesetId?: string | null;
  }): Promise<{ rulesetId: string | null; ruleId: string | null }> {
    const description = `cfman route WAF: ${input.hostname}${input.path}`;
    if (this.mode === "mock") {
      return input.enabled
        ? { rulesetId: input.rulesetId ?? randomUUID(), ruleId: randomUUID() }
        : { rulesetId: input.rulesetId ?? null, ruleId: null };
    }

    let ruleset: CloudflareRuleset | undefined;
    if (input.rulesetId) {
      try {
        const candidate = await this.request<CloudflareRuleset>(`/zones/${input.zoneId}/rulesets/${input.rulesetId}`);
        if (candidate.kind === "zone" && candidate.phase === "http_request_firewall_custom") ruleset = candidate;
      } catch (error) {
        if (!input.enabled && (error as Error & { status?: number }).status === 404) {
          return { rulesetId: null, ruleId: null };
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
    const existingRules = (ruleset?.rules ?? []).filter((rule) => rule.description !== description);
    if (input.enabled) {
      const escapedHostname = input.hostname.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const escapedPath = input.path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const pathExpression = input.path === "/"
        ? `http.request.uri.path eq "${escapedPath}"`
        : `(http.request.uri.path eq "${escapedPath}" or starts_with(http.request.uri.path, "${escapedPath}/"))`;
      const sourceExpression = input.allowedIps.length ? `not ip.src in { ${input.allowedIps.join(" ")} }` : "true";
      existingRules.push({
        action: "block",
        expression: `(http.host eq "${escapedHostname}" and ${pathExpression} and ${sourceExpression})`,
        description,
        enabled: true
      });
    }
    if (!ruleset && !input.enabled) return { rulesetId: null, ruleId: null };
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
    const managedRule = (ruleset.rules ?? []).find((rule) => rule.description === description);
    return { rulesetId: ruleset.id, ruleId: managedRule?.id ?? null };
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
      return { id: randomUUID(), network: `${targetIp}/32`, cf_tunnel_id: cfTunnelId, virtual_network_id: virtualNetworkId };
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
      if (existing.cf_tunnel_id !== cfTunnelId) throw new Error(`RDP route ${network} is assigned to another tunnel`);
      return existing;
    }
    return this.request<CloudflareTunnelRoute>(`/accounts/${this.accountId}/teamnet/routes`, {
      method: "POST",
      body: JSON.stringify({
        network,
        cf_tunnel_id: cfTunnelId,
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
}
