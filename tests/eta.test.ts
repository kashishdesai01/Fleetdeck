import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { ModelSchema, predict, treePrediction } from '../packages/eta/src/predict.js';
import { features, baseline, type EtaFeatures } from '../packages/eta/src/features.js';
import { startMotion, stepMotion } from '../packages/simulation/src/motion.js';
import { EtaEstimator } from '../apps/api/src/eta.js';

const modelBytes = readFileSync('packages/eta/artifacts/model.json');
const model = ModelSchema.parse(JSON.parse(modelBytes.toString()));
const sample = { distance: 600, turns: 2, battery: 85, congestion: 0.4 };
const at = '2026-10-19T12:00:00.000Z';
describe('ETA model release and serving', () => {
  it('matches scikit-learn predictions across exported parity vectors', () => {
    const vectors = JSON.parse(readFileSync('packages/eta/artifacts/parity.json', 'utf8')) as {
      features: EtaFeatures;
      expected: number;
    }[];
    expect(vectors).toHaveLength(40);
    for (const vector of vectors)
      expect(treePrediction(model, vector.features)).toBeCloseTo(vector.expected, 9);
  });
  it('binds the artifact to its evaluation checksum and loads the promoted release', () => {
    const report = JSON.parse(readFileSync('packages/eta/artifacts/evaluation.json', 'utf8'));
    expect(createHash('sha256').update(modelBytes).digest('hex')).toBe(report.modelSha256);
    expect(model.trainingDataSha256).toBe(report.dataset.sha256);
    const estimator = new EtaEstimator();
    expect(estimator.loadError).toBeNull();
    expect(estimator.model?.promoted).toBe(true);
    expect(report.validation.promoted).toBe(true);
    expect(report.evaluation.hidden_delays.mission_interval_coverage).toBeLessThan(0.9);
  });
  it('falls back without inventing a calibrated interval when disabled, missing or out of support', () => {
    for (const prediction of [
      predict(sample, null, { at }),
      predict(sample, model, { at, enabled: false }),
      predict({ ...sample, congestion: 0.95 }, model, { at }),
      predict(sample, { ...model, promoted: false }, { at }),
    ]) {
      expect(prediction.source).toBe('baseline');
      expect(prediction.seconds).toBe(25);
      expect(prediction.lowerSeconds).toBeNull();
      expect(prediction.modelVersion).toBeNull();
    }
    expect(predict({ ...sample, battery: NaN }, model, { at }).source).toBe('unavailable');
    expect(new EtaEstimator(true, '/nonexistent/fleetdeck-model.json').model).toBeNull();
  });
  it('rejects structurally unsafe trees and checksum-altered artifacts', () => {
    const unsafe = structuredClone(model);
    unsafe.trees[0]!.left[0] = 0;
    expect(ModelSchema.safeParse(unsafe).success).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), 'fleetdeck-eta-'));
    try {
      writeFileSync(join(directory, 'model.json'), JSON.stringify({ ...model, radiusSeconds: 1 }));
      writeFileSync(
        join(directory, 'evaluation.json'),
        JSON.stringify({ modelSha256: '0'.repeat(64) }),
      );
      expect(new EtaEstimator(true, join(directory, 'model.json')).model).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('falls back for an implausible model output even with structurally valid trees', () => {
    const bad = ModelSchema.parse({ ...model, initial: 1000 });
    const result = predict(sample, bad, { at });
    expect(result.source).toBe('baseline');
    expect(result.reason).toBe('invalid_model_output');
    expect(result.lowerSeconds).toBeNull();
  });
  it('returns finite ordered intervals for generated in-support inputs', () => {
    fc.assert(
      fc.property(
        fc.record({
          distance: fc.integer({ min: 0, max: 1200 }),
          turns: fc.integer({ min: 0, max: 2 }),
          battery: fc.integer({ min: 25, max: 100 }),
          congestion: fc.integer({ min: 0, max: 80 }),
        }),
        (input) => {
          const result = predict({ ...input, congestion: input.congestion / 100 }, model, { at });
          expect(result.source).toBe('model');
          expect(result.lowerSeconds).toBeLessThanOrEqual(result.seconds!);
          expect(result.upperSeconds).toBeGreaterThanOrEqual(result.seconds!);
          expect(Number.isFinite(result.seconds)).toBe(true);
        },
      ),
      { numRuns: 150, seed: 731 },
    );
  });
  it('withholds stale telemetry even when duplicate contact is fresh', () => {
    const now = new Date(at);
    const vehicle = {
      x: 130,
      y: 150,
      battery: 85,
      online: true,
      contact_at: now,
      observed_at: new Date(now.getTime() - 20000),
      snapshot_received_at: new Date(now.getTime() - 20000),
    };
    const result = new EtaEstimator().estimate(vehicle, { x: 850, y: 150 }, 0.4, now);
    expect(result.source).toBe('unavailable');
    expect(result.reason).toBe('stale_telemetry');
    expect(result.features).toBeNull();
  });
});
describe('synthetic motion and feature contract', () => {
  it('uses the shared aisle route and only dispatch-time observables', () => {
    expect(features({ x: 130, y: 150, battery: 85 }, { x: 850, y: 150 }, 0.4)).toEqual({
      distance: 990,
      turns: 2,
      battery: 85,
      congestion: 0.4,
    });
    expect(baseline(sample)).toBe(25);
  });
  it('resumes an identical random motion trace after serialization', () => {
    const body = { x: 130, y: 150, battery: 80, speed: 0, heading: 0 };
    const motion = startMotion(body, { x: 850, y: 420 }, 731, 0.6);
    for (let i = 0; i < 80; i++) stepMotion(body, motion, 0.25);
    const resumed = JSON.parse(JSON.stringify({ body, motion })) as {
      body: typeof body;
      motion: typeof motion;
    };
    for (let i = 0; i < 500; i++) {
      stepMotion(body, motion, 0.25);
      stepMotion(resumed.body, resumed.motion, 0.25);
    }
    expect(resumed).toEqual({ body, motion });
    expect(motion.waypoints).toEqual([]);
    expect(body.x).toBeCloseTo(850);
    expect(body.y).toBeCloseTo(420);
  });
  it('congestion changes completion time for the same route and random seed', () => {
    const complete = (congestion: number) => {
      const body = { x: 130, y: 150, battery: 85, speed: 0, heading: 0 };
      const motion = startMotion(body, { x: 850, y: 150 }, 731, congestion);
      let duration = 0;
      while (!stepMotion(body, motion, 0.25)) {
        duration += 0.25;
        if (duration > 500) throw new Error('Motion did not complete');
      }
      return duration;
    };
    expect(complete(0.8)).toBeGreaterThan(complete(0));
  });
});
