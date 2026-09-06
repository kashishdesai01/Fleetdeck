import { randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
try {
  await access('.env');
  console.log('.env already exists; existing secrets preserved.');
} catch {
  await writeFile(
    '.env',
    `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nINGEST_KEY=${randomBytes(32).toString('hex')}\nDEMO_MODE=true\nDEMO_ACCESS=admin\nPUBLIC_ORIGIN=http://127.0.0.1:3080\nCOOKIE_SECURE=false\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log('Local .env created with random secrets.');
}
