import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { getPublicBaseUrl } from "../lib/app-settings.js";
import { writeAudit } from "../lib/audit.js";
import { pool, withTransaction } from "../lib/database.js";
import { deprovisionTunnel, tunnelHasActiveCfTunnel, provisionTunnel, withTunnelCloudflareLock } from "../lib/provisioning.js";
import { completeRdpEnableExecution, RDP_ENABLE_SCRIPT_MARKER } from "../lib/rdp.js";
import { ensureCommandAgentWafAllowsCloudflareMan } from "../lib/route-waf.js";
import { decryptSecret, hashToken } from "../lib/security.js";
import { scheduleTunnelVerification, verifyTunnelEndpoints } from "../lib/tunnel-verification.js";
import { automaticUnenrollmentScript, createCommandExecution, ensureCommandAgentToken, executeTunnelScript, getCommandAgentConfig, recordCommandExecutionLog, recordCommandExecutionReport, recordCommandExecutionStarted } from "../lib/command-agent.js";
import { synchronizeAccount } from "./accounts.js";

const tokenParams = z.object({ token: z.string().min(30).max(200) });
const claimSchema = z.object({
  token: z.string().min(30).max(200),
  platform: z.enum(["windows", "linux", "darwin", "unix"]),
  architecture: z.string().max(40).optional(),
  machineName: z.string().max(200).optional(),
  osName: z.string().max(200).optional(),
  osVersion: z.string().max(100).optional(),
  osBuild: z.string().max(100).optional(),
  installId: z.string().max(200).optional(),
  scriptId: z.string().uuid().optional(),
  overrideExisting: z.boolean().default(false),
  previousHostname: z.string().max(253).optional(),
  previousInstallId: z.string().max(200).optional(),
  previousTunnelId: z.string().max(200).optional()
});
const reportSchema = z.object({
  token: z.string().min(30).max(200),
  scriptId: z.string().uuid().optional(),
  platform: z.enum(["windows", "unix"]).optional(),
  status: z.enum(["installed", "failed"]),
  version: z.string().max(80).optional(),
  error: z.string().max(2000).optional(),
  agentReady: z.boolean().optional(),
  agentError: z.string().max(2000).optional(),
  osName: z.string().max(200).optional(),
  osVersion: z.string().max(100).optional(),
  osBuild: z.string().max(100).optional(),
  architecture: z.string().max(40).optional(),
  machineName: z.string().max(200).optional()
});
const logSchema = z.object({
  token: z.string().min(30).max(200),
  scriptId: z.string().uuid().optional(),
  events: z.array(z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    step: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(4000).optional(),
    messageBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(6000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  }).refine((event) => event.message || event.messageBase64, "A log message is required")).min(1).max(50)
});
const unenrollReportSchema = z.object({
  token: z.string().min(30).max(200),
  scriptId: z.string().uuid().optional(),
  platform: z.enum(["windows", "unix"]),
  status: z.enum(["unenrolled", "failed"]),
  error: z.string().max(2000).optional()
});
const commandExecutionReportSchema = z.object({
  token: z.string().min(30).max(200),
  success: z.boolean(),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(20_000).default(""),
  stderr: z.string().max(20_000).default(""),
  durationMs: z.number().int().min(0).max(600_000),
  error: z.string().max(2000).optional(),
  status: z.enum(["succeeded", "failed", "timed_out", "cancelled"]).optional()
});
const commandExecutionStartedSchema = z.object({
  token: z.string().min(30).max(200),
  taskId: z.string().min(1).max(200),
  processId: z.number().int().positive()
});
const commandExecutionLogSchema = z.object({
  token: z.string().min(30).max(200),
  stream: z.enum(["stdout", "stderr"]),
  line: z.string().max(4000),
  sequence: z.number().int().min(0).optional()
});

