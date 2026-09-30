import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ModelSchema } from '../packages/eta/src/predict.js';
import { assertEquivalent } from '../packages/eta/src/reproduction.js';
const python =
  process.env.ETA_PYTHON ??
  (existsSync('.local/ml-venv/bin/python') ? '.local/ml-venv/bin/python' : 'python3');
const reproduce = process.argv.includes('--verify');
const output = reproduce ? '.local/eta/reproduced' : 'packages/eta/artifacts';
const result = spawnSync(python, ['ml/train_eta.py', '--output', output], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (reproduce) {
  const read = (directory: string, name: string) =>
    JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
  const candidateModel = ModelSchema.parse(read(output, 'model.json'));
  const releaseModel = ModelSchema.parse(read('packages/eta/artifacts', 'model.json'));
  const report = read(output, 'evaluation.json');
  const release = read('packages/eta/artifacts', 'evaluation.json');
  for (const [directory, model, evaluation] of [
    [output, candidateModel, report],
    ['packages/eta/artifacts', releaseModel, release],
  ] as const) {
    const checksum = createHash('sha256')
      .update(readFileSync(`${directory}/model.json`))
      .digest('hex');
    if (checksum !== evaluation.modelSha256 || model.version !== evaluation.version)
      throw new Error(`Model checksum or version does not match its manifest: ${directory}`);
  }
  assertEquivalent(candidateModel, releaseModel, '$', ['version']);
  assertEquivalent(read(output, 'parity.json'), read('packages/eta/artifacts', 'parity.json'));
  assertEquivalent(report, release, '$', ['python', 'version', 'modelSha256']);
  console.log(
    'Reproduced model structure, provenance, predictions and evaluation within numerical tolerance (1e-8 absolute + 1e-10 relative).',
  );
}
