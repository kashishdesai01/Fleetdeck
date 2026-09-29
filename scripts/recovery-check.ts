import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import type { FleetState } from '../apps/web/src/types.js';
const exec = promisify(execFile),
  base = 'http://127.0.0.1:3080';
const login = await fetch(base + '/v1/auth/demo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
if (!login.ok) throw new Error('Demo authentication failed.');
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Missing session cookie.');
async function state(): Promise<FleetState> {
  const r = await fetch(base + '/v1/state', { headers: { cookie: cookie! } });
  if (!r.ok) throw new Error('State read failed.');
  return r.json() as Promise<FleetState>;
}
const before = await state();
let peak = 0;
try {
  await exec('./scripts/compose.sh', ['stop', 'worker']);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    peak = (await state()).health.pending;
    if (peak >= 25) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (peak < 25) throw new Error('No admitted backlog was observed while worker was stopped.');
} finally {
  await exec('./scripts/compose.sh', ['start', 'worker']);
}
let after = await state();
const deadline = Date.now() + 15000;
while (after.health.pending !== 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300));
  after = await state();
}
if (after.health.pending !== 0) throw new Error('Worker did not drain its admitted backlog.');
const result = {
  date: new Date().toISOString(),
  boundary:
    'Packaged Compose worker stop/start with the simulator continuing durable admissions; database storage remained intact.',
  before: { admitted: before.health.admitted, pending: before.health.pending },
  paused: { pending: peak },
  after: { admitted: after.health.admitted, pending: after.health.pending },
  recovered: true,
};
await mkdir('test-results', { recursive: true });
await writeFile('test-results/container-recovery.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
