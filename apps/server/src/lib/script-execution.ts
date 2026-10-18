import { writeAudit } from "./audit.js";
import { createCommandExecution, executeTunnelScript, getCommandAgentConfig } from "./command-agent.js";
import { pool } from "./database.js";
import {
  applyScriptArguments,
  describeArgumentValueSources,
  resolveArgumentValues,
  resolveAvailableVariablesForTunnel,
  scriptArgumentsSchema,
  type ArgumentBindings,
  type ExecutionVariables,
  type ScriptArgument
} from "./execution-variables.js";

export type ExecuteScriptOnTunnelInput = {
  tunnelId: string;
  scriptVersionId?: string | undefined;
  inlineScript?: string | undefined;
  name?: string | undefined;
  language?: "powershell" | "bash" | "sh" | undefined;
  timeoutMs?: number | undefined;
  arguments?: ScriptArgument[] | undefined;
  argumentBindings?: ArgumentBindings | undefined;
  requestedBy: string | null;
  requestedVia: "web" | "mcp" | "automation";
  // The automation run this execution belongs to, when a rule script asked
  // for it.
  automationRunId?: string | null | undefined;
};

export type ExecuteScriptOnTunnelResult = {
  scheduled: boolean;
  response: Record<string, unknown>;
};

// Carries the HTTP status the API route should answer with, so the single
// implementation below can be shared by the route, MCP, and the automation
// runner without any of them re-deriving "no enrollment" or "wrong platform".
export class ScriptExecutionError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly executionId?: string) {
    super(message);
  }
}

export async function executeScriptOnTunnel(input: ExecuteScriptOnTunnelInput): Promise<ExecuteScriptOnTunnelResult> {
  const tunnelId = input.tunnelId;
  const argumentBindings = input.argumentBindings ?? {};
  const enrollmentResult = await pool.query(
    `SELECT id, platform
       FROM enrollments
      WHERE tunnel_id = $1
        AND status IN ('ready', 'installed')
        AND unenrolled_at IS NULL
        AND deleted_at IS NULL
      ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC
      LIMIT 1`,
    [tunnelId]
  );
  const enrollment = enrollmentResult.rows[0];
  if (!enrollment) throw new ScriptExecutionError(409, "This tunnel has no active enrollment");
  const enrollmentPlatform = enrollment.platform === "windows" ? "windows" : "unix";
  let executionScript: string;
  let scriptType: "managed" | "inline";
  let scriptVersionId: string | null;
  let scriptName: string;
  let scriptVersion: number | null;
  let scriptPlatform: "windows" | "unix";
  let scriptLanguage: "powershell" | "bash" | "sh";
  let scriptId: string | null;
  let scriptArguments: ScriptArgument[] = [];
  let resolvedTimeoutMs = input.timeoutMs ?? 60_000;
  if (input.scriptVersionId) {
    const scriptVersionResult = await pool.query(
      `SELECT v.id, v.content, v.version, v.arguments, s.id AS script_id, s.name, s.platform, s.language,
              s.default_timeout_ms AS "defaultTimeoutMs"
         FROM managed_script_versions v
         JOIN managed_scripts s ON s.id = v.script_id
        WHERE v.id = $1`,
      [input.scriptVersionId]
    );
    const managedScript = scriptVersionResult.rows[0];
    if (!managedScript) throw new ScriptExecutionError(404, "Script version not found");
    if (managedScript.platform !== enrollmentPlatform) {
      throw new ScriptExecutionError(409, `This script is for ${managedScript.platform}, but the active enrollment is ${enrollmentPlatform}`);
    }
    executionScript = managedScript.content;
    scriptType = "managed";
    scriptVersionId = managedScript.id;
    scriptId = managedScript.script_id;
    scriptName = managedScript.name;
    scriptVersion = managedScript.version;
    scriptPlatform = managedScript.platform;
    scriptLanguage = managedScript.language;
    scriptArguments = scriptArgumentsSchema.parse(managedScript.arguments);
    resolvedTimeoutMs = input.timeoutMs ?? managedScript.defaultTimeoutMs;
  } else {
    const inlineLanguage = input.language ?? (enrollmentPlatform === "windows" ? "powershell" : "bash");
    if (enrollmentPlatform === "windows" && inlineLanguage !== "powershell") {
      throw new ScriptExecutionError(409, "Windows inline scripts must use PowerShell");
    }
    if (enrollmentPlatform === "unix" && inlineLanguage === "powershell") {
      throw new ScriptExecutionError(409, "Unix inline scripts must use Bash or sh");
    }
    executionScript = input.inlineScript!;
    scriptType = "inline";
    scriptVersionId = null;
    scriptId = null;
    scriptName = input.name ?? "Inline script";
    scriptVersion = null;
    scriptPlatform = enrollmentPlatform;
    scriptLanguage = inlineLanguage;
    scriptArguments = input.arguments ?? [];
  }
  const agent = await getCommandAgentConfig(tunnelId);
  if (!agent) throw new ScriptExecutionError(409, "No command agent route is configured for this tunnel");
  let argumentValues: ExecutionVariables;
  let argumentSources: ReturnType<typeof describeArgumentValueSources>;
  try {
    const available = await resolveAvailableVariablesForTunnel(tunnelId);
    argumentValues = resolveArgumentValues(scriptArguments, available.variables, argumentBindings);
    argumentSources = describeArgumentValueSources(scriptArguments, available.sources, argumentBindings);
  } catch (error) {
    throw new ScriptExecutionError(409, error instanceof Error ? error.message : "Unable to resolve script arguments");
  }
  const dispatchedScript = applyScriptArguments(executionScript, scriptLanguage, argumentValues);
  const executionHandle = await createCommandExecution({
    tunnelId,
    enrollmentId: enrollment.id,
    scriptVersionId,
    requestedBy: input.requestedBy,
    script: executionScript,
    timeoutMs: resolvedTimeoutMs,
    scriptType,
    scriptName,
    scriptPlatform,
    scriptLanguage,
    scriptVersion,
    environmentVariables: argumentValues,
    argumentSources,
    inlineArguments: scriptType === "inline" ? scriptArguments : undefined,
    requestedVia: input.requestedVia,
    automationRunId: input.automationRunId ?? null
  });
  try {
    const result = await executeTunnelScript(tunnelId, dispatchedScript, resolvedTimeoutMs, executionHandle);
    if (!result) throw new ScriptExecutionError(409, "No command agent route is configured for this tunnel", executionHandle.executionId);
    await writeAudit({
      ...(input.requestedBy ? { actorUserId: input.requestedBy } : {}),
      action: "tunnel.command_executed",
      entityType: "tunnel",
      entityId: tunnelId,
      details: {
        endpoint: agent.endpoint,
        executionId: executionHandle.executionId,
        taskId: result.taskId,
        enrollmentId: enrollment.id,
        scriptType,
        scriptId,
        scriptVersionId,
        timeoutMs: resolvedTimeoutMs,
        argumentNames: Object.keys(argumentValues),
        status: result.status,
        success: result.result?.success ?? null,
        exitCode: result.result?.exitCode ?? null,
        requestedVia: input.requestedVia
      }
    });
    return {
      scheduled: result.scheduled,
      response: {
        executionId: executionHandle.executionId,
        taskId: result.taskId,
        status: result.status,
        scheduled: result.scheduled,
        endpoint: agent.endpoint,
        enrollmentId: enrollment.id,
        scriptType,
        scriptId,
        scriptVersionId,
        scriptName,
        version: scriptVersion,
        platform: scriptPlatform,
        language: scriptLanguage,
        ...(result.result ?? {})
      }
    };
  } catch (error) {
    if (error instanceof ScriptExecutionError) throw error;
    const message = error instanceof Error ? error.message : "Command agent execution failed";
    await writeAudit({
      ...(input.requestedBy ? { actorUserId: input.requestedBy } : {}),
      action: "tunnel.command_executed",
      entityType: "tunnel",
      entityId: tunnelId,
      details: {
        endpoint: agent.endpoint,
        executionId: executionHandle.executionId,
        enrollmentId: enrollment.id,
        scriptType,
        scriptId,
        scriptVersionId,
        timeoutMs: resolvedTimeoutMs,
        success: false,
        error: message,
        requestedVia: input.requestedVia
      }
    });
    throw new ScriptExecutionError(502, message, executionHandle.executionId);
  }
}

