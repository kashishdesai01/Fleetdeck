import { randomBytes } from 'node:crypto';
import { pool, Database, hashPassword } from '../apps/api/src/db.js';
import { tokenHash } from '../packages/core/src/domain.js';
export const SITE = '10000000-0000-4000-8000-000000000001';
export const ADMIN = '20000000-0000-4000-8000-000000000001';
export const VIEWER = '20000000-0000-4000-8000-000000000002';
export function vehicleId(i: number): string {
  return `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}
const key = process.env.INGEST_KEY;
if (!key || key.length < 24)
  throw new Error('Set INGEST_KEY to a random secret of at least 24 characters.');
const demo = process.env.DEMO_MODE === 'true';
if (
  !demo &&
  (!process.env.ADMIN_EMAIL ||
    !process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD.length < 14)
)
  throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 14 characters.');
await new Database(pool).transaction(async (tx) => {
  await tx.query('INSERT INTO sites(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    SITE,
    'Northstar · Distribution Campus',
  ]);
  await tx.query(
    'INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      ADMIN,
      demo ? 'demo@fleetdeck.local' : process.env.ADMIN_EMAIL?.toLowerCase(),
      'Alex Morgan',
      hashPassword(process.env.ADMIN_PASSWORD ?? randomBytes(32).toString('hex')),
      'admin',
    ],
  );
  if (demo)
    await tx.query(
      'INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [
        VIEWER,
        'viewer@fleetdeck.local',
        'Demo observer',
        hashPassword(randomBytes(32).toString('hex')),
        'viewer',
      ],
    );
  await tx.query('INSERT INTO ingest_keys(key_hash,site_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    tokenHash(key),
    SITE,
  ]);
  for (let i = 1; i <= 25; i++)
    await tx.query(
      'INSERT INTO vehicles(id,site_id,name,model,x,y,battery) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [
        vehicleId(i),
        SITE,
        `AMR-${String(i).padStart(2, '0')}`,
        i % 4 === 0 ? 'Atlas H2' : 'Vector M1',
        130 + ((i - 1) % 9) * 80,
        i <= 13 ? 150 : 420,
        54 + ((i * 7) % 45),
      ],
    );
});
console.log('Site, 25 vehicles, and operator accounts seeded.');
await pool.end();
