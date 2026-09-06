-- Keep the immutable first admission time of the exact applied observation.
-- Existing state stays conservatively ineligible until a new snapshot is applied.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS snapshot_received_at timestamptz;
