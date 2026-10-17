import { z } from "zod";
import { askOnChannel, MAX_PROMPT_TIMEOUT_MS, MIN_PROMPT_TIMEOUT_MS } from "../notification-prompts.js";
import { getChannelByKey, listChannels, sendChannelMessage } from "../notifications.js";
import { pool } from "../database.js";
import { argumentBindingsSchema } from "../execution-variables.js";
import { executeScriptOnTunnel, getExecutionSnapshot, waitForExecution } from "../script-execution.js";
import { activeEnrollmentPlatformJoin, latestEnrollmentJoin, onboardingStatusExpression } from "../../routes/tunnels.js";

export type AutomationContextOptions = {
  requestedBy: string | null;
  // The run every side effect of this script is attributed to: a message the
  // script sends is listed in the channel log under the run that sent it.
  automationRunId: string | null;
  // Shared budget for everything the script does; context calls refuse to
  // start a new wait once the run's own deadline has passed.
  deadlineAt: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tunnelProjection = `s.id, s.tenant_code AS "tenantCode", s.tunnel_code AS "tunnelCode",
       s.display_name AS "displayName", s.hostname, s.cf_tunnel_status AS "cfTunnelStatus",
       ${onboardingStatusExpression} AS "onboardingStatus",
       active_enrollment.platform AS "platform",
       s.rdp_status AS "rdpStatus", s.ssh_status AS "sshStatus",
       s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt",
       s.last_error AS "lastError", a.name AS "accountName", z.name AS "zoneName"`;

const tunnelFrom = `FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
       ${latestEnrollmentJoin}
       ${activeEnrollmentPlatformJoin}`;

// Everything a context call returns crosses a worker boundary and is then
// compared and serialized by operator JavaScript, so it is normalized to the
// same plain JSON shape the HTTP API would produce (timestamps as ISO
// strings, no pg Date or BigInt instances).
function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

export class AutomationContextError extends Error {}

async function resolveTunnel(reference: unknown): Promise<{ id: string; displayName: string; tunnelCode: string }> {
  const value = typeof reference === "string" ? reference.trim() : "";
  if (!value) throw new AutomationContextError("A tunnel id, tunnel code, or display name is required");
  const result = await pool.query(
    `SELECT id, display_name AS "displayName", tunnel_code AS "tunnelCode"
       FROM tunnels
      WHERE ($1::boolean AND id = $2::uuid) OR tunnel_code = $3 OR lower(display_name) = lower($3)
      ORDER BY (tunnel_code = $3) DESC
      LIMIT 2`,
    [uuidPattern.test(value), uuidPattern.test(value) ? value : null, value]
  );
  if (!result.rowCount) throw new AutomationContextError(`No tunnel matches "${value}"`);
  if (result.rowCount > 1) throw new AutomationContextError(`"${value}" matches more than one tunnel; use the tunnel code or id`);
  return result.rows[0] as { id: string; displayName: string; tunnelCode: string };
}

async function resolveRule(reference: unknown): Promise<{ id: string; key: string; name: string }> {
  const value = typeof reference === "string" ? reference.trim() : "";
  if (!value) throw new AutomationContextError("An automation rule key, id, or name is required");
  const result = await pool.query(
    `SELECT id, key, name
       FROM automation_rules
      WHERE ($1::boolean AND id = $2::uuid) OR key = $3 OR lower(name) = lower($3)
      ORDER BY (key = $3) DESC
      LIMIT 2`,
    [uuidPattern.test(value), uuidPattern.test(value) ? value : null, value]
  );
  if (!result.rowCount) throw new AutomationContextError(`No automation rule matches "${value}"`);
  if (result.rowCount > 1) throw new AutomationContextError(`"${value}" matches more than one automation rule; use the rule key`);
  return result.rows[0] as { id: string; key: string; name: string };
}

// The run history a script reads back is the same history the UI shows, minus
// the output body and logs, which only the single-run read carries.
const runProjection = `run.id, r.key AS "ruleKey", r.name AS "ruleName", run.sequence,
       run.status, run.trigger_source AS "trigger", run_version.version AS "scriptVersion",
       run.output_mime_type AS "outputMimeType", run.error,
       run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.elapsed_ms AS "elapsedMs"`;

const runDetailProjection = `${runProjection}, run.output_body AS "outputBody",
       run.output_truncated AS "outputTruncated", run.logs,
       run.trigger_payload->>'scheduledFor' AS "scheduledFor"`;

const runFrom = `FROM automation_runs run
       JOIN automation_rules r ON r.id = run.rule_id
       LEFT JOIN automation_rule_versions run_version ON run_version.id = run.script_version_id`;

const listRunsSchema = z.object({
  rule: z.string().trim().max(160).optional(),
  status: z.enum(["running", "succeeded", "failed", "timed_out"]).optional(),
  sinceMinutes: z.number().int().min(1).max(60 * 24 * 90).optional(),
  limit: z.number().int().min(1).max(200).default(25)
});

const listTunnelsSchema = z.object({
  search: z.string().trim().max(160).optional(),
  tenantCode: z.string().trim().max(80).optional(),
  onboardingStatus: z.string().trim().max(40).optional(),
  cfTunnelStatus: z.string().trim().max(40).optional(),
  platform: z.enum(["windows", "unix"]).optional(),
  limit: z.number().int().min(1).max(500).default(200)
});

const listExecutionsSchema = z.object({
  tunnel: z.string().trim().max(160).optional(),
  scriptId: z.string().uuid().optional(),
  status: z.enum(["scheduled", "running", "succeeded", "failed", "timed_out", "cancelled", "never_run"]).optional(),
  sinceMinutes: z.number().int().min(1).max(60 * 24 * 90).optional(),
  limit: z.number().int().min(1).max(200).default(25)
});

const executeScriptSchema = z.object({
  tunnel: z.string().trim().min(1).max(160),
  scriptVersionId: z.string().uuid().optional(),
  script: z.string().min(1).max(262_144).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  language: z.enum(["powershell", "bash", "sh"]).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  argumentBindings: argumentBindingsSchema.default({}),
  wait: z.boolean().default(true)
}).superRefine((value, context) => {
  if (Boolean(value.scriptVersionId) === Boolean(value.script)) {
    context.addIssue({ code: "custom", message: "Provide exactly one of scriptVersionId or script" });
  }
  if (value.scriptVersionId && (value.name || value.language)) {
    context.addIssue({ code: "custom", message: "name and language are only accepted for an inline script" });
  }
});

// Single source of truth for what a rule script can call. The editor's
// IntelliSense (as a TypeScript declaration file), the editor's help panel,
// and the MCP tool description are all derived from this list, so a new
// context call is described exactly once. A test keeps the list and the
// methods actually implemented below from drifting apart.
export type AutomationContextMethodDoc = {
  name: string;
  declaration: string;
  description: string;
};

export const AUTOMATION_CONTEXT_METHODS: AutomationContextMethodDoc[] = [
  {
    name: "listTunnels",
    declaration: "listTunnels(filter?: { search?: string; tenantCode?: string; onboardingStatus?: string; cfTunnelStatus?: string; platform?: CfmanPlatform; limit?: number }): Promise<{ tunnels: CfmanTunnel[]; count: number }>",
    description: "Registered tunnels with their Cloudflare status, enrollment status, and active platform."
  },
  {
    name: "getTunnel",
    declaration: "getTunnel(tunnel: string): Promise<{ tunnel: CfmanTunnel & { commandAgent: CfmanCommandAgent | null } }>",
    description: "One tunnel, addressed by id, tunnel code, or display name, plus the state of its command agent."
  },
  {
    name: "listScripts",
    declaration: "listScripts(filter?: { search?: string; platform?: CfmanPlatform; limit?: number }): Promise<{ scripts: CfmanScript[]; count: number }>",
    description: "Saved scripts with the id of their latest version."
  },
  {
    name: "getScript",
    declaration: "getScript(script: string): Promise<{ script: CfmanScript & { arguments: CfmanScriptArgument[] } }>",
    description: "One saved script, addressed by id or name, including the arguments declared on its latest version."
  },
  {
    name: "executeScript",
    declaration: "executeScript(request: { tunnel: string; scriptVersionId?: string; script?: string; name?: string; language?: CfmanScriptLanguage; timeoutMs?: number; argumentBindings?: Record<string, { type: \"custom\"; value: string } | { type: \"variable\"; variable: string }>; wait?: boolean }): Promise<CfmanExecution & { executionId: string; tunnel: { id: string; displayName: string; tunnelCode: string } }>",
    description: "Runs a saved version (scriptVersionId) or an inline script (script) on one tunnel. With wait, the default, it resolves once the execution reports back or the rule's own timeout runs out."
  },
  {
    name: "getExecution",
    declaration: "getExecution(executionId: string): Promise<{ execution: CfmanExecution }>",
    description: "Current status, exit code, stdout, and stderr of one execution."
  },
  {
    name: "listExecutions",
    declaration: "listExecutions(filter?: { tunnel?: string; scriptId?: string; status?: CfmanExecutionStatus; sinceMinutes?: number; limit?: number }): Promise<{ executions: CfmanExecution[]; count: number }>",
    description: "Recent executions, newest first."
  },
  {
    name: "getExecutionLogs",
    declaration: "getExecutionLogs(executionId: string, options?: { limit?: number }): Promise<{ executionId: string; logs: CfmanExecutionLogLine[]; count: number }>",
    description: "Streamed stdout and stderr lines of one execution."
  },
  {
    name: "getDashboard",
    declaration: "getDashboard(): Promise<{ stats: { totalTunnels: number; healthyTunnels: number; attentionTunnels: number } }>",
    description: "Tunnel health counters."
  },
  {
    name: "listChannels",
    declaration: "listChannels(): Promise<{ channels: CfmanChannel[] }>",
    description: "Notification channels this script can send through."
  },
  {
    name: "listRuns",
    declaration: "listRuns(filter?: { rule?: string; status?: CfmanRunStatus; sinceMinutes?: number; limit?: number }): Promise<{ runs: CfmanRun[]; count: number }>",
    description: "Past runs of automation rules, newest first, each with its own per-rule sequence number. Without a rule filter it spans every rule, including this one."
  },
  {
    name: "getRun",
    declaration: "getRun(rule: string, sequence: number): Promise<{ run: CfmanRunDetail }>",
    description: "One run of one rule, addressed by the rule key and that run's sequence number, including its output body, console logs, and what triggered it."
  },
  {
    name: "getLastRun",
    declaration: "getLastRun(rule: string): Promise<{ run: CfmanRunDetail | null }>",
    description: "The most recent finished run of one rule, or null when it has never finished one. A run still in progress is skipped, so a script asking about its own rule gets the run before itself - which is what comparing against last time needs."
  },
  {
    name: "sendMessage",
    declaration: "sendMessage(channel: string, body: string): Promise<CfmanSentMessage>",
    description: "Sends a message through one channel, addressed by its key, and records it in that channel's log under this run."
  },
  {
    name: "ask",
    declaration: "ask(channel: string, request: { text: string; buttons: Array<string | { label: string; value?: string }>; timeoutMs?: number }): Promise<CfmanAnswer>",
    description: "Asks a question in the chat with one button per choice and waits for someone to press one. It resolves either way: status is \"answered\" with the pressed button's value, or \"timed_out\" when nobody answered in time. Only channels whose supportsButtons is true can be asked, and the wait never outlives the rule's own timeout."
  }
];

// Implemented inside the sandbox worker rather than dispatched to the host,
// so they are declared for the editor but never appear in the RPC method list.
export const AUTOMATION_OUTPUT_HELPERS: AutomationContextMethodDoc[] = [
  { name: "text", declaration: "text(body: unknown): CfmanOutput", description: "Returns the value as text/plain." },
  { name: "json", declaration: "json(value: unknown): CfmanOutput", description: "Returns the value as pretty-printed application/json." },
  { name: "xml", declaration: "xml(body: string): CfmanOutput", description: "Returns the value as application/xml." },
  { name: "output", declaration: "output(body: string, mimeType: string): CfmanOutput", description: "Returns the value with an explicit MIME type." }
];

export const AUTOMATION_CONTEXT_DOCS: Array<{ signature: string; description: string }> = [
  ...AUTOMATION_CONTEXT_METHODS.map((method) => ({ signature: `await cfman.${method.declaration}`, description: method.description })),
  ...AUTOMATION_OUTPUT_HELPERS.map((helper) => ({ signature: `cfman.${helper.declaration}`, description: helper.description })),
  { signature: "await sleep(ms: number): Promise<void>", description: "Pauses inside the rule's own timeout." },
  { signature: "console.log(...values: unknown[])", description: "Writes a line into the run log." }
];

const AUTOMATION_TYPE_PRELUDE = `type CfmanPlatform = "windows" | "unix";
type CfmanScriptLanguage = "powershell" | "bash" | "sh";
type CfmanExecutionStatus = "scheduled" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "never_run";

interface CfmanTunnel {
  id: string;
  tenantCode: string;
  tunnelCode: string;
  displayName: string;
  hostname: string;
  cfTunnelStatus: string;
  onboardingStatus: string;
  /** Platform of the enrollment currently servicing the tunnel, or null when it has none. */
  platform: CfmanPlatform | null;
  rdpStatus: string;
  sshStatus: string;
  lastConnectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  accountName: string;
  zoneName: string;
}

interface CfmanCommandAgent {
  status: "pending" | "ready" | "failed";
  lastSeenAt: string | null;
  lastError: string | null;
}

interface CfmanScript {
  id: string;
  name: string;
  platform: CfmanPlatform;
  language: CfmanScriptLanguage;
  description: string;
  defaultTimeoutMs: number;
  latestVersionId: string | null;
  latestVersion: number | null;
}

interface CfmanScriptArgument {
  name: string;
  defaultValue: string;
  description: string;
  required: boolean;
}

interface CfmanExecution {
  id: string;
  tunnelId: string;
  tunnelDisplayName?: string;
  tunnelCode?: string;
  scriptName: string;
  status: CfmanExecutionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timeoutMs: number;
  elapsedMs: number | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt: string | null;
  requestedVia: "web" | "mcp" | "automation";
}

interface CfmanExecutionLogLine {
  stream: "stdout" | "stderr";
  line: string;
  sequence: number | null;
  createdAt: string;
}

interface CfmanChannel {
  key: string;
  name: string;
  type: string;
  enabled: boolean;
  target: string;
  /** True when this channel can show buttons and report back which one was pressed, which is what cfman.ask needs. */
  supportsButtons: boolean;
  /** How many buttons one question may show on this channel; 0 when it supports none. */
  maxButtons: number;
}

interface CfmanAnswer {
  /** "answered" when a button was pressed, "timed_out" when nobody pressed one in time. */
  status: "answered" | "timed_out";
  /** The value of the button that was pressed, or null when nobody pressed one. */
  value: string | null;
  label: string | null;
  /** Whoever pressed it, as the chat names them (for Telegram, @username); never a CFMan account. */
  answeredBy: string | null;
  answeredAt: string | null;
  /** The recorded question, which stays readable in the channel's history after the run. */
  promptId: string;
  channelKey: string;
}

type CfmanRunStatus = "running" | "succeeded" | "failed" | "timed_out";

interface CfmanRun {
  id: string;
  ruleKey: string;
  ruleName: string;
  /** Counts up per rule across every version of its script; runs are addressed by it. */
  sequence: number;
  status: CfmanRunStatus;
  trigger: "timer" | "manual" | "mcp";
  /** Version of the rule script this run executed. */
  scriptVersion: number | null;
  outputMimeType: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
}

interface CfmanRunDetail extends CfmanRun {
  /** What the script returned, as the run history stores it. */
  outputBody: string;
  outputTruncated: boolean;
  logs: Array<{ at: string; level: "log" | "warn" | "error"; message: string }>;
  /** The scheduled moment a timer run fired for; null for a manual or MCP run. */
  scheduledFor: string | null;
}

interface CfmanSentMessage {
  messageId: string;
  channelKey: string;
  providerMessageId: string | null;
  /** True when the body was longer than the channel's own limit and was cut to fit. */
  truncated: boolean;
}

interface CfmanOutput {
  mimeType: string;
  body: string;
}

interface CfmanTrigger {
  source: "timer" | "manual" | "mcp";
  firedAt: string;
  /** The scheduled moment the timer fired for; absent when a person or MCP started the run. */
  scheduledFor?: string;
}

interface CfmanRule {
  key: string;
  name: string;
  description: string;
}

/** The sandbox implements exactly these console methods; each writes one line into the run log. */
interface CfmanConsole {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
  debug(...values: unknown[]): void;
}`;

function declareMember(member: AutomationContextMethodDoc): string {
  return `  /** ${member.description} */\n  ${member.declaration};`;
}

// The declaration file Monaco loads so that `cfman.` offers exactly the calls
// the sandbox actually provides, with their real parameter and result shapes.
export function automationTypeDefinitions(): string {
  return `${AUTOMATION_TYPE_PRELUDE}

declare const cfman: {
${[...AUTOMATION_CONTEXT_METHODS, ...AUTOMATION_OUTPUT_HELPERS].map(declareMember).join("\n")}
};

/** What started this run. */
declare const trigger: CfmanTrigger;

/** The rule being run. */
declare const rule: CfmanRule;

/** Pauses inside the rule's own timeout. */
declare function sleep(ms: number): Promise<void>;

/** Writes lines into the run log. The sandbox has no DOM, so this is declared here rather than coming from a browser library. */
declare const console: CfmanConsole;
`;
}

// The MCP description of a rule script, built from the same single source as
// the editor's IntelliSense: an agent writing a rule gets the call list and
// the exact shapes it will read back, not a prose summary that can drift.
export function automationScriptToolDescription(): string {
  return [
    "Async JavaScript body that is the whole rule, run in a sandboxed worker (node:vm in a worker thread). It decides for itself what to inspect, what to act on, and what to report; there is no separate condition or action stage.",
    "",
    "Globals: cfman (the calls below), trigger (what started this run), rule (key, name, description), console (writes run log lines), and sleep(ms). There is no process, require, fetch, DOM, or network access of its own - everything the script reaches, it reaches through cfman.",
    "",
    "The returned value becomes the run output: a string becomes text/plain, any other value becomes application/json, and cfman.text/json/xml/output set the MIME type explicitly. Returning nothing records an empty output, which is the normal shape of a run that found nothing to report.",
    "",
    "Context calls:",
    ...AUTOMATION_CONTEXT_METHODS.map((method) => `- await cfman.${method.declaration}\n  ${method.description}`),
    ...AUTOMATION_OUTPUT_HELPERS.map((helper) => `- cfman.${helper.declaration}\n  ${helper.description}`),
    "",
    "Asking a person for a decision, when a channel's supportsButtons is true:",
    "```js",
    "const answer = await cfman.ask(\"ops-alerts\", {",
    "  text: `Restart the agent on ${tunnel.displayName}?`,",
    "  buttons: [{ label: \"Restart\", value: \"restart\" }, { label: \"Skip\", value: \"skip\" }],",
    "  timeoutMs: 120000",
    "});",
    "if (answer.status !== \"answered\" || answer.value !== \"restart\") return `no restart (${answer.status})`;",
    "await cfman.executeScript({ tunnel: tunnel.id, script: \"Restart-Service cloudflared\" });",
    "return `restarted, approved by ${answer.answeredBy}`;",
    "```",
    "The question stays in the chat with its buttons until someone presses one or the timeout passes, and the message is then edited to show the outcome so it cannot be answered twice. The wait is bounded by the rule's own script timeout, so a rule that asks for a decision needs a timeout long enough to cover the answer.",
    "",
    "Every global and every type named above, as TypeScript declarations:",
    "```ts",
    automationTypeDefinitions(),
    "```"
  ].join("\n");
}

export function createAutomationContext(options: AutomationContextOptions) {
  const remainingMs = () => Math.max(0, options.deadlineAt - Date.now());

  const methods: Record<string, (...args: never[]) => Promise<unknown>> = {
    listTunnels: async (input?: unknown) => {
      const query = listTunnelsSchema.parse(input ?? {});
      const values: unknown[] = [];
      const conditions: string[] = ["TRUE"];
      if (query.search) {
        values.push(`%${query.search}%`);
        conditions.push(`(s.tunnel_code ILIKE $${values.length} OR s.tenant_code ILIKE $${values.length} OR s.display_name ILIKE $${values.length} OR s.hostname ILIKE $${values.length})`);
      }
      if (query.tenantCode) { values.push(query.tenantCode); conditions.push(`s.tenant_code = $${values.length}`); }
      if (query.cfTunnelStatus) { values.push(query.cfTunnelStatus); conditions.push(`s.cf_tunnel_status = $${values.length}`); }
      if (query.onboardingStatus) { values.push(query.onboardingStatus); conditions.push(`${onboardingStatusExpression} = $${values.length}`); }
      if (query.platform) { values.push(query.platform); conditions.push(`active_enrollment.platform = $${values.length}`); }
      values.push(query.limit);
      const result = await pool.query(
        `SELECT ${tunnelProjection} ${tunnelFrom}
          WHERE ${conditions.join(" AND ")}
          ORDER BY s.tenant_code, s.tunnel_code
          LIMIT $${values.length}`,
        values
      );
      return toPlainJson({ tunnels: result.rows, count: result.rowCount });
    },

    getTunnel: async (reference?: unknown) => {
      const tunnel = await resolveTunnel(reference);
      const result = await pool.query(
        `SELECT ${tunnelProjection} ${tunnelFrom} WHERE s.id = $1`,
        [tunnel.id]
      );
      const agent = await pool.query(
        `SELECT ca.status, ca.last_seen_at AS "lastSeenAt", ca.last_error AS "lastError"
           FROM tunnel_command_agents ca WHERE ca.tunnel_id = $1`,
        [tunnel.id]
      );
      return toPlainJson({ tunnel: { ...result.rows[0], commandAgent: agent.rows[0] ?? null } });
    },

    listScripts: async (input?: unknown) => {
      const query = z.object({
        search: z.string().trim().max(160).optional(),
        platform: z.enum(["windows", "unix"]).optional(),
        limit: z.number().int().min(1).max(200).default(100)
      }).parse(input ?? {});
      const values: unknown[] = [];
      const conditions: string[] = ["TRUE"];
      if (query.search) { values.push(`%${query.search}%`); conditions.push(`(s.name ILIKE $${values.length} OR s.description ILIKE $${values.length})`); }
      if (query.platform) { values.push(query.platform); conditions.push(`s.platform = $${values.length}`); }
      values.push(query.limit);
      const result = await pool.query(
        `SELECT s.id, s.name, s.platform, s.language, s.description,
                s.default_timeout_ms AS "defaultTimeoutMs",
                latest.id AS "latestVersionId", latest.version AS "latestVersion"
           FROM managed_scripts s
           LEFT JOIN LATERAL (
             SELECT v.id, v.version FROM managed_script_versions v
              WHERE v.script_id = s.id ORDER BY v.version DESC LIMIT 1
           ) latest ON TRUE
          WHERE ${conditions.join(" AND ")}
          ORDER BY s.name
          LIMIT $${values.length}`,
        values
      );
      return toPlainJson({ scripts: result.rows, count: result.rowCount });
    },

    getScript: async (reference?: unknown) => {
      const value = typeof reference === "string" ? reference.trim() : "";
      if (!value) throw new AutomationContextError("A script id or name is required");
      const result = await pool.query(
        `SELECT s.id, s.name, s.platform, s.language, s.description,
                s.default_timeout_ms AS "defaultTimeoutMs",
                latest.id AS "latestVersionId", latest.version AS "latestVersion",
                latest.arguments AS "arguments"
           FROM managed_scripts s
           LEFT JOIN LATERAL (
             SELECT v.id, v.version, v.arguments FROM managed_script_versions v
              WHERE v.script_id = s.id ORDER BY v.version DESC LIMIT 1
           ) latest ON TRUE
          WHERE ($1::boolean AND s.id = $2::uuid) OR lower(s.name) = lower($3)
          LIMIT 2`,
        [uuidPattern.test(value), uuidPattern.test(value) ? value : null, value]
      );
      if (!result.rowCount) throw new AutomationContextError(`No script matches "${value}"`);
      if (result.rowCount > 1) throw new AutomationContextError(`"${value}" matches more than one script; use the script id`);
      return toPlainJson({ script: result.rows[0] });
    },

    executeScript: async (input?: unknown) => {
      const request = executeScriptSchema.parse(input ?? {});
      const tunnel = await resolveTunnel(request.tunnel);
      const execution = await executeScriptOnTunnel({
        tunnelId: tunnel.id,
        scriptVersionId: request.scriptVersionId,
        inlineScript: request.script,
        name: request.name,
        language: request.language,
        timeoutMs: request.timeoutMs,
        argumentBindings: request.argumentBindings,
        requestedBy: options.requestedBy,
        requestedVia: "automation"
      });
      const executionId = execution.response.executionId as string;
      if (!request.wait) return toPlainJson({ ...execution.response, tunnel });
      const snapshot = await waitForExecution(executionId, remainingMs());
      return toPlainJson({ ...execution.response, tunnel, ...(snapshot ?? {}), executionId });
    },

    getExecution: async (executionId?: unknown) => {
      const id = z.string().uuid().parse(executionId);
      const snapshot = await getExecutionSnapshot(id);
      if (!snapshot) throw new AutomationContextError(`No execution with id ${id}`);
      return toPlainJson({ execution: snapshot });
    },

    listExecutions: async (input?: unknown) => {
      const query = listExecutionsSchema.parse(input ?? {});
      const values: unknown[] = [];
      const conditions: string[] = ["TRUE"];
      if (query.tunnel) {
        const tunnel = await resolveTunnel(query.tunnel);
        values.push(tunnel.id);
        conditions.push(`ce.tunnel_id = $${values.length}`);
      }
      if (query.scriptId) {
        values.push(query.scriptId);
        conditions.push(`(executed_version.script_id = $${values.length} OR ce.saved_script_id = $${values.length})`);
      }
      if (query.status) { values.push(query.status); conditions.push(`ce.status = $${values.length}`); }
      if (query.sinceMinutes) { values.push(query.sinceMinutes); conditions.push(`ce.created_at >= now() - ($${values.length}::int * interval '1 minute')`); }
      values.push(query.limit);
      const result = await pool.query(
        `SELECT ce.id, ce.tunnel_id AS "tunnelId", t.display_name AS "tunnelDisplayName", t.tunnel_code AS "tunnelCode",
                COALESCE(executed_script.name, ce.script_name, 'Inline script') AS "scriptName",
                ce.status, ce.exit_code AS "exitCode", ce.stdout, ce.stderr, ce.error,
                ce.timeout_ms AS "timeoutMs", ce.elapsed_ms AS "elapsedMs",
                ce.created_at AS "createdAt", ce.finished_at AS "finishedAt", ce.requested_via AS "requestedVia"
           FROM tunnel_command_executions ce
           JOIN tunnels t ON t.id = ce.tunnel_id
           LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
           LEFT JOIN managed_scripts executed_script ON executed_script.id = executed_version.script_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY ce.created_at DESC
          LIMIT $${values.length}`,
        values
      );
      return toPlainJson({ executions: result.rows, count: result.rowCount });
    },

    getExecutionLogs: async (executionId?: unknown, input?: unknown) => {
      const id = z.string().uuid().parse(executionId);
      const query = z.object({ limit: z.number().int().min(1).max(2000).default(500) }).parse(input ?? {});
      const result = await pool.query(
        `SELECT stream, line, sequence, created_at AS "createdAt"
           FROM tunnel_command_execution_logs
          WHERE execution_id = $1
          ORDER BY COALESCE(sequence, 0), created_at
          LIMIT $2`,
        [id, query.limit]
      );
      return toPlainJson({ executionId: id, logs: result.rows, count: result.rowCount });
    },

    getDashboard: async () => {
      const stats = await pool.query(
        `SELECT count(*)::int AS "totalTunnels",
                (count(*) FILTER (WHERE s.cf_tunnel_status = 'healthy'))::int AS "healthyTunnels",
                (count(*) FILTER (WHERE s.cf_tunnel_status <> 'healthy'))::int AS "attentionTunnels"
           FROM tunnels s`
      );
      return toPlainJson({ stats: stats.rows[0] });
    },

    listRuns: async (input?: unknown) => {
      const query = listRunsSchema.parse(input ?? {});
      const values: unknown[] = [];
      const conditions: string[] = ["TRUE"];
      if (query.rule) {
        const rule = await resolveRule(query.rule);
        values.push(rule.id);
        conditions.push(`run.rule_id = $${values.length}`);
      }
      if (query.status) { values.push(query.status); conditions.push(`run.status = $${values.length}`); }
      if (query.sinceMinutes) { values.push(query.sinceMinutes); conditions.push(`run.started_at >= now() - ($${values.length}::int * interval '1 minute')`); }
      values.push(query.limit);
      const result = await pool.query(
        `SELECT ${runProjection} ${runFrom}
          WHERE ${conditions.join(" AND ")}
          ORDER BY run.started_at DESC
          LIMIT $${values.length}`,
        values
      );
      return toPlainJson({ runs: result.rows, count: result.rowCount });
    },

    getRun: async (ruleReference?: unknown, sequence?: unknown) => {
      const rule = await resolveRule(ruleReference);
      const wanted = z.number().int().min(1).parse(sequence);
      const result = await pool.query(
        `SELECT ${runDetailProjection} ${runFrom}
          WHERE run.rule_id = $1 AND run.sequence = $2`,
        [rule.id, wanted]
      );
      if (!result.rowCount) throw new AutomationContextError(`Rule "${rule.key}" has no run #${wanted}`);
      return toPlainJson({ run: result.rows[0] });
    },

    getLastRun: async (ruleReference?: unknown) => {
      const rule = await resolveRule(ruleReference);
      // A run still in progress is skipped, which is what makes this usable
      // from inside a run: a script asking for its rule's last run means the
      // one before itself, not the one it is sitting in.
      const result = await pool.query(
        `SELECT ${runDetailProjection} ${runFrom}
          WHERE run.rule_id = $1 AND run.status <> 'running'
          ORDER BY run.sequence DESC
          LIMIT 1`,
        [rule.id]
      );
      return toPlainJson({ run: result.rows[0] ?? null });
    },

    sendMessage: async (channelKey?: unknown, body?: unknown) => {
      const input = z.object({
        channel: z.string().trim().min(1).max(64),
        body: z.string().min(1).max(32_000)
      }).parse({ channel: channelKey, body });
      const channel = await getChannelByKey(input.channel);
      if (!channel) throw new AutomationContextError(`No notification channel with key "${input.channel}"`);
      const sent = await sendChannelMessage({
        channel,
        body: input.body,
        automationRunId: options.automationRunId,
        requestedBy: options.requestedBy,
        requestedVia: "automation"
      });
      return toPlainJson({
        messageId: sent.messageId,
        channelKey: sent.channelKey,
        providerMessageId: sent.providerMessageId,
        truncated: sent.truncated
      });
    },

    listChannels: async () => {
      const channels = await listChannels();
      return toPlainJson({
        channels: channels.map((channel) => ({
          key: channel.key,
          name: channel.name,
          type: channel.type,
          enabled: channel.enabled,
          target: channel.target,
          supportsButtons: channel.supportsButtons,
          maxButtons: channel.maxButtons
        }))
      });
    },

    ask: async (channelKey?: unknown, request?: unknown) => {
      const input = z.object({
        channel: z.string().trim().min(1).max(64),
        text: z.string().trim().min(1).max(3_000),
        buttons: z.array(z.union([
          z.string().trim().min(1).max(32),
          z.object({ label: z.string().trim().min(1).max(32), value: z.string().trim().min(1).max(48).optional() })
        ])).min(1).max(10),
        timeoutMs: z.number().int().min(MIN_PROMPT_TIMEOUT_MS).max(MAX_PROMPT_TIMEOUT_MS).default(120_000)
      }).parse({ channel: channelKey, ...(typeof request === "object" && request ? request : {}) });
      const channel = await getChannelByKey(input.channel);
      if (!channel) throw new AutomationContextError(`No notification channel with key "${input.channel}"`);
      // The sandbox is killed when the rule's timeout passes, so the question
      // is given the time that is actually left, minus a moment to close the
      // message out in the chat.
      const budgetMs = remainingMs() - 2_000;
      if (budgetMs < MIN_PROMPT_TIMEOUT_MS) {
        throw new AutomationContextError(`Only ${Math.max(0, Math.round(remainingMs() / 1000))}s of this rule's timeout are left, which is not enough to wait for an answer. Raise the rule's script timeout.`);
      }
      const outcome = await askOnChannel({
        channel,
        body: input.text,
        buttons: input.buttons,
        timeoutMs: Math.min(input.timeoutMs, budgetMs),
        automationRunId: options.automationRunId,
        requestedBy: options.requestedBy,
        requestedVia: "automation"
      });
      if (outcome.status === "failed") throw new AutomationContextError(outcome.error ?? "The question could not be answered");
      return toPlainJson({
        status: outcome.status,
        value: outcome.value,
        label: outcome.label,
        answeredBy: outcome.answeredBy,
        answeredAt: outcome.answeredAt,
        promptId: outcome.promptId,
        channelKey: outcome.channelKey
      });
    }
  };

  return {
    methodNames: Object.keys(methods),
    call: async (method: string, args: unknown[]): Promise<unknown> => {
      const handler = methods[method];
      if (!handler) throw new AutomationContextError(`cfman.${method} is not available`);
      if (remainingMs() <= 0) throw new AutomationContextError("The run deadline passed before this call could start");
      return handler(...(args as never[]));
    }
  };
}
