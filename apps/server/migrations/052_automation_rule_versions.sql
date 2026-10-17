-- A rule's script is versioned exactly like a saved script in the library:
-- the content lives in immutable versions, the newest one is what the rule
-- runs, and every run records the version it actually executed.
CREATE TABLE automation_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  script_source text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rule_id, version)
);

CREATE INDEX automation_rule_versions_rule_idx ON automation_rule_versions(rule_id, version DESC);

-- Whatever a rule holds today becomes its version 1, so no rule starts its
-- history empty and every later edit is a numbered change from it.
INSERT INTO automation_rule_versions(rule_id, version, script_source, created_by, created_at)
SELECT id, 1, script_source, created_by, created_at FROM automation_rules;

-- The script now has exactly one home; a column beside the versions could
-- only drift from them.
ALTER TABLE automation_rules DROP COLUMN script_source;

-- Which version a finished run used stays true even after later edits, so the
-- output and logs below it can always be read against the right source.
ALTER TABLE automation_runs
  ADD COLUMN script_version_id uuid REFERENCES automation_rule_versions(id) ON DELETE SET NULL;