async function findEnrollment(token: string) {
  const result = await pool.query(
    `SELECT e.id, e.tunnel_id, e.status, e.expires_at, e.install_id, e.claimed_at, e.claimed_by, e.created_by, e.platform,
            e.deleted_at, e.unenrolled_at,
            e.host_info, s.hostname
       FROM enrollments e JOIN tunnels s ON s.id = e.tunnel_id
      WHERE e.token_hash = $1 AND e.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return result.rows[0];
}

async function findUnenrollment(token: string) {
  const result = await pool.query(
    `SELECT e.id, e.tunnel_id, e.status, e.unenroll_token_expires_at, e.unenroll_cf_tunnel_id,
            e.unenroll_reason, e.unenrolled_at, e.deleted_at, s.hostname
       FROM enrollments e JOIN tunnels s ON s.id = e.tunnel_id
      WHERE e.unenroll_token_hash = $1 AND e.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return result.rows[0];
}

async function findDiagnose(token: string) {
  const result = await pool.query(
    `SELECT dr.id AS diagnostic_run_id, dr.status AS diagnostic_run_status,
            dr.expires_at AS diagnose_token_expires_at,
            e.id AS enrollment_id, e.tunnel_id, e.deleted_at, s.hostname
       FROM enrollment_diagnostic_runs dr
       JOIN enrollments e ON e.id = dr.enrollment_id
       JOIN tunnels s ON s.id = e.tunnel_id
      WHERE dr.token_hash = $1 AND dr.status IN ('pending', 'running') AND e.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return result.rows[0];
}

async function startDiagnosticRun(runId: string, platform: "windows" | "unix"): Promise<void> {
  const started = await pool.query(
    `UPDATE enrollment_diagnostic_runs
        SET status = 'running', platform = $2, started_at = COALESCE(started_at, now())
      WHERE id = $1 AND status = 'pending' AND expires_at > now()
      RETURNING enrollment_id`,
    [runId, platform]
  );
  if (!started.rowCount) return;
  await pool.query(
    `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata, phase, diagnostic_run_id)
     VALUES ($1, 'info', 'started', $2, $3::jsonb, 'diagnostic', $4)`,
    [started.rows[0].enrollment_id, `Diagnostic script started on ${platform}`, JSON.stringify({ platform }), runId]
  );
}

async function findEnrollmentScript(enrollmentId: string, scriptKind: "install" | "unenroll", platform: "windows" | "unix") {
  const result = await pool.query(
    `SELECT id, status, started_at, finished_at, last_error
       FROM enrollment_scripts
      WHERE enrollment_id = $1 AND script_kind = $2 AND platform = $3`,
    [enrollmentId, scriptKind, platform]
  );
  return result.rows[0];
}

async function resolveEnrollmentScriptId(
  enrollmentId: string,
  scriptKind: "install" | "unenroll",
  scriptId?: string,
  platform?: "windows" | "unix" | null
): Promise<string | null> {
  const result = await pool.query(
    `SELECT id
       FROM enrollment_scripts
      WHERE enrollment_id = $1 AND script_kind = $2
        AND ($3::uuid IS NULL OR id = $3)
        AND ($4::text IS NULL OR platform = $4)
      ORDER BY created_at
      LIMIT 1`,
    [enrollmentId, scriptKind, scriptId ?? null, platform ?? null]
  );
  return (result.rows[0]?.id as string | undefined) ?? null;
}

function normalizeScriptPlatform(platform: string | null | undefined): "windows" | "unix" | null {
  if (!platform) return null;
  return platform === "windows" ? "windows" : "unix";
}

function noTunnel(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-tunnel, private");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
}

async function commandAgentToken(tunnelId: string): Promise<string> {
  return ensureCommandAgentToken(pool, tunnelId);
}

type PreviousMachineIdentity = {
  hostname: string | undefined;
  installId: string | undefined;
  cfTunnelId: string | undefined;
};

async function reconcileTargetPriorEnrollments(
  tunnelId: string,
  keepEnrollmentId: string,
  requestedBy: string | null,
  previousMachine: PreviousMachineIdentity,
  lockClient?: PoolClient
): Promise<void> {
  const previous = await pool.query(
    `SELECT e.id, e.platform, e.install_id, e.unenroll_token_encrypted,
            e.unenroll_token_expires_at, s.hostname, s.cf_tunnel_id
       FROM enrollments e
       JOIN tunnels s ON s.id = e.tunnel_id
      WHERE tunnel_id = $1
        AND e.id <> $2
        AND e.status IN ('claimed', 'provisioning', 'ready', 'installed')
        AND e.unenrolled_at IS NULL
        AND e.deleted_at IS NULL
      ORDER BY COALESCE(e.installed_at, e.claimed_at, e.created_at) DESC`,
    [tunnelId, keepEnrollmentId]
  );
  if (!previous.rowCount) return;

  const localMatch = previous.rows.find((enrollment) =>
    previousMachine.hostname === enrollment.hostname
    && previousMachine.installId === enrollment.install_id
    && previousMachine.cfTunnelId === enrollment.cf_tunnel_id
  );
  const localCleanupVerified = localMatch && previousMachine.cfTunnelId
    ? await tunnelHasActiveCfTunnel(tunnelId, previousMachine.cfTunnelId).catch(() => false)
    : false;

  for (const enrollment of previous.rows) {
    if (localCleanupVerified && enrollment.id === localMatch.id) continue;
    const platform = normalizeScriptPlatform(enrollment.platform);
    const token = enrollment.unenroll_token_encrypted
      && enrollment.unenroll_token_expires_at
      && new Date(enrollment.unenroll_token_expires_at) > new Date()
      ? decryptSecret(enrollment.unenroll_token_encrypted)
      : null;
    const agent = await getCommandAgentConfig(tunnelId);
    if (!platform || !token || !agent || agent.status !== "ready") {
      await pool.query(
        "UPDATE enrollments SET unenroll_last_error = $1, unenroll_reason = 'override', updated_at = now() WHERE id = $2",
        ["Automatic cleanup could not be scheduled before this enrollment was replaced", enrollment.id]
      );
      continue;
    }
    const scriptId = await resolveEnrollmentScriptId(enrollment.id, "unenroll", undefined, platform);
    if (!scriptId) continue;
    const baseUrl = await getPublicBaseUrl();
    const cleanupUrl = `${baseUrl}/e/${token}/${platform === "windows" ? "unenroll.ps1" : "unenroll.sh"}`;
    const script = automaticUnenrollmentScript(platform, cleanupUrl);
    const executionHandle = await createCommandExecution({
      tunnelId,
      enrollmentId: enrollment.id,
      scriptVersionId: null,
      requestedBy,
      script,
      timeoutMs: 30_000,
      scriptType: "inline",
      scriptName: "Automatic enrollment replacement cleanup",
      scriptPlatform: platform,
      scriptLanguage: platform === "windows" ? "powershell" : "sh",
      scriptVersion: null
    });
    try {
      const result = await executeTunnelScript(tunnelId, script, 30_000, executionHandle);
      await pool.query(
        `UPDATE enrollments
            SET unenroll_reason = 'override', unenroll_last_error = $1, updated_at = now()
          WHERE id = $2`,
        [result?.scheduled || result?.result?.success ? null : result?.result?.stderr || "The command agent did not schedule cleanup", enrollment.id]
      );
    } catch (error) {
      await pool.query(
        "UPDATE enrollments SET unenroll_reason = 'override', unenroll_last_error = $1, updated_at = now() WHERE id = $2",
        [error instanceof Error ? error.message : "Automatic cleanup failed", enrollment.id]
      );
    }
  }

  await deprovisionTunnel(tunnelId, "override", lockClient);
  if (localCleanupVerified) {
    await pool.query(
      `UPDATE enrollments
          SET status = 'unenrolled', unenrolled_at = COALESCE(unenrolled_at, now()),
              unenroll_reason = 'override', unenroll_last_error = null, updated_at = now()
        WHERE id = $1`,
      [localMatch.id]
    );
  }
}

async function reconcilePreviousMachineTunnel(
  targetTunnelId: string,
  keepEnrollmentId: string,
  previousMachine: PreviousMachineIdentity
): Promise<void> {
  if (!previousMachine.hostname || !previousMachine.installId || !previousMachine.cfTunnelId) return;
  const match = await pool.query(
    `SELECT s.id AS tunnel_id, e.id AS enrollment_id
       FROM tunnels s
       JOIN enrollments e ON e.tunnel_id = s.id
      WHERE s.hostname = $1 AND s.id <> $2 AND s.cf_tunnel_id = $3
        AND e.install_id = $4
        AND e.status IN ('claimed', 'provisioning', 'ready', 'installed')
        AND e.unenrolled_at IS NULL AND e.deleted_at IS NULL
      ORDER BY COALESCE(e.installed_at, e.claimed_at, e.created_at) DESC
      LIMIT 1`,
    [previousMachine.hostname, targetTunnelId, previousMachine.cfTunnelId, previousMachine.installId]
  );
  const previous = match.rows[0] as { tunnel_id: string; enrollment_id: string } | undefined;
  if (!previous) return;
  const active = await tunnelHasActiveCfTunnel(previous.tunnel_id, previousMachine.cfTunnelId).catch(() => false);
  if (!active) return;
  await withTunnelCloudflareLock(previous.tunnel_id, async (lockClient) => {
    const stillMatches = await pool.query(
      `SELECT 1 FROM tunnels s JOIN enrollments e ON e.tunnel_id = s.id
        WHERE s.id = $1 AND s.cf_tunnel_id = $2 AND e.id = $3 AND e.install_id = $4
          AND e.unenrolled_at IS NULL AND e.deleted_at IS NULL`,
      [previous.tunnel_id, previousMachine.cfTunnelId, previous.enrollment_id, previousMachine.installId]
    );
    if (!stillMatches.rowCount) return;
    await deprovisionTunnel(previous.tunnel_id, "override", lockClient);
    await pool.query(
      `UPDATE enrollments
          SET status = 'unenrolled', unenrolled_at = COALESCE(unenrolled_at, now()),
              unenroll_reason = 'override', unenroll_last_error = null, updated_at = now()
        WHERE id = $1`,
      [previous.enrollment_id]
    );
    await writeAudit({
      action: "tunnel.enrollment_replaced_from_local_identity",
      entityType: "tunnel",
      entityId: previous.tunnel_id,
      details: { keepEnrollmentId, previousEnrollmentId: previous.enrollment_id, previousTunnelId: previousMachine.cfTunnelId }
    });
  });
}

export function unixAgentProgram(agentToken: string): string {
  return `#!/usr/bin/env python3
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "${agentToken}"
USER_AGENT = "cfman-command-agent/1.0"
MAX_SCRIPT_BYTES = 65536
PORT = 47831
TASK_DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "command-executions")
TASKS = {}
TASKS_LOCK = threading.Lock()
os.makedirs(TASK_DIRECTORY, exist_ok=True)

def task_path(task_id):
    return os.path.join(TASK_DIRECTORY, task_id + ".json")

def write_task_state(task, status, process_id=None):
    payload = {
        "taskId": task["task_id"],
        "executionId": task["execution_id"],
        "processId": process_id,
        "status": status,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    temporary = task_path(task["task_id"]) + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(temporary, task_path(task["task_id"]))

def post_json(url, payload, timeout=10, attempts=3):
    if not isinstance(url, str) or not url:
        return False
    body = json.dumps(payload).encode("utf-8")
    last_error = None
    for attempt in range(attempts):
        try:
            callback = urllib.request.Request(url, data=body, headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": USER_AGENT
            }, method="POST")
            with urllib.request.urlopen(callback, timeout=timeout) as response:
                response.read()
            return True
        except Exception as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(1 if timeout <= 5 else 2)
    print("Command agent callback failed: {}".format(last_error), file=sys.stderr, flush=True)
    return False

def run_execution(request_payload, task):
    started = time.monotonic()
    process = None
    report_token = request_payload.get("reportToken")
    timeout_ms = max(1000, min(int(request_payload.get("timeoutMs", 60000)), 300000))
    stdout_lines = deque(maxlen=2000)
    stderr_lines = deque(maxlen=2000)
    sequence_lock = threading.Lock()
    sequence = [0]
    log_queue = queue.Queue(maxsize=10000)

    def next_sequence():
        with sequence_lock:
            value = sequence[0]
            sequence[0] += 1
            return value

    def report_worker():
        while True:
            item = log_queue.get()
            if item is None:
                log_queue.task_done()
                return
            stream_name, line, item_sequence = item
            post_json(request_payload.get("logUrl"), {
                "token": report_token,
                "stream": stream_name,
                "line": line[:4000],
                "sequence": item_sequence
            }, timeout=5)
            log_queue.task_done()

    def read_stream(pipe, stream_name, collected):
        try:
            for raw_line in iter(pipe.readline, ""):
                line = raw_line.rstrip("\\r\\n")
                collected.append(line)
                log_queue.put((stream_name, line, next_sequence()))
        finally:
            pipe.close()

    reporter = threading.Thread(target=report_worker, daemon=True)
    reporter.start()
    cancelled = task["cancelled"].is_set()
    timed_out = False
    try:
        if not cancelled:
            process = subprocess.Popen(
                ["/bin/sh", "-lc", request_payload["script"]],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                start_new_session=True
            )
            with TASKS_LOCK:
                task["process"] = process
                task["process_id"] = process.pid
                task["status"] = "running"
                cancelled = task["cancelled"].is_set()
                write_task_state(task, "running", process.pid)
            post_json(request_payload.get("startUrl"), {
                "token": report_token,
                "taskId": task["task_id"],
                "processId": process.pid
            })
            if cancelled:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except Exception:
                    process.kill()
            stdout_reader = threading.Thread(target=read_stream, args=(process.stdout, "stdout", stdout_lines), daemon=True)
            stderr_reader = threading.Thread(target=read_stream, args=(process.stderr, "stderr", stderr_lines), daemon=True)
            stdout_reader.start()
            stderr_reader.start()
            try:
                process.wait(timeout=timeout_ms / 1000)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except Exception:
                    process.kill()
                process.wait()
            stdout_reader.join(timeout=10)
            stderr_reader.join(timeout=10)
            cancelled = task["cancelled"].is_set()
    except Exception as error:
        stderr_lines.append(str(error)[:2000])

    log_queue.put(None)
    reporter.join(timeout=30)
    stdout = "\\n".join(stdout_lines)[-20000:]
    stderr = "\\n".join(stderr_lines)[-20000:]
    status = "cancelled" if cancelled else "timed_out" if timed_out else "succeeded" if process is not None and process.returncode == 0 else "failed"
    result_payload = {
        "token": report_token,
        "status": status,
        "success": status == "succeeded",
        "exitCode": None if process is None or status in ("cancelled", "timed_out") else process.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "durationMs": round((time.monotonic() - started) * 1000)
    }
    if status == "cancelled":
        result_payload["error"] = "Script cancelled"
    elif status == "timed_out":
        result_payload["error"] = "Script timed out"
    elif process is None:
        result_payload["error"] = stderr or "Unable to start script"
    post_json(request_payload.get("reportUrl"), result_payload)
    write_task_state(task, status, process.pid if process is not None else None)
    with TASKS_LOCK:
        TASKS.pop(task["task_id"], None)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/health") and self.headers.get("X-Cloudflare-Man-Agent-Token") == TOKEN:
            self.respond(200, {"ready": True})
        elif self.path.endswith("/health"):
            self.respond(401, {"error": "Invalid command agent token"})
        else:
            self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.headers.get("X-Cloudflare-Man-Agent-Token") != TOKEN:
            self.respond(401, {"error": "Invalid command agent token"})
            return
        try:
            path = self.path.split("?", 1)[0].rstrip("/")
            if path.endswith("/cancel") and "/executions/" in path:
                task_id = path.split("/")[-2]
                try:
                    uuid.UUID(task_id)
                except ValueError:
                    self.respond(400, {"error": "Invalid execution task ID"})
                    return
                with TASKS_LOCK:
                    task = TASKS.get(task_id)
                    if task is not None:
                        task["cancelled"].set()
                        task["status"] = "cancelling"
                        process = task.get("process")
                        write_task_state(task, "cancelling", task.get("process_id"))
                    else:
                        process = None
                if task is None:
                    try:
                        with open(task_path(task_id), "r", encoding="utf-8") as handle:
                            previous = json.load(handle)
                        if previous.get("status") in ("succeeded", "failed", "timed_out", "cancelled"):
                            self.respond(409, {"error": "Execution already finished", "taskId": task_id})
                            return
                    except (FileNotFoundError, ValueError):
                        pass
                    self.respond(404, {"error": "Execution task not found"})
                    return
                if process is not None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except Exception:
                        try:
                            process.kill()
                        except Exception:
                            pass
                self.respond(202, {"accepted": True, "taskId": task_id, "status": "cancelling"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_SCRIPT_BYTES + 4096:
                self.respond(413, {"error": "Request is too large"})
                return
            request_payload = json.loads(self.rfile.read(length).decode("utf-8"))
            script = request_payload.get("script")
            execution_id = request_payload.get("executionId")
            if not isinstance(script, str) or not script.strip():
                self.respond(400, {"error": "A script is required"})
                return
            if len(script.encode("utf-8")) > MAX_SCRIPT_BYTES:
                self.respond(413, {"error": "Script is too large"})
                return
            try:
                task_id = str(uuid.UUID(str(execution_id)))
            except ValueError:
                self.respond(400, {"error": "A valid executionId is required"})
                return
            task = {
                "task_id": task_id,
                "execution_id": task_id,
                "process": None,
                "process_id": None,
                "status": "scheduled",
                "cancelled": threading.Event()
            }
            with TASKS_LOCK:
                if task_id in TASKS or os.path.exists(task_path(task_id)):
                    self.respond(409, {"error": "Execution task is already scheduled", "taskId": task_id})
                    return
                TASKS[task_id] = task
                write_task_state(task, "scheduled")
            worker = threading.Thread(target=run_execution, args=(request_payload, task), daemon=True)
            worker.start()
            self.respond(202, {"scheduled": True, "executionId": task_id, "taskId": task_id})
        except Exception as error:
            self.respond(400, {"error": str(error)[:2000]})

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;
}

export function windowsAgentProgram(agentToken: string): string {
  return `param([string]$WorkerPayloadPath)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
$Token = "${agentToken}"
$Port = 47831
$TaskDirectory = Join-Path (Split-Path -Parent $PSCommandPath) "command-executions"
New-Item -ItemType Directory -Path $TaskDirectory -Force | Out-Null

function Get-TaskStatePath([string]$TaskId) {
  return Join-Path $TaskDirectory "$TaskId.json"
}

function Get-WorkerProcessPath([string]$TaskId) {
  return Join-Path $TaskDirectory "$TaskId.worker.pid"
}

function Write-TaskState([string]$TaskId, [string]$ExecutionId, [string]$Status, $WorkerProcessId, $ProcessId) {
  $path = Get-TaskStatePath $TaskId
  $temporary = "$path.$PID.tmp"
  @{
    taskId = $TaskId
    executionId = $ExecutionId
    workerProcessId = $WorkerProcessId
    processId = $ProcessId
    status = $Status
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  } | ConvertTo-Json -Compress | Set-Content -Path $temporary -Encoding UTF8
  Move-Item -Path $temporary -Destination $path -Force
}

function Send-JsonCallback([string]$Url, $Payload, [int]$TimeoutSeconds = 10) {
  if ([string]::IsNullOrWhiteSpace($Url)) { return }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body ($Payload | ConvertTo-Json -Compress -Depth 5) -TimeoutSec $TimeoutSeconds | Out-Null
      return
    } catch {
      if ($attempt -lt 3) { Start-Sleep -Seconds $(if ($TimeoutSeconds -le 5) { 1 } else { 2 }) }
    }
  }
}

function Send-JsonResponse($Context, [int]$StatusCode, $Payload) {
  $json = $Payload | ConvertTo-Json -Compress -Depth 5
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "application/json"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.Close()
}

function Send-ExecutionLogLine([string]$Url, [string]$ReportToken, [string]$Stream, [string]$Line, [int]$Sequence) {
  if ([string]::IsNullOrWhiteSpace($Url) -or [string]::IsNullOrWhiteSpace($ReportToken)) { return }
  $payload = @{ token = $ReportToken; stream = $Stream; line = $Line.Substring(0, [Math]::Min($Line.Length, 4000)); sequence = $Sequence } | ConvertTo-Json -Compress
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body $payload -TimeoutSec 5 | Out-Null
      return
    } catch {
      if ($attempt -lt 3) { Start-Sleep -Seconds 1 }
    }
  }
}

function Invoke-ExecutionWorker([string]$PayloadPath) {
  $request = Get-Content -Path $PayloadPath -Raw | ConvertFrom-Json
  $taskId = ([Guid]([string]$request.executionId)).ToString()
  Write-TaskState $taskId $taskId "scheduled" $PID $null
  $started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $timeoutMs = [Math]::Min([Math]::Max([int]$request.timeoutMs, 1000), 300000)
  $script = [string]$request.script
  $executionLogUrl = [string]$request.logUrl
  $executionReportToken = [string]$request.reportToken
  $process = $null
  $stdoutBuilder = New-Object Text.StringBuilder
  $stderrBuilder = New-Object Text.StringBuilder
  $timedOut = $false
  try {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    Write-TaskState $taskId $taskId "running" $PID $process.Id
    Send-JsonCallback ([string]$request.startUrl) @{ token = $executionReportToken; taskId = $taskId; processId = $process.Id }

    $stdoutTask = $process.StandardOutput.ReadLineAsync()
    $stderrTask = $process.StandardError.ReadLineAsync()
    $stdoutDone = $false
    $stderrDone = $false
    $sequence = 0
    while (-not ($process.HasExited -and $stdoutDone -and $stderrDone)) {
      if (-not $stdoutDone -and $stdoutTask.IsCompleted) {
        $line = $stdoutTask.Result
        if ($null -eq $line) { $stdoutDone = $true } else {
          if ($stdoutBuilder.Length -gt 0) { [void]$stdoutBuilder.Append("\`n") }
          [void]$stdoutBuilder.Append($line)
          Send-ExecutionLogLine $executionLogUrl $executionReportToken "stdout" $line $sequence
          $sequence++
          $stdoutTask = $process.StandardOutput.ReadLineAsync()
        }
      }
      if (-not $stderrDone -and $stderrTask.IsCompleted) {
        $line = $stderrTask.Result
        if ($null -eq $line) { $stderrDone = $true } else {
          if ($stderrBuilder.Length -gt 0) { [void]$stderrBuilder.Append("\`n") }
          [void]$stderrBuilder.Append($line)
          Send-ExecutionLogLine $executionLogUrl $executionReportToken "stderr" $line $sequence
          $sequence++
          $stderrTask = $process.StandardError.ReadLineAsync()
        }
      }
      if (-not $process.HasExited -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started) -ge $timeoutMs) {
        $timedOut = $true
        & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
      }
      Start-Sleep -Milliseconds 25
    }
    $process.WaitForExit()
  } catch {
    [void]$stderrBuilder.Append($_.Exception.Message)
  }

  $stdout = $stdoutBuilder.ToString()
  $stderr = $stderrBuilder.ToString()
  if ($stdout.Length -gt 20000) { $stdout = $stdout.Substring($stdout.Length - 20000) }
  if ($stderr.Length -gt 20000) { $stderr = $stderr.Substring($stderr.Length - 20000) }
  $status = if ($timedOut) { "timed_out" } elseif ($process -and $process.ExitCode -eq 0) { "succeeded" } else { "failed" }
  $result = @{
    token = $executionReportToken
    status = $status
    success = ($status -eq "succeeded")
    exitCode = if ($timedOut -or -not $process) { $null } else { $process.ExitCode }
    stdout = $stdout
    stderr = $stderr
    durationMs = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started)
  }
  if ($timedOut) { $result.error = "Script timed out" }
  elseif (-not $process) { $result.error = if ($stderr) { $stderr } else { "Unable to start script" } }
  Write-TaskState $taskId $taskId $status $PID $(if ($process) { $process.Id } else { $null })
  Send-JsonCallback ([string]$request.reportUrl) $result
  Remove-Item -Path $PayloadPath -Force -ErrorAction SilentlyContinue
  Remove-Item -Path (Get-WorkerProcessPath $taskId) -Force -ErrorAction SilentlyContinue
}

if (-not [string]::IsNullOrWhiteSpace($WorkerPayloadPath)) {
  try { Invoke-ExecutionWorker $WorkerPayloadPath } catch { }
  exit
}

$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:$Port/")
$Listener.Start()

while ($true) {
  $context = $Listener.GetContext()
  try {
    $path = $context.Request.Url.AbsolutePath
    if ($context.Request.HttpMethod -eq "GET" -and $path.EndsWith("/health") -and $context.Request.Headers["X-Cloudflare-Man-Agent-Token"] -eq $Token) {
      Send-JsonResponse $context 200 @{ ready = $true }
      continue
    }
    if ($context.Request.HttpMethod -eq "GET" -and $path.EndsWith("/health")) {
      Send-JsonResponse $context 401 @{ error = "Invalid command agent token" }
      continue
    }
    if ($context.Request.HttpMethod -ne "POST") {
      Send-JsonResponse $context 404 @{ error = "Not found" }
      continue
    }
    if ($context.Request.Headers["X-Cloudflare-Man-Agent-Token"] -ne $Token) {
      Send-JsonResponse $context 401 @{ error = "Invalid command agent token" }
      continue
    }
    $cancelMatch = [regex]::Match($path, "/executions/([0-9a-fA-F-]{36})/cancel/?$")
    if ($cancelMatch.Success) {
      $taskId = ([Guid]$cancelMatch.Groups[1].Value).ToString()
      $statePath = Get-TaskStatePath $taskId
      if (-not (Test-Path $statePath)) {
        Send-JsonResponse $context 404 @{ error = "Execution task not found" }
        continue
      }
      $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
      if (@("succeeded", "failed", "timed_out", "cancelled") -contains [string]$state.status) {
        Send-JsonResponse $context 409 @{ error = "Execution already finished"; taskId = $taskId }
        continue
      }
      $workerProcessId = $state.workerProcessId
      $workerProcessPath = Get-WorkerProcessPath $taskId
      if (-not $workerProcessId -and (Test-Path $workerProcessPath)) {
        $workerProcessId = [int](Get-Content -Path $workerProcessPath -Raw)
      }
      Write-TaskState $taskId $taskId "cancelling" $workerProcessId $state.processId
      if ($workerProcessId) {
        $workerProcessId = [int]$workerProcessId
        & taskkill.exe /PID $workerProcessId /T /F 2>&1 | Out-Null
      }
      Remove-Item -Path (Join-Path $TaskDirectory "$taskId.payload.json") -Force -ErrorAction SilentlyContinue
      Remove-Item -Path $workerProcessPath -Force -ErrorAction SilentlyContinue
      Write-TaskState $taskId $taskId "cancelled" $workerProcessId $state.processId
      Send-JsonResponse $context 202 @{ accepted = $true; taskId = $taskId; status = "cancelling" }
      continue
    }
    $reader = New-Object IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
    $body = $reader.ReadToEnd()
    $reader.Close()
    if ($body.Length -gt 70000) { Send-JsonResponse $context 413 @{ error = "Request is too large" }; continue }
    $request = $body | ConvertFrom-Json
    $script = [string]$request.script
    if ([string]::IsNullOrWhiteSpace($script)) { Send-JsonResponse $context 400 @{ error = "A script is required" }; continue }
    if ($script.Length -gt 65536) { Send-JsonResponse $context 413 @{ error = "Script is too large" }; continue }
    try { $taskId = ([Guid]([string]$request.executionId)).ToString() } catch { Send-JsonResponse $context 400 @{ error = "A valid executionId is required" }; continue }
    $statePath = Get-TaskStatePath $taskId
    if (Test-Path $statePath) {
      $existing = Get-Content -Path $statePath -Raw | ConvertFrom-Json
      if (@("scheduled", "running", "cancelling") -contains [string]$existing.status) {
        Send-JsonResponse $context 409 @{ error = "Execution task is already scheduled"; taskId = $taskId }
        continue
      }
    }
    $payloadPath = Join-Path $TaskDirectory "$taskId.payload.json"
    $body | Set-Content -Path $payloadPath -Encoding UTF8
    Write-TaskState $taskId $taskId "scheduled" $null $null
    $worker = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "\`"$PSCommandPath\`"", "-WorkerPayloadPath", "\`"$payloadPath\`"") -WindowStyle Hidden -PassThru
    $workerProcessPath = Get-WorkerProcessPath $taskId
    [string]$worker.Id | Set-Content -Path $workerProcessPath -Encoding ASCII
    $latestState = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if (@("succeeded", "failed", "timed_out", "cancelled") -contains [string]$latestState.status) {
      Remove-Item -Path $workerProcessPath -Force -ErrorAction SilentlyContinue
    }
    Send-JsonResponse $context 202 @{ scheduled = $true; executionId = $taskId; taskId = $taskId }
  } catch {
    try { Send-JsonResponse $context 400 @{ error = $_.Exception.Message } } catch { }
  }
}
`;
}

export function shellScript(token: string, hostname: string, publicBaseUrl: string, agentToken: string, scriptId: string): string {
  const claimUrl = `${publicBaseUrl}/api/public/enrollments/claim`;
  const reportUrl = `${publicBaseUrl}/api/public/enrollments/report`;
  return `#!/usr/bin/env bash
set -euo pipefail

ENROLLMENT_TOKEN='${token}'
SCRIPT_ID='${scriptId}'
CLOUDFLARED_VERSION='${config.CLOUDFLARED_VERSION}'
CLAIM_URL='${claimUrl}'
REPORT_URL='${reportUrl}'
LOG_URL='${publicBaseUrl}/api/public/enrollments/logs'
ASSIGNED_HOSTNAME='${hostname}'
AGENT_TOKEN='${agentToken}'
REPORT_SENT=0
TEMP_DIR=""
OS_DISPLAY_NAME="unknown"
OS_VERSION="unknown"
OS_BUILD="unknown"
MACHINE_ARCH="unknown"
MACHINE_NAME="unknown"
PREVIOUS_HOSTNAME=""

send_log() {
  level="$1"
  step="$2"
  message="$(printf '%s' "$3" | cut -c1-3500)"
  encoded_message="$(printf '%s' "$message" | base64 | tr -d '\r\n')"
  curl --silent --show-error --fail --max-time 10 -X POST "$LOG_URL" -H 'Content-Type: application/json' --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"events\\":[{\\"level\\":\\"$level\\",\\"step\\":\\"$step\\",\\"messageBase64\\":\\"$encoded_message\\"}]}" >/dev/null 2>&1 || true
}

log_message() {
  printf '[%s] %s\n' "$2" "$3"
  send_log "$1" "$2" "$3"
}

report_failure() {
  exit_code=$?
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then rm -rf "$TEMP_DIR"; fi
  if [ "$exit_code" -ne 0 ] && [ "$REPORT_SENT" -eq 0 ]; then
    send_log "error" "installer" "Installer exited with code $exit_code"
    curl --silent --show-error --fail --retry 2 --retry-all-errors -X POST "$REPORT_URL" \\
      -H 'Content-Type: application/json' \\
      --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"status\\":\\"failed\\",\\"platform\\":\\"unix\\",\\"error\\":\\"installer exited with code $exit_code\\",\\"osName\\":\\"$OS_DISPLAY_NAME\\",\\"osVersion\\":\\"$OS_VERSION\\",\\"osBuild\\":\\"$OS_BUILD\\",\\"architecture\\":\\"$MACHINE_ARCH\\",\\"machineName\\":\\"$MACHINE_NAME\\"}" >/dev/null || true
  fi
  exit "$exit_code"
}
trap report_failure EXIT
log_message "info" "preflight" "Starting cloudflare-man enrollment for $ASSIGNED_HOSTNAME"

if [ "$(id -u)" -ne 0 ]; then
  log_message "error" "preflight" "Run this installer as root with sudo"
  echo "Run this installer as root (sudo)." >&2
  exit 1
fi

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
MACHINE_ARCH="$(uname -m)"
MACHINE_NAME="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-200)"
[ -n "$MACHINE_NAME" ] || MACHINE_NAME="unknown"
OS_VERSION="$(uname -r)"
OS_BUILD="$OS_VERSION"
if [ "$OS_NAME" = "darwin" ]; then
  OS_DISPLAY_NAME="macOS"
  OS_VERSION="$(sw_vers -productVersion 2>/dev/null || printf '%s' "$OS_VERSION")"
  OS_BUILD="$(sw_vers -buildVersion 2>/dev/null || printf '%s' "$OS_BUILD")"
elif [ "$OS_NAME" = "linux" ]; then
  OS_DISPLAY_NAME="Linux"
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    OS_DISPLAY_NAME="\${PRETTY_NAME:-Linux}"
    OS_VERSION="\${VERSION_ID:-$OS_VERSION}"
    OS_BUILD="\${BUILD_ID:-$OS_BUILD}"
  fi
else
  OS_DISPLAY_NAME="$OS_NAME"
fi
case "$MACHINE_ARCH" in
  x86_64|amd64) CF_ARCH="amd64" ;;
  arm64|aarch64) CF_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $MACHINE_ARCH" >&2; exit 1 ;;
esac

if [ "$OS_NAME" = "linux" ]; then
  STATE_DIR="/var/lib/cfman"
  LEGACY_STATE_DIR="/var/lib/cloudflare-man"
else
  STATE_DIR="/Library/Application Support/cfman"
  LEGACY_STATE_DIR="/Library/Application Support/cloudflare-man"
fi
INSTALL_ID_FILE="$STATE_DIR/install-id"
HOSTNAME_FILE="$STATE_DIR/assigned-hostname"
TUNNEL_ID_FILE="$STATE_DIR/tunnel-id"
LEGACY_INSTALL_ID_FILE="$LEGACY_STATE_DIR/install-id"
LEGACY_HOSTNAME_FILE="$LEGACY_STATE_DIR/assigned-hostname"
LEGACY_TUNNEL_ID_FILE="$LEGACY_STATE_DIR/tunnel-id"
OVERRIDE_EXISTING=false
PREVIOUS_INSTALL_ID=""
PREVIOUS_TUNNEL_ID=""
EXISTING_ENROLLMENT=0
if [ -s "$INSTALL_ID_FILE" ] || [ -s "$LEGACY_INSTALL_ID_FILE" ] || pgrep -x cloudflared >/dev/null 2>&1 \\
  || [ -f /etc/systemd/system/cloudflared.service ] \\
  || [ -f /Library/LaunchDaemons/com.cloudflare.cloudflared.plist ]; then
  EXISTING_ENROLLMENT=1
fi
if [ "$EXISTING_ENROLLMENT" -eq 1 ]; then
  PREVIOUS_HOSTNAME=""
  if [ -s "$HOSTNAME_FILE" ]; then PREVIOUS_HOSTNAME="$(cat "$HOSTNAME_FILE")"; elif [ -s "$LEGACY_HOSTNAME_FILE" ]; then PREVIOUS_HOSTNAME="$(cat "$LEGACY_HOSTNAME_FILE")"; fi
  if [ -s "$INSTALL_ID_FILE" ]; then PREVIOUS_INSTALL_ID="$(cat "$INSTALL_ID_FILE")"; elif [ -s "$LEGACY_INSTALL_ID_FILE" ]; then PREVIOUS_INSTALL_ID="$(cat "$LEGACY_INSTALL_ID_FILE")"; fi
  if [ -s "$TUNNEL_ID_FILE" ]; then PREVIOUS_TUNNEL_ID="$(cat "$TUNNEL_ID_FILE")"; elif [ -s "$LEGACY_TUNNEL_ID_FILE" ]; then PREVIOUS_TUNNEL_ID="$(cat "$LEGACY_TUNNEL_ID_FILE")"; fi
  if [ -n "$PREVIOUS_HOSTNAME" ]; then
    log_message "warn" "existing-enrollment" "Existing enrollment detected for $PREVIOUS_HOSTNAME"
  else
    log_message "warn" "existing-enrollment" "Existing cloudflare-man enrollment or cloudflared service detected"
  fi
  if [ ! -r /dev/tty ]; then
    log_message "error" "existing-enrollment" "Interactive confirmation is required to cleanup and override"
    REPORT_SENT=1
    exit 1
  fi
  printf 'An existing tunnel enrollment was detected. Cleanup and override it? [y/N] ' > /dev/tty
  IFS= read -r CONFIRM_OVERRIDE < /dev/tty
  case "$CONFIRM_OVERRIDE" in
    y|Y|yes|YES)
      log_message "info" "cleanup" "User approved cleanup and override"
      if command -v cloudflared >/dev/null 2>&1; then
        CLEANUP_OUTPUT="$(cloudflared service uninstall 2>&1 || true)"
        if [ -n "$CLEANUP_OUTPUT" ]; then log_message "info" "cleanup" "$CLEANUP_OUTPUT"; fi
      fi
      if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now cfman-command-agent.service >/dev/null 2>&1 || true
        systemctl disable --now cloudflare-man-command-agent.service >/dev/null 2>&1 || true
        rm -f /etc/systemd/system/cfman-command-agent.service /etc/systemd/system/cloudflare-man-command-agent.service
        systemctl daemon-reload >/dev/null 2>&1 || true
      fi
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout system/cfman.command-agent >/dev/null 2>&1 || true
        launchctl bootout system/dev.cfman.command-agent >/dev/null 2>&1 || true
        launchctl bootout system/dev.cloudflare-man.command-agent >/dev/null 2>&1 || true
        rm -f /Library/LaunchDaemons/cfman.command-agent.plist /Library/LaunchDaemons/dev.cfman.command-agent.plist /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist
      fi
      pkill -f "cfman/command-agent.py" >/dev/null 2>&1 || true
      pkill -f "cloudflare-man/command-agent.py" >/dev/null 2>&1 || true
      rm -rf "$STATE_DIR" "$LEGACY_STATE_DIR"
      OVERRIDE_EXISTING=true
      ;;
    *)
      log_message "warn" "cleanup" "User declined cleanup; enrollment cancelled"
      REPORT_SENT=1
      exit 0
      ;;
  esac
fi
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
INSTALL_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || printf '%s-%s' "$(date +%s)" "$$")"
printf '%s' "$INSTALL_ID" > "$INSTALL_ID_FILE"
chmod 600 "$INSTALL_ID_FILE"
log_message "info" "preflight" "Local enrollment state is ready"

if ! command -v cloudflared >/dev/null 2>&1; then
  TEMP_DIR="$(mktemp -d)"
  log_message "info" "download" "Downloading cloudflared $CLOUDFLARED_VERSION for $OS_NAME/$CF_ARCH"
  if [ "$OS_NAME" = "darwin" ]; then
    ARCHIVE="$TEMP_DIR/cloudflared.tgz"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-$CF_ARCH.tgz" -o "$ARCHIVE"
    tar -xzf "$ARCHIVE" -C "$TEMP_DIR"
    install -m 0755 "$TEMP_DIR/cloudflared" /usr/local/bin/cloudflared
  elif [ "$OS_NAME" = "linux" ]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-$CF_ARCH" -o "$TEMP_DIR/cloudflared"
    install -m 0755 "$TEMP_DIR/cloudflared" /usr/local/bin/cloudflared
  else
    echo "Unsupported operating system: $OS_NAME" >&2
    exit 1
  fi
  log_message "info" "download" "cloudflared installed successfully"
fi

log_message "info" "claim" "Claiming enrollment and provisioning the Cloudflare tunnel"
CLAIM_BODY="$(printf '{\\"token\\":\\"%s\\",\\"scriptId\\":\\"%s\\",\\"platform\\":\\"%s\\",\\"architecture\\":\\"%s\\",\\"machineName\\":\\"%s\\",\\"osName\\":\\"%s\\",\\"osVersion\\":\\"%s\\",\\"osBuild\\":\\"%s\\",\\"installId\\":\\"%s\\",\\"overrideExisting\\":%s,\\"previousHostname\\":\\"%s\\",\\"previousInstallId\\":\\"%s\\",\\"previousTunnelId\\":\\"%s\\"}' "$ENROLLMENT_TOKEN" "$SCRIPT_ID" "$OS_NAME" "$MACHINE_ARCH" "$MACHINE_NAME" "$OS_DISPLAY_NAME" "$OS_VERSION" "$OS_BUILD" "$INSTALL_ID" "$OVERRIDE_EXISTING" "$PREVIOUS_HOSTNAME" "$PREVIOUS_INSTALL_ID" "$PREVIOUS_TUNNEL_ID")"
CLAIM_RESPONSE_FILE="$(mktemp)"
CLAIM_CURL_ERROR=0
CLAIM_STATUS="$(curl --silent --show-error --retry 3 --retry-all-errors --output "$CLAIM_RESPONSE_FILE" --write-out '%{http_code}' -X POST "$CLAIM_URL" -H 'Content-Type: application/json' -H 'Accept: text/plain' --data "$CLAIM_BODY")" || CLAIM_CURL_ERROR=$?
CLAIM_RESPONSE="$(cat "$CLAIM_RESPONSE_FILE")"
rm -f "$CLAIM_RESPONSE_FILE"
if [ "$CLAIM_CURL_ERROR" -ne 0 ] || [ "$CLAIM_STATUS" -lt 200 ] || [ "$CLAIM_STATUS" -ge 300 ]; then
  CLAIM_ERROR="Enrollment claim failed with HTTP $CLAIM_STATUS"
  if [ -n "$CLAIM_RESPONSE" ]; then CLAIM_ERROR="$CLAIM_ERROR: $CLAIM_RESPONSE"; fi
  log_message "error" "claim" "$CLAIM_ERROR"
  exit 1
fi
TUNNEL_TOKEN="$(printf '%s\\n' "$CLAIM_RESPONSE" | sed -n '1p')"
CLAIM_AGENT_TOKEN="$(printf '%s\\n' "$CLAIM_RESPONSE" | sed -n '2p')"
CLAIM_TUNNEL_ID="$(printf '%s\\n' "$CLAIM_RESPONSE" | sed -n '3p')"
[ -n "$CLAIM_AGENT_TOKEN" ] && AGENT_TOKEN="$CLAIM_AGENT_TOKEN"
log_message "info" "claim" "Enrollment claimed successfully"
log_message "info" "service" "Installing the cloudflared service"
if ! SERVICE_OUTPUT="$(cloudflared service install "$TUNNEL_TOKEN" 2>&1)"; then
  log_message "error" "service" "$SERVICE_OUTPUT"
  exit 1
fi
if [ -n "$SERVICE_OUTPUT" ]; then log_message "info" "service" "$SERVICE_OUTPUT"; fi
if [ "$OS_NAME" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p /etc/systemd/system/cloudflared.service.d
  rm -f /etc/systemd/system/cloudflared.service.d/10-cloudflare-man-restart.conf
  cat > /etc/systemd/system/cloudflared.service.d/10-cfman-restart.conf <<EOF
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=always
RestartSec=5
EOF
  systemctl daemon-reload
  systemctl enable --now cloudflared.service
  systemctl restart cloudflared.service
elif [ "$OS_NAME" = "darwin" ] && command -v launchctl >/dev/null 2>&1; then
  CLOUDFLARED_PLIST="/Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
  if [ ! -f "$CLOUDFLARED_PLIST" ] || ! command -v plutil >/dev/null 2>&1; then
    log_message "error" "service" "The cloudflared launchd service was not created"
    exit 1
  fi
  plutil -replace RunAtLoad -bool true "$CLOUDFLARED_PLIST" || plutil -insert RunAtLoad -bool true "$CLOUDFLARED_PLIST"
  plutil -replace KeepAlive -bool true "$CLOUDFLARED_PLIST" || plutil -insert KeepAlive -bool true "$CLOUDFLARED_PLIST"
  launchctl bootout system/com.cloudflare.cloudflared >/dev/null 2>&1 || true
  launchctl bootstrap system "$CLOUDFLARED_PLIST"
  launchctl enable system/com.cloudflare.cloudflared
else
  log_message "error" "service" "A supported service manager (systemd or launchd) is required"
  exit 1
fi
VERSION="$(cloudflared --version | head -n 1)"
AGENT_READY=false
AGENT_ERROR=""
AGENT_SCRIPT="$STATE_DIR/command-agent.py"
if ! command -v python3 >/dev/null 2>&1; then
  AGENT_ERROR="python3 is required to run the cloudflare-man command agent"
  log_message "error" "command-agent" "$AGENT_ERROR"
  exit 1
fi
PYTHON_BIN="$(command -v python3)"
log_message "info" "command-agent" "Installing the local command agent"
cat > "$AGENT_SCRIPT" <<'PYTHON'
${unixAgentProgram(agentToken)}
PYTHON
chmod 700 "$AGENT_SCRIPT"
if [ "$OS_NAME" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/cfman-command-agent.service <<EOF
[Unit]
Description=CFMan command agent
After=network.target
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStart=$PYTHON_BIN $AGENT_SCRIPT
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  systemctl disable --now cloudflare-man-command-agent.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/cloudflare-man-command-agent.service
  systemctl daemon-reload
  systemctl enable --now cfman-command-agent.service
elif [ "$OS_NAME" = "darwin" ] && command -v launchctl >/dev/null 2>&1; then
  cat > /Library/LaunchDaemons/cfman.command-agent.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>cfman.command-agent</string>
<key>ProgramArguments</key><array><string>$PYTHON_BIN</string><string>$AGENT_SCRIPT</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/var/log/cfman-command-agent.log</string>
<key>StandardErrorPath</key><string>/var/log/cfman-command-agent.error.log</string>
</dict></plist>
EOF
  launchctl bootout system/dev.cloudflare-man.command-agent >/dev/null 2>&1 || true
  launchctl bootout system/dev.cfman.command-agent >/dev/null 2>&1 || true
  rm -f /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist /Library/LaunchDaemons/dev.cfman.command-agent.plist
  launchctl bootout system/cfman.command-agent >/dev/null 2>&1 || true
  launchctl bootstrap system /Library/LaunchDaemons/cfman.command-agent.plist
  launchctl enable system/cfman.command-agent
else
  log_message "error" "command-agent" "A supported service manager (systemd or launchd) is required"
  exit 1
fi
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --silent --show-error --fail --max-time 2 -H "X-Cloudflare-Man-Agent-Token: $AGENT_TOKEN" http://127.0.0.1:47831/health >/dev/null 2>&1; then AGENT_READY=true; break; fi
  sleep 1
done
if [ "$AGENT_READY" != true ]; then
  AGENT_ERROR="The local command agent did not become ready"
  log_message "error" "command-agent" "$AGENT_ERROR"
  exit 1
fi
log_message "info" "command-agent" "Local command agent is ready"

log_message "info" "report" "Reporting successful installation"
REPORT_FIELDS="\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"status\\":\\"installed\\",\\"platform\\":\\"unix\\",\\"version\\":\\"$VERSION\\",\\"agentReady\\":$AGENT_READY,\\"osName\\":\\"$OS_DISPLAY_NAME\\",\\"osVersion\\":\\"$OS_VERSION\\",\\"osBuild\\":\\"$OS_BUILD\\",\\"architecture\\":\\"$MACHINE_ARCH\\",\\"machineName\\":\\"$MACHINE_NAME\\""
curl --silent --show-error --fail --retry 3 --retry-all-errors -X POST "$REPORT_URL" -H 'Content-Type: application/json' --data "{$REPORT_FIELDS}" >/dev/null
REPORT_SENT=1
printf '%s' "$ASSIGNED_HOSTNAME" > "$HOSTNAME_FILE"
chmod 600 "$HOSTNAME_FILE"
printf '%s' "$CLAIM_TUNNEL_ID" > "$TUNNEL_ID_FILE"
chmod 600 "$TUNNEL_ID_FILE"
log_message "info" "complete" "Tunnel tunnel installed successfully for $ASSIGNED_HOSTNAME"

echo "Tunnel tunnel installed: $ASSIGNED_HOSTNAME"
`;
}

export function powerShellScript(token: string, hostname: string, publicBaseUrl: string, agentToken: string, scriptId: string): string {
  return `$ErrorActionPreference = "Stop"
$EnrollmentToken = "${token}"
$ScriptId = "${scriptId}"
$CloudflaredVersion = "${config.CLOUDFLARED_VERSION}"
$ClaimUrl = "${publicBaseUrl}/api/public/enrollments/claim"
$ReportUrl = "${publicBaseUrl}/api/public/enrollments/report"
$AssignedHostname = "${hostname}"
$AgentToken = "${agentToken}"
$ReportSent = $false
$LogUrl = "${publicBaseUrl}/api/public/enrollments/logs"
$architecture = "unknown"
$osName = "unknown"
$osVersion = "unknown"
$osBuild = "unknown"
$machineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { "unknown" }

function Send-InstallLog {
  param(
    [ValidateSet("debug", "info", "warn", "error")][string]$Level,
    [string]$Step,
    [string]$Message
  )
  if ($Message.Length -gt 3500) { $Message = $Message.Substring(0, 3500) }
  Write-Host "[$Step] $Message"
  try {
    $encodedMessage = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Message))
    $logBody = @{
      token = $EnrollmentToken
      scriptId = $ScriptId
      events = @(@{ level = $Level; step = $Step; messageBase64 = $encodedMessage })
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri $LogUrl -ContentType "application/json" -Body $logBody -TimeoutSec 10 | Out-Null
  } catch {
    Write-Warning "Unable to send installation log: $($_.Exception.Message)"
  }
}

function Get-HttpErrorMessage {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)
  $message = $ErrorRecord.Exception.Message
  try {
    $response = $ErrorRecord.Exception.Response
    $body = $null
    if ($response -and $response.Content) {
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } elseif ($response) {
      $stream = $response.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      }
    }
    if ($body) {
      $payload = $body | ConvertFrom-Json
      if ($payload.error) { return [string]$payload.error }
      return $body
    }
  } catch { }
  return $message
}

try {
Send-InstallLog -Level "info" -Step "preflight" -Message "Starting cloudflare-man enrollment for $AssignedHostname"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Send-InstallLog -Level "error" -Step "preflight" -Message "Run PowerShell as Administrator."
  throw "Run PowerShell as Administrator."
}

$architecture = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
$osInfo = Get-CimInstance Win32_OperatingSystem
$osName = [string]$osInfo.Caption
$osVersion = [string]$osInfo.Version
$osBuild = [string]$osInfo.BuildNumber
$installDirectory = Join-Path $env:ProgramFiles "cloudflared"
$binary = Join-Path $installDirectory "cloudflared.exe"
$stateDirectory = Join-Path $env:ProgramData "cfman"
$legacyStateDirectory = Join-Path $env:ProgramData "cloudflare-man"
$installIdFile = Join-Path $stateDirectory "install-id"
$hostnameFile = Join-Path $stateDirectory "assigned-hostname"
$tunnelIdFile = Join-Path $stateDirectory "tunnel-id"
$legacyInstallIdFile = Join-Path $legacyStateDirectory "install-id"
$legacyHostnameFile = Join-Path $legacyStateDirectory "assigned-hostname"
$legacyTunnelIdFile = Join-Path $legacyStateDirectory "tunnel-id"
$overrideExisting = $false
$previousHostname = ""
$previousInstallId = ""
$previousTunnelId = ""
$existingService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
$existingEnrollment = (Test-Path $installIdFile) -or (Test-Path $legacyInstallIdFile) -or ($null -ne $existingService)
if ($existingEnrollment) {
  $existingLabel = "an existing cfman enrollment or cloudflared service"
  if (Test-Path $hostnameFile) {
    $previousHostname = (Get-Content $hostnameFile -Raw).Trim()
  } elseif (Test-Path $legacyHostnameFile) {
    $previousHostname = (Get-Content $legacyHostnameFile -Raw).Trim()
  }
  if ($previousHostname) { $existingLabel = "the existing enrollment for $previousHostname" }
  if (Test-Path $installIdFile) { $previousInstallId = (Get-Content $installIdFile -Raw).Trim() }
  elseif (Test-Path $legacyInstallIdFile) { $previousInstallId = (Get-Content $legacyInstallIdFile -Raw).Trim() }
  if (Test-Path $tunnelIdFile) { $previousTunnelId = (Get-Content $tunnelIdFile -Raw).Trim() }
  elseif (Test-Path $legacyTunnelIdFile) { $previousTunnelId = (Get-Content $legacyTunnelIdFile -Raw).Trim() }
  Send-InstallLog -Level "warn" -Step "existing-enrollment" -Message "Detected $existingLabel"
  $confirmation = Read-Host "Cleanup and override $existingLabel? [y/N]"
  if ($confirmation -notmatch "^(y|yes)$") {
    Send-InstallLog -Level "warn" -Step "cleanup" -Message "User declined cleanup; enrollment cancelled"
    $ReportSent = $true
    return
  }
  Send-InstallLog -Level "info" -Step "cleanup" -Message "User approved cleanup and override"
  if (Test-Path $binary) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # cloudflared writes informational messages to stderr. PowerShell 5.1
      # turns native stderr into ErrorRecord objects when the global policy is Stop.
      $ErrorActionPreference = "Continue"
      $cleanupOutput = @(& $binary service uninstall 2>&1)
      $cleanupExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $cleanupOutput) { Send-InstallLog -Level "info" -Step "cleanup" -Message $line.ToString() }
    if ($cleanupExitCode -ne 0) {
      $remainingService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
      if ($remainingService) {
        Send-InstallLog -Level "warn" -Step "cleanup" -Message "cloudflared uninstall exited with code $cleanupExitCode; removing the remaining service"
        Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
      }
    }
  } elseif ($existingService) {
    Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
  }
  # cloudflared's own uninstall does not remove this key, and a leftover key makes
  # the next "service install" fail with "Cannot install event logger".
  Remove-Item -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Cloudflared" -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($taskName in @("CFManCommandAgent", "CloudflareManCommandAgent")) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*cfman*command-agent.ps1*" -or $_.CommandLine -like "*cloudflare-man*command-agent.ps1*" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  if (Test-Path $stateDirectory) { Remove-Item $stateDirectory -Recurse -Force }
  if (Test-Path $legacyStateDirectory) { Remove-Item $legacyStateDirectory -Recurse -Force }
  $overrideExisting = $true
}
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
& icacls.exe $stateDirectory /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
$installId = [guid]::NewGuid().ToString()
Set-Content -Path $installIdFile -Value $installId -NoNewline
Send-InstallLog -Level "info" -Step "preflight" -Message "Local enrollment state is ready"

if (-not (Test-Path $binary)) {
  Send-InstallLog -Level "info" -Step "download" -Message "Downloading cloudflared $CloudflaredVersion for windows/$architecture"
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-$architecture.exe"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $binary -UseBasicParsing
  $signature = Get-AuthenticodeSignature $binary
  if ($signature.Status -ne "Valid") {
    Remove-Item $binary -Force
    throw "The cloudflared executable has an invalid Authenticode signature."
  }
  Send-InstallLog -Level "info" -Step "download" -Message "cloudflared downloaded and signature verified"
}

Send-InstallLog -Level "info" -Step "claim" -Message "Claiming enrollment and provisioning the Cloudflare tunnel"
$claimBody = @{
  token = $EnrollmentToken
  scriptId = $ScriptId
  platform = "windows"
  architecture = $architecture
  machineName = $machineName
  osName = $osName
  osVersion = $osVersion
  osBuild = $osBuild
  installId = $installId
  overrideExisting = $overrideExisting
  previousHostname = $previousHostname
  previousInstallId = $previousInstallId
  previousTunnelId = $previousTunnelId
} | ConvertTo-Json
try {
  $claim = Invoke-RestMethod -Method Post -Uri $ClaimUrl -ContentType "application/json" -Body $claimBody
} catch {
  $claimError = Get-HttpErrorMessage -ErrorRecord $_
  Send-InstallLog -Level "error" -Step "claim" -Message $claimError
  throw $claimError
}
Send-InstallLog -Level "info" -Step "claim" -Message "Enrollment claimed successfully"

Send-InstallLog -Level "info" -Step "service" -Message "Installing the cloudflared service"
$previousErrorActionPreference = $ErrorActionPreference
try {
  # cloudflared writes informational messages to stderr. PowerShell 5.1
  # turns native stderr into ErrorRecord objects when the global policy is Stop.
  $ErrorActionPreference = "Continue"
  $serviceOutput = @(& $binary service install $claim.tunnelToken 2>&1)
  $serviceExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
foreach ($line in $serviceOutput) { Send-InstallLog -Level "info" -Step "service" -Message $line.ToString() }
if ($serviceExitCode -ne 0) { throw "cloudflared service installation failed with exit code $serviceExitCode." }
Set-Service -Name "cloudflared" -StartupType Automatic
& sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null
Start-Service -Name "cloudflared" -ErrorAction SilentlyContinue

$agentReady = $false
$agentError = $null
try {
  Send-InstallLog -Level "info" -Step "command-agent" -Message "Installing the local command agent"
  $agentScript = Join-Path $stateDirectory "command-agent.ps1"
  $agentProgram = @'
${windowsAgentProgram(agentToken)}
'@
  Set-Content -Path $agentScript -Value $agentProgram -Encoding UTF8
  $taskName = "CFManCommandAgent"
  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \`"$agentScript\`""
  $taskTrigger = New-ScheduledTaskTrigger -AtStartup
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:47831/health" -Headers @{ "X-Cloudflare-Man-Agent-Token" = $AgentToken } -TimeoutSec 2
      if ($health.ready) { $agentReady = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $agentReady) { throw "The local command agent did not become ready" }
  Send-InstallLog -Level "info" -Step "command-agent" -Message "Local command agent is ready"
} catch {
  $agentError = $_.Exception.Message
  Send-InstallLog -Level "error" -Step "command-agent" -Message $agentError
  throw
}

$reportPayload = @{
  token = $EnrollmentToken
  scriptId = $ScriptId
  platform = "windows"
  status = "installed"
  version = (& $binary --version | Select-Object -First 1)
  agentReady = $agentReady
  osName = $osName
  osVersion = $osVersion
  osBuild = $osBuild
  architecture = $architecture
  machineName = $machineName
}
if ($agentError) { $reportPayload.agentError = $agentError }
$reportBody = $reportPayload | ConvertTo-Json
Send-InstallLog -Level "info" -Step "report" -Message "Reporting successful installation"
Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $reportBody | Out-Null
$ReportSent = $true
Set-Content -Path $hostnameFile -Value $AssignedHostname -NoNewline
Set-Content -Path $tunnelIdFile -Value ([string]$claim.cfTunnelId) -NoNewline
Send-InstallLog -Level "info" -Step "complete" -Message "Tunnel tunnel installed successfully for $AssignedHostname"
Write-Host "Tunnel tunnel installed: $AssignedHostname"
} catch {
  Send-InstallLog -Level "error" -Step "installer" -Message $_.Exception.Message
  if (-not $ReportSent) {
    try {
      $failureBody = @{ token = $EnrollmentToken; scriptId = $ScriptId; platform = "windows"; status = "failed"; error = $_.Exception.Message; osName = $osName; osVersion = $osVersion; osBuild = $osBuild; architecture = $architecture; machineName = $machineName } | ConvertTo-Json
      Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $failureBody | Out-Null
    } catch { }
  }
  throw
}
`;
}

function shellUnenrollScript(token: string, hostname: string, publicBaseUrl: string, scriptId: string): string {
  const claimUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/claim`;
  const reportUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/report`;
  const logUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/logs`;
  return `#!/usr/bin/env bash
set -euo pipefail

UNENROLL_TOKEN='${token}'
SCRIPT_ID='${scriptId}'
CLAIM_URL='${claimUrl}'
REPORT_URL='${reportUrl}'
LOG_URL='${logUrl}'
REPORT_SENT=0

send_log() {
  level="$1"
  message="$(printf '%s' "$3" | cut -c1-3500)"
  encoded_message="$(printf '%s' "$message" | base64 | tr -d '\\r\\n')"
  curl --silent --show-error --fail --max-time 10 -X POST "$LOG_URL" -H 'Content-Type: application/json' --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"events\\":[{\\"level\\":\\"$level\\",\\"step\\":\\"cleanup\\",\\"messageBase64\\":\\"$encoded_message\\"}]}" >/dev/null 2>&1 || true
}

report_failure() {
  exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ "$REPORT_SENT" -eq 0 ]; then
    curl --silent --show-error --fail --retry 2 --retry-all-errors -X POST "$REPORT_URL" \\
      -H 'Content-Type: application/json' \\
      --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"platform\\":\\"unix\\",\\"status\\":\\"failed\\",\\"error\\":\\"cleanup exited with code $exit_code\\"}" >/dev/null || true
  fi
  exit "$exit_code"
}
trap report_failure EXIT
echo "Unenrolling cloudflare-man instance for ${hostname}"
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this command as root (sudo)." >&2
  exit 1
