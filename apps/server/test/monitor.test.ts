import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBrowserRdpGateway, checkTunnelEndpoint } from "../src/lib/monitor.js";

test("retries a tunnel endpoint while Cloudflare provisioning settles", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await checkTunnelEndpoint("tunnel.example.com", { attempts: 2, retryDelayMs: 0 });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifies a route path and treats server errors as unreachable", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response("upstream failed", { status: 500 });
  };
  try {
    const result = await checkTunnelEndpoint("tunnel.example.com", { path: "/api/health", attempts: 1, retryDelayMs: 0 });
    assert.equal(requested[0], "https://tunnel.example.com/api/health");
    assert.equal(result.reachable, false);
    assert.equal(result.statusCode, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waits for a browser RDP hostname to become an Access endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("Error 1002", { status: 409 })
      : new Response(null, { status: 302, headers: { Location: "https://example.cloudflareaccess.com/login" } });
  };
  try {
    const result = await checkBrowserRdpGateway("https://rdp.example.com/rdp/vnet/ip/3389", {
      attempts: 2,
      retryDelayMs: 0
    });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 302);
    assert.equal(result.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
