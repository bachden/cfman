-- Every run of a rule gets a number that counts up per rule, independent of
-- which script version it executed: "run #12 of this rule" is how an operator
-- and a script refer to one run, while the version says what it ran.
ALTER TABLE automation_runs ADD COLUMN sequence integer;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY rule_id ORDER BY started_at, id) AS sequence
    FROM automation_runs
)
UPDATE automation_runs run
   SET sequence = numbered.sequence
  FROM numbered
 WHERE numbered.id = run.id;

ALTER TABLE automation_runs
  ALTER COLUMN sequence SET NOT NULL,
  ADD CONSTRAINT automation_runs_sequence_check CHECK (sequence > 0);

-- Also the lookup path for cfman.getRun(ruleKey, sequence).
CREATE UNIQUE INDEX automation_runs_rule_sequence_idx ON automation_runs(rule_id, sequence);
