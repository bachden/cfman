ALTER TABLE managed_scripts
  ADD COLUMN arguments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT managed_scripts_arguments_array_check CHECK (jsonb_typeof(arguments) = 'array');

ALTER TABLE cloudflare_accounts
  ADD COLUMN execution_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT cloudflare_accounts_execution_variables_object_check CHECK (jsonb_typeof(execution_variables) = 'object');

ALTER TABLE zones
  ADD COLUMN execution_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT zones_execution_variables_object_check CHECK (jsonb_typeof(execution_variables) = 'object');

ALTER TABLE stores
  ADD COLUMN execution_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT stores_execution_variables_object_check CHECK (jsonb_typeof(execution_variables) = 'object');

ALTER TABLE enrollments
  ADD COLUMN execution_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT enrollments_execution_variables_object_check CHECK (jsonb_typeof(execution_variables) = 'object');

ALTER TABLE store_command_executions
  ADD COLUMN environment_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT store_command_executions_environment_variables_object_check CHECK (jsonb_typeof(environment_variables) = 'object');

ALTER TABLE script_bulk_executions
  ADD COLUMN argument_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT script_bulk_executions_argument_overrides_object_check CHECK (jsonb_typeof(argument_overrides) = 'object');
