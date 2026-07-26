ALTER TABLE store_command_executions
  ADD COLUMN argument_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT store_command_executions_argument_sources_object_check CHECK (jsonb_typeof(argument_sources) = 'object');
