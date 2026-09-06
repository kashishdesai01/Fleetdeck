import pg from 'pg';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/core/src/domain.js';
import { systemClock } from '../../../packages/core/src/domain.js';
export type Tx = pg.PoolClient;
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://fleetdeck:fleetdeck_local_only@127.0.0.1:55437/fleetdeck',
  max: 12,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 10000,
});
pool.on('error', () => {
  console.error('PostgreSQL idle connection error');
});
export class Database {
  constructor(
    public pool: pg.Pool,
    public clock: Clock = systemClock,
  ) {}
  async transaction<T>(fn: (tx: Tx) => Promise<T>, readOnly = false): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }
  now(): Date {
    return this.clock.now();
  }
}
export async function changed(tx: Tx): Promise<void> {
  await tx.query("SELECT pg_notify('fleet_changed','')");
}
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  const key = scryptSync(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${key.toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [salt, hex] = encoded.split(':');
  if (!salt || !hex) return false;
  const value = hashPassword(password, salt).split(':')[1];
  if (!value) return false;
  const a = Buffer.from(value, 'hex'),
    b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function opaqueTag(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
