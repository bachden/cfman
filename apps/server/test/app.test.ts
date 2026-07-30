import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let pool: (typeof import("../src/lib/database.js"))["pool"];
let sessionCookie = "";
let accountId = "";
let tunnelId = "";
let enrollmentToken = "";
let enrollmentId = "";
let commandAgentToken = "";
let scriptVersionId = "";
let mcpToken = "";

before(async () => {
  const database = await import("../src/lib/database.js");
  pool = database.pool;
  await database.runMigrations();
  await database.seedRootUser();
  await pool.query(`
    TRUNCATE audit_logs, tunnel_command_executions, managed_script_versions, managed_scripts, mcp_access, app_settings, enrollments, tunnels, zones, cloudflare_accounts, sessions RESTART IDENTITY CASCADE
  `);
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

test("default root account can sign in", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "root", password: "12345678" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.mustChangePassword, true);
  sessionCookie = response.headers["set-cookie"]!.split(";")[0]!;
});

test("updates the public base URL used by enrollment URLs", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: { cookie: sessionCookie },
    payload: { publicBaseUrl: "cfman.example.test" }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().settings.publicBaseUrl, "https://cfman.example.test");

  const allowedHost = await app.inject({ method: "GET", url: "/api/accounts", headers: { host: "cfman.example.test", cookie: sessionCookie } });
  assert.equal(allowedHost.statusCode, 200, allowedHost.body);
  const blockedHost = await app.inject({ method: "GET", url: "/api/accounts", headers: { host: "unexpected.example.test", cookie: sessionCookie } });
  assert.equal(blockedHost.statusCode, 421, blockedHost.body);
});

test("enables MCP and exposes structured tools with reusable identifiers", async () => {
  const initial = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie: sessionCookie } });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().settings.mcp.enabled, false);
  assert.equal(initial.json().settings.mcp.endpoint, "https://cfman.example.test/mcp");

  const enabled = await app.inject({
    method: "PATCH",
    url: "/api/settings/mcp",
    headers: { cookie: sessionCookie },
    payload: { enabled: true }
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().settings.enabled, true);
  mcpToken = enabled.json().token;
  assert.match(mcpToken, /^cfman_mcp_/);

  const unauthorized = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer invalid", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
  });
  assert.equal(unauthorized.statusCode, 401, unauthorized.body);

  const mcpRequest = (payload: unknown) => app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25"
    },
    payload
  });
  const initialized = await mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cfman-test", version: "1.0.0" } }
  });
  assert.equal(initialized.statusCode, 200, initialized.body);
  assert.equal(initialized.json().result.serverInfo.name, "cfman");

  const listed = await mcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_list_accounts"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_execute_inline_script"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_save_inline_execution_as_script"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_get_script_execution_history"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_delete_script"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_get_tunnel_execution_history"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_get_tunnel_enrollment_history"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_issue_tunnel_diagnostic"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_get_execution_logs"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_cancel_execution"));
  assert.ok(listed.json().result.tools.some((tool: { name: string }) => tool.name === "cfman_issue_unenrollment"));

  const created = await mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "cfman_create_account",
      arguments: { name: "MCP Follow-up Account", providerMode: "mock", initialZoneName: "mcp-follow-up.example" }
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const createdResult = created.json().result;
  assert.equal(createdResult.isError, undefined);
  const createdAccountId = createdResult.structuredContent.data.id as string;
  assert.deepEqual(createdResult.structuredContent.references, [{ path: "response.id", value: createdAccountId }]);

  const deleted = await mcpRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cfman_delete_account", arguments: { accountId: createdAccountId } } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json().result.structuredContent.data.success, true, JSON.stringify(deleted.json()));
  assert.deepEqual(deleted.json().result.structuredContent.references, [{ path: "input.accountId", value: createdAccountId }]);

  const called = await mcpRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cfman_get_tunnel", arguments: { tunnelId: "00000000-0000-4000-8000-000000000001" } } });
  assert.equal(called.statusCode, 200, called.body);
  const toolResult = called.json().result;
  assert.equal(toolResult.isError, true);
  assert.deepEqual(toolResult.structuredContent.references, [
    { path: "input.tunnelId", value: "00000000-0000-4000-8000-000000000001" }
  ]);
});

test("rotating or disabling MCP immediately invalidates its bearer token", async () => {
  const rotated = await app.inject({ method: "POST", url: "/api/settings/mcp/rotate", headers: { cookie: sessionCookie } });
  assert.equal(rotated.statusCode, 200, rotated.body);
  const rotatedToken = rotated.json().token as string;
  assert.notEqual(rotatedToken, mcpToken);

  const oldToken = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${mcpToken}`, accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }
  });
  assert.equal(oldToken.statusCode, 401, oldToken.body);

  const disabled = await app.inject({ method: "PATCH", url: "/api/settings/mcp", headers: { cookie: sessionCookie }, payload: { enabled: false } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  const disabledToken = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${rotatedToken}`, accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }
  });
  assert.equal(disabledToken.statusCode, 401, disabledToken.body);
});

test("creates a mock account with its first zone", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Test Account A",
      providerMode: "mock",
      initialZoneName: "tunnels-a.example",
      softTunnelLimit: 750
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  accountId = response.json().id;
  assert.match(accountId, /^[0-9a-f-]{36}$/);
});

test("deletes an empty account and its zones", async () => {
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/accounts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Disposable Account",
      providerMode: "mock",
      initialZoneName: "disposable.example",
      softTunnelLimit: 10
    }
  });
  assert.equal(createResponse.statusCode, 201, createResponse.body);
  const disposableAccountId = createResponse.json().id;

  const response = await app.inject({
    method: "DELETE",
    url: `/api/accounts/${disposableAccountId}`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.statusCode, 204, response.body);
  const account = await pool.query("SELECT 1 FROM cloudflare_accounts WHERE id = $1", [disposableAccountId]);
  const zones = await pool.query("SELECT 1 FROM zones WHERE account_id = $1", [disposableAccountId]);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'account.deleted' AND entity_id = $1", [disposableAccountId]);
  assert.equal(account.rowCount, 0);
  assert.equal(zones.rowCount, 0);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.cloudflareResourcesDeleted, false);
});