fi
curl --silent --show-error --fail --retry 2 --retry-all-errors -X POST "$CLAIM_URL" \\
  -H 'Content-Type: application/json' \\
  --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"platform\\":\\"unix\\"}" >/dev/null
send_log "info" "cleanup" "Unenrollment script claimed for unix"
send_log "info" "cleanup" "Stopping and removing the cloudflared service"
if command -v cloudflared >/dev/null 2>&1; then
  cloudflared service uninstall >/dev/null 2>&1 || true
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now cfman-command-agent.service >/dev/null 2>&1 || true
  systemctl disable --now cloudflare-man-command-agent.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/cfman-command-agent.service /etc/systemd/system/cloudflare-man-command-agent.service
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout system/cfman.command-agent >/dev/null 2>&1 || true
  launchctl bootout system/dev.cfman.command-agent >/dev/null 2>&1 || true
  launchctl bootout system/dev.cloudflare-man.command-agent >/dev/null 2>&1 || true
  rm -f /Library/LaunchDaemons/cfman.command-agent.plist /Library/LaunchDaemons/dev.cfman.command-agent.plist /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist
fi
rm -rf "/var/lib/cfman" "/var/lib/cloudflare-man" "/Library/Application Support/cfman" "/Library/Application Support/cloudflare-man"
curl --silent --show-error --fail --retry 3 --retry-all-errors -X POST "$REPORT_URL" \\
  -H 'Content-Type: application/json' \\
  --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"scriptId\\":\\"$SCRIPT_ID\\",\\"platform\\":\\"unix\\",\\"status\\":\\"unenrolled\\"}" >/dev/null
