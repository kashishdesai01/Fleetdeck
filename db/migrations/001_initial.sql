CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE sites (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('viewer','operator','admin')));
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE ingest_keys (key_hash text PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites);
CREATE TABLE vehicles (
 id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites, name text UNIQUE NOT NULL,
 model text NOT NULL, generation bigint NOT NULL DEFAULT 0, boot_id uuid,
 revision bigint NOT NULL DEFAULT 0, last_seq bigint NOT NULL DEFAULT -1,
 contact_at timestamptz, observed_at timestamptz, processed_at timestamptz,
 online boolean NOT NULL DEFAULT false, x double precision NOT NULL DEFAULT 130,
 y double precision NOT NULL DEFAULT 150, heading real NOT NULL DEFAULT 0,
 speed real NOT NULL DEFAULT 0, battery real NOT NULL DEFAULT 100,
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','moving','working','charging','stopped','fault'))
);
CREATE TABLE vehicle_boots (vehicle_id uuid NOT NULL REFERENCES vehicles, boot_id uuid NOT NULL, generation bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(vehicle_id,boot_id), UNIQUE(vehicle_id,generation));
CREATE TABLE inbox (
 id bigserial PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites, vehicle_id uuid NOT NULL REFERENCES vehicles,
 boot_id uuid NOT NULL, generation bigint NOT NULL, seq bigint NOT NULL, body_hash text NOT NULL,
 body jsonb NOT NULL, received_at timestamptz NOT NULL, processed_at timestamptz, outcome text,
 UNIQUE(vehicle_id,boot_id,seq), FOREIGN KEY(vehicle_id,boot_id) REFERENCES vehicle_boots(vehicle_id,boot_id)
);
CREATE INDEX inbox_pending ON inbox(vehicle_id,generation,seq) WHERE processed_at IS NULL;
CREATE INDEX inbox_history ON inbox(vehicle_id,id DESC);
CREATE TABLE rule_conditions (vehicle_id uuid NOT NULL REFERENCES vehicles, kind text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(vehicle_id,kind));
CREATE TABLE incidents (
 id uuid PRIMARY KEY, vehicle_id uuid NOT NULL REFERENCES vehicles, type text NOT NULL,
 severity text NOT NULL CHECK(severity IN ('warning','critical')), title text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','acknowledged','resolved')),
 condition_active boolean NOT NULL DEFAULT true, assignee_id uuid REFERENCES users,
 version integer NOT NULL DEFAULT 1, opened_at timestamptz NOT NULL, acknowledged_at timestamptz,
 resolved_at timestamptz, resolution text, note jsonb NOT NULL
);
CREATE UNIQUE INDEX one_live_incident ON incidents(vehicle_id,type) WHERE state <> 'resolved';
CREATE TABLE incident_events (id bigserial PRIMARY KEY, incident_id uuid NOT NULL REFERENCES incidents, at timestamptz NOT NULL, actor text NOT NULL, kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE missions (
 id uuid PRIMARY KEY, vehicle_id uuid NOT NULL REFERENCES vehicles, destination text NOT NULL,
 state text NOT NULL CHECK(state IN ('assigned','in_progress','uncertain','canceling','completed','canceled','failed')),
 version integer NOT NULL DEFAULT 1, current_attempt_id uuid NOT NULL,
 created_at timestamptz NOT NULL, finished_at timestamptz, created_by uuid NOT NULL REFERENCES users
);
CREATE UNIQUE INDEX one_reserved_mission_per_vehicle ON missions(vehicle_id) WHERE state IN ('assigned','in_progress','uncertain','canceling');
CREATE TABLE attempts (
 id uuid PRIMARY KEY, mission_id uuid NOT NULL REFERENCES missions, vehicle_id uuid NOT NULL REFERENCES vehicles,
 state text NOT NULL CHECK(state IN ('reserved','running','unknown','canceling','completed','canceled','failed')),
 created_at timestamptz NOT NULL, terminal_at timestamptz
);
ALTER TABLE missions ADD CONSTRAINT current_attempt_fk FOREIGN KEY(current_attempt_id) REFERENCES attempts(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE commands (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES attempts, vehicle_id uuid NOT NULL REFERENCES vehicles,
 kind text NOT NULL CHECK(kind IN ('start','cancel')), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','completed','expired','superseded')),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, payload jsonb NOT NULL,
 last_sent_at timestamptz, deliveries integer NOT NULL DEFAULT 0, UNIQUE(attempt_id,kind)
);
CREATE TABLE mission_events (id bigserial PRIMARY KEY, mission_id uuid NOT NULL REFERENCES missions, at timestamptz NOT NULL, actor text NOT NULL, kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE idempotency_keys (actor_id uuid NOT NULL REFERENCES users, operation text NOT NULL, key text NOT NULL, body_hash text NOT NULL, response jsonb, PRIMARY KEY(actor_id,operation,key));
CREATE TABLE audit_log (id bigserial PRIMARY KEY, actor_id uuid REFERENCES users, action text NOT NULL, subject_id uuid NOT NULL, at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE demo_scenarios (vehicle_id uuid PRIMARY KEY REFERENCES vehicles, kind text NOT NULL CHECK(kind IN ('normal','offline','battery_low','stuck','lost_ack')), expires_at timestamptz NOT NULL);