test("validates an account-owned Cloudflare API token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.cloudflare.com/client/v4/accounts/cloudflare-account-id/tokens/verify");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer cloudflare-api-token");
    return new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: { id: "token-id", status: "active" }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/validate-token",
      headers: { cookie: sessionCookie },
      payload: { cfAccountId: "cloudflare-account-id", apiToken: "cloudflare-api-token" }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { valid: true, status: "active" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("merges every WAF-protected route in a zone into a single Cloudflare rule", async () => {
  const { CloudflareClient } = await import("../src/lib/cloudflare.js");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.includes("/rulesets?") && method === "GET") {
      return Response.json({ success: true, result: [{ id: "entrypoint-id", name: "zone", kind: "zone", phase: "http_request_firewall_custom" }] });
    }
    if (url.endsWith("/rulesets/entrypoint-id") && method === "GET") {
      return Response.json({
        success: true,
        result: {
          id: "entrypoint-id",
          name: "zone",
          kind: "zone",
          phase: "http_request_firewall_custom",
          rules: [
            { id: "manual-rule", action: "block", expression: "ip.src eq 192.0.2.1", description: "Manual rule" },
            { id: "old-merged-rule", action: "block", expression: "(http.host eq \"stale.example.test\" and http.request.uri.path eq \"/\" and true)", description: "cfman managed WAF #1" }
          ]
        }
      });
    }
    if (url.endsWith("/rulesets/entrypoint-id") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { rules: Array<Record<string, unknown>> };
      return Response.json({
        success: true,
        result: {
          id: "entrypoint-id",
          name: "zone",
          kind: "zone",
          phase: "http_request_firewall_custom",
          rules: body.rules.map((rule, index) => ({ ...rule, id: String(rule.id ?? `created-${index}`) }))
        }
      });
    }
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  try {
    const client = new CloudflareClient("account-id", "api-token", "live");
    const result = await client.configureZoneWaf({
      zoneId: "zone-id",
      routes: [
        { hostname: "tunnel.example.test", path: "/api", allowedIps: ["203.0.113.10/32"] },
        { hostname: "other.example.test", path: "/", allowedIps: [] }
      ]
    });
    assert.equal(result.rulesetId, "entrypoint-id");
    assert.deepEqual(result.ruleIds, ["created-1", "created-1"]);
    const update = requests.find((request) => request.method === "PUT");
    assert.ok(update?.body);
    const rules = update.body.rules as Array<{ description: string; expression: string }>;
    // The unrelated manual rule is preserved untouched; the stale merged rule
    // is replaced (not duplicated alongside) by a single new rule covering
    // every currently WAF-protected route in the zone.
    assert.deepEqual(rules.map((rule) => rule.description), ["Manual rule", "cfman managed WAF #1"]);
    assert.match(rules[1]!.expression, /tunnel\.example\.test/);
    assert.match(rules[1]!.expression, /203\.0\.113\.10\/32/);
    assert.match(rules[1]!.expression, /other\.example\.test/);
    assert.match(rules[1]!.expression, / or /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("packs routes into multiple pool rules when the merged expression would exceed Cloudflare's per-rule character limit", async () => {
  const { CloudflareClient } = await import("../src/lib/cloudflare.js");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.includes("/rulesets?") && method === "GET") {
      return Response.json({ success: true, result: [{ id: "entrypoint-id", name: "zone", kind: "zone", phase: "http_request_firewall_custom" }] });
    }
    if (url.endsWith("/rulesets/entrypoint-id") && method === "GET") {
      return Response.json({ success: true, result: { id: "entrypoint-id", name: "zone", kind: "zone", phase: "http_request_firewall_custom", rules: [] } });
    }
    if (url.endsWith("/rulesets/entrypoint-id") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { rules: Array<Record<string, unknown>> };
      return Response.json({
        success: true,
        result: {
          id: "entrypoint-id",
          name: "zone",
          kind: "zone",
          phase: "http_request_firewall_custom",
          rules: body.rules.map((rule, index) => ({ ...rule, id: String(rule.id ?? `created-${index}`) }))
        }
      });
    }
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  try {
    const client = new CloudflareClient("account-id", "api-token", "live");
    // Each condition alone comfortably fits under the 4096-character limit,
    // but two of them together don't - CFMan must split across pool rules
    // instead of building one oversized expression.
    const bigAllowedIps = Array.from({ length: 210 }, (_, i) => `10.0.${i}.1/32`);
    const result = await client.configureZoneWaf({
      zoneId: "zone-id",
      routes: [
        { hostname: "big-one.example.test", path: "/", allowedIps: bigAllowedIps },
        { hostname: "big-two.example.test", path: "/", allowedIps: bigAllowedIps },
        { hostname: "small.example.test", path: "/", allowedIps: [] }
      ]
    });
    const update = requests.find((request) => request.method === "PUT");
    assert.ok(update?.body);
    const rules = update.body.rules as Array<{ description: string; expression: string }>;
    assert.ok(rules.length >= 2, `expected at least 2 pool rules, got ${rules.length}`);
    for (const rule of rules) assert.ok(rule.expression.length <= 4096, `rule expression exceeded 4096 chars: ${rule.expression.length}`);
    assert.deepEqual(rules.map((rule) => rule.description), rules.map((_, index) => `cfman managed WAF #${index + 1}`));
    assert.equal(result.ruleIds.length, 3);
    assert.notEqual(result.ruleIds[0], result.ruleIds[1]);
    assert.equal(result.ruleIds[1], result.ruleIds[2], "the small route should be packed alongside whichever pool rule still has room");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synchronizes the account pool", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts/sync-all",
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().success, true);
  assert.equal(response.json().results[0].id, accountId);
});

test("configures RDP operator access", async () => {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/accounts/${accountId}/rdp-settings`,
    headers: { cookie: sessionCookie },
    payload: { rdpAllowedEmails: ["ops@cfman.example"] }
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = await pool.query("SELECT rdp_allowed_emails FROM cloudflare_accounts WHERE id = $1", [accountId]);
  assert.deepEqual(result.rows[0].rdp_allowed_emails, ["ops@cfman.example"]);
});

test("creates and versions a platform-specific managed script", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/scripts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Tunnel readiness check",
      platform: "windows",
      language: "powershell",
      description: "Checks the active tunnel host",
      defaultTimeoutMs: 90000,
      content: "Write-Output 'ready v1'"
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.match(created.json().id, /^[0-9a-f-]{36}$/);
  const version = await app.inject({
    method: "POST",
    url: `/api/scripts/${created.json().id}/versions`,
    headers: { cookie: sessionCookie },
    payload: { content: "Write-Output 'ready v2'" }
  });
  assert.equal(version.statusCode, 201, version.body);
  assert.equal(version.json().version, 2);
  scriptVersionId = version.json().versionId;

  const list = await app.inject({ method: "GET", url: "/api/scripts?platform=windows&name=READINESS", headers: { cookie: sessionCookie } });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().scripts.length, 1);
  assert.equal(list.json().scripts[0].latestVersion, 2);
  assert.equal(list.json().scripts[0].versionCount, 2);
  assert.deepEqual(list.json().pagination, { page: 1, pageSize: 100, total: 1, totalPages: 1 });
  assert.equal(list.json().scripts[0].latestVersionId, scriptVersionId);
  assert.equal(list.json().scripts[0].defaultTimeoutMs, 90000);
  const noMatch = await app.inject({ method: "GET", url: "/api/scripts?platform=windows&name=missing", headers: { cookie: sessionCookie } });
  assert.equal(noMatch.statusCode, 200, noMatch.body);
  assert.equal(noMatch.json().scripts.length, 0);
  const detail = await app.inject({ method: "GET", url: `/api/scripts/${created.json().id}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().script.versions.map((item: { version: number }) => item.version), [2, 1]);
  assert.equal(detail.json().script.defaultTimeoutMs, 90000);
});

test("allocates a tunnel and issues bootstrap URLs", async () => {
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/tunnels",
    headers: { cookie: sessionCookie },
    payload: {
      tenantCode: "HLC",
      tunnelCode: "0001",
      displayName: "Highlands Test Tunnel",
      publications: [
        {
          suffix: "",
          routes: [
            { path: "/", serviceUrl: "http://localhost:8080" },
            { path: "/api", serviceUrl: "http://localhost:8081" }
          ]
        },
        {
          suffix: "admin",
          routes: [{ path: "/", serviceUrl: "http://192.168.10.20:9000" }]
        }
      ]
    }
  });
  assert.equal(createResponse.statusCode, 201, createResponse.body);
  const tunnel = createResponse.json().tunnel;
  tunnelId = tunnel.id;
  assert.equal(tunnel.accountId, accountId);
  assert.equal(tunnel.hostname, "0001.tunnels-a.example");
  assert.equal(tunnel.publications.length, 2);
  assert.equal(tunnel.publications[0].routes.length, 2);

  const enrollmentResponse = await app.inject({
    method: "POST",
    url: `/api/tunnels/${tunnelId}/enrollments`,
    headers: { cookie: sessionCookie },
    payload: { expiresInHours: 24 }
  });
  assert.equal(enrollmentResponse.statusCode, 201, enrollmentResponse.body);
  const enrollment = enrollmentResponse.json();
  enrollmentId = enrollment.id;
  assert.match(enrollment.urls.shell, /^https:\/\/cfman\.example\.test\/e\//);
  const match = enrollment.urls.shell.match(/\/e\/([^/]+)\/install\.sh$/);
  assert.ok(match);
  enrollmentToken = match[1];

  const scriptResponse = await app.inject({ method: "GET", url: `/e/${enrollmentToken}/install.sh` });
  assert.equal(scriptResponse.statusCode, 200);
  assert.match(scriptResponse.body, /cloudflared service install/);
  assert.match(scriptResponse.body, /0001\.tunnels-a\.example/);
  assert.match(scriptResponse.body, /install-id/);
  assert.match(scriptResponse.body, /status\\":\\"failed/);
  assert.match(scriptResponse.body, /https:\/\/cfman\.example\.test\/api\/public\/enrollments\/claim/);
  assert.match(scriptResponse.body, /api\/public\/enrollments\/logs/);
  assert.match(scriptResponse.body, /Cleanup and override it\? \[y\/N\]/);
  assert.match(scriptResponse.body, /overrideExisting/);
  assert.match(scriptResponse.body, /command-agent\.py/);
  assert.match(scriptResponse.body, /ThreadingHTTPServer/);
  assert.match(scriptResponse.body, /log_queue/);
  assert.match(scriptResponse.body, /USER_AGENT = "cfman-command-agent\/1\.0"/);
  assert.match(scriptResponse.body, /"User-Agent": USER_AGENT/);
  assert.match(scriptResponse.body, /Command agent callback failed/);
  assert.match(scriptResponse.body, /cfman-command-agent\.service/);
  assert.match(scriptResponse.body, /disable --now cloudflare-man-command-agent\.service/);
  assert.match(scriptResponse.body, /Library\/LaunchDaemons\/cfman\.command-agent\.plist/);
  assert.match(scriptResponse.body, /<string>cfman\.command-agent<\/string>/);
  assert.match(scriptResponse.body, /Restart=always/);
  assert.match(scriptResponse.body, /systemctl enable --now cloudflared\.service/);
  assert.match(scriptResponse.body, /osName/);
  assert.match(scriptResponse.body, /osVersion/);
  assert.match(scriptResponse.body, /machineName/);
  assert.match(scriptResponse.body, /CLAIM_STATUS/);
  assert.match(scriptResponse.body, /Enrollment claim failed with HTTP/);

  const windowsScript = await app.inject({ method: "GET", url: `/e/${enrollmentToken}/install.ps1` });
  assert.equal(windowsScript.statusCode, 200);
  assert.match(windowsScript.body, /https:\/\/cfman\.example\.test\/api\/public\/enrollments\/report/);
  assert.match(windowsScript.body, /Send-InstallLog/);
  assert.match(windowsScript.body, /Get-HttpErrorMessage/);
  assert.match(windowsScript.body, /\$payload\.error/);
  assert.match(windowsScript.body, /Read-Host "Cleanup and override/);
  assert.match(windowsScript.body, /overrideExisting/);
  assert.match(windowsScript.body, /CFManCommandAgent/);
  assert.match(windowsScript.body, /CloudflareManCommandAgent/);
  assert.match(windowsScript.body, /ReadLineAsync/);
  assert.match(windowsScript.body, /New-ScheduledTaskAction/);
  assert.match(windowsScript.body, /X-Cloudflare-Man-Agent-Token/);
  assert.match(windowsScript.body, /sc\.exe failure cloudflared/);
  assert.match(windowsScript.body, /RestartCount 999/);
  assert.match(windowsScript.body, /\$cleanupExitCode = \$LASTEXITCODE/);
  assert.match(windowsScript.body, /\$ErrorActionPreference = "Continue"/);
  assert.match(windowsScript.body, /Get-CimInstance Win32_OperatingSystem/);
  assert.match(windowsScript.body, /platform = "windows"/);
});

test("paginates and refreshes the visible tunnel list", async () => {
  const list = await app.inject({
    method: "GET",
    url: "/api/tunnels?page=1&pageSize=10",
    headers: { cookie: sessionCookie }
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().tunnels.length, 1);
  assert.deepEqual(list.json().pagination, { page: 1, pageSize: 10, total: 1, totalPages: 1 });
  const filtered = await app.inject({
    method: "GET",
    url: "/api/tunnels?tenantCode=hl&cfTunnelStatus=not_created&enrollmentStatus=url_issued&page=1&pageSize=10",
    headers: { cookie: sessionCookie }
  });
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.deepEqual(filtered.json().tunnels.map((tunnel: { id: string }) => tunnel.id), [tunnelId]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const refresh = await app.inject({
      method: "POST",
      url: "/api/tunnels/refresh",
      headers: { cookie: sessionCookie },
      payload: { tunnelIds: [tunnelId] }
    });
    assert.equal(refresh.statusCode, 200, refresh.body);
    assert.deepEqual(
      { success: refresh.json().success, refreshed: refresh.json().refreshed, failed: refresh.json().failed },
      { success: true, refreshed: 1, failed: 0 }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("filters named listing APIs and MCP tools case-insensitively", async () => {
  for (const [nameMatch, name] of [
    ["exact", "HIGHLANDS TEST TUNNEL"],
    ["ilike", "LANDS TEST"],
    ["regex", "^highlands test tunnel$"]
  ] as const) {
    const response = await app.inject({
      method: "GET",
      url: `/api/tunnels?name=${encodeURIComponent(name)}&nameMatch=${nameMatch}&page=1&pageSize=10`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().tunnels.map((tunnel: { id: string }) => tunnel.id), [tunnelId]);
  }
  const invalidRegex = await app.inject({
    method: "GET",
    url: "/api/tunnels?name=%5B&nameMatch=regex&page=1&pageSize=10",
    headers: { cookie: sessionCookie }
  });
  assert.equal(invalidRegex.statusCode, 400, invalidRegex.body);

  await app.inject({
    method: "PATCH",
    url: "/api/settings/mcp",
    headers: { cookie: sessionCookie },
    payload: { enabled: true }
  });
  const rotated = await app.inject({ method: "POST", url: "/api/settings/mcp/rotate", headers: { cookie: sessionCookie } });
  assert.equal(rotated.statusCode, 200, rotated.body);
  const token = rotated.json().token as string;
  const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().result.isError, undefined, response.body);
    return response.json().result.structuredContent;
  };

  const accounts = await callTool(40, "cfman_list_accounts", { name: "test account a", nameMatch: "exact" });
  assert.deepEqual(accounts.data.accounts.map((account: { id: string }) => account.id), [accountId]);
  assert.ok(accounts.references.some((reference: { value: string }) => reference.value === accountId));

  const tunnels = await callTool(41, "cfman_list_tunnels", { name: "highlands.*tunnel", nameMatch: "regex", page: 1, pageSize: 10 });
  assert.deepEqual(tunnels.data.tunnels.map((tunnel: { id: string }) => tunnel.id), [tunnelId]);
  assert.ok(tunnels.references.some((reference: { value: string }) => reference.value === tunnelId));

  const scripts = await callTool(42, "cfman_list_scripts", { name: "READINESS", nameMatch: "ilike", page: 1, pageSize: 10 });
  assert.equal(scripts.data.scripts.length, 1);
  assert.equal(scripts.data.scripts[0].name, "Tunnel readiness check");
  assert.ok(scripts.references.some((reference: { value: string }) => reference.value === scripts.data.scripts[0].id));

  const audit = await callTool(43, "cfman_list_audit_logs", { name: "^TUNNEL\\.CREATED$", nameMatch: "regex" });
  assert.ok(audit.data.entries.length >= 1);
  assert.ok(audit.data.entries.every((entry: { action: string }) => entry.action === "tunnel.created"));
  assert.ok(audit.references.some((reference: { value: string }) => reference.value === tunnelId));
});

test("manages a source-IP WAF policy for each ingress route", async () => {
  const detail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  const route = detail.json().tunnel.publications[0].routes[0];
  assert.equal(route.wafEnabled, true);
  assert.deepEqual(route.wafAllowedIps, []);

  const defaults = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}/routes/${route.id}/waf`, headers: { cookie: sessionCookie } });
  assert.equal(defaults.statusCode, 200, defaults.body);
  assert.deepEqual(defaults.json().waf.allowedIps, ["127.0.0.1/32"]);
  assert.equal(defaults.json().waf.defaulted, true);

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/tunnels/${tunnelId}/routes/${route.id}/waf`,
    headers: { cookie: sessionCookie },
    payload: { enabled: true, allowedIps: ["10.20.0.0/16", "2001:db8::/64"] }
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().waf.allowedIps, ["10.20.0.0/16", "2001:db8::/64"]);
  assert.match(updated.json().waf.rulesetId, /^[0-9a-f-]{36}$/);
  const stored = await pool.query("SELECT waf_enabled, waf_allowed_ips, waf_ruleset_id, waf_rule_id FROM tunnel_routes WHERE id = $1", [route.id]);
  assert.equal(stored.rows[0].waf_enabled, true);
  assert.deepEqual(stored.rows[0].waf_allowed_ips, ["10.20.0.0/16", "2001:db8::/64"]);
  assert.ok(stored.rows[0].waf_ruleset_id);
  assert.ok(stored.rows[0].waf_rule_id);

  const invalid = await app.inject({
    method: "PATCH",
    url: `/api/tunnels/${tunnelId}/routes/${route.id}/waf`,
    headers: { cookie: sessionCookie },
    payload: { enabled: true, allowedIps: ["not-an-ip"] }
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
});

test("keeps source-IP WAF disabled on the CFMan public hostname", async () => {
  const zone = await pool.query("SELECT id, name FROM zones WHERE account_id = $1 ORDER BY created_at LIMIT 1", [accountId]);
  const selfHostname = `cfman-self-test.${zone.rows[0].name}`;
  let selfTunnelId = "";
  try {
    const setting = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie: sessionCookie },
      payload: { publicBaseUrl: `https://${selfHostname}` }
    });
    assert.equal(setting.statusCode, 200, setting.body);

    const created = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      headers: { cookie: sessionCookie },
      payload: {
        tenantCode: "SELF",
        tunnelCode: "CONTROL",
        displayName: "CFMan self-hosted route",
        zoneId: zone.rows[0].id,
        publications: [{
          suffix: "",
          customLabel: "cfman-self-test",
          routes: [{ path: "/", serviceUrl: "http://127.0.0.1:3000" }]
        }]
      }
    });
    assert.equal(created.statusCode, 201, created.body);
    selfTunnelId = created.json().tunnel.id;
    const route = created.json().tunnel.publications[0].routes[0];
    assert.equal(route.wafEnabled, false);

    // CFMan auto-creates its own remote-agent callback routes (enrollment/
    // unenroll/diagnostic/script-execution log callbacks) on its own public
    // hostname, defaulted off - but unlike every other path there, they can
    // be switched on (with a warning) instead of being hard-blocked.
    const remoteAgentRoute = await pool.query(
      `SELECT r.id, r.waf_enabled FROM tunnel_routes r
         JOIN tunnel_publications p ON p.id = r.publication_id
        WHERE p.hostname = $1 AND r.path = '/api/public'`,
      [selfHostname]
    );
    assert.equal(remoteAgentRoute.rowCount, 1);
    assert.equal(remoteAgentRoute.rows[0].waf_enabled, false);
    const remoteAgentWaf = await app.inject({
      method: "GET",
      url: `/api/tunnels/${selfTunnelId}/routes/${remoteAgentRoute.rows[0].id}/waf`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(remoteAgentWaf.statusCode, 200, remoteAgentWaf.body);
    assert.equal(remoteAgentWaf.json().waf.remoteAgentPath, true);
    assert.equal(remoteAgentWaf.json().waf.protectsCloudflareMan, false);
    const enableRemoteAgent = await app.inject({
      method: "PATCH",
      url: `/api/tunnels/${selfTunnelId}/routes/${remoteAgentRoute.rows[0].id}/waf`,
      headers: { cookie: sessionCookie },
      payload: { enabled: true, allowedIps: ["127.0.0.1/32"] }
    });
    assert.equal(enableRemoteAgent.statusCode, 200, enableRemoteAgent.body);
    assert.match(enableRemoteAgent.json().warning ?? "", /log callbacks/);

    await pool.query(
      "UPDATE tunnel_routes SET waf_enabled = true, waf_ruleset_id = 'stale-ruleset', waf_rule_id = 'stale-rule' WHERE id = $1",
      [route.id]
    );
    const reconciled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie: sessionCookie },
      payload: { publicBaseUrl: `https://${selfHostname}` }
    });
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    const stored = await pool.query("SELECT waf_enabled, waf_rule_id FROM tunnel_routes WHERE id = $1", [route.id]);
    assert.deepEqual(stored.rows[0], { waf_enabled: false, waf_rule_id: null });

    const waf = await app.inject({
      method: "GET",
      url: `/api/tunnels/${selfTunnelId}/routes/${route.id}/waf`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(waf.statusCode, 200, waf.body);
    assert.equal(waf.json().waf.protectsCloudflareMan, true);

    const enable = await app.inject({
      method: "PATCH",
      url: `/api/tunnels/${selfTunnelId}/routes/${route.id}/waf`,
      headers: { cookie: sessionCookie },
      payload: { enabled: true, allowedIps: ["127.0.0.1/32"] }
    });
    assert.equal(enable.statusCode, 409, enable.body);
    assert.match(enable.json().error, /CFMan public hostname/);

    const reconcile = await app.inject({
      method: "POST",
      url: `/api/tunnels/${selfTunnelId}/reconcile-cfman-self`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(reconcile.statusCode, 200, reconcile.body);
    assert.equal(reconcile.json().hostname, selfHostname);
    assert.deepEqual(
      reconcile.json().routes.map((entry: { path: string; created: boolean }) => entry.path).sort(),
      ["/api/public", "/d", "/e"]
    );
    assert.ok(reconcile.json().routes.every((entry: { created: boolean }) => entry.created === false), "remote-agent routes already existed, so reconcile should report none newly created");

    const notSelf = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/reconcile-cfman-self`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(notSelf.statusCode, 409, notSelf.body);
  } finally {
    if (selfTunnelId) await pool.query("DELETE FROM tunnels WHERE id = $1", [selfTunnelId]);
    const restored = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie: sessionCookie },
      payload: { publicBaseUrl: "https://cfman.example.test" }
    });
    assert.equal(restored.statusCode, 200, restored.body);
  }
});

test("tunnels structured installer logs", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/logs",
    payload: {
      token: enrollmentToken,
      events: [
        { level: "info", step: "preflight", message: "Installer started" },
        { level: "warn", step: "rdp", messageBase64: Buffer.from("RDP warning").toString("base64") }
      ]
    }
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().accepted, 2);
  const logs = await pool.query("SELECT level, step, message FROM enrollment_logs WHERE enrollment_id = $1 ORDER BY id", [enrollmentId]);
  assert.deepEqual(logs.rows, [
    { level: "info", step: "preflight", message: "Installer started" },
    { level: "warn", step: "rdp", message: "RDP warning" }
  ]);
});

test("keeps installer preflight failures retryable", async () => {
  const report = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/report",
    payload: { token: enrollmentToken, platform: "windows", status: "failed", error: "Run PowerShell as Administrator." }
  });
  assert.equal(report.statusCode, 200, report.body);
  const retryable = await pool.query("SELECT status, last_error FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.equal(retryable.rows[0].status, "url_issued");
  assert.equal(retryable.rows[0].last_error, "Run PowerShell as Administrator.");

  await pool.query("UPDATE enrollments SET status = 'failed' WHERE id = $1", [enrollmentId]);
  const legacyRetry = await app.inject({ method: "GET", url: `/e/${enrollmentToken}/install.ps1` });
  assert.equal(legacyRetry.statusCode, 200, legacyRetry.body);
});

test("does not delete an account that still has tunnels", async () => {
  const response = await app.inject({
    method: "DELETE",
    url: `/api/accounts/${accountId}`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /assigned to 1 tunnel/);
  const account = await pool.query("SELECT 1 FROM cloudflare_accounts WHERE id = $1", [accountId]);
  assert.equal(account.rowCount, 1);
});

test("claim is atomic and provisions a tunnel once", async () => {
  const claimResponse = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64", installId: "installer-a" }
  });
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  assert.match(claimResponse.json().tunnelToken, /^mock-/);
  assert.match(claimResponse.json().agentToken, /^[A-Za-z0-9_-]{40,}$/);
  commandAgentToken = claimResponse.json().agentToken;
  const provisionedTunnel = await pool.query("SELECT cf_tunnel_name FROM tunnels WHERE id = $1", [tunnelId]);
  assert.equal(provisionedTunnel.rows[0].cf_tunnel_name, `cfman-hlc-0001-${tunnelId.slice(0, 8)}`);

  const retryClaim = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64" }
  });
  assert.equal(retryClaim.statusCode, 409);

  const sameInstallerRetry = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64", installId: "installer-a" }
  });
  assert.equal(sameInstallerRetry.statusCode, 200, sameInstallerRetry.body);
  assert.match(sameInstallerRetry.json().tunnelToken, /^mock-/);

  const approvedOverride = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64", installId: "installer-b", overrideExisting: true }
  });
  assert.equal(approvedOverride.statusCode, 200, approvedOverride.body);
  const overridden = await pool.query("SELECT install_id FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.equal(overridden.rows[0].install_id, "installer-b");
  const claimedScripts = await pool.query("SELECT platform, status FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'install' ORDER BY platform", [enrollmentId]);
  assert.deepEqual(claimedScripts.rows, [
    { platform: "unix", status: "staled_ignored" },
    { platform: "windows", status: "running" }
  ]);
});

test("tracks multiple diagnostic runs as grouped enrollment log sections", async () => {
  await pool.query(
    "UPDATE tunnels SET cf_tunnel_status = 'healthy' WHERE id = $1",
    [tunnelId]
  );
  const first = await app.inject({
    method: "POST",
    url: `/api/tunnels/${tunnelId}/diagnose`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().enrollmentId, enrollmentId);
  assert.equal(first.json().status, "pending");
  const firstRunId = first.json().diagnosticRunId as string;
  const tokenMatch = first.json().urls.powershell.match(/\/d\/([^/]+)\/diagnose\.ps1$/);
  assert.ok(tokenMatch);

  const script = await app.inject({ method: "GET", url: `/d/${tokenMatch[1]}/diagnose.ps1` });
  assert.equal(script.statusCode, 200, script.body);
  assert.match(script.body, new RegExp(firstRunId));
  const runningLogs = await app.inject({
    method: "GET",
    url: `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/logs`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(runningLogs.statusCode, 200, runningLogs.body);
  assert.equal(runningLogs.json().hasActiveDiagnostics, true);
  assert.equal(runningLogs.json().diagnosticRuns[0].status, "running");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const reported = await app.inject({
      method: "POST",
      url: "/api/public/tunnels/diagnose/report",
      payload: {
        tunnelId,
        diagnosticRunId: firstRunId,
        agentToken: commandAgentToken,
        cloudflaredRunning: true,
        hostnameMatch: true,
        localHostname: "0001.tunnels-a.example",
        agentHealthy: true
      }
    });
    assert.equal(reported.statusCode, 200, reported.body);
    assert.equal(reported.json().diagnosticRunId, firstRunId);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const second = await app.inject({
    method: "POST",
    url: `/api/tunnels/${tunnelId}/diagnose`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(second.statusCode, 200, second.body);
  const groupedLogs = await app.inject({
    method: "GET",
    url: `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/logs`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(groupedLogs.statusCode, 200, groupedLogs.body);
  assert.equal(groupedLogs.json().hasActiveDiagnostics, true);
  assert.deepEqual(groupedLogs.json().diagnosticRuns.map((run: { id: string; status: string }) => ({ id: run.id, status: run.status })), [
    { id: second.json().diagnosticRunId, status: "pending" },
    { id: firstRunId, status: "completed" }
  ]);
  const firstRunLogs = groupedLogs.json().logs.filter((log: { diagnosticRunId: string | null }) => log.diagnosticRunId === firstRunId);
  assert.deepEqual(firstRunLogs.map((log: { step: string }) => log.step), ["started", "cloudflared", "local-enrollment", "command-agent", "cloudflare-tunnel", "published-endpoints", "summary"]);
  assert.ok(firstRunLogs.every((log: { phase: string }) => log.phase === "diagnostic"));
});

test("updates all ingress routes on an existing tunnel", async () => {
  const response = await app.inject({
    method: "PUT",
    url: `/api/tunnels/${tunnelId}/connectivity`,
    headers: { cookie: sessionCookie },
    payload: {
      publications: [
        { suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:8080" }] },
        {
          suffix: "pos",
          routes: [
            { path: "/api", serviceUrl: "http://localhost:8081" },
            { path: "/admin", serviceUrl: "http://localhost:8082" }
          ]
        },
        {
          suffix: "ops",
          routes: [{ kind: "command_agent", path: "/agent", serviceUrl: "" }]
        }
      ]
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().applied, true);
  const publications = await pool.query("SELECT suffix, hostname, status FROM tunnel_publications WHERE tunnel_id = $1 ORDER BY created_at", [tunnelId]);
  const routes = await pool.query("SELECT path, service_url FROM tunnel_routes WHERE publication_id IN (SELECT id FROM tunnel_publications WHERE tunnel_id = $1) ORDER BY path", [tunnelId]);
  assert.deepEqual(publications.rows.map((publication) => publication.suffix), ["", "pos", "ops"]);
  assert.equal(publications.rows[1].hostname, "0001-pos.tunnels-a.example");
  assert.ok(publications.rows.every((publication) => publication.status === "active"));
  assert.deepEqual(routes.rows.map((route) => route.path), ["/", "/admin", "/agent", "/api"]);
  const agentRoute = await pool.query("SELECT route_kind, service_url FROM tunnel_routes WHERE path = '/agent'");
  assert.deepEqual(agentRoute.rows[0], { route_kind: "command_agent", service_url: "http://127.0.0.1:47831" });
});

test("rejects a second ssh:// route for the same tunnel", async () => {
  const response = await app.inject({
    method: "PUT",
    url: `/api/tunnels/${tunnelId}/connectivity`,
    headers: { cookie: sessionCookie },
    payload: {
      publications: [
        { suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:8080" }] },
        { suffix: "ssh1", routes: [{ path: "/", serviceUrl: "ssh://127.0.0.1:22" }] },
        { suffix: "ssh2", routes: [{ path: "/", serviceUrl: "ssh://127.0.0.1:2222" }] }
      ]
    }
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /Only one ssh:\/\/ route can be configured per tunnel/);
});

test("command agent route WAF is mandatory and cannot be disabled", async () => {
  const detail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  const agentRoute = detail.json().tunnel.publications
    .flatMap((publication: { routes: Array<{ id: string; path: string; kind: string }> }) => publication.routes)
    .find((route: { kind: string }) => route.kind === "command_agent");
  assert.ok(agentRoute, "expected a command_agent route from the previous test");

  const waf = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}/routes/${agentRoute.id}/waf`, headers: { cookie: sessionCookie } });
  assert.equal(waf.statusCode, 200, waf.body);
  assert.equal(waf.json().waf.mandatory, true);
  assert.equal(waf.json().waf.enabled, true);

  const rejected = await app.inject({
    method: "PATCH",
    url: `/api/tunnels/${tunnelId}/routes/${agentRoute.id}/waf`,
    headers: { cookie: sessionCookie },
    payload: { enabled: false, allowedIps: [] }
  });
  assert.equal(rejected.statusCode, 409, rejected.body);

  const accepted = await app.inject({
    method: "PATCH",
    url: `/api/tunnels/${tunnelId}/routes/${agentRoute.id}/waf`,
    headers: { cookie: sessionCookie },
    payload: { enabled: true, allowedIps: ["198.51.100.5/32"] }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().waf.enabled, true);
  assert.equal(accepted.json().warning, null);
  const stored = await pool.query("SELECT waf_enabled, waf_rule_id FROM tunnel_routes WHERE id = $1", [agentRoute.id]);
  assert.equal(stored.rows[0].waf_enabled, true);
  assert.ok(stored.rows[0].waf_rule_id);
});

test("keeps configured ingress paths as the source of truth", async () => {
  const { pathPrefixPattern } = await import("../src/lib/provisioning.js");
  assert.equal(pathPrefixPattern("/exec"), "^/exec(?:$|/)");
  assert.equal(pathPrefixPattern("/agent/v1"), "^/agent/v1(?:$|/)");
  assert.equal(pathPrefixPattern("/"), undefined);
});

test("ingress path patterns anchor instead of matching as a bare substring", async () => {
  // Cloudflare Tunnel treats the ingress `path` field as an unanchored regex.
  // A command_agent route at "/exec" must not also swallow unrelated API
  // paths that merely contain "exec" as a substring, e.g. CFMan's own
  // "/execution-variables/resolve" or "/commands/execute" endpoints on a
  // hostname that also hosts that tunnel's command agent.
  const { pathPrefixPattern } = await import("../src/lib/provisioning.js");
  const pattern = new RegExp(pathPrefixPattern("/exec")!);
  assert.ok(pattern.test("/exec"));
  assert.ok(pattern.test("/exec/status"));
  assert.ok(!pattern.test("/execution-variables/resolve"));
  assert.ok(!pattern.test("/api/tunnels/abc/commands/execute"));
});

test("installer report activates a mock tunnel", async () => {
  const report = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/report",
    payload: {
      token: enrollmentToken,
      platform: "windows",
      status: "installed",
      version: "cloudflared test",
      agentReady: true,
      osName: "Microsoft Windows 11 Pro",
      osVersion: "10.0.26100",
      osBuild: "26100",
      architecture: "amd64",
      machineName: "TUNNEL-WIN-01"
    }
  });
  assert.equal(report.statusCode, 200, report.body);
  // The general install script never enables Remote Desktop itself anymore -
  // that only happens on demand via "Enable RDS", so the report leaves rdp
  // untouched (still its pre-existing default) rather than auto-provisioning.
  assert.equal(report.json().rdp, undefined);
  const preEnable = await pool.query("SELECT onboarding_status, cf_tunnel_status, rdp_status, rdp_target_ip::text, rdp_url FROM tunnels WHERE id = $1", [tunnelId]);
  assert.equal(preEnable.rows[0].onboarding_status, "active");
  assert.equal(preEnable.rows[0].cf_tunnel_status, "healthy");
  assert.equal(preEnable.rows[0].rdp_status, "pending");
  assert.equal(preEnable.rows[0].rdp_target_ip, null);
  assert.equal(preEnable.rows[0].rdp_url, null);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://0001-ops.tunnels-a.example/agent");
    const headers = new Headers(init?.headers);
    assert.match(headers.get("X-Cloudflare-Man-Agent-Token") ?? "", /^[A-Za-z0-9_-]{40,}$/);
    const requestBody = JSON.parse(String(init?.body));
    assert.match(requestBody.script, /rdpEnabled/);
    return new Response(JSON.stringify({
      success: true,
      exitCode: 0,
      stdout: JSON.stringify({ rdpEnabled: true, rdpTargetIp: "192.168.10.25", rdpPort: 3389 }),
      stderr: "",
      durationMs: 500
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  let enable: Awaited<ReturnType<typeof app.inject>>;
  try {
    enable = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/rdp/enable`,
      headers: { cookie: sessionCookie }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(enable.statusCode, 200, enable.body);
  assert.equal(enable.json().ready, true);
  const result = await pool.query("SELECT onboarding_status, cf_tunnel_status, rdp_status, rdp_target_ip::text, rdp_url FROM tunnels WHERE id = $1", [tunnelId]);
  assert.equal(result.rows[0].onboarding_status, "active");
  assert.equal(result.rows[0].cf_tunnel_status, "healthy");
  assert.equal(result.rows[0].rdp_status, "ready");
  assert.equal(result.rows[0].rdp_target_ip, "192.168.10.25/32");
  assert.match(result.rows[0].rdp_url, /^https:\/\/rdp\.tunnels-a\.example\/rdp\//);
  const enrollmentInfo = await pool.query("SELECT host_info FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.deepEqual(enrollmentInfo.rows[0].host_info, {
    osName: "Microsoft Windows 11 Pro",
    osVersion: "10.0.26100",
    osBuild: "26100",
    architecture: "amd64",
    machineName: "TUNNEL-WIN-01"
  });
  const enrollmentDetail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(enrollmentDetail.statusCode, 200, enrollmentDetail.body);
  assert.equal(enrollmentDetail.json().tunnel.enrollments[0].environment, "windows");
  const enrollmentHistory = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}/enrollments?page=1&pageSize=5`, headers: { cookie: sessionCookie } });
  assert.equal(enrollmentHistory.statusCode, 200, enrollmentHistory.body);
  assert.deepEqual(enrollmentHistory.json().pagination, { page: 1, pageSize: 5, total: 1, totalPages: 1 });
  assert.equal(enrollmentHistory.json().enrollments[0].id, enrollmentId);
  assert.equal(enrollmentHistory.json().enrollments[0].environment, "windows");
  const installedScripts = await pool.query("SELECT platform, status FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'install' ORDER BY platform", [enrollmentId]);
  assert.deepEqual(installedScripts.rows, [
    { platform: "unix", status: "staled_ignored" },
    { platform: "windows", status: "completed" }
  ]);

  const currentDelete = await app.inject({
    method: "DELETE",
    url: `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(currentDelete.statusCode, 409, currentDelete.body);
  assert.match(currentDelete.json().error, /current connected/i);

  const retry = await app.inject({
    method: "POST",
    url: `/api/tunnels/${tunnelId}/rdp/retry`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().ready, true);
});

test("installer report enables SSH access for a Linux enrollment", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/tunnels",
    headers: { cookie: sessionCookie },
    payload: {
      tenantCode: "HLC",
      tunnelCode: "SSH1",
      displayName: "Linux SSH Test Tunnel",
      publications: [{ suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:9090" }] }]
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const sshTunnelId = created.json().tunnel.id;
  try {
    const enrollmentResponse = await app.inject({
      method: "POST",
      url: `/api/tunnels/${sshTunnelId}/enrollments`,
      headers: { cookie: sessionCookie },
      payload: { expiresInHours: 24 }
    });
    assert.equal(enrollmentResponse.statusCode, 201, enrollmentResponse.body);
    const shellMatch = enrollmentResponse.json().urls.shell.match(/\/e\/([^/]+)\/install\.sh$/);
    assert.ok(shellMatch);
    const sshEnrollmentToken = shellMatch[1];

    const script = await app.inject({ method: "GET", url: `/e/${sshEnrollmentToken}/install.sh` });
    assert.equal(script.statusCode, 200, script.body);

    const claimResponse = await app.inject({
      method: "POST",
      url: "/api/public/enrollments/claim",
      payload: { token: sshEnrollmentToken, platform: "unix", architecture: "amd64", installId: "ssh-installer" }
    });
    assert.equal(claimResponse.statusCode, 200, claimResponse.body);

    const report = await app.inject({
      method: "POST",
      url: "/api/public/enrollments/report",
      payload: {
        token: sshEnrollmentToken,
        platform: "unix",
        status: "installed",
        version: "cloudflared test",
        agentReady: true,
        osName: "Ubuntu 24.04 LTS",
        osVersion: "24.04",
        osBuild: "24.04",
        architecture: "amd64",
        machineName: "LINUX-SSH-01"
      }
    });
    assert.equal(report.statusCode, 200, report.body);
    // The general install script never enables SSH itself anymore - that
    // only happens on demand once the account publishes an ssh:// route
    // (see "Enable SSH"), so the report leaves ssh untouched.
    assert.equal(report.json().ssh, undefined);

    const tunnelRow = await pool.query(
      "SELECT ssh_status, ssh_target_ip::text AS ssh_target_ip, ssh_port, ssh_username, ssh_url, account_id FROM tunnels WHERE id = $1",
      [sshTunnelId]
    );
    assert.equal(tunnelRow.rows[0].ssh_status, "pending");
    assert.equal(tunnelRow.rows[0].ssh_target_ip, null);
    assert.equal(tunnelRow.rows[0].ssh_username, null);
    assert.equal(tunnelRow.rows[0].ssh_url, null);

    const addSshRoute = await app.inject({
      method: "PUT",
      url: `/api/tunnels/${sshTunnelId}/connectivity`,
      headers: { cookie: sessionCookie },
      payload: {
        publications: [
          { suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:9090" }] },
          { suffix: "ssh", routes: [{ path: "/", serviceUrl: "ssh://192.168.20.30:22" }] }
        ]
      }
    });
    assert.equal(addSshRoute.statusCode, 200, addSshRoute.body);

    const sshRoute = await pool.query(
      `SELECT p.hostname, r.service_url FROM tunnel_publications p
         JOIN tunnel_routes r ON r.publication_id = p.id
        WHERE p.tunnel_id = $1 AND r.service_url LIKE 'ssh://%'`,
      [sshTunnelId]
    );
    assert.equal(sshRoute.rowCount, 1);
    assert.equal(sshRoute.rows[0].hostname, "ssh1-ssh.tunnels-a.example");
    assert.equal(sshRoute.rows[0].service_url, "ssh://192.168.20.30:22");

    // Adding the route already auto-provisions the gateway (syncBrowserSsh,
    // called after every connectivity save) - no manual retry needed.
    const afterAdd = await pool.query("SELECT ssh_status, ssh_url FROM tunnels WHERE id = $1", [sshTunnelId]);
    assert.equal(afterAdd.rows[0].ssh_status, "ready");
    assert.equal(afterAdd.rows[0].ssh_url, "https://ssh1-ssh.tunnels-a.example");

    const retry = await app.inject({
      method: "POST",
      url: `/api/tunnels/${sshTunnelId}/ssh/retry`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().ready, true);
    assert.equal(retry.json().url, "https://ssh1-ssh.tunnels-a.example");

    // Renaming the ssh:// route's subdomain must move the browser SSH
    // gateway to follow it, not leave it pointed at the old hostname.
    const renameSshRoute = await app.inject({
      method: "PUT",
      url: `/api/tunnels/${sshTunnelId}/connectivity`,
      headers: { cookie: sessionCookie },
      payload: {
        publications: [
          { suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:9090" }] },
          { suffix: "ssh-renamed", routes: [{ path: "/", serviceUrl: "ssh://192.168.20.30:22" }] }
        ]
      }
    });
    assert.equal(renameSshRoute.statusCode, 200, renameSshRoute.body);
    const afterRename = await pool.query("SELECT ssh_status, ssh_url FROM tunnels WHERE id = $1", [sshTunnelId]);
    assert.equal(afterRename.rows[0].ssh_status, "ready");
    assert.equal(afterRename.rows[0].ssh_url, "https://ssh1-ssh-renamed.tunnels-a.example");

    // Removing the ssh:// route entirely must tear the gateway down instead
    // of leaving a dead ssh_url pointing at nothing.
    const removeSshRoute = await app.inject({
      method: "PUT",
      url: `/api/tunnels/${sshTunnelId}/connectivity`,
      headers: { cookie: sessionCookie },
      payload: {
        publications: [{ suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:9090" }] }]
      }
    });
    assert.equal(removeSshRoute.statusCode, 200, removeSshRoute.body);
    const afterRemove = await pool.query("SELECT ssh_status, ssh_url, ssh_access_app_id FROM tunnels WHERE id = $1", [sshTunnelId]);
    assert.equal(afterRemove.rows[0].ssh_status, "disabled");
    assert.equal(afterRemove.rows[0].ssh_url, null);
    assert.equal(afterRemove.rows[0].ssh_access_app_id, null);
  } finally {
    await pool.query("DELETE FROM tunnels WHERE id = $1", [sshTunnelId]);
  }
});

test("Enable RDS provisions via the async report callback when the agent schedules the command", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/tunnels",
    headers: { cookie: sessionCookie },
    payload: {
      tenantCode: "HLC",
      tunnelCode: "RDP1",
      displayName: "Windows RDP Async Test Tunnel",
      publications: [{ suffix: "", routes: [{ kind: "command_agent", path: "/agent" }] }]
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const rdpTunnelId = created.json().tunnel.id;
  try {
    const enrollmentResponse = await app.inject({
      method: "POST",
      url: `/api/tunnels/${rdpTunnelId}/enrollments`,
      headers: { cookie: sessionCookie },
      payload: { expiresInHours: 24 }
    });
    assert.equal(enrollmentResponse.statusCode, 201, enrollmentResponse.body);
    const shellMatch = enrollmentResponse.json().urls.shell.match(/\/e\/([^/]+)\/install\.sh$/);
    assert.ok(shellMatch);
    const rdpEnrollmentToken = shellMatch[1];

    const claimResponse = await app.inject({
      method: "POST",
      url: "/api/public/enrollments/claim",
      payload: { token: rdpEnrollmentToken, platform: "windows", architecture: "amd64", installId: "rdp-async-installer" }
    });
    assert.equal(claimResponse.statusCode, 200, claimResponse.body);

    const report = await app.inject({
      method: "POST",
      url: "/api/public/enrollments/report",
      payload: {
        token: rdpEnrollmentToken,
        platform: "windows",
        status: "installed",
        version: "cloudflared test",
        agentReady: true,
        osName: "Microsoft Windows 11 Pro",
        osVersion: "10.0.26100",
        osBuild: "26100",
        architecture: "amd64",
        machineName: "TUNNEL-WIN-RDP1"
      }
    });
    assert.equal(report.statusCode, 200, report.body);

    const originalFetch = globalThis.fetch;
    let capturedExecutionId = "";
    let capturedReportUrl = "";
    let capturedReportToken = "";
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://rdp1.tunnels-a.example/agent");
      const requestBody = JSON.parse(String(init?.body));
      assert.match(requestBody.script, /rdpEnabled/);
      capturedExecutionId = requestBody.executionId;
      capturedReportUrl = requestBody.reportUrl;
      capturedReportToken = requestBody.reportToken;
      return new Response(JSON.stringify({ scheduled: true, taskId: "agent-task-1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    };
    let enable: Awaited<ReturnType<typeof app.inject>>;
    try {
      enable = await app.inject({
        method: "POST",
        url: `/api/tunnels/${rdpTunnelId}/rdp/enable`,
        headers: { cookie: sessionCookie }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(enable.statusCode, 202, enable.body);
    assert.equal(enable.json().scheduled, true);
    assert.equal(enable.json().executionId, capturedExecutionId);

    const beforeReport = await pool.query("SELECT rdp_status, rdp_target_ip::text, rdp_url FROM tunnels WHERE id = $1", [rdpTunnelId]);
    assert.equal(beforeReport.rows[0].rdp_status, "provisioning");
    assert.equal(beforeReport.rows[0].rdp_target_ip, null);

    // The agent answers later, out of band, via the report callback - this
    // is what actually has to finish the job for a scheduled execution,
    // independent of anything the original POST /rdp/enable request saw.
    const callback = await app.inject({
      method: "POST",
      url: `/api/public/command-executions/${capturedExecutionId}/report`,
      payload: {
        token: capturedReportToken,
        success: true,
        exitCode: 0,
        stdout: JSON.stringify({ rdpEnabled: true, rdpTargetIp: "192.168.30.40", rdpPort: 3389 }),
        stderr: "",
        durationMs: 4200
      }
    });
    assert.equal(callback.statusCode, 202, callback.body);
    assert.match(capturedReportUrl, new RegExp(`/api/public/command-executions/${capturedExecutionId}/report$`));

    const afterReport = await pool.query("SELECT rdp_status, rdp_target_ip::text, rdp_url FROM tunnels WHERE id = $1", [rdpTunnelId]);
    assert.equal(afterReport.rows[0].rdp_status, "ready");
    assert.equal(afterReport.rows[0].rdp_target_ip, "192.168.30.40/32");
    assert.match(afterReport.rows[0].rdp_url, /^https:\/\/rdp\.tunnels-a\.example\/rdp\//);
  } finally {
    await pool.query("DELETE FROM tunnels WHERE id = $1", [rdpTunnelId]);
  }
});

test("executes a script through the configured tunnel command agent", async () => {
  const detail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().tunnel.commandAgent.endpoint, "https://0001-ops.tunnels-a.example/agent");
  assert.equal(detail.json().tunnel.commandAgent.status, "ready");
  const list = await app.inject({ method: "GET", url: "/api/tunnels?page=1&pageSize=25", headers: { cookie: sessionCookie } });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().tunnels.find((tunnel: { id: string }) => tunnel.id === tunnelId).commandAgent.endpoint, "https://0001-ops.tunnels-a.example/agent");

  const originalFetch = globalThis.fetch;
  let executionCall = 0;
  let streamedExecutionId = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://0001-ops.tunnels-a.example/agent");
    const headers = new Headers(init?.headers);
    assert.match(headers.get("X-Cloudflare-Man-Agent-Token") ?? "", /^[A-Za-z0-9_-]{40,}$/);
    executionCall += 1;
    const requestBody = JSON.parse(String(init?.body));
    assert.equal(requestBody.timeoutMs, executionCall === 1 ? 90000 : executionCall === 2 ? 30000 : 15000);
    assert.match(requestBody.script, /\$TUNNEL_CODE = '0001'/);
    assert.match(requestBody.script, /\$TUNNEL_NAME = 'Highlands Test Tunnel'/);
    assert.match(requestBody.script, /\$TENANT_CODE = 'HLC'/);
    assert.ok(requestBody.script.endsWith(executionCall <= 2 ? "Write-Output 'ready v2'" : "Write-Output 'inline'"));
    assert.match(requestBody.executionId, /^[0-9a-f-]{36}$/);
    assert.match(requestBody.reportToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(requestBody.startUrl, `https://cfman.example.test/api/public/command-executions/${requestBody.executionId}/started`);
    assert.equal(requestBody.reportUrl, `https://cfman.example.test/api/public/command-executions/${requestBody.executionId}/report`);
    assert.equal(requestBody.logUrl, `https://cfman.example.test/api/public/command-executions/${requestBody.executionId}/log`);
    if (executionCall === 1) {
      streamedExecutionId = requestBody.executionId;
      const streamed = await app.inject({
        method: "POST",
        url: `/api/public/command-executions/${requestBody.executionId}/log`,
        payload: { token: requestBody.reportToken, stream: "stdout", line: "streamed ready", sequence: 0 }
      });
      assert.equal(streamed.statusCode, 202, streamed.body);
    }
    return new Response(JSON.stringify(executionCall === 1
      ? { success: true, exitCode: 0, stdout: "ready\n", stderr: "", durationMs: 25 }
      : executionCall === 2
        ? { success: false, exitCode: 2, stdout: "partial\n", stderr: "failed\n", durationMs: 12 }
        : { success: true, exitCode: 0, stdout: "inline\n", stderr: "", durationMs: 8 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/commands/execute`,
      headers: { cookie: sessionCookie },
      payload: { scriptVersionId }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual({
      endpoint: response.json().endpoint,
      success: response.json().success,
      exitCode: response.json().exitCode,
      stdout: response.json().stdout,
      stderr: response.json().stderr,
      durationMs: response.json().durationMs
    }, {
      endpoint: "https://0001-ops.tunnels-a.example/agent",
      success: true,
      exitCode: 0,
      stdout: "ready\n",
      stderr: "",
      durationMs: 25
    });
    assert.match(response.json().executionId, /^[0-9a-f-]{36}$/);
    assert.equal(response.json().enrollmentId, enrollmentId);
    assert.equal(response.json().scriptVersionId, scriptVersionId);
    assert.equal(response.json().scriptName, "Tunnel readiness check");
    assert.equal(response.json().version, 2);
    const failed = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/commands/execute`,
      headers: { cookie: sessionCookie },
      payload: { scriptVersionId, timeoutMs: 30000 }
    });
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal(failed.json().success, false);
    const rotatedMcp = await app.inject({
      method: "POST",
      url: "/api/settings/mcp/rotate",
      headers: { cookie: sessionCookie }
    });
    assert.equal(rotatedMcp.statusCode, 200, rotatedMcp.body);
    const inline = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${rotatedMcp.json().token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "cfman_execute_inline_script",
          arguments: { tunnelId, name: "MCP quick check", inlineScript: "Write-Output 'inline'", language: "powershell", timeoutMs: 15000 }
        }
      }
    });
    assert.equal(inline.statusCode, 200, inline.body);
    const inlineResult = inline.json().result.structuredContent.data;
    assert.equal(inlineResult.success, true);
    assert.equal(inlineResult.scriptType, "inline");
    assert.equal(inlineResult.scriptId, null);
    assert.equal(inlineResult.scriptVersionId, null);
    assert.equal(inlineResult.scriptName, "MCP quick check");
    assert.equal(inlineResult.version, null);
    assert.equal(inlineResult.enrollmentId, enrollmentId);
    assert.match(inlineResult.executionId, /^[0-9a-f-]{36}$/);
    assert.ok(inline.json().result.structuredContent.references.some((reference: { path: string; value: string }) => reference.path === "response.executionId" && reference.value === inlineResult.executionId));
    const savedInline = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${rotatedMcp.json().token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "cfman_save_inline_execution_as_script",
          arguments: { tunnelId, executionId: inlineResult.executionId }
        }
      }
    });
    assert.equal(savedInline.statusCode, 200, savedInline.body);
    const savedInlineResult = savedInline.json().result.structuredContent.data;
    assert.equal(savedInlineResult.executionId, inlineResult.executionId);
    assert.match(savedInlineResult.scriptId, /^[0-9a-f-]{36}$/);
    assert.match(savedInlineResult.versionId, /^[0-9a-f-]{36}$/);
    assert.equal(savedInlineResult.version, 1);
    assert.equal(savedInlineResult.alreadySaved, false);
    assert.ok(savedInline.json().result.structuredContent.references.some((reference: { path: string; value: string }) => reference.path === "response.scriptId" && reference.value === savedInlineResult.scriptId));
    const scriptHistory = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${rotatedMcp.json().token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "cfman_get_script_execution_history",
          arguments: { scriptId: savedInlineResult.scriptId, version: 1, page: 1, pageSize: 10 }
        }
      }
    });
    assert.equal(scriptHistory.statusCode, 200, scriptHistory.body);
    assert.equal(scriptHistory.json().result.isError, undefined, scriptHistory.body);
    const historyResult = scriptHistory.json().result.structuredContent.data;
    assert.equal(historyResult.scriptId, savedInlineResult.scriptId);
    assert.equal(historyResult.version, 1);
    assert.equal(historyResult.pagination.total, 1);
    assert.deepEqual(historyResult.summary, { total: 1, succeeded: 1, failed: 0, timedOut: 0, cancelled: 0, scheduled: 0, running: 0 });
    assert.equal(historyResult.executions[0].id, inlineResult.executionId);
    assert.equal(historyResult.executions[0].tunnelId, tunnelId);
    assert.equal(historyResult.executions[0].enrollmentId, enrollmentId);
    assert.equal(historyResult.executions[0].osName, "Microsoft Windows 11 Pro");
    assert.equal(historyResult.executions[0].anchorScriptVersionId, savedInlineResult.versionId);
    assert.equal(historyResult.executions[0].scriptType, "managed");
    assert.ok(scriptHistory.json().result.structuredContent.references.some((reference: { path: string; value: string }) => reference.path === "response.executions[0].tunnelId" && reference.value === tunnelId));
  } finally {
    globalThis.fetch = originalFetch;
  }
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'tunnel.command_executed' AND entity_id = $1", [tunnelId]);
  assert.equal(audit.rowCount, 3);
  assert.equal(audit.rows[0].details.success, true);
  const executions = await pool.query("SELECT enrollment_id, script_version_id, saved_script_id, saved_script_version_id, saved_at, script_type, script_name, script_platform, script_language, script_version_number, status, elapsed_ms, stdout, stderr FROM tunnel_command_executions WHERE tunnel_id = $1 AND script_name <> '__cfman_rdp_enable__' ORDER BY created_at", [tunnelId]);
  assert.equal(executions.rows.length, 3);
  assert.deepEqual({ status: executions.rows[0].status, stdout: executions.rows[0].stdout, stderr: executions.rows[0].stderr }, { status: "succeeded", stdout: "ready\n", stderr: "" });
  assert.equal(typeof executions.rows[0].elapsed_ms, "number");
  assert.deepEqual({ status: executions.rows[1].status, stdout: executions.rows[1].stdout, stderr: executions.rows[1].stderr }, { status: "failed", stdout: "partial\n", stderr: "failed\n" });
  assert.equal(typeof executions.rows[1].elapsed_ms, "number");
  assert.deepEqual({
    scriptVersionId: executions.rows[2].script_version_id,
    scriptType: executions.rows[2].script_type,
    scriptName: executions.rows[2].script_name,
    savedScriptId: executions.rows[2].saved_script_id,
    savedScriptVersionId: executions.rows[2].saved_script_version_id,
    scriptPlatform: executions.rows[2].script_platform,
    scriptLanguage: executions.rows[2].script_language,
    scriptVersion: executions.rows[2].script_version_number,
    status: executions.rows[2].status,
    stdout: executions.rows[2].stdout
  }, {
    scriptVersionId: executions.rows[2].saved_script_version_id,
    scriptType: "managed",
    scriptName: "MCP quick check",
    savedScriptId: executions.rows[2].saved_script_id,
    savedScriptVersionId: executions.rows[2].saved_script_version_id,
    scriptPlatform: "windows",
    scriptLanguage: "powershell",
    scriptVersion: 1,
    status: "succeeded",
    stdout: "inline\n"
  });
  assert.match(executions.rows[2].saved_script_id, /^[0-9a-f-]{36}$/);
  assert.match(executions.rows[2].saved_script_version_id, /^[0-9a-f-]{36}$/);
  assert.ok(executions.rows[2].saved_at);
  assert.ok(executions.rows.every((execution) => execution.enrollment_id === enrollmentId));
  assert.ok(executions.rows.slice(0, 2).every((execution) => execution.script_version_id === scriptVersionId));
  const streamedLogs = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}/command-executions/${streamedExecutionId}/logs`, headers: { cookie: sessionCookie } });
  assert.equal(streamedLogs.statusCode, 200, streamedLogs.body);
  assert.deepEqual(streamedLogs.json().logs.map((entry: { stream: string; line: string; sequence: number }) => ({ stream: entry.stream, line: entry.line, sequence: entry.sequence })), [{ stream: "stdout", line: "streamed ready", sequence: 0 }]);

  const refreshedDetail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(refreshedDetail.statusCode, 200, refreshedDetail.body);
  const latestExecution = refreshedDetail.json().tunnel.commandExecutions[0];
  assert.equal(latestExecution.scriptType, "managed");
  assert.match(latestExecution.scriptId, /^[0-9a-f-]{36}$/);
  assert.equal(latestExecution.scriptId, latestExecution.savedScriptId);
  assert.equal(latestExecution.scriptVersionId, latestExecution.savedScriptVersionId);
  assert.equal(latestExecution.scriptName, "MCP quick check");
  assert.match(latestExecution.savedScriptId, /^[0-9a-f-]{36}$/);
  assert.match(latestExecution.savedScriptVersionId, /^[0-9a-f-]{36}$/);
  assert.ok(latestExecution.savedAt);
  assert.equal(latestExecution.scriptVersion, 1);

  const paginatedHistory = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}/command-executions?page=1&pageSize=5`, headers: { cookie: sessionCookie } });
  assert.equal(paginatedHistory.statusCode, 200, paginatedHistory.body);
  // Includes the "installer report activates a mock tunnel" test's Enable
  // RDS execution too - it runs through this same generic execution/history
  // system, so it's expected to show up here alongside ordinary scripts.
  assert.equal(paginatedHistory.json().pagination.total, 4);
  assert.deepEqual(paginatedHistory.json().summary, { total: 4, succeeded: 3, failed: 1, timedOut: 0, cancelled: 0, scheduled: 0, running: 0 });
  assert.equal(paginatedHistory.json().pagination.pageSize, 5);
  assert.equal(paginatedHistory.json().executions.length, 4);
  assert.equal(paginatedHistory.json().executions[0].id, latestExecution.id);
  const scriptListWithStats = await app.inject({ method: "GET", url: "/api/scripts", headers: { cookie: sessionCookie } });
  assert.equal(scriptListWithStats.statusCode, 200, scriptListWithStats.body);
  const readinessScript = scriptListWithStats.json().scripts.find((script: { name: string }) => script.name === "Tunnel readiness check");
  assert.deepEqual(readinessScript.executionStats, { total: 2, succeeded: 1, failed: 1, timedOut: 0, cancelled: 0, scheduled: 0, running: 0 });
});