REPORT_SENT=1
echo "Cloudflare tunnel instance unenrolled successfully."
`;
}

function powerShellUnenrollScript(token: string, hostname: string, publicBaseUrl: string, scriptId: string): string {
  const claimUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/claim`;
  const reportUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/report`;
  const logUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/logs`;
  return `$ErrorActionPreference = "Stop"
$UnenrollToken = "${token}"
$ScriptId = "${scriptId}"
$ClaimUrl = "${claimUrl}"
$ReportUrl = "${reportUrl}"
$LogUrl = "${logUrl}"
$ReportSent = $false

function Send-CleanupLog {
  param([string]$Level, [string]$Message)
  Write-Host "[cleanup] $Message"
  try {
    $body = @{ token = $UnenrollToken; scriptId = $ScriptId; events = @(@{ level = $Level; step = "cleanup"; message = $Message }) } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri $LogUrl -ContentType "application/json" -Body $body -TimeoutSec 10 | Out-Null
  } catch { }
}

function Invoke-WithRetry {
  # Matches the unix script's "curl --retry" resilience: a transient network
  # blip here must not leave local cleanup done with the server never told,
  # since that produces a tunnel that looks installed but has nothing running.
  param([scriptblock]$Action, [int]$MaxAttempts = 3, [int]$DelaySeconds = 2)
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      return & $Action
    } catch {
      if ($attempt -ge $MaxAttempts) { throw }
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}

try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run PowerShell as Administrator." }
  Invoke-WithRetry { Invoke-RestMethod -Method Post -Uri $ClaimUrl -ContentType "application/json" -Body (@{ token = $UnenrollToken; scriptId = $ScriptId; platform = "windows" } | ConvertTo-Json) | Out-Null }
  Send-CleanupLog -Level "info" -Message "Unenrollment script claimed for windows"
  Send-CleanupLog -Level "info" -Message "Stopping and removing the cloudflared service for ${hostname}"
  $binary = Join-Path $env:ProgramFiles "cloudflared\\cloudflared.exe"
  if (Test-Path $binary) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # cloudflared writes INF messages to stderr even when uninstall succeeds.
      # Capture native output without promoting it to a terminating PowerShell error.
      $ErrorActionPreference = "Continue"
      $uninstallOutput = @(& $binary service uninstall 2>&1)
      $uninstallExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $uninstallOutput) { Send-CleanupLog -Level "info" -Message $line.ToString() }
    if ($uninstallExitCode -ne 0) {
      $remainingService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
      if ($remainingService) {
        Send-CleanupLog -Level "warn" -Message "cloudflared uninstall exited with code $uninstallExitCode; removing the remaining service"
        Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
      } else {
        Send-CleanupLog -Level "warn" -Message "cloudflared uninstall exited with code $uninstallExitCode, but the service is already absent"
      }
    }
  }
  foreach ($taskName in @("CFManCommandAgent", "CloudflareManCommandAgent")) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*cfman*command-agent.ps1*" -or $_.CommandLine -like "*cloudflare-man*command-agent.ps1*" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  $service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
  if ($service) {
    Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
  }
  # cloudflared's own uninstall does not remove this key, and a leftover key would make
  # a future "service install" fail with "Cannot install event logger".
  Remove-Item -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Cloudflared" -Recurse -Force -ErrorAction SilentlyContinue
  $stateDirectory = Join-Path $env:ProgramData "cfman"
  $legacyStateDirectory = Join-Path $env:ProgramData "cloudflare-man"
  if (Test-Path $stateDirectory) { Remove-Item $stateDirectory -Recurse -Force }
  if (Test-Path $legacyStateDirectory) { Remove-Item $legacyStateDirectory -Recurse -Force }
  $body = @{ token = $UnenrollToken; scriptId = $ScriptId; platform = "windows"; status = "unenrolled" } | ConvertTo-Json
  Invoke-WithRetry { Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $body | Out-Null }
  $ReportSent = $true
  Write-Host "Cloudflare tunnel instance unenrolled successfully."
} catch {
  Send-CleanupLog -Level "error" -Message $_.Exception.Message
  if (-not $ReportSent) {
    try {
      $body = @{ token = $UnenrollToken; scriptId = $ScriptId; platform = "windows"; status = "failed"; error = $_.Exception.Message } | ConvertTo-Json
      Invoke-WithRetry { Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $body | Out-Null }
    } catch { }
  }
  throw
}
`;
}

