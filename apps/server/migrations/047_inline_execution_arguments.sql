-- Inline scripts have no persisted version to hang argument declarations off
-- of, so an operator preparing an inline run declares them ad hoc, for that
-- run only. They're recorded on the execution itself (mirroring
-- managed_script_versions.arguments) so "Applied arguments" can show them and
-- saving the execution to the script library can carry them into version 1.
ALTER TABLE tunnel_command_executions
  ADD COLUMN inline_arguments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT tunnel_command_executions_inline_arguments_array_check CHECK (jsonb_typeof(inline_arguments) = 'array');
