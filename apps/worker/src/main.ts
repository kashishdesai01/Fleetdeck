import { pool, Database } from '../../api/src/db.js';
import { FleetService } from '../../api/src/service.js';
const service = new FleetService(new Database(pool));
let running = true;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    running = false;
  });
let sweepAt = 0;
while (running) {
  try {
    const worked = await service.processOne();
    if (Date.now() - sweepAt >= 1000) {
      await service.sweep();
      sweepAt = Date.now();
    }
    if (!worked) await new Promise((r) => setTimeout(r, 100));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker.error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await pool.end();
