import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { Database } from '../apps/api/src/db.js';
import { FleetService, type Actor } from '../apps/api/src/service.js';
import { createApp } from '../apps/api/src/app.js';
import { EtaEstimator } from '../apps/api/src/eta.js';
import { policy, tokenHash, type Snapshot, type Message } from '../packages/core/src/domain.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const url =
  process.env.FLEETDECK_TEST_URL ??
  'postgres://fleetdeck:fleetdeck_local_only@127.0.0.1:55437/fleetdeck';
const schema = `fleetdeck_test_${randomUUID().replaceAll('-', '')}`;
const root = new pg.Pool({ connectionString: url, max: 2 });
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
let now = Date.parse('2026-10-19T12:00:00.000Z');
const db = new Database(pool, { now: () => new Date(now) }),
  service = new FleetService(db);
const site = '10000000-0000-4000-8000-000000000001',
  v1 = '30000000-0000-4000-8000-000000000001',
  v2 = '30000000-0000-4000-8000-000000000002',
  boot = '40000000-0000-4000-8000-000000000001';
const actor: Actor = { id: '20000000-0000-4000-8000-000000000001', name: 'Alex', role: 'admin' };
const gatewayKey = 'test_gateway_secret_at_least_32_characters';
function snap(seq: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    kind: 'snapshot',
    vehicleId: v1,
    bootId: boot,
    seq,
    at: new Date(now).toISOString(),
    x: 130,
    y: 150,
    heading: 0,
    speed: 0,
    battery: 85,
    status: 'idle',
    ...over,
  };
}
async function drain() {
  for (let i = 0; i < 100; i++) {
    if (!(await service.processOne())) return;
  }
  throw new Error('Inbox did not drain.');
}
async function admit(msg: Message) {
  await service.ingest(site, [msg]);
  await drain();
}
async function dispatch(
  vehicleId = v1,
  key = randomUUID(),
): Promise<{ id: string; attemptId: string; commandId: string; version: number }> {
  return (await service.dispatch(actor, key, { vehicleId, destination: 'shipping' })) as {
    id: string;
    attemptId: string;
    commandId: string;
    version: number;
  };
}
async function report(
  seq: number,
  mission: Awaited<ReturnType<typeof dispatch>>,
  outcome: 'started' | 'completed' | 'canceled' | 'accepted' | 'rejected',
  extra: Partial<Message> = {},
) {
  await admit({
    kind: 'command_report',
    vehicleId: v1,
    bootId: boot,
    seq,
    at: new Date(now).toISOString(),
    commandId: mission.commandId,
    attemptId: mission.attemptId,
    outcome,
    ...extra,
  } as Message);
}
async function vehicle() {
  return (await pool.query('SELECT * FROM vehicles WHERE id=$1', [v1])).rows[0];
}
async function mission(id: string) {
  return (await pool.query('SELECT * FROM missions WHERE id=$1', [id])).rows[0];
}

