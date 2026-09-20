import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { nodes } from '../packages/core/src/domain.js';
import { random, seedOf, startMotion, stepMotion } from '../packages/simulation/src/motion.js';
import { features } from '../packages/eta/src/features.js';

// All missions from a run stay together. Run identity and future motion state are never features.
const plan = [
  { split: 'train', runs: 600, scenario: 'normal' },
  { split: 'validation', runs: 100, scenario: 'normal' },
  { split: 'calibration', runs: 150, scenario: 'normal' },
  { split: 'test', runs: 200, scenario: 'normal' },
  { split: 'stress', runs: 80, scenario: 'severe_congestion' },
  { split: 'stress', runs: 80, scenario: 'hidden_delays' },
] as const;
const rows: unknown[] = [];
for (const group of plan) {
  for (let run = 0; run < group.runs; run++) {
    const runId = `${group.split}/${group.scenario}/${run}`;
    const rng = { rng: seedOf(`fleetdeck-eta-v1/${runId}`) };
    const congestion =
      group.scenario === 'severe_congestion' ? 0.85 + random(rng) * 0.15 : random(rng) * 0.8;
    for (let mission = 0; mission < 6; mission++) {
      const from = {
        x: 100 + random(rng) * 800,
        y: 120 + random(rng) * 330,
        battery: 25 + random(rng) * 75,
        heading: 0,
        speed: 0,
      };
      const to = nodes[Math.floor(random(rng) * nodes.length)]!;
      const input = features(from, to, congestion);
      const motion = startMotion(from, to, Math.floor(random(rng) * 4294967296), congestion);
      // Unobserved regime shift: extra stops not present during training/calibration.
      if (group.scenario === 'hidden_delays') motion.pause += 20 + random(rng) * 40;
      let seconds = 0;
      while (!stepMotion(from, motion, 0.25)) {
        seconds += 0.25;
        if (seconds > 1000) throw new Error('Synthetic trace did not terminate.');
      }
      // Dispatch-to-observed-completion target includes gateway/report scheduling jitter.
      seconds += 0.25 + random(rng) * 2;
      rows.push({
        runId,
        mission,
        split: group.split,
        scenario: group.scenario,
        features: input,
        seconds,
      });
    }
  }
}
const content = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
await mkdir('.local/eta', { recursive: true });
await writeFile('.local/eta/dataset.jsonl', content);
const sources = [
  'packages/simulation/src/motion.ts',
  'packages/eta/src/features.ts',
  'scripts/eta-data.ts',
];
await writeFile(
  '.local/eta/dataset-manifest.json',
  JSON.stringify(
    {
      generator: 'fleetdeck-eta-v1',
      seedScheme: 'FNV1a(run identity) + LCG32',
      rows: rows.length,
      sha256: sha256(content),
      plan,
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (path) => [path, sha256(await readFile(path, 'utf8'))]),
        ),
      ),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Generated ${rows.length} synthetic mission traces with disjoint runs.`);
