-- An execution a rule script dispatched belongs to that run, not just to the
-- tunnel: the run history can then list what it actually did, and each entry
-- can link straight to that execution's log.
ALTER TABLE tunnel_command_executions
  ADD COLUMN automation_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL;

CREATE INDEX tunnel_command_executions_automation_run_idx
  ON tunnel_command_executions(automation_run_id)
  WHERE automation_run_id IS NOT NULL;
