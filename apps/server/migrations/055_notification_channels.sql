-- "Communication hub" named a place rather than what it holds. What these
-- tables actually are is the set of channels a rule script (or an operator)
-- sends a notification through, plus the log of what was sent.
ALTER TABLE communication_channels RENAME TO notification_channels;
ALTER TABLE communication_messages RENAME TO notification_messages;

-- Constraints and indexes keep the name they were born with, so they are
-- renamed in bulk rather than one by one; a future column added to either
-- table would otherwise sit beside constraints named after a concept that no
-- longer exists.
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN
    SELECT conname, conrelid::regclass AS table_name
      FROM pg_constraint
     WHERE conname LIKE 'communication\_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      entry.table_name, entry.conname, replace(entry.conname, 'communication_', 'notification_')
    );
  END LOOP;

  FOR entry IN
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = current_schema() AND indexname LIKE 'communication\_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', entry.indexname, replace(entry.indexname, 'communication_', 'notification_'));
  END LOOP;
END $$;
