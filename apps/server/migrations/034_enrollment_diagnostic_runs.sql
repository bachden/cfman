CREATE TABLE enrollment_diagnostic_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  platform text CHECK (platform IN ('windows', 'unix')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX enrollment_diagnostic_runs_enrollment_idx
  ON enrollment_diagnostic_runs(enrollment_id, created_at DESC);

INSERT INTO enrollment_diagnostic_runs(enrollment_id, token_hash, platform, expires_at)
SELECT id, diagnose_token_hash, platform, diagnose_token_expires_at
  FROM enrollments
 WHERE diagnose_token_hash IS NOT NULL
   AND diagnose_token_expires_at > now()
ON CONFLICT (token_hash) DO NOTHING;

ALTER TABLE enrollment_logs
  DROP CONSTRAINT enrollment_logs_phase_check,
  ADD CONSTRAINT enrollment_logs_phase_check CHECK (phase IN ('enroll', 'unenroll', 'diagnostic')),
  ADD COLUMN diagnostic_run_id uuid REFERENCES enrollment_diagnostic_runs(id) ON DELETE CASCADE;

CREATE INDEX enrollment_logs_diagnostic_run_idx
  ON enrollment_logs(diagnostic_run_id, id);
