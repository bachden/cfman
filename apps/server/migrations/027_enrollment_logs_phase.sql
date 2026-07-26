ALTER TABLE enrollment_logs
  ADD COLUMN phase text NOT NULL DEFAULT 'enroll' CHECK (phase IN ('enroll', 'unenroll'));
