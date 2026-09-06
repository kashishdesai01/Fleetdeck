import { pool, Database } from './db.js';
import { createApp } from './app.js';
const demo = process.env.DEMO_MODE === 'true';
if (
  process.env.NODE_ENV === 'production' &&
  (demo ||
    process.env.COOKIE_SECURE !== 'true' ||
    !process.env.DATABASE_URL ||
    !process.env.PUBLIC_ORIGIN?.startsWith('https://'))
)
  throw new Error(
    'Production requires HTTPS origin, secure cookies, explicit database, and demo mode disabled.',
  );
const port = Number(process.env.PORT ?? 3080),
  host = process.env.HOST ?? '127.0.0.1';
const app = await createApp({
  db: new Database(pool),
  demo,
  demoRole: process.env.DEMO_ACCESS === 'admin' ? 'admin' : 'viewer',
  secureCookies: process.env.COOKIE_SECURE === 'true',
  origin: process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  logging: true,
});
await app.listen({ host, port });
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  await pool.end();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void stop().then(() => process.exit(0));
  });
