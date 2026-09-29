import { spawn, type ChildProcess } from 'node:child_process';
const children: ChildProcess[] = [];
const node = (file: string) =>
  spawn(process.execPath, ['--import', 'tsx', file], { stdio: 'inherit', env: process.env });
async function once(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = node(file);
    p.once('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${file} exited ${c}`))));
    p.once('error', reject);
  });
}
await once('scripts/migrate.ts');
await once('scripts/seed.ts');
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
for (const file of ['apps/api/src/main.ts', 'apps/worker/src/main.ts']) {
  const p = node(file);
  children.push(p);
  p.once('exit', () => {
    if (!stopping) stop();
  });
}
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch((process.env.API_URL ?? 'http://127.0.0.1:3080') + '/readyz')).ok) break;
  } catch {
    /* Wait for API startup. */
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (!stopping) {
  const sim = node('apps/simulator/src/main.ts');
  children.push(sim);
  sim.once('exit', () => {
    if (!stopping) stop();
  });
  console.log('Fleetdeck is running at ' + (process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3080'));
}