test("schedules concurrent agent work, accepts post-unenrollment logs, and reconciles terminal callbacks", async () => {
  const originalFetch = globalThis.fetch;
  const dispatched: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/executions/") && url.endsWith("/cancel")) {
      const executionId = url.split("/").at(-2)!;
      return new Response(JSON.stringify({ accepted: true, taskId: executionId, status: "cancelling" }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    assert.equal(url, "https://0001-ops.tunnels-a.example/agent");
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    dispatched.push(payload);
    return new Response(JSON.stringify({ scheduled: true, executionId: payload.executionId, taskId: payload.executionId }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const scheduled = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/commands/execute`,
      headers: { cookie: sessionCookie },
      payload: { scriptVersionId }
    });
    assert.equal(scheduled.statusCode, 202, scheduled.body);
    assert.equal(scheduled.json().scheduled, true);
    assert.equal(scheduled.json().status, "scheduled");
    assert.equal(scheduled.json().taskId, scheduled.json().executionId);
    const executionId = scheduled.json().executionId as string;
    const request = dispatched[0]!;
    assert.equal(request.startUrl, `https://cfman.example.test/api/public/command-executions/${executionId}/started`);

    const started = await app.inject({
      method: "POST",
      url: `/api/public/command-executions/${executionId}/started`,
      payload: { token: request.reportToken, taskId: executionId, processId: 4242 }
    });
    assert.equal(started.statusCode, 202, started.body);
    const running = await pool.query("SELECT status, task_id, process_id FROM tunnel_command_executions WHERE id = $1", [executionId]);
    assert.deepEqual(running.rows[0], { status: "running", task_id: executionId, process_id: "4242" });

    await pool.query("UPDATE enrollments SET status = 'unenrolled', unenrolled_at = now() WHERE id = $1", [enrollmentId]);
    const postUnenrollmentLog = await app.inject({
      method: "POST",
      url: `/api/public/command-executions/${executionId}/log`,
      payload: { token: request.reportToken, stream: "stdout", line: "worker still reporting", sequence: 0 }
    });
    assert.equal(postUnenrollmentLog.statusCode, 202, postUnenrollmentLog.body);
    const retriedLog = await app.inject({
      method: "POST",
      url: `/api/public/command-executions/${executionId}/log`,
      payload: { token: request.reportToken, stream: "stdout", line: "worker still reporting", sequence: 0 }
    });
    assert.equal(retriedLog.statusCode, 202, retriedLog.body);
    const loggedLines = await pool.query("SELECT count(*)::int AS count FROM tunnel_command_execution_logs WHERE execution_id = $1", [executionId]);
    assert.equal(loggedLines.rows[0].count, 1);
    await pool.query("UPDATE enrollments SET status = 'installed', unenrolled_at = NULL WHERE id = $1", [enrollmentId]);

    await pool.query("UPDATE tunnel_command_executions SET status = 'timed_out', error = 'No final result was reported before the execution deadline.' WHERE id = $1", [executionId]);
    const succeeded = await app.inject({
      method: "POST",
      url: `/api/public/command-executions/${executionId}/report`,
      payload: { token: request.reportToken, status: "succeeded", success: true, exitCode: 0, stdout: "worker still reporting", stderr: "", durationMs: 95000 }
    });
    assert.equal(succeeded.statusCode, 202, succeeded.body);
    const corrected = await pool.query("SELECT status, error, stdout FROM tunnel_command_executions WHERE id = $1", [executionId]);
    assert.deepEqual(corrected.rows[0], { status: "succeeded", error: null, stdout: "worker still reporting" });

    const cancellable = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/commands/execute`,
      headers: { cookie: sessionCookie },
      payload: { scriptVersionId }
    });
    assert.equal(cancellable.statusCode, 202, cancellable.body);
    const cancellableId = cancellable.json().executionId as string;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/command-executions/${cancellableId}/cancel`,
      headers: { cookie: sessionCookie }
    });
    assert.equal(cancelled.statusCode, 202, cancelled.body);
    assert.equal(cancelled.json().status, "cancelled");

    const cancelledRequest = dispatched[1]!;
    const lateSuccess = await app.inject({
      method: "POST",
      url: `/api/public/command-executions/${cancellableId}/report`,
      payload: { token: cancelledRequest.reportToken, status: "succeeded", success: true, exitCode: 0, stdout: "too late", stderr: "", durationMs: 10 }
    });
    assert.equal(lateSuccess.statusCode, 404, lateSuccess.body);
    const stillCancelled = await pool.query("SELECT status FROM tunnel_command_executions WHERE id = $1", [cancellableId]);
    assert.equal(stillCancelled.rows[0].status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("groups a bulk script execution and exposes per-tunnel detail", async () => {
  const script = await pool.query("SELECT script_id FROM managed_script_versions WHERE id = $1", [scriptVersionId]);
  const scriptId = script.rows[0].script_id as string;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, exitCode: 0, stdout: "bulk ready\n", stderr: "", durationMs: 30 }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const started = await app.inject({
      method: "POST",
      url: `/api/scripts/${scriptId}/bulk-execute`,
      headers: { cookie: sessionCookie },
      payload: {
        scriptVersionId,
        name: "July rollout",
        description: "Validate tunnel readiness",
        filters: { tenantCode: "HLC", enrollmentStatus: "active" },
        selectAll: true
      }
    });
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().selectedCount, 1);
    assert.equal(started.json().timeoutMs, 90000);
    const runId = started.json().bulkExecutionId as string;
    const scriptVersion = await pool.query("SELECT version FROM managed_script_versions WHERE id = $1", [scriptVersionId]);
    const versionNumber = scriptVersion.rows[0].version as number;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await pool.query("SELECT status FROM tunnel_command_executions WHERE bulk_execution_id = $1", [runId]);
      if (status.rows[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const history = await app.inject({ method: "GET", url: `/api/scripts/${scriptId}/bulk-executions?page=1&pageSize=10`, headers: { cookie: sessionCookie } });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().runs[0].id, runId);
    assert.deepEqual({ selected: history.json().runs[0].selectedCount, succeeded: history.json().runs[0].succeeded, running: history.json().runs[0].running }, { selected: 1, succeeded: 1, running: 0 });
    const unifiedHistory = await app.inject({ method: "GET", url: `/api/scripts/${scriptId}/execution-history?version=${versionNumber}&page=1&pageSize=10`, headers: { cookie: sessionCookie } });
    assert.equal(unifiedHistory.statusCode, 200, unifiedHistory.body);
    const unifiedBulk = unifiedHistory.json().history.find((item: { kind: string; run?: { id: string; selectedCount: number; succeeded: number } }) => item.kind === "bulk");
    assert.equal(unifiedBulk?.kind, "bulk");
    assert.deepEqual({ id: unifiedBulk?.run?.id, selectedCount: unifiedBulk?.run?.selectedCount, succeeded: unifiedBulk?.run?.succeeded }, { id: runId, selectedCount: 1, succeeded: 1 });
    const filteredUnified = await app.inject({ method: "GET", url: `/api/scripts/${scriptId}/execution-history?version=${versionNumber}&search=July%20rollout&page=1&pageSize=10`, headers: { cookie: sessionCookie } });
    assert.equal(filteredUnified.statusCode, 200, filteredUnified.body);
    assert.deepEqual(filteredUnified.json().history.map((item: { kind: string }) => item.kind), ["bulk"]);
    const detail = await app.inject({ method: "GET", url: `/api/scripts/${scriptId}/bulk-executions/${runId}?status=succeeded&page=1&pageSize=25`, headers: { cookie: sessionCookie } });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().executions[0].tunnelId, tunnelId);
    assert.equal(detail.json().executions[0].computerName, "TUNNEL-WIN-01");
    assert.equal(detail.json().executions[0].environment, "windows");
    assert.deepEqual(detail.json().summary, { total: 1, running: 0, succeeded: 1, failed: 0, timedOut: 0, cancelled: 0, scheduled: 0 });
    for (const tunnelSearch of ["highlands", "hlc", "0001"]) {
      const filtered = await app.inject({ method: "GET", url: `/api/scripts/${scriptId}/bulk-executions/${runId}?tunnelSearch=${tunnelSearch}&page=1&pageSize=25`, headers: { cookie: sessionCookie } });
      assert.equal(filtered.statusCode, 200, filtered.body);
      assert.deepEqual(filtered.json().executions.map((execution: { tunnelId: string }) => execution.tunnelId), [tunnelId]);
    }
    const missingTunnel = await app.inject({ method: "GET", url: `/api/scripts/${scriptId}/bulk-executions/${runId}?tunnelSearch=missing-tunnel&page=1&pageSize=25`, headers: { cookie: sessionCookie } });
    assert.equal(missingTunnel.statusCode, 200, missingTunnel.body);
    assert.equal(missingTunnel.json().pagination.total, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deletes a saved script and all related execution history", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/scripts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Disposable script",
      platform: "windows",
      language: "powershell",
      description: "Delete behavior test",
      content: "Write-Output 'delete me'"
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const scriptId = created.json().id as string;
  const versionId = created.json().versionId as string;
  const execution = await pool.query(
    `INSERT INTO tunnel_command_executions(
       tunnel_id, enrollment_id, script_version_id, script, timeout_ms, status,
       finished_at, elapsed_ms, script_name, script_platform, script_language, script_version_number
     ) VALUES ($1, $2, $3, $4, 30000, 'succeeded', now(), 5, $5, 'windows', 'powershell', 1)
     RETURNING id`,
    [tunnelId, enrollmentId, versionId, "Write-Output 'delete me'", "Disposable script"]
  );

  const deleted = await app.inject({ method: "DELETE", url: `/api/scripts/${scriptId}`, headers: { cookie: sessionCookie } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), {
    success: true,
    scriptId,
    scriptName: "Disposable script",
    deletedExecutionCount: 1
  });
  assert.equal((await pool.query("SELECT 1 FROM managed_scripts WHERE id = $1", [scriptId])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM tunnel_command_executions WHERE id = $1", [execution.rows[0].id])).rowCount, 0);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'script.deleted' AND entity_id = $1", [scriptId]);
  assert.equal(audit.rows[0].details.deletedExecutionCount, 1);
});

test("rejects a second command agent route for the same tunnel", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const publication = await client.query(
      `INSERT INTO tunnel_publications(tunnel_id, suffix, hostname, status)
       VALUES ($1, 'duplicate-agent-test', 'duplicate-agent-test.tunnels-a.example', 'pending')
       RETURNING id`,
      [tunnelId]
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO tunnel_routes(publication_id, path, service_url, route_kind, sort_order)
         VALUES ($1, '/agent', 'http://127.0.0.1:47831', 'command_agent', 0)`,
        [publication.rows[0].id]
      ),
      /Only one command agent route is allowed per tunnel/
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("tracks enrollment history and issues cleanup for a running tunnel", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/api/tunnels/${tunnelId}/enrollments`,
    headers: { cookie: sessionCookie },
    payload: { expiresInHours: 24 }
  });
  assert.equal(response.statusCode, 201, response.body);
  const issued = response.json();
  const waitingState = await pool.query("SELECT onboarding_status FROM tunnels WHERE id = $1", [tunnelId]);
  assert.equal(waitingState.rows[0].onboarding_status, "waiting_for_new_enrollment");
  await pool.query("UPDATE tunnels SET onboarding_status = 'active' WHERE id = $1", [tunnelId]);
  const latestEnrollmentList = await app.inject({ method: "GET", url: "/api/tunnels?page=1&pageSize=25", headers: { cookie: sessionCookie } });
  assert.equal(latestEnrollmentList.statusCode, 200, latestEnrollmentList.body);
  assert.equal(latestEnrollmentList.json().tunnels[0].onboardingStatus, "waiting_for_new_enrollment");
  await pool.query("UPDATE tunnels SET onboarding_status = 'waiting_for_new_enrollment' WHERE id = $1", [tunnelId]);
  const deletedPending = await app.inject({
    method: "DELETE",
    url: `/api/tunnels/${tunnelId}/enrollments/${issued.id}`,
    headers: { cookie: sessionCookie },
    payload: { mode: "soft" }
  });
  assert.equal(deletedPending.statusCode, 200, deletedPending.body);
  assert.equal(deletedPending.json().hardDeleted, true);
  const restoredState = await pool.query("SELECT onboarding_status FROM tunnels WHERE id = $1", [tunnelId]);
  assert.equal(restoredState.rows[0].onboarding_status, "verified");
  const pendingRow = await pool.query("SELECT 1 FROM enrollments WHERE id = $1", [issued.id]);
  assert.equal(pendingRow.rowCount, 0);
  assert.equal(issued.unenrollCommands.length, 1);
  assert.equal(issued.unenrollCommands[0].enrollmentId, enrollmentId);
  assert.match(issued.unenrollCommands[0].urls.shell, /\/unenroll\.sh$/);

  const revertedEnrollment = await pool.query(
    `SELECT unenroll_token_hash, unenroll_requested_at, unenrolled_at, superseded_by_enrollment_id
       FROM enrollments WHERE id = $1`,
    [enrollmentId]
  );
  assert.deepEqual(revertedEnrollment.rows[0], {
    unenroll_token_hash: null,
    unenroll_requested_at: null,
    unenrolled_at: null,
    superseded_by_enrollment_id: null
  });
  const revertedCleanupScripts = await pool.query(
    "SELECT 1 FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'unenroll'",
    [enrollmentId]
  );
  assert.equal(revertedCleanupScripts.rowCount, 0);
  const detailAfterRevert = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(detailAfterRevert.statusCode, 200, detailAfterRevert.body);
  assert.equal(detailAfterRevert.json().tunnel.enrollments[0].unenrollStatus, "not_required");

  const cloudflareResources = await pool.query(
    `SELECT cf_tunnel_id, dns_record_id, rdp_route_id, rdp_target_id, rdp_vnet_id
       FROM tunnels WHERE id = $1`,
    [tunnelId]
  );
  assert.ok(cloudflareResources.rows[0].cf_tunnel_id);
  assert.ok(cloudflareResources.rows[0].dns_record_id);
  assert.ok(cloudflareResources.rows[0].rdp_route_id);
  assert.ok(cloudflareResources.rows[0].rdp_target_id);
  assert.ok(cloudflareResources.rows[0].rdp_vnet_id);

  const rotatedMcp = await app.inject({ method: "POST", url: "/api/settings/mcp/rotate", headers: { cookie: sessionCookie } });
  assert.equal(rotatedMcp.statusCode, 200, rotatedMcp.body);
  const originalFetch = globalThis.fetch;
  let scheduledScript = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://0001-ops.tunnels-a.example/agent");
    const payload = JSON.parse(String(init?.body));
    scheduledScript = payload.script;
    assert.equal(payload.timeoutMs, 30000);
    return new Response(JSON.stringify({ success: true, exitCode: 0, stdout: "scheduled\n", stderr: "", durationMs: 5 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  let automaticUnenrollment: any;
  try {
    const automatic = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${rotatedMcp.json().token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "cfman_issue_unenrollment",
          arguments: { tunnelId, enrollmentId, automatic: true, expiresInHours: 24 }
        }
      }
    });
    assert.equal(automatic.statusCode, 200, automatic.body);
    automaticUnenrollment = automatic.json().result.structuredContent.data;
    assert.equal(automaticUnenrollment.tunnelId, tunnelId);
    assert.equal(automaticUnenrollment.enrollmentId, enrollmentId);
    assert.equal(automaticUnenrollment.automatic.status, "scheduled");
    assert.equal(automaticUnenrollment.automatic.platform, "windows");
    assert.match(automaticUnenrollment.automatic.executionId, /^[0-9a-f-]{36}$/);
    const references = automatic.json().result.structuredContent.references;
    assert.ok(references.some((reference: { path: string; value: string }) => reference.path === "response.tunnelId" && reference.value === tunnelId));
    assert.ok(references.some((reference: { path: string; value: string }) => reference.path === "response.automatic.executionId" && reference.value === automaticUnenrollment.automatic.executionId));
    assert.match(scheduledScript, /Start-Process/);
    assert.match(scheduledScript, /-EncodedCommand/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const automaticExecution = await pool.query(
    `SELECT tunnel_id, enrollment_id, script_type, script_name, status
       FROM tunnel_command_executions WHERE id = $1`,
    [automaticUnenrollment.automatic.executionId]
  );
  assert.deepEqual(automaticExecution.rows[0], {
    tunnel_id: tunnelId,
    enrollment_id: enrollmentId,
    script_type: "inline",
    script_name: "Automatic unenrollment",
    status: "succeeded"
  });

  const cleanupToken = automaticUnenrollment.urls.shell.match(/\/e\/([^/]+)\/unenroll\.sh$/)?.[1];
  assert.ok(cleanupToken);
  const cleanupScript = await app.inject({ method: "GET", url: `/e/${cleanupToken}/unenroll.sh` });
  assert.equal(cleanupScript.statusCode, 200, cleanupScript.body);
  assert.match(cleanupScript.body, /cloudflared service uninstall/);
  const cleanupPowerShell = await app.inject({ method: "GET", url: `/e/${cleanupToken}/unenroll.ps1` });
  assert.equal(cleanupPowerShell.statusCode, 200, cleanupPowerShell.body);
  assert.match(cleanupPowerShell.body, /Run PowerShell as Administrator/);
  assert.match(cleanupPowerShell.body, /\$uninstallExitCode = \$LASTEXITCODE/);
  assert.match(cleanupPowerShell.body, /cloudflared writes INF messages to stderr/);

  const cleanupClaim = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/claim",
    payload: { token: cleanupToken, platform: "unix" }
  });
  assert.equal(cleanupClaim.statusCode, 200, cleanupClaim.body);
  const staleCleanupPowerShell = await app.inject({ method: "GET", url: `/e/${cleanupToken}/unenroll.ps1` });
  assert.equal(staleCleanupPowerShell.statusCode, 410, staleCleanupPowerShell.body);

  const detail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().tunnel.enrollments.length, 1);
  assert.equal(detail.json().tunnel.enrollments[0].unenrollStatus, "pending");

  const cleanupLog = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/logs",
    payload: { token: cleanupToken, events: [{ level: "info", step: "cleanup", message: "Service removed" }] }
  });
  assert.equal(cleanupLog.statusCode, 202, cleanupLog.body);
  const cleanupReport = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/report",
    payload: { token: cleanupToken, platform: "unix", status: "unenrolled" }
  });
  assert.equal(cleanupReport.statusCode, 200, cleanupReport.body);
  const oldEnrollment = await pool.query("SELECT unenrolled_at, unenroll_last_error FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.ok(oldEnrollment.rows[0].unenrolled_at);
  assert.equal(oldEnrollment.rows[0].unenroll_last_error, null);
  const oldEnrollmentStatus = await pool.query("SELECT status FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.equal(oldEnrollmentStatus.rows[0].status, "unenrolled");
  const cleanupScripts = await pool.query("SELECT platform, status FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'unenroll' ORDER BY platform", [enrollmentId]);
  assert.deepEqual(cleanupScripts.rows, [
    { platform: "unix", status: "completed" },
    { platform: "windows", status: "staled_ignored" }
  ]);
  const cleanedTunnel = await pool.query(
    `SELECT cf_tunnel_id, cf_tunnel_name, dns_record_id, cf_tunnel_status, rdp_route_id, rdp_target_id, rdp_vnet_id, rdp_url
       FROM tunnels WHERE id = $1`,
    [tunnelId]
  );
  assert.deepEqual(cleanedTunnel.rows[0], {
    cf_tunnel_id: null,
    cf_tunnel_name: null,
    dns_record_id: null,
    cf_tunnel_status: "not_created",
    rdp_route_id: null,
    rdp_target_id: null,
    rdp_vnet_id: null,
    rdp_url: null
  });
  const cleanedPublications = await pool.query("SELECT dns_record_id, status FROM tunnel_publications WHERE tunnel_id = $1", [tunnelId]);
  assert.ok(cleanedPublications.rows.every((publication) => publication.dns_record_id === null && publication.status === "pending"));
  const cleanedRoutes = await pool.query(
    `SELECT waf_ruleset_id, waf_rule_id FROM tunnel_routes
      WHERE publication_id IN (SELECT id FROM tunnel_publications WHERE tunnel_id = $1)`,
    [tunnelId]
  );
  assert.ok(cleanedRoutes.rows.every((route) => route.waf_ruleset_id === null && route.waf_rule_id === null));

  const logs = await app.inject({
    method: "GET",
    url: `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/logs`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(logs.statusCode, 200, logs.body);
  assert.equal(logs.json().logs.length, 10);

  const hardDeleted = await app.inject({
    method: "DELETE",
    url: `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(hardDeleted.statusCode, 200, hardDeleted.body);
  assert.equal(hardDeleted.json().alreadyDeleted, false);
  assert.equal(hardDeleted.json().hardDeleted, true);
  const deletedDetail = await app.inject({ method: "GET", url: `/api/tunnels/${tunnelId}`, headers: { cookie: sessionCookie } });
  assert.equal(deletedDetail.statusCode, 200, deletedDetail.body);
  const deletedEnrollment = deletedDetail.json().tunnel.enrollments.find((item: { id: string }) => item.id === enrollmentId);
  assert.equal(deletedEnrollment, undefined);
  const deletedLogs = await pool.query("SELECT 1 FROM enrollment_logs WHERE enrollment_id = $1", [enrollmentId]);
  assert.equal(deletedLogs.rowCount, 0);

  const orphanedExecution = deletedDetail.json().tunnel.commandExecutions.find((item: { enrollmentId: string | null }) => item.enrollmentId === null);
  assert.ok(orphanedExecution, "Command execution rows remain available without the deleted enrollment");
});

test("preflights and force-deletes a tunnel with explicit name confirmation", async () => {
  await pool.query("UPDATE tunnels SET cf_tunnel_id = '00000000-0000-4000-8000-000000000099', cf_tunnel_status = 'healthy' WHERE id = $1", [tunnelId]);
  const preflight = await app.inject({
    method: "GET",
    url: `/api/tunnels/${tunnelId}/delete-preflight`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  assert.equal(preflight.json().canDelete, false);
  assert.deepEqual(preflight.json().checks.map((check: { id: string; ok: boolean }) => ({ id: check.id, ok: check.ok })), [
    { id: "tunnel", ok: false },
    { id: "enrollments", ok: true },
    { id: "commands", ok: true },
    { id: "cloudflare", ok: true }
  ]);
  assert.match(preflight.json().checks[0].resolution, /unenrollment|cloudflared/i);

  const blocked = await app.inject({
    method: "DELETE",
    url: `/api/tunnels/${tunnelId}`,
    headers: { cookie: sessionCookie },
    payload: { force: false }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().requiresNameConfirmation, true);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/tunnels/${tunnelId}`,
    headers: { cookie: sessionCookie },
    payload: { force: true, confirmName: "Highlands Test Tunnel" }
  });
  assert.equal(deleted.statusCode, 204, deleted.body);
  const tunnel = await pool.query("SELECT 1 FROM tunnels WHERE id = $1", [tunnelId]);
  assert.equal(tunnel.rowCount, 0);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'tunnel.deleted' AND entity_id = $1", [tunnelId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.forced, true);
});

test("deprovisions the previous tunnel before an enrollment override", async () => {
  const zone = await pool.query("SELECT id FROM zones WHERE account_id = $1 ORDER BY created_at LIMIT 1", [accountId]);
  const created = await app.inject({
    method: "POST",
    url: "/api/tunnels",
    headers: { cookie: sessionCookie },
    payload: {
      tenantCode: "HLC",
      tunnelCode: "OVERRIDE",
      displayName: "Override Test Tunnel",
      zoneId: zone.rows[0].id,
      publications: [{ suffix: "", routes: [{ kind: "command_agent", path: "/exec" }] }]
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const overrideTunnelId = created.json().tunnel.id as string;

  const firstIssue = await app.inject({ method: "POST", url: `/api/tunnels/${overrideTunnelId}/enrollments`, headers: { cookie: sessionCookie }, payload: { expiresInHours: 24 } });
  assert.equal(firstIssue.statusCode, 201, firstIssue.body);
  const firstEnrollmentId = firstIssue.json().id as string;
  const firstToken = firstIssue.json().urls.shell.match(/\/e\/([^/]+)\/install\.sh$/)?.[1];
  assert.ok(firstToken);
  const firstClaim = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: firstToken, platform: "linux", machineName: "TUNNEL-OLD", installId: "override-old" }
  });
  assert.equal(firstClaim.statusCode, 200, firstClaim.body);
  const firstReport = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/report",
    payload: { token: firstToken, platform: "unix", status: "installed", agentReady: true, machineName: "TUNNEL-OLD", osName: "Linux" }
  });
  assert.equal(firstReport.statusCode, 200, firstReport.body);
  const firstResources = await pool.query(
    `SELECT s.cf_tunnel_id, p.dns_record_id
       FROM tunnels s JOIN tunnel_publications p ON p.tunnel_id = s.id
      WHERE s.id = $1`,
    [overrideTunnelId]
  );
  assert.ok(firstResources.rows[0].cf_tunnel_id);
  assert.ok(firstResources.rows[0].dns_record_id);

  const secondIssue = await app.inject({ method: "POST", url: `/api/tunnels/${overrideTunnelId}/enrollments`, headers: { cookie: sessionCookie }, payload: { expiresInHours: 24 } });
  assert.equal(secondIssue.statusCode, 201, secondIssue.body);
  const secondToken = secondIssue.json().urls.shell.match(/\/e\/([^/]+)\/install\.sh$/)?.[1];
  const supersededCleanupToken = secondIssue.json().unenrollCommands[0].urls.shell.match(/\/e\/([^/]+)\/unenroll\.sh$/)?.[1];
  assert.ok(secondToken);
  assert.ok(supersededCleanupToken);
  const secondClaim = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: secondToken, platform: "linux", machineName: "TUNNEL-NEW", installId: "override-new", overrideExisting: true }
  });
  assert.equal(secondClaim.statusCode, 200, secondClaim.body);
  const replacedResources = await pool.query(
    `SELECT s.cf_tunnel_id, p.dns_record_id
       FROM tunnels s JOIN tunnel_publications p ON p.tunnel_id = s.id
      WHERE s.id = $1`,
    [overrideTunnelId]
  );
  assert.notEqual(replacedResources.rows[0].cf_tunnel_id, firstResources.rows[0].cf_tunnel_id);
  assert.notEqual(replacedResources.rows[0].dns_record_id, firstResources.rows[0].dns_record_id);
  const staleReport = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/report",
    payload: { token: supersededCleanupToken, platform: "unix", status: "unenrolled" }
  });
  assert.equal(staleReport.statusCode, 200, staleReport.body);
  assert.equal(staleReport.json().cloudflareDeprovisioned, false);
  const resourcesAfterStaleReport = await pool.query("SELECT cf_tunnel_id FROM tunnels WHERE id = $1", [overrideTunnelId]);
  assert.equal(resourcesAfterStaleReport.rows[0].cf_tunnel_id, replacedResources.rows[0].cf_tunnel_id);
  const previousEnrollment = await pool.query("SELECT status, unenroll_reason, unenrolled_at FROM enrollments WHERE id = $1", [firstEnrollmentId]);
  assert.equal(previousEnrollment.rows[0].status, "unenrolled");
  assert.equal(previousEnrollment.rows[0].unenroll_reason, "override");
  assert.ok(previousEnrollment.rows[0].unenrolled_at);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'tunnel.cloudflare_deprovisioned' AND entity_id = $1", [overrideTunnelId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.reason, "override");
});
