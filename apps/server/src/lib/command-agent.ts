import type { PoolClient } from "pg";
import { getPublicBaseUrl } from "./app-settings.js";
import { pool } from "./database.js";
import { createOpaqueToken, decryptSecret, encryptSecret, hashToken } from "./security.js";

export const COMMAND_AGENT_SERVICE_URL = "http://127.0.0.1:47831";

export function automaticUnenrollmentScript(platform: "windows" | "unix", url: string): string {
  if (platform === "windows") {
    const escapedUrl = url.replaceAll("'", "''");
    const delayedCleanup = `$ErrorActionPreference = "Stop"; Start-Sleep -Seconds 2; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm '${escapedUrl}' | iex`;
    const encodedCommand = Buffer.from(delayedCleanup, "utf16le").toString("base64");
    return `$ErrorActionPreference = "Stop"
Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-EncodedCommand","${encodedCommand}" -WindowStyle Hidden
Write-Output "Automatic unenrollment scheduled. The command agent and cloudflared services will stop shortly."
`;
  }
  const delayedCleanup = `sleep 2; curl -fsSL '${url.replaceAll("'", `'\"'\"'`)}' | /bin/sh`;
  return `nohup /bin/sh -c '${delayedCleanup.replaceAll("'", `'\"'\"'`)}' >/tmp/cloudflare-man-unenroll.log 2>&1 &
printf '%s\n' 'Automatic unenrollment scheduled. The command agent and cloudflared services will stop shortly.'
`;
}

type Queryable = Pick<PoolClient, "query">;

export type CommandAgentConfig = {
  tunnelId: string;
  hostname: string;
  path: string;
  endpoint: string;
  token: string;
  status: "pending" | "ready" | "failed";
  lastSeenAt: string | null;
  lastError: string | null;
};

export async function ensureCommandAgentToken(client: Queryable, tunnelId: string): Promise<string> {
  const existing = await client.query("SELECT token_encrypted FROM tunnel_command_agents WHERE tunnel_id = $1", [tunnelId]);
  if (existing.rows[0]?.token_encrypted) return decryptSecret(existing.rows[0].token_encrypted as string);
  const token = createOpaqueToken();
  await client.query(
    `INSERT INTO tunnel_command_agents(tunnel_id, token_encrypted)
     VALUES ($1, $2)
     ON CONFLICT (tunnel_id) DO NOTHING`,
    [tunnelId, encryptSecret(token)]
  );
  const inserted = await client.query("SELECT token_encrypted FROM tunnel_command_agents WHERE tunnel_id = $1", [tunnelId]);
  if (!inserted.rows[0]?.token_encrypted) throw new Error("Unable to initialize the tunnel command agent");
  return decryptSecret(inserted.rows[0].token_encrypted as string);
}

export async function getCommandAgentConfig(tunnelId: string): Promise<CommandAgentConfig | null> {
  const result = await pool.query(
    `SELECT s.id AS tunnel_id, p.hostname, r.path, ca.token_encrypted, ca.status,
            ca.last_seen_at, ca.last_error
       FROM tunnels s
       JOIN tunnel_publications p ON p.tunnel_id = s.id
       JOIN tunnel_routes r ON r.publication_id = p.id AND r.route_kind = 'command_agent'
       JOIN tunnel_command_agents ca ON ca.tunnel_id = s.id
      WHERE s.id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at
      LIMIT 1`,
    [tunnelId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    tunnelId: row.tunnel_id,
    hostname: row.hostname,
    path: row.path,
    endpoint: `https://${row.hostname}${row.path}`,
    token: decryptSecret(row.token_encrypted),
    status: row.status,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error
  };
}

export type CommandExecutionResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type CommandExecutionDispatch = {
  scheduled: boolean;
  executionId: string;
  taskId: string;
  status: "scheduled" | "succeeded" | "failed" | "timed_out";
  result?: CommandExecutionResult;
};

export type CommandExecutionHandle = {
  executionId: string;
  reportToken: string;
};

