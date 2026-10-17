-- Runs that finished before scripts were versioned carry no version id. For a
-- rule that was never edited after it was created, version 1 is provably the
-- source those runs executed, so they are attributed to it; for an edited rule
-- the source they ran is gone, and the run keeps an empty version rather than
-- claiming one it may not have used.
UPDATE automation_runs run
   SET script_version_id = v.id
  FROM automation_rules r
  JOIN automation_rule_versions v ON v.rule_id = r.id AND v.version = 1
 WHERE run.rule_id = r.id
   AND run.script_version_id IS NULL
   AND r.updated_at <= r.created_at;
