import type { Message } from '../../../packages/core/src/domain.js';
import {
  seedOf,
  startMotion,
  stepMotion,
  type Motion,
} from '../../../packages/simulation/src/motion.js';
export interface SimCommand {
  id: string;
  attemptId: string;
  kind: 'start' | 'cancel';
  expiresAt: string;
  payload: { destination?: string; node?: { x: number; y: number }; congestion?: number };
}
export interface SimLedger {
  command: SimCommand;
  outcome: 'started' | 'completed' | 'canceled' | 'rejected';
  reported: boolean;
}
export interface SimVehicle {
  id: string;
  name: string;
  bootId: string;
  seq: number;
  x: number;
  y: number;
  battery: number;
  heading: number;
  speed: number;
  status: 'idle' | 'moving' | 'working' | 'charging' | 'stopped' | 'fault';
  outbox: Message[];
  ledgers: Record<string, SimLedger>;
  active: {
    attemptId: string;
    commandId: string;
    x: number;
    y: number;
    waypoints: { x: number; y: number }[];
    motion?: Motion;
  } | null;
  phase: number;
}
export function enqueue(v: SimVehicle, make: () => Message, capacity = 7200): boolean {
  if (v.outbox.length >= capacity) return false;
  v.outbox.push(make());
  return true;
}
export function execute(v: SimVehicle, cmd: SimCommand, now: number): void {
  if (v.ledgers[cmd.id]) return;
  if (Date.parse(cmd.expiresAt) <= now) {
    v.ledgers[cmd.id] = { command: cmd, outcome: 'rejected', reported: false };
    return;
  }
  if (cmd.kind === 'cancel') {
    const prior = Object.values(v.ledgers).find(
      (l) => l.command.attemptId === cmd.attemptId && l.command.kind === 'start',
    );
    if (prior?.outcome === 'completed') return; // Reconcile the actual completed start instead of inventing cancellation.
    if (v.active?.attemptId === cmd.attemptId) {
      v.active = null;
      v.speed = 0;
      v.status = 'idle';
    }
    if (prior) {
      prior.outcome = 'canceled';
      prior.reported = true;
    }
    v.ledgers[cmd.id] = { command: cmd, outcome: 'canceled', reported: false };
    return;
  }
  const terminal = Object.values(v.ledgers).some(
    (l) =>
      l.command.attemptId === cmd.attemptId &&
      ['completed', 'canceled', 'rejected'].includes(l.outcome),
  );
  if (v.active || terminal || !cmd.payload.node) {
    v.ledgers[cmd.id] = { command: cmd, outcome: 'rejected', reported: false };
    return;
  }
  const { x, y } = cmd.payload.node;
  v.active = {
    attemptId: cmd.attemptId,
    commandId: cmd.id,
    x,
    y,
    waypoints: [
      { x: v.x, y: 285 },
      { x, y: 285 },
      { x, y },
    ],
    motion: startMotion(
      v,
      { x, y },
      seedOf(cmd.id),
      Math.max(0, Math.min(1, cmd.payload.congestion ?? 0)),
    ),
  };
  v.status = 'moving';
  v.ledgers[cmd.id] = { command: cmd, outcome: 'started', reported: false };
}
export function advance(v: SimVehicle, dt: number, blocked: boolean): void {
  if (!v.active) {
    v.speed = 0;
    if (v.status === 'moving') v.status = 'idle';
    return;
  }
  if (blocked) {
    v.speed = 0;
    v.status = 'moving';
    return;
  }
  const active = v.active;
  // Upgrade persisted in-flight simulations without teleporting or restarting their route.
  active.motion ??= {
    ...startMotion(v, active, seedOf(active.commandId), 0),
    waypoints: active.waypoints,
  };
  const completed = stepMotion(v, active.motion, dt);
  active.waypoints = active.motion.waypoints;
  v.status = 'moving';
  if (completed) {
    const ledger = v.ledgers[active.commandId];
    if (ledger) {
      ledger.outcome = 'completed';
      ledger.reported = false;
    }
    v.active = null;
    v.speed = 0;
    v.status = 'idle';
  }
}