export type ExecutionSnapshot = {
  id: string;
  tunnelId: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timeoutMs: number;
  elapsedMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  scriptName: string;
  requestedVia: string;
};

const FINAL_EXECUTION_STATUSES = ["succeeded", "failed", "timed_out", "cancelled", "never_run"];

export async function getExecutionSnapshot(executionId: string): Promise<ExecutionSnapshot | null> {
  const result = await pool.query(
    `SELECT id, tunnel_id AS "tunnelId", status, exit_code AS "exitCode", stdout, stderr, error,
            timeout_ms AS "timeoutMs", elapsed_ms AS "elapsedMs", created_at AS "createdAt",
            started_at AS "startedAt", finished_at AS "finishedAt", script_name AS "scriptName",
            requested_via AS "requestedVia"
       FROM tunnel_command_executions
      WHERE id = $1`,
    [executionId]
  );
  return (result.rows[0] as ExecutionSnapshot | undefined) ?? null;
}

// The command agent reports asynchronously over HTTP, so "run this and tell me
// what it printed" means polling the execution row until it reaches a final
// status. The deadline is the caller's, not the execution's: a script that is
// still running when the caller gives up keeps running and its row is left
// untouched for the normal reporting path to finish.
export async function waitForExecution(
  executionId: string,
  deadlineMs: number,
  pollIntervalMs = 1_000
): Promise<ExecutionSnapshot | null> {
  const deadline = Date.now() + Math.max(0, deadlineMs);
  for (;;) {
    const snapshot = await getExecutionSnapshot(executionId);
    if (!snapshot) return null;
    if (FINAL_EXECUTION_STATUSES.includes(snapshot.status)) return snapshot;
    if (Date.now() >= deadline) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(50, deadline - Date.now()))));
  }
}
