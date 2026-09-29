import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Database } from '../apps/api/src/db.js';
import { FleetService } from '../apps/api/src/service.js';
import { createApp } from '../apps/api/src/app.js';
import { tokenHash, type Snapshot } from '../packages/core/src/domain.js';
const url =
  process.env.FLEETDECK_TEST_URL ??
  process.env.DATABASE_URL ??
  'postgres://fleetdeck:fleetdeck_local_only@127.0.0.1:55437/fleetdeck';
if (!new URL(url).pathname.match(/fleetdeck|test/))
  throw new Error('Benchmark requires a dedicated Fleetdeck/test database.');
const schema = `fleetdeck_bench_${randomUUID().replaceAll('-', '')}`,
  admin = new pg.Pool({ connectionString: url, max: 2 });
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
await admin.query(`CREATE SCHEMA ${schema}`);
const db = new Database(pool),
  service = new FleetService(db),
  site = randomUUID(),
  boot = randomUUID(),
  key = randomUUID();
const admitMs: number[] = [],
  applyMs: number[] = [];
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  await pool.query(await readFile('db/migrations/001_initial.sql', 'utf8'));
  await pool.query(await readFile('db/migrations/002_command_attempts.sql', 'utf8'));
  await pool.query(await readFile('db/migrations/003_snapshot_receipt.sql', 'utf8'));
  await pool.query(await readFile('db/migrations/004_mission_eta.sql', 'utf8'));
  await pool.query('INSERT INTO sites VALUES($1,$2)', [site, 'Isolated benchmark']);
  await pool.query('INSERT INTO ingest_keys VALUES($1,$2)', [tokenHash(key), site]);
  const ids = Array.from({ length: 25 }, () => randomUUID());
  for (const [i, id] of ids.entries()) {
    await pool.query('INSERT INTO vehicles(id,site_id,name,model) VALUES($1,$2,$3,$4)', [
      id,
      site,
      `BENCH-${i}`,
      'Synthetic',
    ]);
    await service.registerBoot(site, id, boot);
  }
  app = await createApp({ db, serveWeb: false });
  const started = performance.now();
  for (let round = 0; round < 10; round++) {
    const messages: Snapshot[] = ids.flatMap((id) =>
      Array.from({ length: 4 }, (_, n) => ({
        kind: 'snapshot',
        vehicleId: id,
        bootId: boot,
        seq: round * 4 + n,
        at: new Date().toISOString(),
        x: 130 + n,
        y: 150,
        heading: 0,
        speed: 0,
        battery: 80,
        status: 'idle',
      })),
    );
    const a = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest/telemetry',
      headers: { authorization: `Bearer ${key}` },
      payload: { messages },
    });
    if (res.statusCode !== 202) throw new Error(`Admission failed ${res.statusCode}`);
    admitMs.push(performance.now() - a);
    const b = performance.now();
    while (await service.processOne()) {
      /* Drain all admitted vehicle batches. */
    }
    applyMs.push(performance.now() - b);
  }
  const elapsed = performance.now() - started;
  const percentile = (v: number[], p: number) =>
    [...v].sort((a, b) => a - b)[Math.ceil(v.length * p) - 1];
  const result = {
    date: new Date().toISOString(),
    boundary:
      'Local smoke benchmark with in-process Fastify HTTP injection and real isolated PostgreSQL; excludes TCP/TLS, browser paint, physical devices, and deployment. Ten samples do not establish sustained capacity or an SLO.',
    machine: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      postgres: (await pool.query('SELECT version()')).rows[0].version,
    },
    workload: { vehicles: 25, batches: 10, messagesPerBatch: 100, totalMessages: 1000, workers: 1 },
    results: {
      admissionBatchMs: {
        p50: percentile(admitMs, 0.5),
        p95: percentile(admitMs, 0.95),
        samples: admitMs,
      },
      drainBatchMs: {
        p50: percentile(applyMs, 0.5),
        p95: percentile(applyMs, 0.95),
        samples: applyMs,
      },
      elapsedMs: elapsed,
      combinedMessagesPerSecond: 1000 / (elapsed / 1000),
      pending: Number(
        (await pool.query('SELECT count(*) FROM inbox WHERE processed_at IS NULL')).rows[0].count,
      ),
    },
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/benchmark.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
