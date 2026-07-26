ALTER TABLE store_command_executions
  DROP CONSTRAINT store_command_executions_status_check;

ALTER TABLE store_command_executions
  ADD CONSTRAINT store_command_executions_status_check
    CHECK (status IN ('scheduled', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'never_run'));
