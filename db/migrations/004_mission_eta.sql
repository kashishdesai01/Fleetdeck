-- Immutable dispatch prediction; completion labels measure server-observed report receipt.
ALTER TABLE missions ADD COLUMN eta jsonb;
ALTER TABLE missions ADD COLUMN eta_observed_seconds double precision CHECK (eta_observed_seconds >= 0);
ALTER TABLE missions ADD COLUMN eta_reconciled boolean NOT NULL DEFAULT false;
CREATE INDEX mission_eta_monitoring ON missions(created_at DESC) WHERE eta IS NOT NULL;
