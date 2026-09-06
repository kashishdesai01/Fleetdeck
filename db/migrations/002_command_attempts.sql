-- Commands are immutable executions. A new cancellation request gets a new identity.
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_attempt_id_kind_key;
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_state_check;
ALTER TABLE commands ADD CONSTRAINT commands_state_check CHECK(state IN ('pending','accepted','completed','expired','superseded','rejected'));
CREATE INDEX IF NOT EXISTS commands_attempt ON commands(attempt_id);
