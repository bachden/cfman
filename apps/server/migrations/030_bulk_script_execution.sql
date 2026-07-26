ALTER TABLE managed_scripts
  ADD COLUMN default_timeout_ms integer NOT NULL DEFAULT 60000
    CHECK (default_timeout_ms BETWEEN 1000 AND 300000);

CREATE TABLE script_bulk_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_script_id uuid NOT NULL REFERENCES managed_scripts(id) ON DELETE CASCADE,
  saved_script_version_id uuid NOT NULL REFERENCES managed_script_versions(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  description_version integer NOT NULL DEFAULT 1 CHECK (description_version > 0),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 300000),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX script_bulk_executions_script_idx
  ON script_bulk_executions(saved_script_id, created_at DESC);

ALTER TABLE store_command_executions
  ADD COLUMN bulk_execution_id uuid REFERENCES script_bulk_executions(id) ON DELETE SET NULL;

CREATE INDEX store_command_executions_bulk_idx
  ON store_command_executions(bulk_execution_id, created_at DESC)
  WHERE bulk_execution_id IS NOT NULL;
