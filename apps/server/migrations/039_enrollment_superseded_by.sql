ALTER TABLE enrollments
  ADD COLUMN superseded_by_enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL;