function diagnosticShellScript(hostname: string, publicBaseUrl: string, agentToken: string, tunnelId: string, diagnosticRunId: string): string {
  const reportUrl = `${publicBaseUrl}/api/public/tunnels/diagnose/report`;
  return `#!/usr/bin/env bash
set -uo pipefail

ASSIGNED_HOSTNAME='${hostname}'
TUNNEL_ID='${tunnelId}'
DIAGNOSTIC_RUN_ID='${diagnosticRunId}'
AGENT_TOKEN='${agentToken}'
REPORT_URL='${reportUrl}'

if [ "$(uname -s)" = "Linux" ]; then
  STATE_DIR="/var/lib/cfman"
  LEGACY_STATE_DIR="/var/lib/cloudflare-man"
else
  STATE_DIR="/Library/Application Support/cfman"
  LEGACY_STATE_DIR="/Library/Application Support/cloudflare-man"
fi
HOSTNAME_FILE="$STATE_DIR/assigned-hostname"
if [ ! -s "$HOSTNAME_FILE" ] && [ -s "$LEGACY_STATE_DIR/assigned-hostname" ]; then
  HOSTNAME_FILE="$LEGACY_STATE_DIR/assigned-hostname"
fi

echo "cloudflare-man diagnostics for $ASSIGNED_HOSTNAME"
echo "----------------------------------------"

CLOUDFLARED_RUNNING=false
if pgrep -x cloudflared >/dev/null 2>&1; then CLOUDFLARED_RUNNING=true; fi
if [ "$CLOUDFLARED_RUNNING" = true ]; then
  echo "[PASS] cloudflared is running"
else
  echo "[FAIL] cloudflared is not running"
fi

HOSTNAME_MATCH=false
LOCAL_HOSTNAME=""
if [ -s "$HOSTNAME_FILE" ]; then
  LOCAL_HOSTNAME="$(cat "$HOSTNAME_FILE")"
  if [ "$LOCAL_HOSTNAME" = "$ASSIGNED_HOSTNAME" ]; then
    HOSTNAME_MATCH=true
    echo "[PASS] Local install is registered for $ASSIGNED_HOSTNAME"
  else
    echo "[FAIL] Local install is registered for $LOCAL_HOSTNAME, not $ASSIGNED_HOSTNAME"
  fi
else
  echo "[FAIL] No local enrollment state found at $HOSTNAME_FILE"
fi

AGENT_HEALTHY=false
if curl --silent --show-error --fail --max-time 3 -H "X-Cloudflare-Man-Agent-Token: $AGENT_TOKEN" http://127.0.0.1:47831/health >/dev/null 2>&1; then
  AGENT_HEALTHY=true
  echo "[PASS] Command agent is responding on 127.0.0.1:47831"
else
  echo "[FAIL] Command agent is not responding on 127.0.0.1:47831"
fi

echo "----------------------------------------"
echo "Reporting results to cloudflare-man..."
REPORT_BODY="$(printf '{"tunnelId":"%s","diagnosticRunId":"%s","agentToken":"%s","cloudflaredRunning":%s,"hostnameMatch":%s,"localHostname":"%s","agentHealthy":%s}' "$TUNNEL_ID" "$DIAGNOSTIC_RUN_ID" "$AGENT_TOKEN" "$CLOUDFLARED_RUNNING" "$HOSTNAME_MATCH" "$LOCAL_HOSTNAME" "$AGENT_HEALTHY")"
RESPONSE="$(curl --silent --show-error --max-time 15 -X POST "$REPORT_URL" -H 'Content-Type: application/json' --data "$REPORT_BODY")"
MESSAGE="$(printf '%s' "$RESPONSE" | grep -o '"message":"[^"]*"' | sed 's/"message":"//;s/"$//')"
if [ -n "$MESSAGE" ]; then echo "$MESSAGE"; else echo "$RESPONSE"; fi
`;
}