describe.skipIf(!enabled)('PostgreSQL contracts and authenticated HTTP', () => {
  beforeAll(async () => {
    if (!new URL(url).pathname.match(/fleetdeck|test/))
      throw new Error('Integration tests require an explicitly named fleetdeck/test database.');
    await root.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile('db/migrations/001_initial.sql', 'utf8'));
    await pool.query(await readFile('db/migrations/002_command_attempts.sql', 'utf8'));
    await pool.query(await readFile('db/migrations/003_snapshot_receipt.sql', 'utf8'));
    await pool.query(await readFile('db/migrations/004_mission_eta.sql', 'utf8'));
    await pool.query(
      "INSERT INTO schema_migrations(version) VALUES('001'),('002'),('003'),('004')",
    );
  });
  afterAll(async () => {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  });
  beforeEach(async () => {
    now = Date.parse('2026-10-19T12:00:00.000Z');
    await pool.query('TRUNCATE sites,users CASCADE');
    await pool.query("INSERT INTO sites(id,name) VALUES($1,'Test site')", [site]);
    await pool.query(
      "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,'demo@fleetdeck.local','Alex','unused','admin')",
      [actor.id],
    );
    await pool.query(
      "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,'viewer@fleetdeck.local','Observer','unused','viewer')",
      ['20000000-0000-4000-8000-000000000002'],
    );
    await pool.query('INSERT INTO ingest_keys(key_hash,site_id) VALUES($1,$2)', [
      tokenHash(gatewayKey),
      site,
    ]);
    await pool.query(
      "INSERT INTO vehicles(id,site_id,name,model) VALUES($1,$3,'AMR-01','Test'),($2,$3,'AMR-02','Test')",
      [v1, v2, site],
    );
    await service.registerBoot(site, v1, boot);
    await service.registerBoot(site, v2, boot);
    await admit(snap(1));
    await admit(snap(1, { vehicleId: v2 }));
  });
  it('readiness requires the migration used by mission predictions', async () => {
    const app = await createApp({ db, serveWeb: false });
    try {
      expect((await app.inject('/readyz')).statusCode).toBe(200);
      await pool.query("DELETE FROM schema_migrations WHERE version='004'");
      expect((await app.inject('/readyz')).statusCode).toBe(503);
    } finally {
      await pool.query(
        "INSERT INTO schema_migrations(version) VALUES('004') ON CONFLICT DO NOTHING",
      );
      await app.close();
    }
  });
  it('persists an immutable dispatch prediction and unchanged idempotent response', async () => {
    const key = randomUUID();
    const first = await dispatch(v1, key);
    const row = await mission(first.id);
    expect(row.eta.source).toBe('model');
    expect(row.eta.features.distance).toBe(990);
    expect(row.eta.modelVersion).toMatch(/^eta-gbr-v1-/);
    expect(row.eta.artifactSha256).toHaveLength(64);
    now += 1000;
    await admit(snap(2, { battery: 80 }));
    expect(await dispatch(v1, key)).toEqual(first);
    expect((await mission(first.id)).eta).toEqual(row.eta);
    const command = (
      await pool.query('SELECT payload FROM commands WHERE id=$1', [first.commandId])
    ).rows[0];
    expect(command.payload.congestion).toBe(row.eta.features.congestion);
  });
  it('completion monitoring uses first report receipt, excludes reconciliation, and ignores retries', async () => {
    const m = await dispatch();
    now += 12000;
    const msg: Message = {
      kind: 'command_report',
      vehicleId: v1,
      bootId: boot,
      seq: 2,
      at: new Date(now).toISOString(),
      commandId: m.commandId,
      attemptId: m.attemptId,
      outcome: 'completed',
    };
    await service.ingest(site, [msg]);
    now += 5000;
    await drain();
    expect((await mission(m.id)).eta_observed_seconds).toBe(12);
    await service.ingest(site, [msg]);
    await drain();
    expect((await mission(m.id)).eta_observed_seconds).toBe(12);
    const monitoring = await service.etaMonitoring();
    expect(monitoring.recent[0].labeled).toBe(1);
    expect(Number(monitoring.recent[0].mae_seconds)).toBeGreaterThan(0);
    await admit(snap(3));
    const second = await dispatch();
    now += policy.commandTtlMs + 1;
    await service.sweep();
    await report(4, second, 'completed');
    expect((await mission(second.id)).eta_reconciled).toBe(true);
    const after = await service.etaMonitoring();
    expect(after.recent[0].labeled).toBe(1);
    expect(after.recent[0].reconciled_excluded).toBe(1);
  });
  it('disabled model preserves dispatch behavior using an explicit baseline', async () => {
    const fallback = new FleetService(db, 100000, new EtaEstimator(false));
    const m = (await fallback.dispatch(actor, randomUUID(), {
      vehicleId: v1,
      destination: 'shipping',
    })) as { eta: { source: string; reason: string; lowerSeconds: number | null } };
    expect(m.eta.source).toBe('baseline');
    expect(m.eta.reason).toBe('disabled');
    expect(m.eta.lowerSeconds).toBeNull();
  });
  it('preview withholds stale snapshots despite renewed contact and does not reserve a vehicle', async () => {
    expect((await service.previewEta(v1, 'shipping')).source).toBe('model');
    expect((await pool.query('SELECT count(*) FROM missions')).rows[0].count).toBe('0');
    now += 12000;
    await service.ingest(site, [snap(1, { at: '2026-10-19T12:00:00.000Z' })]);
    const prediction = await service.previewEta(v1, 'shipping');
    expect(prediction.source).toBe('unavailable');
    expect(prediction.seconds).toBeNull();
  });
  it('returns acceptance only after durable admission; unchanged retry is a duplicate', async () => {
    const m = snap(2);
    const result = await service.ingest(site, [m]);
    expect(result.accepted).toBe(1);
    expect(
      (await pool.query('SELECT processed_at FROM inbox WHERE seq=2')).rows[0].processed_at,
    ).toBeNull();
    expect((await service.ingest(site, [m])).duplicates).toBe(1);
    await drain();
    expect((await vehicle()).last_seq).toBe('2');
  });
  it('conflicting timestamp or payload reuse is rejected atomically', async () => {
    const m = snap(2);
    await service.ingest(site, [m]);
    await expect(service.ingest(site, [snap(3), { ...m, battery: 2 }])).rejects.toMatchObject({
      code: 'identity_conflict',
    });
    expect((await pool.query('SELECT count(*) FROM inbox WHERE seq=3')).rows[0].count).toBe('0');
    await expect(
      service.ingest(site, [{ ...m, at: new Date(now + 1000).toISOString() }]),
    ).rejects.toMatchObject({ code: 'identity_conflict' });
  });
  it('newer sequence wins even if a lower sequence has a later clamped receipt time', async () => {
    await admit(snap(101, { at: new Date(now + 30000).toISOString(), battery: 80 }));
    now += 1000;
    await admit(snap(100, { at: new Date(now + 28000).toISOString(), battery: 2 }));
    expect((await vehicle()).battery).toBe(80);
  });
  it('old boot cannot overwrite new boot and repeated registration cannot reactivate it', async () => {
    const second = randomUUID();
    await service.registerBoot(site, v1, second);
    await admit(snap(0, { bootId: second, battery: 91 }));
    expect((await service.registerBoot(site, v1, boot)).active).toBe(false);
    await admit(snap(99, { battery: 1 }));
    expect((await vehicle()).battery).toBe(91);
  });
  it('capacity recovers after processing; acknowledged history does not count as backlog', async () => {
    const bounded = new FleetService(db, 3);
    await bounded.ingest(site, [snap(2), snap(3), snap(4)]);
    await expect(bounded.ingest(site, [snap(5)])).rejects.toMatchObject({ code: 'overloaded' });
    await drain();
    await expect(bounded.ingest(site, [snap(5)])).resolves.toMatchObject({ accepted: 1 });
  });
  it('SQL current state converges across different application order and duplicate retries', async () => {
    await admit(snap(20, { battery: 70 }));
    await admit(snap(12, { battery: 10 }));
    await admit(snap(19, { battery: 20 }));
    expect((await vehicle()).battery).toBe(70);
    await service.ingest(site, [snap(20, { battery: 70 })]);
    await drain();
    expect((await vehicle()).battery).toBe(70);
  });
  it('concurrent consumers apply each admitted message once', async () => {
    for (let i = 2; i <= 20; i++) await service.ingest(site, [snap(i)]);
    await Promise.all(Array.from({ length: 8 }, () => service.processOne()));
    expect(
      (await pool.query('SELECT count(*) FROM inbox WHERE processed_at IS NULL')).rows[0].count,
    ).toBe('0');
    expect((await vehicle()).last_seq).toBe('20');
  });
  it('a rolled-back processing batch leaves no partial effects and is retryable', async () => {
    await service.ingest(site, [snap(2, { battery: 50 })]);
    await expect(service.processOne(true)).rejects.toThrow('Injected');
    expect((await vehicle()).battery).toBe(85);
    await drain();
    expect((await vehicle()).battery).toBe(50);
  });
  it('SIGKILL before commit recovers without a lease or duplicate application', async () => {
    await service.ingest(site, [snap(2, { battery: 50 })]);
    const crashUrl = new URL(url);
    crashUrl.searchParams.set('options', `-c search_path=${schema}`);
    const child = fork('tests/crash-worker.ts', [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, DATABASE_URL: crashUrl.toString() },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Crash failpoint timeout'));
      }, 8000);
      child.once('message', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once('error', reject);
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    expect((await vehicle()).battery).toBe(85);
    await drain();
    expect((await vehicle()).battery).toBe(50);
  });
  it('historical replay cannot generate a live battery incident, across batch splits', async () => {
    for (let i = 2; i < 15; i++) {
      await admit(snap(i, { at: new Date(now - 30000 + i * 1000).toISOString(), battery: 10 }));
      now += 1000;
    }
    expect(
      (await pool.query("SELECT count(*) FROM incidents WHERE type='battery_low'")).rows[0].count,
    ).toBe('0');
  });
  it('fresh low battery creates one incident; duplicates and parallel consumers do not repeat it', async () => {
    for (let i = 2; i < 16; i++) {
      now += 1000;
      await admit(snap(i, { battery: 10 }));
    }
    expect(
      (await pool.query("SELECT count(*) FROM incidents WHERE type='battery_low'")).rows[0].count,
    ).toBe('1');
    await service.ingest(site, [snap(15, { battery: 10 })]);
    await Promise.all([service.processOne(), service.processOne()]);
    expect(
      (await pool.query("SELECT count(*) FROM incidents WHERE type='battery_low'")).rows[0].count,
    ).toBe('1');
  });
  it('a missing observation interval resets duration instead of counting silence', async () => {
    now += 1000;
    await admit(snap(2, { battery: 10 }));
    now += 20000;
    await admit(snap(3, { battery: 10 }));
    expect(
      (await pool.query("SELECT count(*) FROM incidents WHERE type='battery_low'")).rows[0].count,
    ).toBe('0');
  });
  it('offline transitions increment revision and valid duplicate contact clears the condition', async () => {
    const before = BigInt((await vehicle()).revision);
    now += 16000;
    await service.sweep();
    const off = await vehicle();
    expect(off.online).toBe(false);
    expect(BigInt(off.revision)).toBeGreaterThan(before);
    await service.ingest(site, [snap(1, { at: '2026-10-19T12:00:00.000Z' })]);
    expect((await vehicle()).online).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT condition_active FROM incidents WHERE type='offline' AND vehicle_id='30000000-0000-4000-8000-000000000001'",
        )
      ).rows[0].condition_active,
    ).toBe(false);
  });
  it('two operators acknowledging the same version get one success and one conflict', async () => {
    now += 16000;
    await service.sweep();
    const i = (
      await pool.query("SELECT * FROM incidents WHERE vehicle_id=$1 AND type='offline'", [v1])
    ).rows[0];
    const results = await Promise.allSettled([
      service.incidentAction(actor, i.id, { action: 'acknowledge', version: i.version }),
      service.incidentAction(actor, i.id, { action: 'acknowledge', version: i.version }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code,
    ).toBe('version_conflict');
  });
  it('active conditions cannot be hidden by manual resolution; recovery permits a noted resolution', async () => {
    now += 16000;
    await service.sweep();
    let i = (
      await pool.query("SELECT * FROM incidents WHERE vehicle_id=$1 AND type='offline'", [v1])
    ).rows[0];
    await expect(
      service.incidentAction(actor, i.id, { action: 'resolve', version: i.version, note: 'done' }),
    ).rejects.toMatchObject({ code: 'condition_active' });
    await service.ingest(site, [snap(2)]);
    i = (await pool.query('SELECT * FROM incidents WHERE id=$1', [i.id])).rows[0];
    await service.incidentAction(actor, i.id, {
      action: 'resolve',
      version: i.version,
      note: 'Verified restored gateway contact.',
    });
    expect(
      (await pool.query('SELECT state FROM incidents WHERE id=$1', [i.id])).rows[0].state,
    ).toBe('resolved');
  });
  it('idempotency is claimed before changing eligibility and rejects changed request bodies', async () => {
    const key = randomUUID(),
      a = await dispatch(v1, key),
      b = await dispatch(v1, key);
    expect(b).toEqual(a);
    await expect(
      service.dispatch(actor, key, { vehicleId: v2, destination: 'shipping' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });
  });
  it('concurrent assignments reserve a vehicle only once', async () => {
    const results = await Promise.allSettled([dispatch(), dispatch()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT count(*) FROM missions')).rows[0].count).toBe('1');
  });
  it('complete-before-start is terminal; a delayed start cannot regress it', async () => {
    const m = await dispatch();
    await report(2, m, 'completed');
    await report(3, m, 'started');
    expect((await mission(m.id)).state).toBe('completed');
  });
  it('lost acknowledgement enters uncertainty and retains the reservation', async () => {
    const m = await dispatch();
    now += policy.commandTtlMs + 1;
    await service.sweep();
    expect((await mission(m.id)).state).toBe('uncertain');
    await admit(snap(2));
    await expect(dispatch()).rejects.toMatchObject({ code: 'vehicle_reserved' });
    await report(3, m, 'completed');
    expect((await mission(m.id)).state).toBe('completed');
  });
  it('a vehicle cannot acknowledge another vehicle’s command or release its reservation', async () => {
    const m = await dispatch();
    await admit({
      kind: 'command_report',
      vehicleId: v2,
      bootId: boot,
      seq: 2,
      at: new Date(now).toISOString(),
      commandId: m.commandId,
      attemptId: m.attemptId,
      outcome: 'completed',
    });
    expect((await mission(m.id)).state).toBe('assigned');
    expect(
      (await pool.query('SELECT outcome FROM inbox WHERE vehicle_id=$1 AND seq=2', [v2])).rows[0]
        .outcome,
    ).toBe('unauthorized_report');
  });
  it('cancellation holds reservation until a valid terminal report', async () => {
    const m = await dispatch();
    await service.cancel(actor, m.id, 1);
    expect((await mission(m.id)).state).toBe('canceling');
    const c = (
      await pool.query("SELECT id FROM commands WHERE attempt_id=$1 AND kind='cancel'", [
        m.attemptId,
      ])
    ).rows[0];
    await report(2, { ...m, commandId: c.id }, 'canceled');
    expect((await mission(m.id)).state).toBe('canceled');
  });
  it('late terminal reports for an old attempt cannot mutate a new mission', async () => {
    const old = await dispatch();
    await report(2, old, 'completed');
    const newer = await dispatch();
    await report(3, old, 'completed');
    expect((await mission(newer.id)).state).toBe('assigned');
  });
  it('an accepted receipt is not execution evidence and still becomes uncertain', async () => {
    const m = await dispatch();
    await report(2, m, 'accepted');
    now += policy.commandTtlMs + 1;
    await service.sweep();
    expect((await mission(m.id)).state).toBe('uncertain');
  });

  it('rejected cancellation never releases potentially executing work', async () => {
    const m = await dispatch();
    await report(2, m, 'started');
    await service.cancel(actor, m.id, (await mission(m.id)).version);
    const c = (
      await pool.query(
        "SELECT id FROM commands WHERE attempt_id=$1 AND kind='cancel' ORDER BY created_at DESC",
        [m.attemptId],
      )
    ).rows[0];
    await report(3, { ...m, commandId: c.id }, 'rejected');
    expect((await mission(m.id)).state).toBe('uncertain');
    await expect(dispatch()).rejects.toMatchObject({ code: 'vehicle_reserved' });
  });
  it('rejected start also preserves uncertainty rather than claiming terminal evidence', async () => {
    const m = await dispatch();
    await report(2, m, 'rejected');
    expect((await mission(m.id)).state).toBe('uncertain');
    await expect(dispatch()).rejects.toMatchObject({ code: 'vehicle_reserved' });
  });
  for (const interruption of ['offline', 'stale', 'boot'] as const)
    it(`active battery incident clears after ${interruption} and fresh healthy data`, async () => {
      for (let seq = 2; seq < 15; seq++) {
        now += 1000;
        await admit(snap(seq, { battery: 10 }));
      }
      expect(
        (
          await pool.query(
            "SELECT condition_active FROM incidents WHERE vehicle_id=$1 AND type='battery_low'",
            [v1],
          )
        ).rows[0].condition_active,
      ).toBe(true);
      let nextBoot = boot;
      if (interruption === 'offline') {
        now += 16000;
        await service.sweep();
      }
      if (interruption === 'stale')
        await admit(snap(15, { at: new Date(now - 30000).toISOString(), battery: 10 }));
      if (interruption === 'boot') {
        nextBoot = randomUUID();
        await service.registerBoot(site, v1, nextBoot);
      }
      now += 1000;
      await admit(snap(16, { bootId: nextBoot, battery: 85 }));
      expect(
        (
          await pool.query(
            "SELECT condition_active FROM incidents WHERE vehicle_id=$1 AND type='battery_low'",
            [v1],
          )
        ).rows[0].condition_active,
      ).toBe(false);
    });
  it('cancellation retry creates a new identity and leaves the old expiry immutable', async () => {
    const m = await dispatch();
    await report(2, m, 'started');
    await service.cancel(actor, m.id, (await mission(m.id)).version);
    const first = (
      await pool.query("SELECT * FROM commands WHERE attempt_id=$1 AND kind='cancel'", [
        m.attemptId,
      ])
    ).rows[0];
    now += 21000;
    await service.sweep();
    await report(3, { ...m, commandId: first.id }, 'rejected');
    await service.cancel(actor, m.id, (await mission(m.id)).version);
    const rows = (
      await pool.query(
        "SELECT * FROM commands WHERE attempt_id=$1 AND kind='cancel' ORDER BY created_at",
        [m.attemptId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].id).not.toBe(first.id);
    expect(rows[0].expires_at).toEqual(first.expires_at);
    expect(rows[0].state).toBe('superseded');
    await report(4, { ...m, commandId: rows[1].id }, 'canceled');
    expect((await mission(m.id)).state).toBe('canceled');
  });
  it('an old uncertain reservation stays visible after more than 100 terminal missions', async () => {
    const held = await dispatch();
    now += 21000;
    await service.ingest(site, [snap(1, { vehicleId: v2, at: '2026-10-19T12:00:00.000Z' })]);
    await service.sweep();
    for (let i = 0; i < 105; i++) {
      now += 1000;
      await admit(snap(i * 2 + 2, { vehicleId: v2 }));
      const m = await dispatch(v2);
      await report(i * 2 + 3, m, 'completed', { vehicleId: v2 });
    }
    const snapshot = (await service.state()) as { missions: { id: string; state: string }[] };
    expect(snapshot.missions.some((m) => m.id === held.id && m.state === 'uncertain')).toBe(true);
    expect(snapshot.missions.filter((m) => m.state === 'completed')).toHaveLength(100);
  });
  it('skew and refreshed contact cannot launder a queued-old snapshot into dispatch eligibility', async () => {
    const firstReceipt = now;
    const delayed = snap(2, { at: new Date(now + 30000).toISOString() });
    await service.ingest(site, [delayed]);
    now += 30000;
    await service.ingest(site, [delayed]);
    await drain();
    const current = await vehicle();
    expect(current.observed_at.getTime()).toBe(now);
    expect(current.contact_at.getTime()).toBe(now);
    expect(current.snapshot_received_at.getTime()).toBe(firstReceipt);
    await expect(dispatch()).rejects.toMatchObject({ code: 'vehicle_ineligible' });
    await admit(snap(3));
    await expect(dispatch()).resolves.toMatchObject({ state: 'assigned' });
    const nextBoot = randomUUID();
    await service.registerBoot(site, v2, nextBoot);
    expect(
      (await pool.query('SELECT snapshot_received_at FROM vehicles WHERE id=$1', [v2])).rows[0]
        .snapshot_received_at,
    ).toBeNull();
  });
  it('gateway scope, CSRF, role checks, schema limits and session cookies are enforced', async () => {
    const app = await createApp({ db, demo: true, demoRole: 'viewer', serveWeb: false });
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/state' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: `/v1/eta?vehicleId=${v1}&destination=shipping` }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/auth/demo',
            headers: { origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(403);
      const login = await app.inject({ method: 'POST', url: '/v1/auth/demo', payload: {} });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      expect(login.headers['set-cookie']).toContain('HttpOnly');
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
      const csrf = (me.json() as { csrf: string }).csrf;
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/eta?vehicleId=${v1}&destination=shipping`,
            headers: { cookie },
          })
        ).json().source,
      ).toBe('model');
      expect(
        (await app.inject({ method: 'GET', url: '/v1/eta/monitoring', headers: { cookie } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/missions',
            headers: { cookie },
            payload: { vehicleId: v1, destination: 'shipping' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/missions',
            headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
            payload: { vehicleId: v1, destination: 'shipping' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/ingest/telemetry',
            headers: { authorization: `Bearer ${gatewayKey}` },
            payload: { messages: [snap(2, { vehicleId: randomUUID() })] },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/ingest/telemetry',
            headers: { authorization: `Bearer ${gatewayKey}` },
            payload: { messages: [{ ...snap(2), x: -1 }] },
          })
        ).statusCode,
      ).toBe(422);
    } finally {
      await app.close();
    }
  });
  it('production mode does not expose demo login', async () => {
    const app = await createApp({ db, demo: false, serveWeb: false });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/demo', payload: {} })).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