export async function createCommandExecution(
  input: {
    tunnelId: string;
    enrollmentId: string | null;
    scriptVersionId: string | null;
    requestedBy: string | null;
    script: string;
    timeoutMs: number;
    scriptType: "managed" | "inline";
    scriptName: string;
    scriptPlatform: "windows" | "unix";
    scriptLanguage: "powershell" | "bash" | "sh";
    scriptVersion: number | null;
    environmentVariables?: Record<string, string>;
    argumentSources?: Record<string, unknown>;
    inlineArguments?: unknown[] | undefined;
    bulkExecutionId?: string | null;
    requestedVia?: "web" | "mcp";
  }
): Promise<CommandExecutionHandle> {
  const reportToken = createOpaqueToken();
  const result = await pool.query(
    `INSERT INTO tunnel_command_executions(
       tunnel_id, enrollment_id, script_version_id, requested_by, script, timeout_ms,
       script_type, script_name, script_platform, script_language, script_version_number,
       report_token_hash, bulk_execution_id, environment_variables, argument_sources, inline_arguments,
       requested_via
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      input.tunnelId,
      input.enrollmentId,
      input.scriptVersionId,
      input.requestedBy,
      input.script,
      input.timeoutMs,
      input.scriptType,
      input.scriptName,
      input.scriptPlatform,
      input.scriptLanguage,
      input.scriptVersion,
      hashToken(reportToken),
      input.bulkExecutionId ?? null,
      input.environmentVariables ?? {},
      input.argumentSources ?? {},
      JSON.stringify(input.inlineArguments ?? []),
      input.requestedVia ?? "web"
    ]
  );
  return { executionId: result.rows[0].id as string, reportToken };
}

async function finishCommandExecution(
  executionId: string,
  status: "succeeded" | "failed" | "timed_out",
  startedAt: number,
  result: Partial<CommandExecutionResult> & { error?: string }
): Promise<void> {
  await pool.query(
    `UPDATE tunnel_command_executions
        SET status = $1, finished_at = now(), elapsed_ms = $2, exit_code = $3,
            stdout = $4, stderr = $5, error = $6
      WHERE id = $7 AND status IN ('scheduled', 'running')`,
    [
      status,
      Math.max(0, Date.now() - startedAt),
      typeof result.exitCode === "number" ? result.exitCode : null,
      result.stdout ?? "",
      result.stderr ?? "",
      result.error ?? null,
      executionId
    ]
  );
}

export async function recordCommandExecutionStarted(
  executionId: string,
  reportToken: string,
  taskId: string,
  processId: number
): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE tunnel_command_executions
        SET status = 'running', task_id = $1, process_id = $2,
            started_at = COALESCE(started_at, now()), error = null
      WHERE id = $3 AND report_token_hash = $4 AND status IN ('scheduled', 'running')`,
    [taskId, processId, executionId, hashToken(reportToken)]
  );
  return Boolean(updated.rowCount);
}

export async function recordCommandExecutionReport(
  executionId: string,
  reportToken: string,
  result: CommandExecutionResult & { error?: string; status?: "succeeded" | "failed" | "timed_out" | "cancelled" }
): Promise<boolean> {
  const status = result.status ?? (result.error === "Script timed out" ? "timed_out" : result.success ? "succeeded" : "failed");
  const updated = await pool.query(
    `UPDATE tunnel_command_executions
        SET status = $1, started_at = COALESCE(started_at, now()), finished_at = now(), elapsed_ms = $2,
            exit_code = $3,
            stdout = CASE WHEN EXISTS (SELECT 1 FROM tunnel_command_execution_logs l WHERE l.execution_id = $7 AND l.stream = 'stdout') THEN stdout ELSE $4 END,
            stderr = CASE WHEN EXISTS (SELECT 1 FROM tunnel_command_execution_logs l WHERE l.execution_id = $7 AND l.stream = 'stderr') THEN stderr ELSE $5 END,
            error = $6, reported_at = now()
      WHERE id = $7 AND report_token_hash = $8
        AND (
          status IN ('scheduled', 'running')
          OR status = $1
          OR (status = 'timed_out' AND $1 = 'succeeded')
        )`,
    [
      status,
      Math.max(0, result.durationMs),
      result.exitCode,
      result.stdout,
      result.stderr,
      result.error ?? null,
      executionId,
      hashToken(reportToken)
    ]
  );
  return Boolean(updated.rowCount);
}

