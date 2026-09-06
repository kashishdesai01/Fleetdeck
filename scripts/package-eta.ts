import { mkdir, copyFile } from 'node:fs/promises';
const destination = 'dist/packages/eta/artifacts';
await mkdir(destination, { recursive: true });
for (const name of ['model.json', 'evaluation.json'])
  await copyFile(`packages/eta/artifacts/${name}`, `${destination}/${name}`);
console.log('Packaged ETA model and provenance.');
