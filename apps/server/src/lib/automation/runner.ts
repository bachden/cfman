import { pool, withTransaction } from "../database.js";
import { createAutomationContext } from "./context.js";
import { runInSandbox, type SandboxLog } from "./sandbox.js";

export type AutomationTriggerSource = "timer" | "manual" | "mcp";

export type AutomationOutput = { mimeType: string; body: string };

export type AutomationRunSummary = {
  runId: string;
  ruleId: string;
  ruleKey: string;
  // Counts up per rule, across every version of its script: how a person and
  // a script both refer to one run of this rule.
  sequence: number;
  // The version of the rule script this run actually executed, which later
  // edits of the rule do not change.
  scriptVersionId: string;
  scriptVersion: number;
  status: "succeeded" | "failed" | "timed_out";
  output: AutomationOutput | null;
  outputTruncated: boolean;
  logs: SandboxLog[];
  error: string | null;
  elapsedMs: number;
};

type RuleRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  scriptVersionId: string | null;
  scriptVersion: number | null;
  scriptSource: string | null;
  scriptTimeoutMs: number;
  createdBy: string | null;
};

const MAX_OUTPUT_LENGTH = 64_000;
const MAX_LOG_ENTRIES = 500;

// The script returns whatever it wants to leave behind for a reader of the run
// history; its MIME type is what the history renders it as.
export function normalizeScriptOutput(value: unknown): AutomationOutput {
  if (value === null || value === undefined) return { mimeType: "text/plain", body: "" };
  if (typeof value === "string") return { mimeType: "text/plain", body: value };
  if (typeof value === "number" || typeof value === "boolean") return { mimeType: "text/plain", body: String(value) };
  if (typeof value === "object") {
    const candidate = value as { mimeType?: unknown; body?: unknown };
    if (typeof candidate.mimeType === "string" && typeof candidate.body === "string") {
      return { mimeType: candidate.mimeType, body: candidate.body };
    }
    return { mimeType: "application/json", body: JSON.stringify(value, null, 2) };
  }
  return { mimeType: "text/plain", body: String(value) };
}

// A run always executes the newest version of the rule's script, and holds on
// to which one that was.
async function loadRule(ruleId: string): Promise<RuleRow | null> {
  const result = await pool.query(
    `SELECT r.id, r.key, r.name, r.description,
            r.script_timeout_ms AS "scriptTimeoutMs", r.created_by AS "createdBy",
            latest.id AS "scriptVersionId", latest.version AS "scriptVersion",
            latest.script_source AS "scriptSource"
       FROM automation_rules r
       LEFT JOIN LATERAL (
         SELECT v.id, v.version, v.script_source
           FROM automation_rule_versions v
          WHERE v.rule_id = r.id
          ORDER BY v.version DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE r.id = $1`,
    [ruleId]
  );
  return (result.rows[0] as RuleRow | undefined) ?? null;
}

export type RunAutomationRuleInput = {
  ruleId: string;
  trigger: AutomationTriggerSource;
  triggeredBy?: string | null;
  scheduledFor?: string;
};

export async function runAutomationRule(input: RunAutomationRuleInput): Promise<AutomationRunSummary> {
  const rule = await loadRule(input.ruleId);
  if (!rule) throw new Error("Automation rule not found");
  if (!rule.scriptVersionId || rule.scriptVersion === null || rule.scriptSource === null) {
    throw new Error("Automation rule has no script version to run");
  }
  const startedAt = Date.now();
  const trigger = {
    source: input.trigger,
    firedAt: new Date().toISOString(),
    ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {})
  };
  // The rule row is locked while the next sequence number is taken, so a
  // manual run started during a scheduled one cannot claim the same number.
  const runInsert = await withTransaction(async (client) => {
    await client.query("SELECT id FROM automation_rules WHERE id = $1 FOR UPDATE", [rule.id]);
    return client.query(
      `INSERT INTO automation_runs(rule_id, sequence, trigger_source, triggered_by, status, trigger_payload, script_version_id)
       VALUES ($1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM automation_runs WHERE rule_id = $1),
               $2, $3, 'running', $4::jsonb, $5)
       RETURNING id, sequence`,
      [rule.id, input.trigger, input.triggeredBy ?? null, JSON.stringify(trigger), rule.scriptVersionId]
    );
  });
  const runId = runInsert.rows[0].id as string;
  const sequence = runInsert.rows[0].sequence as number;

  const logs: SandboxLog[] = [];
  // Everything the script does - including the messages it sends - belongs to
  // this run, so the context is created once the run row exists.
  const context = createAutomationContext({
    requestedBy: rule.createdBy,
    automationRunId: runId,
    deadlineAt: startedAt + rule.scriptTimeoutMs
  });

  const finish = async (
    summary: Pick<AutomationRunSummary, "status" | "output" | "outputTruncated" | "error">
  ): Promise<AutomationRunSummary> => {
    const elapsedMs = Date.now() - startedAt;
    await pool.query(
      `UPDATE automation_runs
          SET status = $1, output_body = $2, output_mime_type = $3, output_truncated = $4,
              logs = $5::jsonb, error = $6, finished_at = now(), elapsed_ms = $7
        WHERE id = $8`,
      [
        summary.status,
        summary.output?.body ?? "",
        summary.output?.mimeType ?? null,
        summary.outputTruncated,
        JSON.stringify(logs),
        summary.error,
        elapsedMs,
        runId
      ]
    );
    await pool.query(
      "UPDATE automation_rules SET last_run_at = now(), last_run_status = $1 WHERE id = $2",
      [summary.status, rule.id]
    );
    return {
      ...summary,
      runId,
      ruleId: rule.id,
      ruleKey: rule.key,
      sequence,
      scriptVersionId: rule.scriptVersionId!,
      scriptVersion: rule.scriptVersion!,
      logs,
      elapsedMs
    };
  };

  const scriptRun = await runInSandbox({
    source: rule.scriptSource,
    globals: { trigger, rule: { key: rule.key, name: rule.name, description: rule.description } },
    methods: context.methodNames,
    timeoutMs: rule.scriptTimeoutMs,
    onCall: context.call,
    onLog: (log) => {
      if (logs.length >= MAX_LOG_ENTRIES) return;
      logs.push(log);
    }
  });

  if (scriptRun.status !== "completed") {
    return finish({
      status: scriptRun.status === "timed_out" ? "timed_out" : "failed",
      output: null,
      outputTruncated: false,
      error: scriptRun.error
    });
  }

  const rawOutput = normalizeScriptOutput(scriptRun.value);
  const outputTruncated = rawOutput.body.length > MAX_OUTPUT_LENGTH;
  return finish({
    status: "succeeded",
    output: {
      mimeType: rawOutput.mimeType,
      body: outputTruncated ? `${rawOutput.body.slice(0, MAX_OUTPUT_LENGTH)}\n[...]` : rawOutput.body
    },
    outputTruncated,
    error: null
  });
}