export async function cancelCommandExecution(tunnelId: string, executionId: string): Promise<{
  executionId: string;
  taskId: string;
  status: "cancelled";
}> {
  const current = await pool.query(
    `SELECT id, status, COALESCE(task_id, id::text) AS task_id
       FROM tunnel_command_executions
      WHERE id = $1 AND tunnel_id = $2`,
    [executionId, tunnelId]
  );
  const execution = current.rows[0] as { id: string; status: string; task_id: string } | undefined;
  if (!execution) throw new Error("Command execution not found");
  if (!['scheduled', 'running'].includes(execution.status)) {
    throw new Error(`Only scheduled or running executions can be cancelled; current status is ${execution.status}`);
  }
  const agent = await getCommandAgentConfig(tunnelId);
  if (!agent) throw new Error("No command agent route is configured for this tunnel");
  const response = await fetch(`${agent.endpoint.replace(/\/$/, "")}/executions/${executionId}/cancel`, {
    method: "POST",
    headers: { "X-Cloudflare-Man-Agent-Token": agent.token },
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; taskId?: string };
  if (!response.ok && response.status !== 409) {
    throw new Error(payload.error ?? `Command agent returned HTTP ${response.status}`);
  }
  if (response.status === 409) {
    throw new Error(payload.error ?? "The command agent reports that this execution already finished");
  }
  const taskId = payload.taskId ?? execution.task_id;
  const updated = await pool.query(
    `UPDATE tunnel_command_executions
        SET status = 'cancelled', task_id = COALESCE(task_id, $1),
            cancel_requested_at = now(), finished_at = now(),
            elapsed_ms = CASE WHEN started_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int END,
            error = 'Execution cancelled by an operator'
      WHERE id = $2 AND tunnel_id = $3 AND status IN ('scheduled', 'running')
      RETURNING id`,
    [taskId, executionId, tunnelId]
  );
  if (!updated.rowCount) throw new Error("Command execution finished before cancellation was recorded");
  return { executionId, taskId, status: "cancelled" };
}

export async function recordCommandExecutionLog(
  executionId: string,
  reportToken: string,
  stream: "stdout" | "stderr",
  line: string,
  sequence: number | null = null
): Promise<boolean> {
  const result = await pool.query(
    `WITH execution AS (
       SELECT id FROM tunnel_command_executions
        WHERE id = $1 AND report_token_hash = $2
     ), inserted AS (
       INSERT INTO tunnel_command_execution_logs(execution_id, stream, line, sequence)
       SELECT execution.id, $3, $4, $5 FROM execution
       ON CONFLICT (execution_id, sequence) WHERE sequence IS NOT NULL DO NOTHING
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM execution) AS valid,
            EXISTS (SELECT 1 FROM inserted) AS inserted`,
    [executionId, hashToken(reportToken), stream, line, sequence]
  );
  const callback = result.rows[0] as { valid: boolean; inserted: boolean };
  if (!callback.valid) return false;
  if (!callback.inserted) return true;
  // Keep the existing history response useful without making the stream table
  // mandatory for consumers that only read the final execution snapshot.
  await pool.query(
    `UPDATE tunnel_command_executions
        SET ${stream} = LEFT(${stream} || CASE WHEN ${stream} = '' THEN '' ELSE E'\\n' END || $1, 20000)
      WHERE id = $2`,
    [line, executionId]
  );
  return true;
}

// Node's fetch (undici) throws a generic "fetch failed" TypeError for any
// lower-level network failure (DNS, TLS, connection reset) and puts the
// actual reason on `.cause` instead of the message, so surface that detail -
// otherwise every network failure looks identical and undiagnosable.
function describeCommandAgentError(error: unknown): string {
  if (!(error instanceof Error)) return "Command agent request failed";
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return `${error.message}: ${code ? `${code} ` : ""}${cause.message}`.trim();
  }
  return error.message;
}

