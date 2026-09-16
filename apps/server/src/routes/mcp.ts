import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { argumentBindingsSchema, executionVariablesSchema, scriptArgumentsSchema } from "../lib/execution-variables.js";
import { requireMcpAuth } from "../lib/auth.js";

type ToolShape = z.ZodRawShape;
type ApiHandler<T extends ToolShape> = (args: z.infer<z.ZodObject<T>>) => Promise<unknown>;

class McpApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly fields?: unknown) {
    super(message);
  }
}

async function callApi(
  app: FastifyInstance,
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      host: "localhost",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
  if (response.statusCode === 204) return { success: true };
  const payload = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400) throw new McpApiError(response.statusCode, payload.error ?? "API request failed", payload.fields);
  return payload;
}

type IdentifierReference = { path: string; value: string };

function collectIdentifierReferences(input: unknown, response: unknown): IdentifierReference[] {
  const references: IdentifierReference[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const itemPath = path ? `${path}.${key}` : key;
      if ((key === "id" || /Id$/.test(key)) && typeof item === "string" && item.length > 0) {
        const signature = `${itemPath}:${item}`;
        if (!seen.has(signature)) {
          references.push({ path: itemPath, value: item });
          seen.add(signature);
        }
      }
      visit(item, itemPath);
    }
  };
  visit(input, "input");
  visit(response, "response");
  return references;
}

function toolText(value: unknown, input: unknown, isError = false): CallToolResult {
  const payload = {
    data: value,
    references: collectIdentifierReferences(input, value)
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  };
}

const routeSchema = z.object({
  kind: z.enum(["service", "command_agent"]).default("service"),
  path: z.string().min(1).describe("Ingress path beginning with /"),
  serviceUrl: z.string().optional().describe("HTTP/HTTPS origin; omit or use an empty string for command_agent routes")
});
const publicationSchema = z.object({
  suffix: z.string().default("").describe("Subdomain suffix; empty creates the tunnel's primary hostname. Ignored when customLabel is set."),
  customLabel: z.string().optional().describe("Full subdomain label used verbatim instead of the tunnel-id-derived suffix, e.g. \"cfman\" for cfman.example.com"),
  routes: z.array(routeSchema).min(1)
});
const mcpNameFilterFields = {
  name: z.string().trim().min(1).max(160).optional().describe("Resource name to match case-insensitively"),
  nameMatch: z.enum(["exact", "ilike", "regex"]).default("ilike").describe("Name matching mode: whole name, substring ILIKE pattern, or PostgreSQL regular expression")
};

function setNameFilterParams(
  params: URLSearchParams,
  args: { name?: string | undefined; nameMatch: "exact" | "ilike" | "regex" }
): void {
  if (!args.name) return;
  params.set("name", args.name);
  params.set("nameMatch", args.nameMatch);
}

function registerApiTool<T extends ToolShape>(
  server: McpServer,
  app: FastifyInstance,
  token: string,
  name: string,
  description: string,
  inputSchema: T,
  handler: ApiHandler<T>
): void {
  const callback = async (args: z.infer<z.ZodObject<T>>): Promise<CallToolResult> => {
    try {
      return toolText(await handler(args), args);
    } catch (error) {
      if (error instanceof McpApiError) {
        return toolText({ error: error.message, status: error.status, fields: error.fields }, args, true);
      }
      return toolText({ error: error instanceof Error ? error.message : "MCP tool failed" }, args, true);
    }
  };
  // The SDK's Zod 3/4 compatibility type is wider than this helper's concrete Zod 4 shape.
  server.registerTool(name, { description, inputSchema }, callback as never);
}

