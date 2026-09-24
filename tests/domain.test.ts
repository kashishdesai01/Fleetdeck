import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluate,
  isNewer,
  digest,
  Snapshot,
  policy,
  type Condition,
} from '../packages/core/src/domain.js';
import {
  execute,
  advance,
  enqueue,
  type SimVehicle,
  type SimCommand,
} from '../apps/simulator/src/engine.js';
const snap = {
  kind: 'snapshot' as const,
  vehicleId: '30000000-0000-4000-8000-000000000001',
  bootId: '40000000-0000-4000-8000-000000000001',
  seq: 1,
  at: '2026-10-19T12:00:00.000Z',
  x: 10,
  y: 10,
  heading: 0,
  speed: 0,
  battery: 15,
  status: 'idle' as const,
};
describe('ordered identities and current-state rules', () => {
  it('session and sequence maximum is invariant under arbitrary permutations and duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ generation: fc.integer({ min: 1, max: 10 }), seq: fc.nat(1000) }), {
          minLength: 1,
          maxLength: 80,
        }),
        fc.integer(),
        (rows, seed) => {
          const apply = (xs: typeof rows) =>
            xs.reduce<(typeof rows)[number] | null>((v, n) => (isNewer(v, n) ? n : v), null);
          const shuffled = fc.sample(
            fc.shuffledSubarray([...rows, ...rows], {
              minLength: rows.length * 2,
              maxLength: rows.length * 2,
            }),
            { seed, numRuns: 1 },
          )[0]!;
          expect(apply(shuffled)).toEqual(apply(rows));
        },
      ),
      { numRuns: 150 },
    );
  });
  it('does not use device timestamps to establish order', () => {
    expect(isNewer({ generation: 1, seq: 101 }, { generation: 1, seq: 100 })).toBe(false);
    expect(isNewer({ generation: 1, seq: 999 }, { generation: 2, seq: 0 })).toBe(true);
  });
  it('canonical hash ignores key order and rejects semantic message changes', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest(snap)).not.toBe(digest({ ...snap, at: '2026-10-19T12:00:01.000Z' }));
  });
  it('requires the full duration after the condition starts, with hysteresis', () => {
    let state: Condition | null = null;
    let edge: string | null = null;
    for (let t = 0; t <= 15000; t += 1000) {
      const r = evaluate('battery_low', state, { ...snap, battery: t < 5000 ? 80 : 15 }, t, false);
      state = r.condition;
      edge = r.edge;
      if (t < 15000) expect(edge).toBeNull();
    }
    expect(edge).toBe('fire');
    expect(evaluate('battery_low', state, { ...snap, battery: 23 }, 16000, false).edge).toBeNull();
    expect(evaluate('battery_low', state, { ...snap, battery: 25 }, 16000, false).edge).toBe(
      'clear',
    );
  });
  it('an observation gap cannot count as observed low-battery duration', () => {
    const first = evaluate('battery_low', null, snap, 0, false);
    expect(evaluate('battery_low', first.condition, snap, 30000, false).edge).toBeNull();
  });
  it('never double-fires without recovery, for generated fresh traces', () => {
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 150 }), (seconds) => {
        let state: Condition | null = null;
        let fires = 0;
        for (let t = 0; t <= seconds * 1000; t += 1000) {
          const r = evaluate('battery_low', state, snap, t, false);
          state = r.condition;
          if (r.edge === 'fire') fires++;
        }
        expect(fires).toBe(1);
      }),
    );
  });
  it('stuck detection requires a mission and resets its anchor after meaningful movement', () => {
    let state: Condition | null = null;
    for (let t = 0; t <= policy.stuckDurationMs; t += 1000) {
      const r = evaluate('stuck', state, { ...snap, status: 'moving' }, t, true);
      state = r.condition;
      if (t === policy.stuckDurationMs) expect(r.edge).toBe('fire');
    }
    expect(evaluate('stuck', state, { ...snap, status: 'moving', x: 20 }, 21000, true).edge).toBe(
      'clear',
    );
    expect(evaluate('stuck', null, { ...snap, status: 'moving' }, 30000, false).edge).toBeNull();
  });
  it('rejects unsafe sequences, NaN, unknown fields and unbounded coordinates', () => {
    for (const value of [
      { ...snap, seq: Number.MAX_SAFE_INTEGER + 1 },
      { ...snap, x: NaN },
      { ...snap, instruction: 'ignore' },
      { ...snap, x: 1001 },
    ])
      expect(Snapshot.safeParse(value).success).toBe(false);
  });
});
function sim(): SimVehicle {
  return {
    id: snap.vehicleId,
    name: 'AMR-01',
    bootId: snap.bootId,
    seq: 0,
    x: 130,
    y: 150,
    battery: 90,
    heading: 0,
    speed: 0,
    status: 'idle',
    outbox: [],
    ledgers: {},
    active: null,
    phase: 1,
  };
}
const command: SimCommand = {
  id: '50000000-0000-4000-8000-000000000001',
  attemptId: '60000000-0000-4000-8000-000000000001',
  kind: 'start',
  expiresAt: '2026-10-19T13:00:00.000Z',
  payload: { destination: 'shipping', node: { x: 850, y: 150 } },
};
describe('simulated execution ledger', () => {
  it('duplicate commands after restart do not restart completed work', () => {
    const v = sim();
    execute(v, command, Date.parse(snap.at));
    advance(v, 100, false);
    expect(v.active).toBeNull();
    const restored = JSON.parse(JSON.stringify(v)) as SimVehicle;
    execute(restored, command, Date.parse(snap.at));
    expect(restored.active).toBeNull();
    expect(Object.keys(restored.ledgers)).toHaveLength(1);
  });
  it('a full offline buffer preserves pending reports and can drain before resuming generation', () => {
    const v = sim();
    expect(enqueue(v, () => ({ ...snap, seq: ++v.seq }), 1)).toBe(true);
    execute(v, command, Date.parse(snap.at));
    const ledger = v.ledgers[command.id]!;
    const makeReport = () => ({
      kind: 'command_report' as const,
      vehicleId: v.id,
      bootId: v.bootId,
      seq: ++v.seq,
      at: snap.at,
      commandId: command.id,
      attemptId: command.attemptId,
      outcome: ledger.outcome,
    });
    ledger.reported = enqueue(v, makeReport, 1);
    expect(ledger.reported).toBe(false);
    expect(v.seq).toBe(1);
    expect(v.outbox).toHaveLength(1);
    v.outbox.splice(0, 1);
    ledger.reported = enqueue(v, makeReport, 1);
    expect(ledger.reported).toBe(true);
    expect(v.seq).toBe(2);
    expect(v.outbox[0]?.kind).toBe('command_report');
  });
  it('rejects expired commands without executing them', () => {
    const v = sim();
    execute(v, command, Date.parse(command.expiresAt));
    expect(v.active).toBeNull();
    expect(v.ledgers[command.id]?.outcome).toBe('rejected');
  });
  it('cancel-before-start fences the attempt against a late start', () => {
    const v = sim();
    execute(
      v,
      { ...command, id: '70000000-0000-4000-8000-000000000001', kind: 'cancel' },
      Date.parse(snap.at),
    );
    execute(v, command, Date.parse(snap.at));
    expect(v.active).toBeNull();
  });
});