function diagnosticPowerShellScript(hostname: string, publicBaseUrl: string, agentToken: string, tunnelId: string, diagnosticRunId: string): string {
  const reportUrl = `${publicBaseUrl}/api/public/tunnels/diagnose/report`;
  return `$ErrorActionPreference = "Continue"
$AssignedHostname = "${hostname}"
$TunnelId = "${tunnelId}"
$DiagnosticRunId = "${diagnosticRunId}"
$AgentToken = "${agentToken}"
$ReportUrl = "${reportUrl}"
$stateDirectory = Join-Path $env:ProgramData "cfman"
$legacyStateDirectory = Join-Path $env:ProgramData "cloudflare-man"
$hostnameFile = Join-Path $stateDirectory "assigned-hostname"
$legacyHostnameFile = Join-Path $legacyStateDirectory "assigned-hostname"
if (-not (Test-Path $hostnameFile) -and (Test-Path $legacyHostnameFile)) { $hostnameFile = $legacyHostnameFile }

Write-Host "cfman diagnostics for $AssignedHostname"
Write-Host "----------------------------------------"

$cloudflaredService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
$cloudflaredRunning = $false
if ($cloudflaredService -and $cloudflaredService.Status -eq "Running") {
  $cloudflaredRunning = $true
  Write-Host "[PASS] cloudflared service is running"
} elseif ($cloudflaredService) {
  Write-Host "[FAIL] cloudflared service is installed but not running"
} else {
  Write-Host "[FAIL] cloudflared service is not installed"
}

$hostnameMatch = $false
$localHostname = ""
if (Test-Path $hostnameFile) {
  $localHostname = (Get-Content $hostnameFile -Raw).Trim()
  if ($localHostname -eq $AssignedHostname) {
    $hostnameMatch = $true
    Write-Host "[PASS] Local install is registered for $AssignedHostname"
  } else {
    Write-Host "[FAIL] Local install is registered for $localHostname, not $AssignedHostname"
  }
} else {
  Write-Host "[FAIL] No local enrollment state found at $hostnameFile"
}

$agentHealthy = $false
try {
  $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:47831/health" -Headers @{ "X-Cloudflare-Man-Agent-Token" = $AgentToken } -TimeoutSec 3
  if ($health.ready) {
    $agentHealthy = $true
    Write-Host "[PASS] Command agent is responding on 127.0.0.1:47831"
  } else {
    Write-Host "[FAIL] Command agent responded but is not ready"
  }
} catch {
  Write-Host "[FAIL] Command agent is not responding on 127.0.0.1:47831"
}

Write-Host "----------------------------------------"
Write-Host "Reporting results to cloudflare-man..."
$reportBody = @{
  tunnelId = $TunnelId
  diagnosticRunId = $DiagnosticRunId
  agentToken = $AgentToken
  cloudflaredRunning = $cloudflaredRunning
  hostnameMatch = $hostnameMatch
  localHostname = $localHostname
  agentHealthy = $agentHealthy
} | ConvertTo-Json
try {
  $report = Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $reportBody
  Write-Host $report.message
} catch {
  Write-Host "Unable to reach cloudflare-man to report diagnostics: $($_.Exception.Message)"
}
`;
}

