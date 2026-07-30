import { lookup as systemLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Resolver } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, setGlobalDispatcher } from "undici";

export type EndpointCheck = {
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  attempts: number;
  error?: string;
};

type CheckOptions = {
  path?: string | undefined;
  attempts?: number | undefined;
  retryDelayMs?: number | undefined;
  timeoutMs?: number | undefined;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The OS resolver on this network has repeatedly served a stale "doesn't
// exist" answer for several minutes after cfman creates a brand-new
// Cloudflare DNS record - confirmed twice by a freshly provisioned browser
// SSH/RDP gateway failing with a bare "fetch failed" even though the record
// already resolved correctly everywhere else (dig against 1.1.1.1 directly).
// Public resolvers don't share whatever cache is doing that, so these
// health checks resolve the hostname there first and only fall back to the
// system resolver if that fails - never making a working check worse.
const publicDnsLookup: LookupFunction = (hostname, options, callback) => {
  const wantsAll = typeof options === "object" && options !== null && (options as LookupOptions).all === true;
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  resolver.resolve4(hostname)
    .then((addresses) => {
      if (!addresses.length) throw new Error("No A records from public DNS");
      if (wantsAll) callback(null, addresses.map((address): LookupAddress => ({ address, family: 4 })));
      else callback(null, addresses[0]!, 4);
    })
    .catch(() => systemLookup(hostname, options, callback));
};

// Node's global fetch() dispatches through undici's global dispatcher by
// default, so swapping that dispatcher for one with a custom DNS lookup is
// enough to fix every fetch() call in the process (not just these three) -
// no call site needs to change, and tests that monkey-patch globalThis.fetch
// still work exactly as before since this only affects real network calls.
setGlobalDispatcher(new Agent({ connect: { lookup: publicDnsLookup } }));

export async function checkTunnelEndpoint(hostname: string, options: CheckOptions = {}): Promise<EndpointCheck> {
  const startedAt = Date.now();
  const attempts = Math.max(1, options.attempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  let lastError = "Endpoint check failed";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const path = options.path?.startsWith("/") ? options.path : `/${options.path ?? ""}`;
      const response = await fetch(`https://${hostname}${path}`, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "*/*", "User-Agent": "cfman-monitor/0.1" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatus = response.status;
      if (response.status < 500) {
        return {
          reachable: true,
          statusCode: response.status,
          latencyMs: Date.now() - startedAt,
          attempts: attempt
        };
      }
      lastError = `Endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Endpoint check failed";
      lastStatus = null;
      if (attempt < attempts && retryDelayMs > 0) await wait(retryDelayMs);
    }
  }

  return {
    reachable: false,
    statusCode: lastStatus,
    latencyMs: Date.now() - startedAt,
    attempts,
    error: lastError
  };
}

export async function checkBrowserRdpGateway(rdpUrl: string, options: CheckOptions = {}): Promise<EndpointCheck> {
  const startedAt = Date.now();
  const attempts = Math.max(1, options.attempts ?? 4);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  let lastError = "Browser RDP gateway is not ready";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(rdpUrl, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "text/html", "User-Agent": "cfman-monitor/0.1" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 400) {
        return {
          reachable: true,
          statusCode: response.status,
          latencyMs: Date.now() - startedAt,
          attempts: attempt
        };
      }
      lastError = `Browser RDP gateway returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Browser RDP gateway check failed";
      lastStatus = null;
    }
    if (attempt < attempts && retryDelayMs > 0) await wait(retryDelayMs);
  }

  return {
    reachable: false,
    statusCode: lastStatus,
    latencyMs: Date.now() - startedAt,
    attempts,
    error: lastError
  };
}

// Confirmed live against a real account: an unauthenticated GET to a
// correctly provisioned browser-SSH gateway URL returns 403 (Cloudflare
// Access enforcing its login gate), not the 200-399/redirect-to-login range
// checkBrowserRdpGateway accepts for RDP. A 403 here is exactly the evidence
// we want - the Access application and domain are wired up and actively
// gating access - so it's treated as reachable rather than a failure.
export async function checkBrowserSshGateway(sshUrl: string, options: CheckOptions = {}): Promise<EndpointCheck> {
  const startedAt = Date.now();
  const attempts = Math.max(1, options.attempts ?? 4);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  let lastError = "Browser SSH gateway is not ready";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(sshUrl, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "text/html", "User-Agent": "cfman-monitor/0.1" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatus = response.status;
      if ((response.status >= 200 && response.status < 400) || response.status === 403) {
        return {
          reachable: true,
          statusCode: response.status,
          latencyMs: Date.now() - startedAt,
          attempts: attempt
        };
      }
      lastError = `Browser SSH gateway returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Browser SSH gateway check failed";
      lastStatus = null;
    }
    if (attempt < attempts && retryDelayMs > 0) await wait(retryDelayMs);
  }

  return {
    reachable: false,
    statusCode: lastStatus,
    latencyMs: Date.now() - startedAt,
    attempts,
    error: lastError
  };
}
