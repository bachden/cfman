-- An automation rule is one script, not an event-condition-action pipeline.
--
-- Anything a condition or an action could express is ordinary JavaScript the
-- script already has: it decides for itself whether there is something to
-- report and calls cfman.sendMessage when there is. What remains that a script
-- cannot do for itself is the schedule that starts it, so the timer moves out
-- of the generic event_type/event_config pair and into plain columns.
DROP TABLE IF EXISTS automation_rule_actions;

ALTER TABLE automation_rules
  DROP COLUMN IF EXISTS condition_source,
  ADD COLUMN IF NOT EXISTS cron text NOT NULL DEFAULT '0 * * * *',
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

UPDATE automation_rules
   SET cron = COALESCE(NULLIF(event_config->>'cron', ''), cron),
       timezone = COALESCE(NULLIF(event_config->>'timezone', ''), timezone);

ALTER TABLE automation_rules
  ALTER COLUMN cron DROP DEFAULT,
  ALTER COLUMN timezone DROP DEFAULT,
  DROP COLUMN event_type,
  DROP COLUMN event_config;

DROP INDEX IF EXISTS automation_rules_due_idx;
CREATE INDEX automation_rules_due_idx ON automation_rules(next_run_at) WHERE enabled;

-- 'matched' and 'skipped' only ever meant "the condition was true / false";
-- with no condition left, a run that finished is simply a run that succeeded.
UPDATE automation_runs SET status = 'succeeded' WHERE status IN ('matched', 'skipped');
UPDATE automation_rules SET last_run_status = 'succeeded' WHERE last_run_status IN ('matched', 'skipped');

ALTER TABLE automation_runs
  DROP CONSTRAINT IF EXISTS automation_runs_status_check,
  DROP CONSTRAINT IF EXISTS automation_runs_failed_stage_check,
  DROP COLUMN IF EXISTS failed_stage,
  DROP COLUMN IF EXISTS condition_result,
  DROP COLUMN IF EXISTS action_results,
  -- A dry run made sense only while the actions were the side effects; a
  -- script performs its own, so there is nothing left to hold back.
  DROP COLUMN IF EXISTS dry_run,
  ADD CONSTRAINT automation_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out'));

ALTER TABLE automation_runs RENAME COLUMN event_payload TO trigger_payload;
