-- Argument definitions belong to a script version, not to the script: a version
-- is an immutable snapshot, so the arguments a run was prepared against must
-- stay pinned to the version that ran.
ALTER TABLE managed_script_versions
  ADD COLUMN arguments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT managed_script_versions_arguments_array_check CHECK (jsonb_typeof(arguments) = 'array');

-- Existing versions inherit the script-level definition they were executed
-- with, so recorded history keeps resolving the same argument names.
UPDATE managed_script_versions v
   SET arguments = s.arguments
  FROM managed_scripts s
 WHERE s.id = v.script_id;

ALTER TABLE managed_scripts DROP COLUMN arguments;
