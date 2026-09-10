import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { execute, advance, enqueue, type SimVehicle, type SimCommand } from './engine.js';
const base = process.env.API_URL ?? 'http://127.0.0.1:3080',
  key = process.env.INGEST_KEY;
if (!key) throw new Error('INGEST_KEY is required.');
const file = resolve(process.env.SIM_STATE_FILE ?? '.local/simulator.json');
await mkdir(dirname(file), { recursive: true });
async function acquireLock() {
  try {
    return await open(file + '.lock', 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let old: { pid: number; host: string };
    try {
      old = JSON.parse(await readFile(file + '.lock', 'utf8')) as typeof old;
    } catch {
      throw new Error(
        'Invalid simulator lock; confirm the previous simulator stopped before removing it.',
      );
    }
    let stale = old.host === hostname() && old.pid === process.pid;
    if (old.host === hostname() && !stale) {
      try {
        process.kill(old.pid, 0);
      } catch (e) {
        stale = (e as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    if (!stale) throw new Error('Simulator state has a live or foreign-host writer.');
    await unlink(file + '.lock');
    return open(file + '.lock', 'wx', 0o600);
  }
}
const lock = await acquireLock();
await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
let running = true;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    running = false;
  });
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`Gateway ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
interface Config {
  vehicles: { id: string; name: string; x: number; y: number; battery: number }[];
  scenarios: { vehicle_id: string; kind: string }[];
}
let saved: Record<string, SimVehicle> = {};
try {
  saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, SimVehicle>;
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
async function persist(): Promise<void> {
  await writeFile(file + '.tmp', JSON.stringify(saved), { mode: 0o600 });
  await rename(file + '.tmp', file);
}
try {
  const config = await api<Config>('/v1/gateway/vehicles');
  for (const meta of config.vehicles) {
    saved[meta.id] ??= {
      ...meta,
      bootId: randomUUID(),
      seq: 0,
      heading: 0,
      speed: 0,
      status: 'idle',
      outbox: [],
      ledgers: {},
      active: null,
      phase: Number(meta.name.slice(-2)),
    };
    const v = saved[meta.id]!;
    const session = await api<{ active: boolean }>('/v1/ingest/sessions', {
      vehicleId: v.id,
      bootId: v.bootId,
    });
    if (!session.active)
      throw new Error(
        `${v.name} has an obsolete boot session. Reconcile simulator state before replacing its identity.`,
      );
  }
  await persist();
  console.log(
    `Simulator connected: ${Object.keys(saved).length} vehicles; durable local state enabled.`,
  );
  let previous = Date.now();
  while (running) {
    const started = Date.now(),
      dt = Math.min(2, (started - previous) / 1000);
    previous = started;
    try {
      const current = await api<Config>('/v1/gateway/vehicles');
      const scenarios = new Map(current.scenarios.map((s) => [s.vehicle_id, s.kind]));
      for (const v of Object.values(saved)) {
        const scenario = scenarios.get(v.id) ?? 'normal';
        if (scenario !== 'offline') {
          const { commands } = await api<{ commands: SimCommand[] }>(
            `/v1/gateway/vehicles/${v.id}/commands`,
          );
          for (const cmd of commands) execute(v, cmd, Date.now());
        }
        advance(v, dt, scenario === 'stuck');
        if (scenario === 'battery_low') v.battery = Math.max(12, v.battery - 10 * dt);
        else if (!v.active && v.battery < 45) v.battery = Math.min(90, v.battery + 8 * dt);
        // Patrol is visual simulation only; assigned missions always own vehicle movement.
        if (!v.active && v.phase > 8) {
          const phase = (started / 30000 + v.phase * 2.39996323) % (2 * Math.PI);
          v.x = 490 + Math.sin(phase) * 330;
          v.y = 285 + (v.phase % 2 ? 18 : -18);
          v.status = 'moving';
          v.speed = 2.5;
        }
        enqueue(v, () => ({
          kind: 'snapshot',
          vehicleId: v.id,
          bootId: v.bootId,
          seq: ++v.seq,
          at: new Date().toISOString(),
          x: v.x,
          y: v.y,
          heading: v.heading,
          speed: v.speed,
          battery: v.battery,
          status: v.status,
        }));
        if (scenario !== 'lost_ack')
          for (const ledger of Object.values(v.ledgers)) {
            if (ledger.reported) continue;
            // The report and its local outbox entry are persisted together before any HTTP receipt.
            ledger.reported = enqueue(v, () => ({
              kind: 'command_report',
              vehicleId: v.id,
              bootId: v.bootId,
              seq: ++v.seq,
              at: new Date().toISOString(),
              commandId: ledger.command.id,
              attemptId: ledger.command.attemptId,
              outcome: ledger.outcome,
            }));
          }
      }
      await persist();
      const deliveries = Object.values(saved)
        .filter((v) => (scenarios.get(v.id) ?? 'normal') !== 'offline')
        .map((v) => ({ v, messages: v.outbox.slice(0, 20) }));
      const messages = deliveries.flatMap((d) => d.messages);
      if (messages.length) {
        await api('/v1/ingest/telemetry', { messages });
        for (const d of deliveries) d.v.outbox.splice(0, d.messages.length);
        await persist();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'simulator.retry',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
    await new Promise((r) => setTimeout(r, Math.max(50, 1000 - (Date.now() - started))));
  }
} finally {
  await persist();
  await lock.close();
  await unlink(file + '.lock');
}