export async function executeTunnelScript(
  tunnelId: string,
  script: string,
  timeoutMs: number,
  execution?: CommandExecutionHandle
): Promise<CommandExecutionDispatch | null> {
  const agent = await getCommandAgentConfig(tunnelId);
  const startedAt = Date.now();
  if (!agent) {
    if (execution) await finishCommandExecution(execution.executionId, "failed", startedAt, { error: "No command agent route is configured for this tunnel" });
    return null;
  }
  try {
    const publicBaseUrl = execution ? await getPublicBaseUrl() : null;
    const response = await fetch(agent.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Cloudflare-Man-Agent-Token": agent.token
      },
      body: JSON.stringify({
        script,
        timeoutMs,
        ...(execution && publicBaseUrl ? {
          executionId: execution.executionId,
          reportToken: execution.reportToken,
          startUrl: `${publicBaseUrl}/api/public/command-executions/${execution.executionId}/started`,
          reportUrl: `${publicBaseUrl}/api/public/command-executions/${execution.executionId}/report`,
          logUrl: `${publicBaseUrl}/api/public/command-executions/${execution.executionId}/log`
        } : {})
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json().catch(() => ({})) as Partial<CommandExecutionResult> & { error?: string; scheduled?: boolean; taskId?: string; executionId?: string };
    if (!response.ok) throw new Error(payload.error ?? `Command agent returned HTTP ${response.status}`);
    if (response.status === 202 || payload.scheduled) {
      const taskId = payload.taskId ?? execution?.executionId ?? payload.executionId ?? "";
      if (execution) {
        await pool.query(
          `UPDATE tunnel_command_executions SET task_id = $1
            WHERE id = $2 AND status IN ('scheduled', 'running')`,
          [taskId, execution.executionId]
        );
      }
      await pool.query(
        `UPDATE tunnel_command_agents
            SET status = 'ready', last_seen_at = now(), last_error = null, updated_at = now()
          WHERE tunnel_id = $1`,
        [tunnelId]
      );
      return {
        scheduled: true,
        executionId: execution?.executionId ?? payload.executionId ?? "",
        taskId,
        status: "scheduled"
      };
    }
    const result: CommandExecutionResult = {
      success: Boolean(payload.success),
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
      stdout: typeof payload.stdout === "string" ? payload.stdout : "",
      stderr: typeof payload.stderr === "string" ? payload.stderr : "",
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : Date.now() - startedAt
    };
    if (execution) {
      await finishCommandExecution(
        execution.executionId,
        payload.error === "Script timed out" ? "timed_out" : result.success ? "succeeded" : "failed",
        startedAt,
        payload.error ? { ...result, error: payload.error } : result
      );
    }
    await pool.query(
      `UPDATE tunnel_command_agents
          SET status = 'ready', last_seen_at = now(), last_error = null, updated_at = now()
        WHERE tunnel_id = $1`,
      [tunnelId]
    );
    return {
      scheduled: false,
      executionId: execution?.executionId ?? "",
      taskId: execution?.executionId ?? "",
      status: result.success ? "succeeded" : payload.error === "Script timed out" ? "timed_out" : "failed",
      result
    };
  } catch (error) {
    const message = describeCommandAgentError(error);
    if (execution) {
      await finishCommandExecution(
        execution.executionId,
        error instanceof Error && error.name === "TimeoutError" ? "timed_out" : "failed",
        startedAt,
        { error: message }
      );
    }
    await pool.query(
      `UPDATE tunnel_command_agents
          SET status = 'failed', last_error = $1, updated_at = now()
        WHERE tunnel_id = $2`,
      [message, tunnelId]
    );
    throw new Error(message);
  }
}
