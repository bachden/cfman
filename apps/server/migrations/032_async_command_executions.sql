ALTER TABLE store_command_executions
  DROP CONSTRAINT store_command_executions_status_check;

ALTER TABLE store_command_executions
  ALTER COLUMN status SET DEFAULT 'scheduled',
  ALTER COLUMN started_at DROP NOT NULL,
  ALTER COLUMN started_at DROP DEFAULT,
  ADD COLUMN task_id text,
  ADD COLUMN process_id bigint,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD CONSTRAINT store_command_executions_status_check
    CHECK (status IN ('scheduled', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'));

CREATE INDEX store_command_executions_active_idx
  ON store_command_executions(store_id, created_at DESC)
  WHERE status IN ('scheduled', 'running');
