import { readFile } from 'node:fs/promises';
import { pool, Database } from '../apps/api/src/db.js';
export async function migrate(): Promise<void> {
  const db = new Database(pool);
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(872364101)');
    const exists = await tx.query("SELECT to_regclass('public.schema_migrations') AS name");
    if (!exists.rows[0]?.name) {
      await tx.query(
        await readFile(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8').catch(
          () => readFile('db/migrations/001_initial.sql', 'utf8'),
        ),
      );
      await tx.query("INSERT INTO schema_migrations(version) VALUES('001')");
    }
    for (const [version, file] of [
      ['002', '002_command_attempts.sql'],
      ['003', '003_snapshot_receipt.sql'],
      ['004', '004_mission_eta.sql'],
    ] as const) {
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])).rowCount)
        continue;
      const sql = await readFile(
        new URL('../db/migrations/' + file, import.meta.url),
        'utf8',
      ).catch(() => readFile('db/migrations/' + file, 'utf8'));
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }
  });
}
await migrate();
console.log('Schema is current.');
await pool.end();
