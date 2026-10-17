import { pool } from "../database.js";
import { nextRunAt, scheduleSchema } from "./cron.js";
import { runAutomationRule } from "./runner.js";

const MAX_CONCURRENT_RULES = 5;
const inFlight = new Set<string>();

// Recomputes when a rule is next due. Called after every create, update, and
// enable/disable so the schedule in the database always matches the rule the
// operator just saved, instead of waiting for the next tick to notice.
export async function refreshRuleSchedule(ruleId: string): Promise<string | null> {
  const result = await pool.query(
    "SELECT enabled, cron, timezone FROM automation_rules WHERE id = $1",
    [ruleId]
  );
  const rule = result.rows[0] as { enabled: boolean; cron: string; timezone: string } | undefined;
  if (!rule) return null;
  if (!rule.enabled) {
    await pool.query("UPDATE automation_rules SET next_run_at = null WHERE id = $1", [ruleId]);
    return null;
  }
  const next = nextRunAt(scheduleSchema.parse({ cron: rule.cron, timezone: rule.timezone }));
  await pool.query("UPDATE automation_rules SET next_run_at = $1 WHERE id = $2", [next, ruleId]);
  return next ? next.toISOString() : null;
}

// A run that was still 'running' when the process stopped can never report
// its own outcome, so it is closed out at startup the same way orphaned
// command executions are.
async function reconcileInterruptedRuns(): Promise<void> {
  await pool.query(
    `UPDATE automation_runs
        SET status = 'failed', finished_at = now(),
            elapsed_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
            error = 'The server stopped before this run finished.'
      WHERE status = 'running'`
  );
}

export async function reconcileAutomationSchedules(): Promise<void> {
  await reconcileInterruptedRuns();
  const result = await pool.query(
    "SELECT id FROM automation_rules WHERE enabled AND next_run_at IS NULL"
  );
  for (const row of result.rows as Array<{ id: string }>) {
    try {
      await refreshRuleSchedule(row.id);
    } catch {
      // A rule whose cron expression became invalid stays unscheduled rather
      // than preventing every other rule from being scheduled.
      await pool.query("UPDATE automation_rules SET next_run_at = null WHERE id = $1", [row.id]);
    }
  }
}

async function claimDueRules(limit: number): Promise<Array<{ id: string }>> {
  // Clearing next_run_at is the claim: a rule that is already running cannot be
  // picked up again by the next tick, and the value is recomputed from the
  // cron expression once the run settles.
  const result = await pool.query(
    `UPDATE automation_rules
        SET next_run_at = null
      WHERE id IN (
        SELECT id FROM automation_rules
         WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
         ORDER BY next_run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [limit]
  );
  return result.rows as Array<{ id: string }>;
}

async function runClaimedRule(rule: { id: string }, scheduledFor: string): Promise<void> {
  inFlight.add(rule.id);
  try {
    await runAutomationRule({ ruleId: rule.id, trigger: "timer", scheduledFor });
  } catch (error) {
    await pool.query(
      `INSERT INTO automation_runs(rule_id, sequence, trigger_source, status, error, finished_at, elapsed_ms)
       VALUES ($1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM automation_runs WHERE rule_id = $1),
               'timer', 'failed', $2, now(), 0)`,
      [rule.id, error instanceof Error ? error.message : "The rule could not be started"]
    );
  } finally {
    inFlight.delete(rule.id);
    try {
      await refreshRuleSchedule(rule.id);
    } catch {
      await pool.query("UPDATE automation_rules SET next_run_at = null WHERE id = $1", [rule.id]);
    }
  }
}

let ticking = false;

export async function tickAutomationScheduler(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const capacity = MAX_CONCURRENT_RULES - inFlight.size;
    if (capacity <= 0) return;
    const due = await claimDueRules(capacity);
    const scheduledFor = new Date().toISOString();
    for (const rule of due) {
      void runClaimedRule(rule, scheduledFor);
    }
  } finally {
    ticking = false;
  }
}

export function startAutomationScheduler(intervalMs = 15_000): void {
  const timer = setInterval(() => {
    void tickAutomationScheduler().catch(() => undefined);
  }, intervalMs);
  timer.unref();
}
