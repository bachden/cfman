CREATE TABLE store_command_execution_logs (
  id bigserial PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES store_command_executions(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('stdout', 'stderr')),
  line text NOT NULL,
  sequence integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_command_execution_logs_execution_idx
  ON store_command_execution_logs(execution_id, id);
