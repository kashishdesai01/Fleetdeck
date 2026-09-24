import { pool, Database } from '../apps/api/src/db.js';
import { FleetService } from '../apps/api/src/service.js';
await new FleetService(new Database(pool)).processOne(false, async () => {
  process.send?.({ ready: true });
  await new Promise<void>(() => {});
});
await pool.end();
