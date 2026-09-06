import { z } from 'zod';
import { baseline, featureVector, featureNames, type EtaFeatures } from './features.js';

const finite = z.number().finite();
const Tree = z
  .object({
    left: z.array(z.number().int()).min(1).max(255),
    right: z.array(z.number().int()).min(1).max(255),
    feature: z.array(z.number().int()).min(1).max(255),
    threshold: z.array(finite).min(1).max(255),
    value: z.array(finite.min(-10000).max(10000)).min(1).max(255),
  })
  .strict()
  .superRefine((tree, ctx) => {
    const n = tree.left.length;
    if ([tree.right, tree.feature, tree.threshold, tree.value].some((v) => v.length !== n)) {
      ctx.addIssue({ code: 'custom', message: 'Tree arrays must have equal lengths.' });
      return;
    }
    for (let i = 0; i < n; i++) {
      if (tree.left[i] === -1 && tree.right[i] === -1) continue;
      // Children must advance, excluding cycles and backward links in exported CART trees.
      if (
        tree.left[i]! <= i ||
        tree.left[i]! >= n ||
        tree.right[i]! <= i ||
        tree.right[i]! >= n ||
        tree.feature[i]! < 0 ||
        tree.feature[i]! >= featureNames.length
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid tree child or feature index.' });
    }
  });
export const ModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureVersion: z.literal('dispatch-v1'),
    version: z.string().regex(/^eta-gbr-v1-[a-f0-9]{12}$/),
    featureNames: z.tuple([
      z.literal('distance'),
      z.literal('turns'),
      z.literal('battery'),
      z.literal('congestion'),
    ]),
    initial: finite.min(0).max(1000),
    learningRate: finite.positive().max(1),
    trees: z.array(Tree).min(1).max(500),
    radiusSeconds: finite.positive().max(1000),
    nominalRunCoverage: z.literal(0.9),
    support: z.array(z.tuple([finite, finite])).length(4),
    promoted: z.boolean(),
    trainingDataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((model, ctx) => {
    if (model.support.some(([lo, hi]) => lo > hi))
      ctx.addIssue({ code: 'custom', message: 'Invalid support range.' });
  });
export type EtaModel = z.infer<typeof ModelSchema>;
export interface EtaPrediction {
  source: 'model' | 'baseline' | 'unavailable';
  reason:
    | 'ok'
    | 'disabled'
    | 'model_unavailable'
    | 'validation_gate_failed'
    | 'out_of_support'
    | 'invalid_input'
    | 'invalid_model_output'
    | 'stale_telemetry';
  seconds: number | null;
  lowerSeconds: number | null;
  upperSeconds: number | null;
  baselineSeconds: number | null;
  modelVersion: string | null;
  artifactSha256: string | null;
  features: EtaFeatures | null;
  predictedAt: string;
}
export function treePrediction(model: EtaModel, input: EtaFeatures): number {
  // scikit-learn casts tree inputs to float32 before comparing against float64 thresholds.
  const values = featureVector(input).map(Math.fround);
  let output = model.initial;
  for (const tree of model.trees) {
    let i = 0;
    while (tree.left[i] !== -1)
      i = values[tree.feature[i]!]! <= tree.threshold[i]! ? tree.left[i]! : tree.right[i]!;
    output += model.learningRate * tree.value[i]!;
  }
  return Math.max(1, output);
}
export function predict(
  input: EtaFeatures,
  model: EtaModel | null,
  options: { at: string; enabled?: boolean; artifactSha256?: string },
): EtaPrediction {
  const vector = featureVector(input);
  const valid =
    vector.every(Number.isFinite) &&
    input.distance >= 0 &&
    input.distance <= 2500 &&
    input.turns >= 0 &&
    input.turns <= 2 &&
    input.battery >= 0 &&
    input.battery <= 100 &&
    input.congestion >= 0 &&
    input.congestion <= 1;
  let reason: EtaPrediction['reason'] = !valid
    ? 'invalid_input'
    : options.enabled === false
      ? 'disabled'
      : !model
        ? 'model_unavailable'
        : !model.promoted
          ? 'validation_gate_failed'
          : vector.some((v, i) => v < model.support[i]![0] || v > model.support[i]![1])
            ? 'out_of_support'
            : 'ok';
  const raw = reason === 'ok' ? treePrediction(model!, input) : null;
  if (raw !== null && (!Number.isFinite(raw) || raw > 600)) reason = 'invalid_model_output';
  const source = !valid ? 'unavailable' : reason === 'ok' ? 'model' : 'baseline';
  const seconds = source === 'model' ? raw : valid ? baseline(input) : null;
  return {
    source,
    reason,
    seconds,
    lowerSeconds: source === 'model' ? Math.max(0, seconds! - model!.radiusSeconds) : null,
    upperSeconds: source === 'model' ? seconds! + model!.radiusSeconds : null,
    baselineSeconds: valid ? baseline(input) : null,
    modelVersion: source === 'model' ? model!.version : null,
    artifactSha256: source === 'model' ? (options.artifactSha256 ?? null) : null,
    features: valid ? input : null,
    predictedAt: options.at,
  };
}
