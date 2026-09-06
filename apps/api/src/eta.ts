import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ModelSchema,
  predict,
  type EtaModel,
  type EtaPrediction,
} from '../../../packages/eta/src/predict.js';
import { features } from '../../../packages/eta/src/features.js';
import type { Point } from '../../../packages/simulation/src/motion.js';
import { policy } from '../../../packages/core/src/domain.js';

export class EtaEstimator {
  readonly model: EtaModel | null;
  readonly artifactSha256: string | null;
  readonly loadError: string | null;
  constructor(
    readonly enabled = process.env.ETA_ENABLED !== 'false',
    path: string | URL = process.env.ETA_MODEL_PATH ??
      new URL('../../../packages/eta/artifacts/model.json', import.meta.url),
  ) {
    try {
      const url = typeof path === 'string' ? pathToFileURL(resolve(path)) : path;
      const bytes = readFileSync(url);
      if (bytes.length > 2_000_000) throw new Error('Artifact exceeds 2 MB.');
      const sha = createHash('sha256').update(bytes).digest('hex');
      const manifest = JSON.parse(readFileSync(new URL('evaluation.json', url), 'utf8')) as {
        modelSha256?: string;
      };
      if (sha !== manifest.modelSha256) throw new Error('Artifact checksum mismatch.');
      this.model = ModelSchema.parse(JSON.parse(bytes.toString('utf8')));
      this.artifactSha256 = sha;
      this.loadError = null;
    } catch {
      this.model = null;
      this.artifactSha256 = null;
      this.loadError = 'Model artifact missing or invalid; baseline fallback active.';
    }
  }
  estimate(
    vehicle: Point & {
      battery: number;
      observed_at: Date | null;
      snapshot_received_at: Date | null;
      contact_at: Date | null;
      online: boolean;
    },
    destination: Point,
    congestion: number,
    now: Date,
  ): EtaPrediction {
    const input = features(vehicle, destination, congestion);
    const result = predict(input, this.model, {
      at: now.toISOString(),
      enabled: this.enabled,
      artifactSha256: this.artifactSha256 ?? undefined,
    });
    const observedAge = vehicle.observed_at
      ? now.getTime() - vehicle.observed_at.getTime()
      : Infinity;
    const receivedAge = vehicle.snapshot_received_at
      ? now.getTime() - vehicle.snapshot_received_at.getTime()
      : Infinity;
    const contactAge = vehicle.contact_at ? now.getTime() - vehicle.contact_at.getTime() : Infinity;
    if (
      !vehicle.online ||
      observedAge < -5000 ||
      observedAge > policy.freshMs ||
      receivedAge < -1000 ||
      receivedAge > policy.freshMs ||
      contactAge > policy.offlineMs
    ) {
      return {
        ...result,
        source: 'unavailable',
        reason: 'stale_telemetry',
        seconds: null,
        lowerSeconds: null,
        upperSeconds: null,
        baselineSeconds: null,
        modelVersion: null,
        artifactSha256: null,
        features: null,
      };
    }
    return result;
  }
}
