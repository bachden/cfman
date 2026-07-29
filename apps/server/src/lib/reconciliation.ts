import { pool } from "./database.js";

// Command agents execute asynchronously and may report after a server restart.
// Only expire active rows after their own limit plus callback headroom; a later
// authenticated success report is still allowed to correct this timeout.
async function reconcileOrphanedCommandExecutions(): Promise<void> {
  await pool.query(
    `UPDATE tunnel_command_executions
        SET status = 'timed_out', finished_at = now(),
            elapsed_ms = GREATEST(timeout_ms, EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000)::int,
            error = 'No final result was reported before the execution deadline.'
      WHERE status IN ('scheduled', 'running')
        AND COALESCE(started_at, created_at) + ((timeout_ms + 300000)::text || ' milliseconds')::interval < now()`
  );
}

// An enrollment link only ever flips to 'expired' when something happens to
// notice - a claim attempt against it, or the read-time fallback expression
// used for display. Nothing proactively marks it, so the raw status can sit
// stale at 'url_issued' long after expires_at has passed. Only the
// enrollment's own status is touched here - tunnels.onboarding_status is left
// alone, since its display already derives the correct value (including
// falling back to an older still-active enrollment) via
// onboardingStatusExpression, and duplicating that fallback logic here would
// just risk the two drifting apart.
async function reconcileExpiredEnrollments(): Promise<void> {
  await pool.query(
    `UPDATE enrollments SET status = 'expired', updated_at = now()
      WHERE status = 'url_issued' AND expires_at <= now()`
  );
}

export async function runStartupReconciliation(): Promise<void> {
  await reconcileOrphanedCommandExecutions();
  await reconcileExpiredEnrollments();
}

export function scheduleExpiredEnrollmentSweep(intervalMs = 15 * 60 * 1000): void {
  const timer = setInterval(() => {
    void Promise.all([
      reconcileExpiredEnrollments(),
      reconcileOrphanedCommandExecutions()
    ]).catch(() => undefined);
  }, intervalMs);
  timer.unref();
}
