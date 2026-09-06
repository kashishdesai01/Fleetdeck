import { routeFeatures, type Point } from '../../simulation/src/motion.js';
export const featureNames = ['distance', 'turns', 'battery', 'congestion'] as const;
export interface EtaFeatures {
  distance: number;
  turns: number;
  battery: number;
  congestion: number;
}
export function features(
  from: Point & { battery: number },
  to: Point,
  congestion: number,
): EtaFeatures {
  return { ...routeFeatures(from, to), battery: from.battery, congestion };
}
export function featureVector(input: EtaFeatures): number[] {
  return featureNames.map((key) => input[key]);
}
export function baseline(input: EtaFeatures): number {
  return Math.max(1, input.distance / 24);
}
