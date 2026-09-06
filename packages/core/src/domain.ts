import { createHash } from 'node:crypto';
import { z } from 'zod';

export const uuid = z.string().uuid();
export const Snapshot = z
  .object({
    kind: z.literal('snapshot'),
    vehicleId: uuid,
    bootId: uuid,
    seq: z.number().int().nonnegative().safe(),
    at: z.string().datetime(),
    x: z.number().finite().min(0).max(1000),
    y: z.number().finite().min(0).max(600),
    heading: z.number().finite().min(0).max(360),
    speed: z.number().finite().min(0).max(30),
    battery: z.number().finite().min(0).max(100),
    status: z.enum(['idle', 'moving', 'working', 'charging', 'stopped', 'fault']),
  })
  .strict();
export const Report = z
  .object({
    kind: z.literal('command_report'),
    vehicleId: uuid,
    bootId: uuid,
    seq: z.number().int().nonnegative().safe(),
    at: z.string().datetime(),
    commandId: uuid,
    attemptId: uuid,
    outcome: z.enum(['accepted', 'started', 'completed', 'canceled', 'rejected']),
  })
  .strict();
export const Message = z.discriminatedUnion('kind', [Snapshot, Report]);
export type Message = z.infer<typeof Message>;
export type Snapshot = z.infer<typeof Snapshot>;
export type Report = z.infer<typeof Report>;

export const policy = {
  offlineMs: 15_000,
  freshMs: 10_000,
  observationGapMs: 4_000,
  batteryDurationMs: 10_000,
  stuckDurationMs: 20_000,
  commandTtlMs: 20_000,
} as const;
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export type Condition = {
  since: number;
  lastAt: number;
  active: boolean;
  matching: boolean;
  anchorX: number;
  anchorY: number;
};
export type RuleKind = 'battery_low' | 'stuck';
export function evaluate(
  kind: RuleKind,
  old: Condition | null,
  snap: Snapshot,
  now: number,
  activeMission: boolean,
): { condition: Condition; edge: 'fire' | 'clear' | null } {
  const continuous =
    old !== null && now >= old.lastAt && now - old.lastAt <= policy.observationGapMs;
  const prev = continuous ? old : null;
  const active = old?.active ?? false;
  const moved = prev ? Math.hypot(snap.x - prev.anchorX, snap.y - prev.anchorY) >= 2 : false;
  const matches =
    kind === 'battery_low'
      ? snap.battery < (active ? 25 : 20)
      : activeMission && snap.status === 'moving' && !moved;
  const since = matches && prev?.matching ? prev.since : now;
  const condition: Condition = {
    since,
    lastAt: now,
    active,
    matching: matches,
    anchorX: prev && !moved ? prev.anchorX : snap.x,
    anchorY: prev && !moved ? prev.anchorY : snap.y,
  };
  const duration = kind === 'battery_low' ? policy.batteryDurationMs : policy.stuckDurationMs;
  if (!matches && active) {
    condition.active = false;
    return { condition, edge: 'clear' };
  }
  if (matches && !active && now - since >= duration) {
    condition.active = true;
    return { condition, edge: 'fire' };
  }
  return { condition, edge: null };
}

export function isNewer(
  current: { generation: number; seq: number } | null,
  next: { generation: number; seq: number },
): boolean {
  return (
    !current ||
    next.generation > current.generation ||
    (next.generation === current.generation && next.seq > current.seq)
  );
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, ordered(v)]),
    );
  return value;
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}
export function tokenHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public current?: unknown,
  ) {
    super(message);
  }
}

export const nodes = [
  { id: 'receiving', label: 'Receiving', x: 130, y: 150, kind: 'dock' },
  { id: 'assembly', label: 'Assembly', x: 490, y: 150, kind: 'station' },
  { id: 'shipping', label: 'Shipping', x: 850, y: 150, kind: 'dock' },
  { id: 'inspection', label: 'Inspection', x: 130, y: 420, kind: 'station' },
  { id: 'storage', label: 'Storage', x: 490, y: 420, kind: 'station' },
  { id: 'charging', label: 'Charging', x: 850, y: 420, kind: 'charger' },
] as const;
export const destination = z.enum([
  'receiving',
  'assembly',
  'shipping',
  'inspection',
  'storage',
  'charging',
]);
export function noteFor(
  type: string,
  vehicle: string,
  battery: number | null,
): { source: 'runbook'; summary: string; evidence: string[]; actions: string[] } {
  if (type === 'offline')
    return {
      source: 'runbook',
      summary: `${vehicle} has stopped contacting the site gateway. Its last position may be stale.`,
      evidence: ['Gateway contact exceeded the 15 second threshold.'],
      actions: [
        'Check the link and last contact time.',
        'Reconcile the active mission before releasing its reservation.',
      ],
    };
  if (type === 'battery_low')
    return {
      source: 'runbook',
      summary: `${vehicle} reported low battery across fresh observations.`,
      evidence: [
        `Observed battery: ${battery?.toFixed(1) ?? 'unknown'}%.`,
        'Threshold: below 20% for 10 seconds; clears at 25%.',
      ],
      actions: [
        'Inspect the vehicle and confirm charging availability.',
        'Cancel an active mission only through the confirmed workflow.',
      ],
    };
  if (type === 'stuck')
    return {
      source: 'runbook',
      summary: `${vehicle} reported movement without meaningful displacement during an active mission.`,
      evidence: ['Displacement remained below 2 m across 20 seconds of fresh observations.'],
      actions: [
        'Inspect the route for an obstruction.',
        'Contact the operator before canceling the attempt.',
      ],
    };
  return {
    source: 'runbook',
    summary: `The outcome of a command to ${vehicle} is unknown. The reservation is held.`,
    evidence: [
      'No conclusive terminal vehicle outcome is recorded; a command deadline or rejection requires reconciliation.',
    ],
    actions: [
      'Restore contact and reconcile execution.',
      'Request cancellation; wait for vehicle confirmation.',
    ],
  };
}
