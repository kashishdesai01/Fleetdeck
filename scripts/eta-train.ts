import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const python =
  process.env.ETA_PYTHON ??
  (existsSync('.local/ml-venv/bin/python') ? '.local/ml-venv/bin/python' : 'python3');
const reproduce = process.argv.includes('--verify');
const output = reproduce ? '.local/eta/reproduced' : 'packages/eta/artifacts';
const result = spawnSync(python, ['ml/train_eta.py', '--output', output], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (reproduce) {
  for (const name of ['model.json', 'parity.json']) {
    if (!readFileSync(`${output}/${name}`).equals(readFileSync(`packages/eta/artifacts/${name}`)))
      throw new Error(
        `Reproduction differs: ${name}. Use the pinned environment and inspect the source/data hashes.`,
      );
  }
  const report = JSON.parse(readFileSync(`${output}/evaluation.json`, 'utf8'));
  const release = JSON.parse(readFileSync('packages/eta/artifacts/evaluation.json', 'utf8'));
  // Interpreter patch versions are metadata; all data, decisions and metrics must reproduce.
  delete report.python;
  delete release.python;
  if (JSON.stringify(report) !== JSON.stringify(release))
    throw new Error('Reproduced evaluation/provenance differs from the release.');
  console.log('Reproduced release model and Python parity vectors byte-for-byte.');
}
