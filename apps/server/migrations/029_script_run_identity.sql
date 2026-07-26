ALTER TABLE enrollment_scripts
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT enrollment_scripts_id_key UNIQUE (id);

ALTER TABLE enrollment_logs
  ADD COLUMN enrollment_script_id uuid REFERENCES enrollment_scripts(id) ON DELETE SET NULL;

CREATE INDEX enrollment_logs_script_idx
  ON enrollment_logs(enrollment_script_id, id);

ALTER TABLE enrollments
  ADD COLUMN unenroll_tunnel_id text;

ALTER TABLE store_command_executions
  ADD COLUMN report_token_hash char(64),
  ADD COLUMN reported_at timestamptz;

CREATE UNIQUE INDEX store_command_executions_report_token_idx
  ON store_command_executions(report_token_hash)
  WHERE report_token_hash IS NOT NULL;
