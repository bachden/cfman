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