export async function enrollmentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/public/command-executions/:executionId/started", {
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { executionId } = z.object({ executionId: z.string().uuid() }).parse(request.params);
    const body = commandExecutionStartedSchema.parse(request.body);
    const recorded = await recordCommandExecutionStarted(executionId, body.token, body.taskId, body.processId);
    if (!recorded) return reply.code(404).send({ error: "Command execution not found or no longer active" });
    return reply.code(202).send({ accepted: true, executionId, taskId: body.taskId });
  });
  app.post("/api/public/command-executions/:executionId/report", {
    config: { rateLimit: { max: 100, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { executionId } = z.object({ executionId: z.string().uuid() }).parse(request.params);
    const body = commandExecutionReportSchema.parse(request.body);
    const recorded = await recordCommandExecutionReport(executionId, body.token, {
      success: body.success,
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
      durationMs: body.durationMs,
      ...(body.error !== undefined ? { error: body.error } : {}),
      ...(body.status !== undefined ? { status: body.status } : {})
    });
    if (!recorded) return reply.code(404).send({ error: "Command execution not found" });
    // "Enable RDS" dispatches its enabling script through this same generic
    // execution channel; when the agent answers asynchronously (rather than
    // in POST /rdp/enable's own synchronous path) this is the only place
    // that ever sees the result, so it has to finish the job here.
    const execution = await pool.query(
      "SELECT tunnel_id, script_name, stdout FROM tunnel_command_executions WHERE id = $1",
      [executionId]
    );
    if (execution.rows[0]?.script_name === RDP_ENABLE_SCRIPT_MARKER) {
      await completeRdpEnableExecution(execution.rows[0].tunnel_id, execution.rows[0].stdout ?? "").catch(() => undefined);
    }
    return reply.code(202).send({ accepted: true, executionId });
  });
  app.post("/api/public/command-executions/:executionId/log", {
    config: { rateLimit: { max: 1200, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { executionId } = z.object({ executionId: z.string().uuid() }).parse(request.params);
    const body = commandExecutionLogSchema.parse(request.body);
    const recorded = await recordCommandExecutionLog(executionId, body.token, body.stream, body.line, body.sequence ?? null);
    if (!recorded) return reply.code(404).send({ error: "Command execution not found" });
    return reply.code(202).send({ accepted: true, executionId });
  });

  app.get("/e/:token/install.sh", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findEnrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "install", "unix") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This unix installer is staled - ignored because the Windows installer already started.\n");
    }
    if (!enrollment || !["url_issued", "failed"].includes(enrollment.status) || new Date(enrollment.expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Enrollment URL is invalid or expired.\n");
    }
    noTunnel(reply);
    return reply.type("text/x-shellscript; charset=utf-8").send(shellScript(token, enrollment.hostname, await getPublicBaseUrl(), await commandAgentToken(enrollment.tunnel_id), script.id));
  });

  app.get("/e/:token/install.ps1", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findEnrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "install", "windows") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This Windows installer is staled - ignored because the Unix installer already started.\n");
    }
    if (!enrollment || !["url_issued", "failed"].includes(enrollment.status) || new Date(enrollment.expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Enrollment URL is invalid or expired.\n");
    }
    noTunnel(reply);
    return reply.type("text/plain; charset=utf-8").send(powerShellScript(token, enrollment.hostname, await getPublicBaseUrl(), await commandAgentToken(enrollment.tunnel_id), script.id));
  });

  app.get("/e/:token/unenroll.sh", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findUnenrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "unenroll", "unix") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This unix unenrollment script is staled - ignored because the Windows script already started.\n");
    }
    if (!enrollment || enrollment.unenrolled_at || !enrollment.unenroll_token_expires_at || new Date(enrollment.unenroll_token_expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Unenrollment URL is invalid or expired.\n");
    }
    noTunnel(reply);
    return reply.type("text/x-shellscript; charset=utf-8").send(shellUnenrollScript(token, enrollment.hostname, await getPublicBaseUrl(), script.id));
  });

  app.get("/e/:token/unenroll.ps1", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findUnenrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "unenroll", "windows") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This Windows unenrollment script is staled - ignored because the Unix script already started.\n");
    }
    if (!enrollment || enrollment.unenrolled_at || !enrollment.unenroll_token_expires_at || new Date(enrollment.unenroll_token_expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Unenrollment URL is invalid or expired.\n");
    }
    noTunnel(reply);
    return reply.type("text/plain; charset=utf-8").send(powerShellUnenrollScript(token, enrollment.hostname, await getPublicBaseUrl(), script.id));
  });

  app.get("/d/:token/diagnose.sh", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const diagnose = await findDiagnose(token);
    if (!diagnose || !diagnose.diagnose_token_expires_at || new Date(diagnose.diagnose_token_expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Diagnostic link is invalid or expired.\n");
    }
    await startDiagnosticRun(diagnose.diagnostic_run_id, "unix");
    noTunnel(reply);
    return reply.type("text/x-shellscript; charset=utf-8").send(diagnosticShellScript(diagnose.hostname, await getPublicBaseUrl(), await commandAgentToken(diagnose.tunnel_id), diagnose.tunnel_id, diagnose.diagnostic_run_id));
  });

  app.get("/d/:token/diagnose.ps1", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const diagnose = await findDiagnose(token);
    if (!diagnose || !diagnose.diagnose_token_expires_at || new Date(diagnose.diagnose_token_expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Diagnostic link is invalid or expired.\n");
    }
    await startDiagnosticRun(diagnose.diagnostic_run_id, "windows");
    noTunnel(reply);
    return reply.type("text/plain; charset=utf-8").send(diagnosticPowerShellScript(diagnose.hostname, await getPublicBaseUrl(), await commandAgentToken(diagnose.tunnel_id), diagnose.tunnel_id, diagnose.diagnostic_run_id));
  });

  app.post("/api/public/enrollments/claim", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = claimSchema.parse(request.body);
    const tokenHash = hashToken(body.token);
    const claimed = await pool.query(
      `UPDATE enrollments
          SET status = 'provisioning', claimed_at = now(), platform = $1, claimed_by = $2,
              install_id = $3,
              host_info = host_info || jsonb_strip_nulls(jsonb_build_object(
                'osName', $6::text, 'osVersion', $7::text, 'osBuild', $8::text,
                'architecture', $9::text, 'machineName', $10::text
              )),
              updated_at = now()
        WHERE token_hash = $4
          AND status IN ('url_issued', 'failed', 'provisioning', 'ready')
          AND deleted_at IS NULL
          AND expires_at > now()
          AND (claimed_at IS NULL OR install_id = $3 OR $5 = true)
      RETURNING id, tunnel_id, created_by`,
      [body.platform, body.machineName ?? request.ip, body.installId ?? null, tokenHash, body.overrideExisting, body.osName ?? null, body.osVersion ?? null, body.osBuild ?? null, body.architecture ?? null, body.machineName ?? null]
    );
    let enrollment = claimed.rows[0];
    if (!enrollment) {
      const expired = await pool.query(
        `UPDATE enrollments SET status = 'expired', updated_at = now()
          WHERE token_hash = $1 AND status IN ('url_issued', 'failed') AND expires_at <= now()
        RETURNING tunnel_id`,
        [tokenHash]
      );
      if (expired.rows[0]) {
        await pool.query("UPDATE tunnels SET onboarding_status = 'expired', updated_at = now() WHERE id = $1", [expired.rows[0].tunnel_id]);
        return reply.code(410).send({ error: "Enrollment has expired" });
      }
      const existing = await findEnrollment(body.token);
      const sameInstaller = existing?.install_id && body.installId && existing.install_id === body.installId;
      if (!existing || !sameInstaller || !["provisioning", "ready", "failed"].includes(existing.status)) {
        return reply.code(409).send({ error: "Enrollment is invalid or already claimed" });
      }
      enrollment = existing;
      if (existing.status === "failed") {
        await pool.query("UPDATE enrollments SET status = 'provisioning', last_error = null, updated_at = now() WHERE id = $1", [existing.id]);
      }
    }

    const scriptPlatform = normalizeScriptPlatform(body.platform)!;
    const claimedScriptId = await resolveEnrollmentScriptId(enrollment.id, "install", body.scriptId, scriptPlatform);
    if (body.scriptId && !claimedScriptId) return reply.code(409).send({ error: "The installer script ID does not match this enrollment" });
    await pool.query(
      `UPDATE enrollment_scripts
          SET status = CASE WHEN platform = $1 THEN 'running' ELSE 'staled_ignored' END,
              started_at = CASE WHEN platform = $1 THEN COALESCE(started_at, now()) ELSE started_at END,
              finished_at = CASE WHEN platform = $1 THEN null ELSE finished_at END,
              last_error = CASE WHEN platform = $1 THEN null ELSE last_error END,
              updated_at = now()
        WHERE enrollment_id = $2 AND script_kind = 'install'`,
      [scriptPlatform, enrollment.id]
    );

    try {
      const previousMachine = {
        hostname: body.previousHostname,
        installId: body.previousInstallId,
        cfTunnelId: body.previousTunnelId
      };
      try {
        await reconcilePreviousMachineTunnel(enrollment.tunnel_id, enrollment.id, previousMachine);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to reconcile the previous tunnel";
        await pool.query(
          `INSERT INTO enrollment_logs(enrollment_id, enrollment_script_id, level, step, message, metadata, phase)
           VALUES ($1, $2, 'warn', 'claim', $3, $4::jsonb, 'enroll')`,
          [enrollment.id, claimedScriptId, message.slice(0, 4000), JSON.stringify({ source: "server", previousHostname: body.previousHostname })]
        );
      }
      const provision = async (lockClient?: PoolClient) => {
        await reconcileTargetPriorEnrollments(enrollment.tunnel_id, enrollment.id, enrollment.created_by ?? null, previousMachine, lockClient);
        return provisionTunnel(enrollment.tunnel_id);
      };
      const provisioned = await withTunnelCloudflareLock(enrollment.tunnel_id, provision);
      const agentToken = await commandAgentToken(enrollment.tunnel_id);
      await pool.query("UPDATE enrollments SET status = 'ready', last_error = null, updated_at = now() WHERE id = $1", [enrollment.id]);
      if (request.headers.accept?.includes("text/plain")) {
        noTunnel(reply);
        return reply.type("text/plain").send(`${provisioned.tunnelToken}\n${agentToken}\n${provisioned.cfTunnelId}`);
      }
      noTunnel(reply);
      return { ...provisioned, agentToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provisioning failed";
      await pool.query("UPDATE enrollments SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2", [message, enrollment.id]);
      await pool.query(
        `INSERT INTO enrollment_logs(enrollment_id, enrollment_script_id, level, step, message, metadata, phase)
         VALUES ($1, $2, 'error', 'claim', $3, '{"source":"server"}'::jsonb, 'enroll')`,
        [enrollment.id, claimedScriptId, message.slice(0, 4000)]
      );
      await pool.query(
        `UPDATE enrollment_scripts
            SET status = 'failed', finished_at = now(), last_error = $1, updated_at = now()
          WHERE enrollment_id = $2 AND script_kind = 'install' AND platform = $3`,
        [message, enrollment.id, scriptPlatform]
      );
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/api/public/enrollments/logs", {
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = logSchema.parse(request.body);
    const enrollment = await findEnrollment(body.token);
    if (!enrollment) return reply.code(404).send({ error: "Enrollment not found" });
    const scriptId = await resolveEnrollmentScriptId(enrollment.id, "install", body.scriptId);
    if (body.scriptId && !scriptId) return reply.code(404).send({ error: "Enrollment script not found" });
    await withTransaction(async (client) => {
      for (const event of body.events) {
        const decodedMessage = event.messageBase64
          ? Buffer.from(event.messageBase64, "base64").toString("utf8").slice(0, 4000)
          : event.message!;
        await client.query(
          `INSERT INTO enrollment_logs(enrollment_id, enrollment_script_id, level, step, message, metadata, phase)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'enroll')`,
          [enrollment.id, scriptId, event.level, event.step ?? null, decodedMessage, JSON.stringify(event.metadata ?? {})]
        );
      }
    });
    return reply.code(202).send({ accepted: body.events.length });
  });

  app.post("/api/public/enrollments/unenroll/logs", {
    config: { rateLimit: { max: 100, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = logSchema.parse(request.body);
    const enrollment = await findUnenrollment(body.token);
    if (!enrollment) return reply.code(404).send({ error: "Unenrollment not found" });
    const scriptId = await resolveEnrollmentScriptId(enrollment.id, "unenroll", body.scriptId);
    if (body.scriptId && !scriptId) return reply.code(404).send({ error: "Unenrollment script not found" });
    await withTransaction(async (client) => {
      for (const event of body.events) {
        const decodedMessage = event.messageBase64
          ? Buffer.from(event.messageBase64, "base64").toString("utf8").slice(0, 4000)
          : event.message!;
        await client.query(
          `INSERT INTO enrollment_logs(enrollment_id, enrollment_script_id, level, step, message, metadata, phase)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'unenroll')`,
          [enrollment.id, scriptId, event.level, event.step ?? "cleanup", decodedMessage, JSON.stringify(event.metadata ?? {})]
        );
      }
    });
    return reply.code(202).send({ accepted: body.events.length });
  });

  app.post("/api/public/enrollments/unenroll/claim", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = z.object({
      token: z.string().min(30).max(200),
      scriptId: z.string().uuid().optional(),
      platform: z.enum(["windows", "unix"])
    }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const enrollmentResult = await client.query(
        `SELECT id, unenrolled_at, unenroll_token_expires_at
           FROM enrollments
          WHERE unenroll_token_hash = $1
          FOR UPDATE`,
        [hashToken(body.token)]
      );
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment || enrollment.unenrolled_at || !enrollment.unenroll_token_expires_at || new Date(enrollment.unenroll_token_expires_at) <= new Date()) return null;
      const scriptId = await resolveEnrollmentScriptId(enrollment.id, "unenroll", body.scriptId, body.platform);
      if (body.scriptId && !scriptId) return null;
      await client.query(
        `UPDATE enrollment_scripts
            SET status = CASE WHEN platform = $1 THEN 'running' ELSE 'staled_ignored' END,
                started_at = CASE WHEN platform = $1 THEN COALESCE(started_at, now()) ELSE started_at END,
                finished_at = CASE WHEN platform = $1 THEN null ELSE finished_at END,
                last_error = CASE WHEN platform = $1 THEN null ELSE last_error END,
                updated_at = now()
          WHERE enrollment_id = $2 AND script_kind = 'unenroll'`,
        [body.platform, enrollment.id]
      );
      return { enrollmentId: enrollment.id as string, scriptId };
    });
    if (!result) return reply.code(409).send({ error: "Unenrollment URL is invalid, expired, or already completed" });
    return { success: true, enrollmentId: result.enrollmentId, scriptId: result.scriptId, platform: body.platform };
  });

  app.post("/api/public/enrollments/unenroll/report", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = unenrollReportSchema.parse(request.body);
    const enrollment = await findUnenrollment(body.token);
    if (!enrollment) return reply.code(404).send({ error: "Unenrollment not found" });
    const scriptId = await resolveEnrollmentScriptId(enrollment.id, "unenroll", body.scriptId, body.platform);
    if (body.scriptId && !scriptId) return reply.code(404).send({ error: "Unenrollment script not found" });
    if (body.status === "failed") {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE enrollments SET unenroll_last_error = $1, updated_at = now() WHERE id = $2`,
          [body.error ?? "Unenrollment failed", enrollment.id]
        );
        await client.query(
          `UPDATE enrollment_scripts
              SET status = 'failed', finished_at = now(), last_error = $1, updated_at = now()
            WHERE enrollment_id = $2 AND script_kind = 'unenroll' AND platform = $3
              AND ($4::uuid IS NULL OR id = $4)`,
          [body.error ?? "Unenrollment failed", enrollment.id, body.platform, scriptId]
        );
      });
      return { success: false };
    }
    await pool.query(
      `UPDATE enrollment_scripts
          SET status = 'completed', finished_at = COALESCE(finished_at, now()), last_error = null, updated_at = now()
        WHERE enrollment_id = $1 AND script_kind = 'unenroll' AND platform = $2
          AND ($3::uuid IS NULL OR id = $3)`,
      [enrollment.id, body.platform, scriptId]
    );
    try {
      const cloudflareDeprovisioned = await withTunnelCloudflareLock(enrollment.tunnel_id, async (lockClient) => {
        const tunnel = await pool.query("SELECT cf_tunnel_id FROM tunnels WHERE id = $1", [enrollment.tunnel_id]);
        const currentTunnelId = tunnel.rows[0]?.cf_tunnel_id as string | null | undefined;
        const shouldDeprovision = enrollment.unenroll_cf_tunnel_id
          ? currentTunnelId === enrollment.unenroll_cf_tunnel_id
          : Boolean(currentTunnelId && !enrollment.unenrolled_at);
        if (shouldDeprovision) await deprovisionTunnel(enrollment.tunnel_id, "unenroll", lockClient);
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE enrollments
                SET status = 'unenrolled', unenrolled_at = COALESCE(unenrolled_at, now()),
                    unenroll_reason = COALESCE(unenroll_reason, 'script'), unenroll_last_error = null, updated_at = now()
              WHERE id = $1`,
            [enrollment.id]
          );
        });
        return shouldDeprovision;
      });
      return { success: true, cloudflareDeprovisioned };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cloudflare cleanup failed";
      await pool.query("UPDATE enrollments SET unenroll_last_error = $1, updated_at = now() WHERE id = $2", [message, enrollment.id]);
      return reply.code(502).send({ success: false, error: message });
    }
  });

  app.post("/api/public/enrollments/report", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = reportSchema.parse(request.body);
    const enrollment = await findEnrollment(body.token);
    if (!enrollment) return reply.code(404).send({ error: "Enrollment not found" });
    const success = body.status === "installed";
    const reportPlatform = body.platform ?? normalizeScriptPlatform(enrollment.platform);
    if (body.platform && enrollment.platform && reportPlatform !== normalizeScriptPlatform(enrollment.platform)) {
      return reply.code(409).send({ error: "The report platform does not match the claimed installer" });
    }
    const scriptId = await resolveEnrollmentScriptId(enrollment.id, "install", body.scriptId, reportPlatform);
    if (body.scriptId && !scriptId) return reply.code(404).send({ error: "Enrollment script not found" });
    if (reportPlatform) {
      await pool.query(
        `UPDATE enrollment_scripts
            SET status = $1, finished_at = COALESCE(finished_at, now()), last_error = $2, updated_at = now()
          WHERE enrollment_id = $3 AND script_kind = 'install' AND platform = $4
            AND ($5::uuid IS NULL OR id = $5)`,
        [success ? "completed" : "failed", body.error ?? null, enrollment.id, reportPlatform, scriptId]
      );
    }
    await pool.query(
      `UPDATE enrollments
          SET host_info = host_info || $1::jsonb, updated_at = now()
        WHERE id = $2`,
      [JSON.stringify(Object.fromEntries(Object.entries({
        osName: body.osName,
        osVersion: body.osVersion,
        osBuild: body.osBuild,
        architecture: body.architecture,
        machineName: body.machineName
      }).filter(([, value]) => value !== undefined))), enrollment.id]
    );
    const latest = await pool.query(
      `SELECT id FROM enrollments
        WHERE tunnel_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [enrollment.tunnel_id]
    );
    const stateApplicable = !enrollment.unenrolled_at
      && enrollment.status !== "revoked"
      && latest.rows[0]?.id === enrollment.id
      && (!success || ["provisioning", "ready", "installed"].includes(enrollment.status));
    if (!stateApplicable) return reply.code(202).send({ success: true, stateApplied: false });
    const retryablePreflightFailure = !success && enrollment.status === "url_issued" && !enrollment.claimed_at;
    let scheduleVerification = false;
    let accountId: string | undefined;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE enrollments SET status = $1, installed_at = CASE WHEN $2 THEN now() ELSE installed_at END,
         last_error = $3, host_info = host_info || $5::jsonb, updated_at = now() WHERE id = $4`,
        [
          success ? "installed" : retryablePreflightFailure ? "url_issued" : "failed",
          success,
          body.error ?? null,
          enrollment.id,
          JSON.stringify(Object.fromEntries(Object.entries({
            osName: body.osName,
            osVersion: body.osVersion,
            osBuild: body.osBuild,
            architecture: body.architecture,
            machineName: body.machineName
          }).filter(([, value]) => value !== undefined)))
        ]
      );
      if (reportPlatform) {
        await client.query(
          `UPDATE enrollment_scripts
              SET status = $1, finished_at = now(), last_error = $2, updated_at = now()
            WHERE enrollment_id = $3 AND script_kind = 'install' AND platform = $4`,
          [success ? "completed" : "failed", body.error ?? null, enrollment.id, reportPlatform]
        );
      }
      if (body.agentReady !== undefined || body.agentError) {
        await client.query(
          `UPDATE tunnel_command_agents
              SET status = $1, last_seen_at = CASE WHEN $2 THEN now() ELSE last_seen_at END,
                  last_error = $3, updated_at = now()
            WHERE tunnel_id = $4`,
          [body.agentReady ? "ready" : "failed", body.agentReady ?? false, body.agentError ?? null, enrollment.tunnel_id]
        );
      }
      const provider = await client.query(
        `SELECT a.provider_mode, s.account_id FROM tunnels s JOIN cloudflare_accounts a ON a.id = s.account_id WHERE s.id = $1`,
        [enrollment.tunnel_id]
      );
      const isMock = provider.rows[0]?.provider_mode === "mock";
      accountId = provider.rows[0]?.account_id;
      scheduleVerification = success && !isMock;
      // The install script never enables Remote Desktop or SSH itself -
      // that only happens later, on demand, via the Connect tab's "Enable
      // RDS"/"Enable SSH" actions (rdp.ts's completeRdpEnableExecution and
      // the connectivity-update -> syncBrowserSsh path). All the report
      // does here is mark rdp/ssh as not applicable when the enrolled
      // platform rules it out, leaving whatever status already exists
      // otherwise (e.g. from a previous Enable action).
      await client.query(
        `UPDATE tunnels SET onboarding_status = $1, cf_tunnel_status = CASE WHEN $2 THEN 'healthy' ELSE cf_tunnel_status END,
         cloudflared_version = $3, last_connected_at = CASE WHEN $2 THEN now() ELSE last_connected_at END,
         last_verified_at = CASE WHEN $2 THEN now() ELSE last_verified_at END, last_error = $4,
         rdp_status = CASE WHEN $5 AND $6 <> 'windows' THEN 'disabled' ELSE rdp_status END,
         ssh_status = CASE WHEN $5 AND $6 <> 'unix' THEN 'disabled' ELSE ssh_status END,
         updated_at = now()
         WHERE id = $7`,
        [
          success ? (isMock ? "active" : "connector_online") : retryablePreflightFailure ? "url_issued" : "failed",
          success && isMock,
          body.version ?? null,
          body.error ?? null,
          success,
          enrollment.platform ?? "unknown",
          enrollment.tunnel_id
        ]
      );
    });
    if (scheduleVerification) {
      scheduleTunnelVerification(enrollment.tunnel_id);
      if (accountId) void synchronizeAccount(accountId).catch(() => undefined);
      void ensureCommandAgentWafAllowsCloudflareMan(enrollment.tunnel_id).catch(() => undefined);
    }
    return { success: true, stateApplied: true };
  });

  const diagnoseReportSchema = z.object({
    tunnelId: z.string().uuid(),
    diagnosticRunId: z.string().uuid(),
    agentToken: z.string().min(1).max(500),
    cloudflaredRunning: z.boolean(),
    hostnameMatch: z.boolean(),
    localHostname: z.string().max(253).default(""),
    agentHealthy: z.boolean()
  });

  app.post("/api/public/tunnels/diagnose/report", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = diagnoseReportSchema.parse(request.body);
    const agent = await pool.query("SELECT token_encrypted FROM tunnel_command_agents WHERE tunnel_id = $1", [body.tunnelId]);
    const storedToken = agent.rows[0]?.token_encrypted ? decryptSecret(agent.rows[0].token_encrypted as string) : null;
    if (!storedToken || storedToken !== body.agentToken) {
      return reply.code(401).send({ error: "Invalid diagnostic credentials" });
    }
    const tunnel = await pool.query("SELECT account_id, hostname FROM tunnels WHERE id = $1", [body.tunnelId]);
    if (!tunnel.rowCount) return reply.code(404).send({ error: "Tunnel not found" });

    const diagnosticRun = await pool.query(
      `SELECT dr.id, dr.enrollment_id, dr.status
         FROM enrollment_diagnostic_runs dr
         JOIN enrollments e ON e.id = dr.enrollment_id
        WHERE dr.id = $1 AND e.tunnel_id = $2 AND e.deleted_at IS NULL
          AND dr.status IN ('pending', 'running') AND dr.expires_at > now()`,
      [body.diagnosticRunId, body.tunnelId]
    );
    if (!diagnosticRun.rowCount) return reply.code(404).send({ error: "Diagnostic run not found" });

    const currentEnrollment = await pool.query(
      `SELECT id, status FROM enrollments
        WHERE tunnel_id = $1 AND deleted_at IS NULL AND unenrolled_at IS NULL
        ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC LIMIT 1`,
      [body.tunnelId]
    );

    // Edge case: this machine has since been overridden by a *different* tunnel's
    // enrollment (the local state file now points at another tunnel's hostname).
    // Detect it precisely and mark this tunnel's enrollment unenrolled instead of
    // reporting a vague mismatch.
    if (body.localHostname && body.localHostname !== tunnel.rows[0].hostname) {
      const supersededBy = await pool.query(
        "SELECT id, display_name FROM tunnels WHERE hostname = $1 AND id <> $2",
        [body.localHostname, body.tunnelId]
      );
      if (supersededBy.rowCount) {
        if (currentEnrollment.rows[0] && currentEnrollment.rows[0].status !== "unenrolled") {
          await pool.query(
            `UPDATE enrollments
                SET status = 'unenrolled', unenrolled_at = COALESCE(unenrolled_at, now()),
                    unenroll_reason = 'override', unenroll_token_hash = null,
                    unenroll_token_expires_at = null, unenroll_requested_at = null,
                    unenroll_last_error = null, updated_at = now()
              WHERE id = $1`,
            [currentEnrollment.rows[0].id]
          );
          await deprovisionTunnel(body.tunnelId, "override").catch(() => undefined);
          await writeAudit({
            action: "tunnel.enrollment_superseded_detected",
            entityType: "tunnel",
            entityId: body.tunnelId,
            details: { supersededByTunnelId: supersededBy.rows[0].id, supersededByTunnelName: supersededBy.rows[0].display_name, localHostname: body.localHostname }
          });
        }
        const message = `This machine now belongs to tunnel "${supersededBy.rows[0].display_name}" - this enrollment has been marked unenrolled.`;
        await withTransaction(async (client) => {
          await client.query(
            `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata, phase, diagnostic_run_id)
             VALUES ($1, 'error', 'local-enrollment', $2, $3::jsonb, 'diagnostic', $4),
                    ($1, 'error', 'summary', $5, $6::jsonb, 'diagnostic', $4)`,
            [diagnosticRun.rows[0].enrollment_id, `Local enrollment reports ${body.localHostname}`, JSON.stringify({ passed: false }), body.diagnosticRunId, message, JSON.stringify({ allHealthy: false, reconciled: false })]
          );
          await client.query(
            `UPDATE enrollment_diagnostic_runs
                SET status = 'failed', started_at = COALESCE(started_at, created_at), finished_at = now()
              WHERE id = $1`,
            [body.diagnosticRunId]
          );
        });
        return {
          diagnosticRunId: body.diagnosticRunId,
          tunnelOnline: false,
          hostnameMatch: false,
          agentHealthy: body.agentHealthy,
          endpointOk: false,
          reconciled: false,
          message
        };
      }
    }

    await synchronizeAccount(tunnel.rows[0].account_id).catch(() => undefined);
    const cfTunnelStatusResult = await pool.query("SELECT cf_tunnel_status FROM tunnels WHERE id = $1", [body.tunnelId]);
    const tunnelOnline = ["healthy", "degraded"].includes(cfTunnelStatusResult.rows[0]?.cf_tunnel_status);

    const endpointResult = await verifyTunnelEndpoints(body.tunnelId).catch(() => null);
    const endpointOk = endpointResult?.success ?? false;

    const allHealthy = tunnelOnline && body.cloudflaredRunning && body.hostnameMatch && body.agentHealthy && endpointOk;
    let reconciled = false;
    if (allHealthy && currentEnrollment.rows[0] && currentEnrollment.rows[0].status !== "installed") {
      await pool.query(
        "UPDATE enrollments SET status = 'installed', installed_at = COALESCE(installed_at, now()), last_error = null, updated_at = now() WHERE id = $1",
        [currentEnrollment.rows[0].id]
      );
      reconciled = true;
      await writeAudit({
        action: "tunnel.enrollment_reconciled",
        entityType: "tunnel",
        entityId: body.tunnelId,
        details: { tunnelOnline, endpointOk, ...body, agentToken: undefined }
      });
    } else if (!allHealthy) {
      const problems: string[] = [];
      if (!body.cloudflaredRunning) problems.push("cloudflared is not running on the machine");
      if (!body.hostnameMatch) problems.push("the local install is not registered for this tunnel's hostname");
      if (!body.agentHealthy) problems.push("the command agent is not responding locally");
      if (!tunnelOnline) problems.push("Cloudflare reports the tunnel as offline");
      if (!endpointOk) problems.push("the published endpoint is not reachable");
      if (problems.length) {
        await pool.query("UPDATE tunnels SET last_error = $1, updated_at = now() WHERE id = $2", [problems.join("; "), body.tunnelId]);
        await writeAudit({
          action: "tunnel.diagnose_reported_issue",
          entityType: "tunnel",
          entityId: body.tunnelId,
          details: { tunnelOnline, endpointOk, ...body, agentToken: undefined }
        });
      }
    }

    const message = allHealthy
      ? reconciled
        ? "Everything checks out - the enrollment status has been updated to installed."
        : "Everything checks out - the enrollment status is already up to date."
      : !body.cloudflaredRunning
        ? "Found a problem: cloudflared is not running on this machine."
        : !body.hostnameMatch
          ? "Found a problem: this machine's local install is registered for a different tunnel."
          : !body.agentHealthy
            ? "Found a problem: the command agent is not responding locally."
            : !tunnelOnline
              ? "Found a problem: Cloudflare reports the tunnel as offline."
              : "Found a problem: the published endpoint is not reachable.";

    const checks = [
      { step: "cloudflared", passed: body.cloudflaredRunning, message: body.cloudflaredRunning ? "cloudflared is running on the machine" : "cloudflared is not running on the machine" },
      { step: "local-enrollment", passed: body.hostnameMatch, message: body.hostnameMatch ? `Local enrollment matches ${tunnel.rows[0].hostname}` : `Local enrollment reports ${body.localHostname || "no assigned hostname"}` },
      { step: "command-agent", passed: body.agentHealthy, message: body.agentHealthy ? "Command agent is responding locally" : "Command agent is not responding locally" },
      { step: "cloudflare-tunnel", passed: tunnelOnline, message: tunnelOnline ? "Cloudflare reports the tunnel online" : "Cloudflare reports the tunnel offline" },
      { step: "published-endpoints", passed: endpointOk, message: endpointOk ? "Published endpoints are reachable" : "One or more published endpoints are not reachable" }
    ];
    await withTransaction(async (client) => {
      const locked = await client.query(
        "SELECT status FROM enrollment_diagnostic_runs WHERE id = $1 FOR UPDATE",
        [body.diagnosticRunId]
      );
      if (!locked.rowCount || ["completed", "failed"].includes(locked.rows[0].status)) return;
      for (const check of checks) {
        await client.query(
          `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata, phase, diagnostic_run_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'diagnostic', $6)`,
          [diagnosticRun.rows[0].enrollment_id, check.passed ? "info" : "error", check.step, check.message, JSON.stringify({ passed: check.passed }), body.diagnosticRunId]
        );
      }
      await client.query(
        `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata, phase, diagnostic_run_id)
         VALUES ($1, $2, 'summary', $3, $4::jsonb, 'diagnostic', $5)`,
        [diagnosticRun.rows[0].enrollment_id, allHealthy ? "info" : "error", message, JSON.stringify({ allHealthy, reconciled }), body.diagnosticRunId]
      );
      await client.query(
        `UPDATE enrollment_diagnostic_runs
            SET status = $2, started_at = COALESCE(started_at, created_at), finished_at = now()
          WHERE id = $1`,
        [body.diagnosticRunId, allHealthy ? "completed" : "failed"]
      );
    });

    return { diagnosticRunId: body.diagnosticRunId, tunnelOnline, hostnameMatch: body.hostnameMatch, agentHealthy: body.agentHealthy, endpointOk, reconciled, message };
  });
}