function createMcpServer(app: FastifyInstance, token: string): McpServer {
  const server = new McpServer(
    { name: "cfman", version: "0.1.0" },
    {
      instructions: "CFMan MCP exposes the same administrative operations as the web UI. Use read tools before mutating tools. Tunnel deletion still requires preflight checks and, when needed, the exact display name confirmation. MCP bearer tokens are administrator credentials; never include them in logs or tool arguments.",
      capabilities: { logging: {} }
    }
  );

  registerApiTool(server, app, token, "cfman_get_dashboard", "Read dashboard statistics, account capacity, recent tunnels, and recent activity.", {}, () => callApi(app, token, "GET", "/api/dashboard"));
  registerApiTool(server, app, token, "cfman_get_settings", "Read public base URL and MCP server metadata without returning the MCP secret.", {}, () => callApi(app, token, "GET", "/api/settings"));
  registerApiTool(server, app, token, "cfman_list_accounts", "List the Cloudflare account pool, zones, tunnel limits, and allocated tunnels, optionally filtering account names case-insensitively.", {
    ...mcpNameFilterFields
  }, (args) => {
    const params = new URLSearchParams();
    setNameFilterParams(params, args);
    return callApi(app, token, "GET", `/api/accounts?${params}`);
  });
  registerApiTool(server, app, token, "cfman_validate_cloudflare_token", "Validate a Cloudflare API token before adding or replacing an account.", {
    cfAccountId: z.string().min(1),
    apiToken: z.string().min(1)
  }, (args) => callApi(app, token, "POST", "/api/accounts/validate-token", args));
  registerApiTool(server, app, token, "cfman_list_tenant_codes", "List every distinct tenant code assigned to at least one tunnel, sorted alphabetically. Use to populate a tenant-code picker before filtering tunnels.", {}, () => callApi(app, token, "GET", "/api/tunnels/tenant-codes"));
  registerApiTool(server, app, token, "cfman_list_tunnels", "List tunnels with display-name, tenant-code, tunnel-status, enrollment-status, broad search, and pagination filters.", {
    ...mcpNameFilterFields,
    name: z.string().trim().min(1).max(160).optional().describe("Matches tunnel display name or tunnel code, case-insensitively"),
    search: z.string().optional(),
    tenantCode: z.string().optional().describe("Case-insensitive tenant code substring"),
    status: z.string().optional().describe("Backward-compatible alias for enrollment status"),
    cfTunnelStatus: z.string().optional(),
    enrollmentStatus: z.string().optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(5).max(100).default(25)
  }, (args) => {
    const params = new URLSearchParams();
    setNameFilterParams(params, args);
    if (args.search) params.set("search", args.search);
    if (args.tenantCode) params.set("tenantCode", args.tenantCode);
    if (args.status) params.set("status", args.status);
    if (args.cfTunnelStatus) params.set("cfTunnelStatus", args.cfTunnelStatus);
    if (args.enrollmentStatus) params.set("enrollmentStatus", args.enrollmentStatus);
    params.set("page", String(args.page));
    params.set("pageSize", String(args.pageSize));
    return callApi(app, token, "GET", `/api/tunnels?${params}`);
  });
  registerApiTool(server, app, token, "cfman_get_tunnel", "Read a complete tunnel detail including connectivity, enrollments, command agent, and script execution history.", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}`));
  registerApiTool(server, app, token, "cfman_get_tunnel_enrollment_history", "Read paginated enrollment history for one tunnel, including machine identity, lifecycle status, installer state, unenrollment state, and log counts.", {
    tunnelId: z.string().uuid(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(5).max(50).default(10)
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}/enrollments?page=${args.page}&pageSize=${args.pageSize}`));
  registerApiTool(server, app, token, "cfman_get_tunnel_delete_preflight", "Check every condition that must be resolved before deleting a tunnel.", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}/delete-preflight`));
  registerApiTool(server, app, token, "cfman_get_enrollment_logs", "Read enrollment, unenrollment, and grouped diagnostic-run logs for one enrollment, including active diagnostic status.", {
    tunnelId: z.string().uuid(),
    enrollmentId: z.string().uuid()
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}/enrollments/${args.enrollmentId}/logs`));
  registerApiTool(server, app, token, "cfman_issue_tunnel_diagnostic", "Create a tracked diagnostic run for the tunnel's active enrollment and return platform-specific commands. The run appears as a separate section in enrollment logs.", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/diagnose`));
  registerApiTool(server, app, token, "cfman_list_scripts", "List saved scripts with pagination, execution statistics, and optional platform and case-insensitive name filters.", {
    ...mcpNameFilterFields,
    platform: z.enum(["windows", "unix"]).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(5).max(100).default(50)
  }, (args) => {
    const params = new URLSearchParams({ page: String(args.page), pageSize: String(args.pageSize) });
    setNameFilterParams(params, args);
    if (args.platform) params.set("platform", args.platform);
    return callApi(app, token, "GET", `/api/scripts?${params}`);
  });
  registerApiTool(server, app, token, "cfman_get_script", "Read a saved script and all immutable versions including source content.", {
    scriptId: z.string().uuid()
  }, (args) => callApi(app, token, "GET", `/api/scripts/${args.scriptId}`));
  registerApiTool(server, app, token, "cfman_get_script_execution_history", "Read paginated executions anchored to a saved script and optionally one immutable version. Results include tunnel, enrollment, execution, script-version, output, status, and timing identifiers.", {
    scriptId: z.string().uuid(),
    version: z.number().int().min(1).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(5).max(50).default(10)
  }, (args) => {
    const params = new URLSearchParams({ page: String(args.page), pageSize: String(args.pageSize) });
    if (args.version) params.set("version", String(args.version));
    return callApi(app, token, "GET", `/api/scripts/${args.scriptId}/executions?${params}`);
  });
  registerApiTool(server, app, token, "cfman_get_bulk_script_executions", "Read grouped bulk executions for a saved script, including run-level statistics and filtered per-tunnel logs.", {
    scriptId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    status: z.enum(["scheduled", "running", "succeeded", "failed", "timed_out", "cancelled"]).optional(),
    tunnelId: z.string().uuid().optional(),
    tunnelSearch: z.string().trim().max(120).optional().describe("Case-insensitive substring across tunnel display name, tenant code, and tunnel code"),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(5).max(100).default(25)
  }, (args) => {
    const { scriptId, runId, ...query } = args;
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
    if (query.status) params.set("status", query.status);
    if (query.tunnelId) params.set("tunnelId", query.tunnelId);
    if (query.tunnelSearch) params.set("tunnelSearch", query.tunnelSearch);
    return callApi(app, token, "GET", `/api/scripts/${scriptId}/bulk-executions${runId ? `/${runId}` : ""}?${params}`);
  });
  registerApiTool(server, app, token, "cfman_get_tunnel_execution_history", "Read paginated command execution history for one tunnel, including saved and inline script snapshots.", {
    tunnelId: z.string().uuid(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(5).max(50).default(10)
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}/command-executions?page=${args.page}&pageSize=${args.pageSize}`));
  registerApiTool(server, app, token, "cfman_get_execution_logs", "Read streamed stdout and stderr lines for one tunnel command execution. Use after to incrementally poll without replaying prior lines.", {
    tunnelId: z.string().uuid(),
    executionId: z.string().uuid(),
    after: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1000).default(500)
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}/command-executions/${args.executionId}/logs?after=${args.after}&limit=${args.limit}`));
  registerApiTool(server, app, token, "cfman_cancel_execution", "Cancel one scheduled or running tunnel command execution by its stable execution identifier.", {
    tunnelId: z.string().uuid(),
    executionId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/command-executions/${args.executionId}/cancel`));
  registerApiTool(server, app, token, "cfman_list_audit_logs", "Read the audit trail shown by the Audit page, optionally filtering action names case-insensitively.", {
    ...mcpNameFilterFields
  }, (args) => {
    const params = new URLSearchParams();
    setNameFilterParams(params, args);
    return callApi(app, token, "GET", `/api/audit?${params}`);
  });
  registerApiTool(server, app, token, "cfman_get_route_waf", "Read a route WAF policy, including the resolved default CFMan source IP.", {
    tunnelId: z.string().uuid(),
    routeId: z.string().uuid()
  }, (args) => callApi(app, token, "GET", `/api/tunnels/${args.tunnelId}/routes/${args.routeId}/waf`));

  registerApiTool(server, app, token, "cfman_create_account", "Create a live or mock Cloudflare account in the account pool and synchronize its zones.", {
    name: z.string().min(2),
    providerMode: z.enum(["live", "mock"]).default("live"),
    cfAccountId: z.string().optional(),
    apiToken: z.string().optional(),
    softTunnelLimit: z.number().int().min(1).max(1000).default(750),
    initialZoneName: z.string().optional(),
    rdpAllowedEmails: z.array(z.string().email()).default([])
  }, (args) => callApi(app, token, "POST", "/api/accounts", args));
  registerApiTool(server, app, token, "cfman_delete_account", "Delete an unused account pool entry; the API rejects accounts still assigned to tunnels.", {
    accountId: z.string().uuid()
  }, (args) => callApi(app, token, "DELETE", `/api/accounts/${args.accountId}`));
  registerApiTool(server, app, token, "cfman_add_zone", "Add a zone allocation under an account.", {
    accountId: z.string().uuid(),
    name: z.string().min(3),
    cfZoneId: z.string().optional(),
    dnsRecordLimit: z.number().int().min(1).default(200),
    softTunnelLimit: z.number().int().min(1).default(150)
  }, (args) => {
    const { accountId, ...body } = args;
    return callApi(app, token, "POST", `/api/accounts/${accountId}/zones`, body);
  });
  registerApiTool(server, app, token, "cfman_update_account_rdp_settings", "Update the account's support emails: the operator email allow-list granted Cloudflare Access to browser-RDP into this account's tunnels.", {
    accountId: z.string().uuid(),
    rdpAllowedEmails: z.array(z.string().email()).min(1)
  }, (args) => {
    const { accountId, ...body } = args;
    return callApi(app, token, "PATCH", `/api/accounts/${accountId}/rdp-settings`, body);
  });
  registerApiTool(server, app, token, "cfman_sync_account", "Synchronize one Cloudflare account's zones, tunnels, and statuses.", {
    accountId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/accounts/${args.accountId}/sync`));
  registerApiTool(server, app, token, "cfman_sync_all_accounts", "Synchronize the complete Cloudflare account pool.", {}, () => callApi(app, token, "POST", "/api/accounts/sync-all"));
  registerApiTool(server, app, token, "cfman_create_tunnel", "Allocate a tunnel to a zone and create one or more subdomains with ordered ingress routes.", {
    tenantCode: z.string().min(1),
    tunnelCode: z.string().min(1),
    displayName: z.string().min(2),
    originUrl: z.string().url().optional(),
    zoneId: z.string().uuid().optional(),
    publications: z.array(publicationSchema).min(1).max(20).optional()
  }, (args) => callApi(app, token, "POST", "/api/tunnels", args));
  registerApiTool(server, app, token, "cfman_update_tunnel_connectivity", "Replace a tunnel's subdomains and ordered ingress routes and apply the tunnel configuration.", {
    tunnelId: z.string().uuid(),
    publications: z.array(publicationSchema).min(1).max(20)
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "PUT", `/api/tunnels/${tunnelId}/connectivity`, body);
  });
  registerApiTool(server, app, token, "cfman_set_route_waf", "Enable or disable a route source-IP allow-list and apply it to the active Cloudflare WAF ruleset.", {
    tunnelId: z.string().uuid(),
    routeId: z.string().uuid(),
    enabled: z.boolean(),
    allowedIps: z.array(z.string().min(1)).default([])
  }, (args) => {
    const { tunnelId, routeId, ...body } = args;
    return callApi(app, token, "PATCH", `/api/tunnels/${tunnelId}/routes/${routeId}/waf`, body);
  });
  registerApiTool(server, app, token, "cfman_reconcile_cfman_self_waf", "For a tunnel that is CFMan's own self-hosted target, backfill any missing remote-agent routes and rebuild the zone's merged WAF rule; reports what was created and any outstanding warning. Fails with 409 if the tunnel is not CFMan's own.", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/reconcile-cfman-self`));
  registerApiTool(server, app, token, "cfman_create_enrollment", "Issue a tunnel enrollment URL and any cleanup commands for an existing connected enrollment.", {
    tunnelId: z.string().uuid(),
    expiresInHours: z.number().int().min(1).max(168).default(24)
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/enrollments`, body);
  });
  registerApiTool(server, app, token, "cfman_revoke_tunnel_enrollments", "Revoke pending or active enrollment records for a tunnel as exposed by the enrollment controls.", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/enrollments/revoke`));
  registerApiTool(server, app, token, "cfman_delete_enrollment", "Hard-delete an unenrolled enrollment, including its logs, following the same rules as the GUI.", {
    tunnelId: z.string().uuid(),
    enrollmentId: z.string().uuid()
  }, (args) => callApi(app, token, "DELETE", `/api/tunnels/${args.tunnelId}/enrollments/${args.enrollmentId}`));
  registerApiTool(server, app, token, "cfman_issue_unenrollment", "Issue unenrollment for the current connected enrollment. Optionally schedule the cleanup through its command agent; the response retains manual fallback URLs plus enrollment and command execution IDs.", {
    tunnelId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    automatic: z.boolean().default(false),
    expiresInHours: z.number().int().min(1).max(168).default(24)
  }, (args) => {
    const { tunnelId, enrollmentId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/unenroll`, body);
  });
  registerApiTool(server, app, token, "cfman_verify_tunnel", "Verify a tunnel, publication, or individual ingress route endpoint.", {
    tunnelId: z.string().uuid(),
    publicationId: z.string().uuid().optional(),
    routeId: z.string().uuid().optional()
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/verify`, body);
  });
  registerApiTool(server, app, token, "cfman_refresh_tunnels", "Refresh endpoint statuses for up to 100 tunnels.", {
    tunnelIds: z.array(z.string().uuid()).min(1).max(100)
  }, (args) => callApi(app, token, "POST", "/api/tunnels/refresh", args));
  registerApiTool(server, app, token, "cfman_retry_rdp", "Re-provision the browser RDP gateway for a tunnel that already had Remote Desktop enabled (use cfman_enable_rdp first if it never has been).", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/rdp/retry`));
  registerApiTool(server, app, token, "cfman_enable_rdp", "Enable Windows Remote Desktop on a tunnel's active enrollment via a remote command through its command agent, then provision the browser RDP gateway. Returns { scheduled: true, executionId } if the agent will report back asynchronously, or the provisioning result directly.", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/rdp/enable`));
  registerApiTool(server, app, token, "cfman_retry_ssh", "Retry browser SSH provisioning for a tunnel that already has an ssh:// ingress route (add one via cfman_update_tunnel_connectivity first if it doesn't).", {
    tunnelId: z.string().uuid()
  }, (args) => callApi(app, token, "POST", `/api/tunnels/${args.tunnelId}/ssh/retry`));
  registerApiTool(server, app, token, "cfman_execute_script", "Schedule a saved script version on the tunnel's command agent. Returns a stable execution/task identifier and scheduled status; poll execution history or logs for running and terminal results.", {
    tunnelId: z.string().uuid(),
    scriptVersionId: z.string().uuid(),
    argumentBindings: argumentBindingsSchema.optional().describe("Per-declared-argument mapping, keyed by argument name: { type: 'custom', value } for a literal value, or { type: 'variable', variable } to bind to one of the tunnel's resolved environment variables (see cfman_resolve_execution_variables). Arguments with no binding use their own declared default value."),
    timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Optional override; omitted uses the saved script default timeout")
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/commands/execute`, body);
  });
  registerApiTool(server, app, token, "cfman_execute_inline_script", "Schedule one named inline script without adding it to the script library. Returns a stable execution/task identifier; source, output, timing, status, and active enrollment are persisted in execution history with an inline tag and no version. Reference declared arguments in the script body as $NAME (a plain script variable), never $env:NAME - argument values are injected as script-scoped variables, not OS/process environment variables.", {
    tunnelId: z.string().uuid(),
    inlineScript: z.string().min(1).max(262144),
    name: z.string().trim().min(1).max(120).optional().describe("Operator-facing name shown beside the inline tag in execution history"),
    language: z.enum(["powershell", "bash", "sh"]).optional().describe("Optional for inline scripts; defaults to PowerShell on Windows and Bash on Unix"),
    arguments: scriptArgumentsSchema.optional().describe("An inline script has no saved version to declare arguments on, so declare them here, ad hoc, for this run only. Bind them with argumentBindings the same way as a saved script's declared arguments. Carried over automatically if this execution is later saved as a script with cfman_save_inline_execution_as_script."),
    argumentBindings: argumentBindingsSchema.optional().describe("Maps each name declared in `arguments` to a value the same way as cfman_execute_script: { type: 'custom', value } or { type: 'variable', variable }. A name with no binding uses its own declared default value."),
    timeoutMs: z.number().int().min(1000).max(300000).optional().default(60000)
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/commands/execute`, body);
  });
  registerApiTool(server, app, token, "cfman_resolve_execution_variables", "List every environment variable available to a tunnel (global, account, zone, tunnel, active-computer scopes, and built-in identity values) along with the script's declared arguments, without running anything or applying any mapping. Script arguments and environment variables are independent until an operator explicitly binds an argument to one of these variable names via argumentBindings on cfman_execute_script / cfman_bulk_execute_script; an argument with no binding uses its own declared default value instead.", {
    tunnelId: z.string().uuid(),
    scriptVersionId: z.string().uuid().optional().describe("Omit for inline scripts, which have no declared arguments")
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/execution-variables/resolve`, body);
  });
  registerApiTool(server, app, token, "cfman_save_inline_execution_as_script", "Save the exact source snapshot from an inline execution as version 1 of a reusable script, carrying over any ad hoc arguments that execution declared. Repeated calls return the same script and version identifiers.", {
    tunnelId: z.string().uuid(),
    executionId: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional().describe("Optional replacement for the inline execution name")
  }, (args) => {
    const { tunnelId, executionId, ...body } = args;
    return callApi(app, token, "POST", `/api/tunnels/${tunnelId}/commands/executions/${executionId}/save-script`, body);
  });
  registerApiTool(server, app, token, "cfman_delete_tunnel", "Delete a tunnel after preflight; force deletion requires the exact display name confirmation and still cleans Cloudflare resources.", {
    tunnelId: z.string().uuid(),
    force: z.boolean().default(false),
    confirmName: z.string().optional()
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "DELETE", `/api/tunnels/${tunnelId}`, body);
  });
  registerApiTool(server, app, token, "cfman_create_script", "Create a reusable Windows or Unix script with immutable version 1. The argument definitions are recorded on version 1. Reference declared arguments in the script body as $NAME (a plain script variable), never $env:NAME - argument values are injected as script-scoped variables, not OS/process environment variables.", {
    name: z.string().min(1),
    platform: z.enum(["windows", "unix"]),
    language: z.enum(["powershell", "bash", "sh"]),
    description: z.string().default(""),
    defaultTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
    arguments: scriptArgumentsSchema.optional(),
    content: z.string().min(1)
  }, (args) => callApi(app, token, "POST", "/api/scripts", args));
  registerApiTool(server, app, token, "cfman_update_script", "Update saved script metadata without changing its immutable versions. Argument definitions belong to a version, so change them with cfman_create_script_version.", {
    scriptId: z.string().uuid(),
    name: z.string().min(1).optional(),
    language: z.enum(["powershell", "bash", "sh"]).optional(),
    description: z.string().optional(),
    defaultTimeoutMs: z.number().int().min(1000).max(300000).optional()
  }, (args) => {
    const { scriptId, ...body } = args;
    return callApi(app, token, "PATCH", `/api/scripts/${scriptId}`, body);
  });
  registerApiTool(server, app, token, "cfman_bulk_execute_script", "Schedule a named, described bulk execution of one saved script version concurrently across selected tunnels or all tunnels matching name/tenant/tunnel/enrollment filters. Each per-tunnel execution starts as scheduled and can be polled or cancelled independently. Each run is an independent, immutable record; running again with the same name does not edit or version the earlier run.", {
    scriptId: z.string().uuid(),
    scriptVersionId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(""),
    timeoutMs: z.number().int().min(1000).max(300000).optional(),
    tunnelIds: z.array(z.string().uuid()).max(5000).optional(),
    excludeTunnelIds: z.array(z.string().uuid()).max(5000).optional().describe("Tunnel ids to exclude from an otherwise matching selectAll run"),
    filters: z.object({
      name: z.string().trim().min(1).max(160).optional().describe("Matches tunnel display name or tunnel code, applied when selectAll is true"),
      nameMatch: z.enum(["exact", "ilike", "regex"]).default("ilike"),
      tenantCode: z.string().optional(),
      cfTunnelStatus: z.string().optional(),
      enrollmentStatus: z.string().optional()
    }).default({ nameMatch: "ilike" }),
    selectAll: z.boolean().default(false),
    argumentBindings: argumentBindingsSchema.optional().describe("Per-declared-argument mapping, keyed by argument name: { type: 'custom', value } for a literal value, or { type: 'variable', variable } to bind to a resolved environment variable - re-resolved per tunnel, so a variable like a tunnel-scoped one can legitimately carry a different value on each target. Arguments with no binding use their own declared default value.")
  }, (args) => {
    const { scriptId, ...body } = args;
    return callApi(app, token, "POST", `/api/scripts/${scriptId}/bulk-execute`, body);
  });
  registerApiTool(server, app, token, "cfman_delete_script", "Permanently delete a saved script, all of its versions, and every related execution history record.", {
    scriptId: z.string().uuid()
  }, (args) => callApi(app, token, "DELETE", `/api/scripts/${args.scriptId}`));
  registerApiTool(server, app, token, "cfman_create_script_version", "Append a new immutable version to a saved script, carrying the argument definitions that version declares. Omitting arguments creates a version with none, so pass the current list when only the content changes. Reference declared arguments in the script body as $NAME (a plain script variable), never $env:NAME - argument values are injected as script-scoped variables, not OS/process environment variables.", {
    scriptId: z.string().uuid(),
    content: z.string().min(1),
    arguments: scriptArgumentsSchema.optional()
  }, (args) => {
    const { scriptId, ...body } = args;
    return callApi(app, token, "POST", `/api/scripts/${scriptId}/versions`, body);
  });
  registerApiTool(server, app, token, "cfman_update_public_base_url", "Update the public HTTPS origin used for enrollment URLs and the MCP endpoint.", {
    publicBaseUrl: z.string().min(1)
  }, (args) => callApi(app, token, "PUT", "/api/settings", args));
  registerApiTool(server, app, token, "cfman_update_global_execution_variables", "Replace the global environment variables inherited by every script execution.", {
    variables: executionVariablesSchema
  }, (args) => callApi(app, token, "PUT", "/api/settings/execution-variables", args));
  registerApiTool(server, app, token, "cfman_update_account_execution_variables", "Replace environment variables inherited by tunnels assigned to one Cloudflare account.", {
    accountId: z.string().uuid(),
    variables: executionVariablesSchema
  }, (args) => {
    const { accountId, ...body } = args;
    return callApi(app, token, "PUT", `/api/accounts/${accountId}/execution-variables`, body);
  });
  registerApiTool(server, app, token, "cfman_update_zone_execution_variables", "Replace environment variables inherited by tunnels assigned to one zone.", {
    accountId: z.string().uuid(),
    zoneId: z.string().uuid(),
    variables: executionVariablesSchema
  }, (args) => {
    const { accountId, zoneId, ...body } = args;
    return callApi(app, token, "PUT", `/api/accounts/${accountId}/zones/${zoneId}/execution-variables`, body);
  });
  registerApiTool(server, app, token, "cfman_update_tunnel_execution_variables", "Replace environment variables inherited by executions for one tunnel.", {
    tunnelId: z.string().uuid(),
    variables: executionVariablesSchema
  }, (args) => {
    const { tunnelId, ...body } = args;
    return callApi(app, token, "PUT", `/api/tunnels/${tunnelId}/execution-variables`, body);
  });
  registerApiTool(server, app, token, "cfman_update_computer_execution_variables", "Replace environment variables for the computer represented by one enrollment. These variables apply while that enrollment is the tunnel's active computer.", {
    tunnelId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    variables: executionVariablesSchema
  }, (args) => {
    const { tunnelId, enrollmentId, ...body } = args;
    return callApi(app, token, "PUT", `/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/execution-variables`, body);
  });

  for (const [name, path] of [
    ["dashboard", "/api/dashboard"],
    ["accounts", "/api/accounts"],
    ["tunnels", "/api/tunnels?page=1&pageSize=100"],
    ["scripts", "/api/scripts"],
    ["audit", "/api/audit"],
    ["settings", "/api/settings"]
  ] as const) {
    server.registerResource(name, `cfman://${name}`, { mimeType: "application/json" }, async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(await callApi(app, token, "GET", path), null, 2) }]
    }));
  }
  return server;
}

async function methodNotAllowed(reply: { hijack: () => void; raw: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void } }): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(405, { "content-type": "application/json" });
  reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mcp", {
    preHandler: requireMcpAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const authorization = request.headers.authorization ?? "";
    const token = authorization.slice(7).trim();
    const server = createMcpServer(app, token);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const socket = request.raw.socket as typeof request.raw.socket & { destroySoon?: () => void };
    if (typeof socket.destroySoon !== "function") {
      socket.destroySoon = () => undefined;
    }
    reply.hijack();
    try {
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed" }, id: null }));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.get("/mcp", { preHandler: requireMcpAuth }, async (_request, reply) => methodNotAllowed(reply));
  app.delete("/mcp", { preHandler: requireMcpAuth }, async (_request, reply) => methodNotAllowed(reply));
}
