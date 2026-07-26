DELETE FROM store_command_execution_logs duplicate
USING store_command_execution_logs original
WHERE duplicate.execution_id = original.execution_id
  AND duplicate.sequence = original.sequence
  AND duplicate.sequence IS NOT NULL
  AND duplicate.id > original.id;

CREATE UNIQUE INDEX store_command_execution_logs_sequence_idx
  ON store_command_execution_logs(execution_id, sequence)
  WHERE sequence IS NOT NULL;
