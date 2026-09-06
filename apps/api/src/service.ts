import { randomUUID } from 'node:crypto';
import { Database, changed, type Tx } from './db.js';
import { EtaEstimator } from './eta.js';
import {
  Problem,
  digest,
  policy,
  evaluate,
  noteFor,
  nodes,
  type Message,
  type Snapshot,
  type Report,
  type Condition,
} from '../../../packages/core/src/domain.js';

export interface Actor {
  id: string;
  name: string;
  role: 'viewer' | 'operator' | 'admin';
}
export interface VehicleRow {
  id: string;
  site_id: string;
  name: string;
  model: string;
  generation: string;
  boot_id: string | null;
  revision: string;
  last_seq: string;
  contact_at: Date | null;
  observed_at: Date | null;
  snapshot_received_at: Date | null;
  processed_at: Date | null;
  online: boolean;
  x: number;
  y: number;
  heading: number;
  speed: number;
  battery: number;
  status: string;
}
interface InboxRow {
  id: string;
  body: Message;
  generation: string;
  received_at: Date;
}
interface MissionRow {
  id: string;
  vehicle_id: string;
  destination: string;
  state: string;
  version: number;
  current_attempt_id: string;
}
interface CommandRow {
  id: string;
  attempt_id: string;
  vehicle_id: string;
  kind: 'start' | 'cancel';
  state: string;
  expires_at: Date;
  payload: Record<string, unknown>;
}
interface IncidentRow {
  id: string;
  vehicle_id: string;
  type: string;
  state: string;
  condition_active: boolean;
  version: number;
}
const activeStates = ['assigned', 'in_progress', 'uncertain', 'canceling'];
export class FleetService {
  constructor(
    public db: Database,
    public maxPending = 100000,
    public eta = new EtaEstimator(),
  ) {}
  private async audit(
    tx: Tx,
    actor: Actor | null,
    action: string,
    id: string,
    data: unknown = {},
  ): Promise<void> {
    await tx.query(
      'INSERT INTO audit_log(actor_id,action,subject_id,at,data) VALUES($1,$2,$3,$4,$5)',
      [actor?.id ?? null, action, id, this.db.now(), data],
    );
  }
  private async missionEvent(
    tx: Tx,
    id: string,
    actor: string,
    kind: string,
    data: unknown = {},
  ): Promise<void> {
    await tx.query(
      'INSERT INTO mission_events(mission_id,at,actor,kind,data) VALUES($1,$2,$3,$4,$5)',
      [id, this.db.now(), actor, kind, data],
    );
  }
  async registerBoot(
    siteId: string,
    vehicleId: string,
    bootId: string,
  ): Promise<{ generation: string; active: boolean }> {
    return this.db.transaction(async (tx) => {
      const v = (
        await tx.query<VehicleRow>('SELECT * FROM vehicles WHERE id=$1 AND site_id=$2 FOR UPDATE', [
          vehicleId,
          siteId,
        ])
      ).rows[0];
      if (!v) throw new Problem(404, 'vehicle_not_found', 'Vehicle not found.');
      const old = (
        await tx.query<{ generation: string }>(
          'SELECT generation FROM vehicle_boots WHERE vehicle_id=$1 AND boot_id=$2',
          [vehicleId, bootId],
        )
      ).rows[0];
      if (old) return { generation: old.generation, active: v.boot_id === bootId };
      const generation = String(BigInt(v.generation) + 1n);
      await tx.query('INSERT INTO vehicle_boots(vehicle_id,boot_id,generation) VALUES($1,$2,$3)', [
        vehicleId,
        bootId,
        generation,
      ]);
      await tx.query(
        'UPDATE vehicles SET generation=$2,boot_id=$3,last_seq=-1,observed_at=NULL,snapshot_received_at=NULL,processed_at=NULL,revision=revision+1 WHERE id=$1',
        [vehicleId, generation, bootId],
      );
      await this.interruptConditions(tx, vehicleId);
      await changed(tx);
      return { generation, active: true };
    });
  }
  async ingest(
    siteId: string,
    messages: Message[],
  ): Promise<{ accepted: number; duplicates: number }> {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(872364102)');
      const pending = Number(
        (await tx.query<{ count: string }>('SELECT count(*) FROM inbox WHERE processed_at IS NULL'))
          .rows[0]?.count ?? 0,
      );
      if (pending + messages.length > this.maxPending)
        throw new Problem(503, 'overloaded', 'Inbox is at capacity. Retry the unchanged batch.');
      const ids = [...new Set(messages.map((m) => m.vehicleId))].sort();
      const locked = await tx.query<VehicleRow>(
        'SELECT * FROM vehicles WHERE id=ANY($1::uuid[]) AND site_id=$2 ORDER BY id FOR UPDATE',
        [ids, siteId],
      );
      if (locked.rowCount !== ids.length)
        throw new Problem(404, 'vehicle_not_found', 'A vehicle is outside this gateway site.');
      const vehicles = new Map(locked.rows.map((v) => [v.id, v]));
      let accepted = 0,
        duplicates = 0;
      for (const msg of messages) {
        const now = this.db.now();
        const boot = (
          await tx.query<{ generation: string }>(
            'SELECT generation FROM vehicle_boots WHERE vehicle_id=$1 AND boot_id=$2',
            [msg.vehicleId, msg.bootId],
          )
        ).rows[0];
        if (!boot)
          throw new Problem(
            409,
            'unregistered_boot',
            'Register this vehicle boot before ingesting telemetry.',
          );
        const hash = digest(msg);
        const existing = (
          await tx.query<{ body_hash: string }>(
            'SELECT body_hash FROM inbox WHERE vehicle_id=$1 AND boot_id=$2 AND seq=$3',
            [msg.vehicleId, msg.bootId, msg.seq],
          )
        ).rows[0];
        if (existing) {
          if (existing.body_hash !== hash)
            throw new Problem(
              409,
              'identity_conflict',
              'This sequence already identifies a different immutable message.',
            );
          duplicates++;
        } else {
          const age = now.getTime() - Date.parse(msg.at);
          if (age > 24 * 3600000 || age < -60000)
            throw new Problem(
              422,
              'timestamp_out_of_range',
              'New observations must be within the 24 hour history window and 60 second clock-skew allowance.',
            );
          await tx.query(
            'INSERT INTO inbox(site_id,vehicle_id,boot_id,generation,seq,body_hash,body,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [siteId, msg.vehicleId, msg.bootId, boot.generation, msg.seq, hash, msg, now],
          );
          accepted++;
        }
        if (vehicles.get(msg.vehicleId)?.boot_id === msg.bootId) {
          await tx.query(
            'UPDATE vehicles SET contact_at=GREATEST(contact_at,$2),online=true,revision=revision+1 WHERE id=$1',
            [msg.vehicleId, now],
          );
          await this.clearIncident(tx, msg.vehicleId, 'offline');
        }
      }
      await changed(tx);
      return { accepted, duplicates };
    });
  }
  private async fireIncident(tx: Tx, v: VehicleRow, type: string): Promise<void> {
    const titles: Record<string, string> = {
      offline: 'Connection lost',
      battery_low: 'Battery reserve low',
      stuck: 'Movement stalled',
      command_uncertain: 'Command outcome unknown',
    };
    const existing = (
      await tx.query<IncidentRow>(
        "SELECT * FROM incidents WHERE vehicle_id=$1 AND type=$2 AND state<>'resolved' FOR UPDATE",
        [v.id, type],
      )
    ).rows[0];
    if (existing) {
      if (!existing.condition_active) {
        await tx.query('UPDATE incidents SET condition_active=true,version=version+1 WHERE id=$1', [
          existing.id,
        ]);
        await tx.query(
          "INSERT INTO incident_events(incident_id,at,actor,kind) VALUES($1,$2,'system','condition_returned')",
          [existing.id, this.db.now()],
        );
      }
      return;
    }
    const id = randomUUID();
    await tx.query(
      'INSERT INTO incidents(id,vehicle_id,type,severity,title,opened_at,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        v.id,
        type,
        type === 'offline' || type === 'command_uncertain' ? 'critical' : 'warning',
        titles[type] ?? type,
        this.db.now(),
        noteFor(type, v.name, v.battery),
      ],
    );
    await tx.query(
      "INSERT INTO incident_events(incident_id,at,actor,kind) VALUES($1,$2,'system','opened')",
      [id, this.db.now()],
    );
    await this.audit(tx, null, 'incident.opened', id, { vehicleId: v.id, type });
  }
  private async clearIncident(tx: Tx, vehicleId: string, type: string): Promise<void> {
    const incident = (
      await tx.query<IncidentRow>(
        "UPDATE incidents SET condition_active=false,version=version+1 WHERE vehicle_id=$1 AND type=$2 AND state<>'resolved' AND condition_active RETURNING *",
        [vehicleId, type],
      )
    ).rows[0];
    if (incident) {
      await tx.query(
        "INSERT INTO incident_events(incident_id,at,actor,kind) VALUES($1,$2,'system','condition_cleared')",
        [incident.id, this.db.now()],
      );
      await this.audit(tx, null, 'incident.condition_cleared', incident.id);
    }
  }
  private async interruptConditions(tx: Tx, vehicleId: string): Promise<void> {
    // Preserve active edges so a later healthy reading can clear them. Only continuity is lost.
    await tx.query(
      "UPDATE rule_conditions SET value=jsonb_set(value,'{lastAt}','-1'::jsonb) WHERE vehicle_id=$1",
      [vehicleId],
    );
  }
  async processOne(failBeforeCommit = false, beforeCommit?: () => Promise<void>): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const v = (
        await tx.query<VehicleRow>(
          'SELECT v.* FROM vehicles v WHERE EXISTS(SELECT 1 FROM inbox i WHERE i.vehicle_id=v.id AND i.processed_at IS NULL) ORDER BY v.id FOR UPDATE OF v SKIP LOCKED LIMIT 1',
        )
      ).rows[0];
      if (!v) return false;
      const rows = (
        await tx.query<InboxRow>(
          'SELECT id,body,generation,received_at FROM inbox WHERE vehicle_id=$1 AND processed_at IS NULL ORDER BY generation,seq LIMIT 500 FOR UPDATE',
          [v.id],
        )
      ).rows;
      for (const row of rows) {
        let outcome = 'historical';
        if (row.generation === v.generation && row.body.bootId === v.boot_id) {
          if (row.body.kind === 'snapshot' && row.body.seq > Number(v.last_seq)) {
            await this.applySnapshot(tx, v, row.body, row.received_at);
            outcome = 'applied';
          } else if (row.body.kind === 'command_report') {
            outcome = await this.applyReport(tx, v, row.body, row.received_at);
          } else outcome = 'older_snapshot';
        }
        await tx.query('UPDATE inbox SET processed_at=$2,outcome=$3 WHERE id=$1', [
          row.id,
          this.db.now(),
          outcome,
        ]);
      }
      if (failBeforeCommit) throw new Error('Injected failure before commit');
      if (beforeCommit) await beforeCommit();
      await changed(tx);
      return true;
    });
  }
  private async applySnapshot(
    tx: Tx,
    v: VehicleRow,
    snap: Snapshot,
    receivedAt: Date,
  ): Promise<void> {
    const now = this.db.now();
    await tx.query(
      'UPDATE vehicles SET last_seq=$2,observed_at=$3,processed_at=$4,x=$5,y=$6,heading=$7,speed=$8,battery=$9,status=$10,snapshot_received_at=$11,revision=revision+1 WHERE id=$1',
      [
        v.id,
        snap.seq,
        snap.at,
        now,
        snap.x,
        snap.y,
        snap.heading,
        snap.speed,
        snap.battery,
        snap.status,
        receivedAt,
      ],
    );
    Object.assign(v, {
      last_seq: String(snap.seq),
      observed_at: new Date(snap.at),
      snapshot_received_at: receivedAt,
      processed_at: now,
      x: snap.x,
      y: snap.y,
      battery: snap.battery,
      status: snap.status,
    });
    const observedAge = now.getTime() - Date.parse(snap.at),
      queuedAge = now.getTime() - receivedAt.getTime();
    // Replayed/skewed data remains inspectable, but cannot establish a live alert duration.
    if (observedAge < -5000 || observedAge > policy.freshMs || queuedAge > policy.freshMs) {
      await this.interruptConditions(tx, v.id);
      return;
    }
    const mission = (
      await tx.query<MissionRow>(
        'SELECT * FROM missions WHERE vehicle_id=$1 AND state=ANY($2::text[])',
        [v.id, activeStates],
      )
    ).rows[0];
    for (const kind of ['battery_low', 'stuck'] as const) {
      const prev =
        (
          await tx.query<{ value: Condition }>(
            'SELECT value FROM rule_conditions WHERE vehicle_id=$1 AND kind=$2',
            [v.id, kind],
          )
        ).rows[0]?.value ?? null;
      const result = evaluate(kind, prev, snap, now.getTime(), !!mission);
      await tx.query(
        'INSERT INTO rule_conditions(vehicle_id,kind,value) VALUES($1,$2,$3) ON CONFLICT(vehicle_id,kind) DO UPDATE SET value=EXCLUDED.value',
        [v.id, kind, result.condition],
      );
      if (result.edge === 'fire') await this.fireIncident(tx, v, kind);
      if (result.edge === 'clear') await this.clearIncident(tx, v.id, kind);
    }
  }
  private async applyReport(
    tx: Tx,
    v: VehicleRow,
    report: Report,
    receivedAt: Date,
  ): Promise<string> {
    const cmd = (
      await tx.query<CommandRow>(
        'SELECT * FROM commands WHERE id=$1 AND vehicle_id=$2 AND attempt_id=$3 FOR UPDATE',
        [report.commandId, v.id, report.attemptId],
      )
    ).rows[0];
    if (!cmd) return 'unauthorized_report';
    const mission = (
      await tx.query<MissionRow>(
        'SELECT m.* FROM missions m JOIN attempts a ON a.mission_id=m.id WHERE a.id=$1 FOR UPDATE OF m',
        [report.attemptId],
      )
    ).rows[0];
    if (
      !mission ||
      mission.current_attempt_id !== report.attemptId ||
      !activeStates.includes(mission.state)
    )
      return 'obsolete_attempt';
    if (
      (cmd.kind === 'cancel' &&
        report.outcome !== 'accepted' &&
        report.outcome !== 'canceled' &&
        report.outcome !== 'rejected') ||
      (cmd.kind === 'start' && report.outcome === 'canceled')
    )
      return 'invalid_outcome';
    if (report.outcome === 'accepted') {
      await tx.query(
        "UPDATE commands SET state='accepted' WHERE id=$1 AND state IN ('pending','expired')",
        [cmd.id],
      );
      await this.missionEvent(tx, mission.id, 'vehicle', 'command.accepted', { commandId: cmd.id });
      return 'command_accepted';
    }
    if (report.outcome === 'rejected') {
      if (cmd.state === 'superseded') return 'superseded_rejection';
      // Rejection is about this command, not proof that the attempt stopped executing.
      await tx.query("UPDATE commands SET state='rejected' WHERE id=$1", [cmd.id]);
      await tx.query("UPDATE missions SET state='uncertain',version=version+1 WHERE id=$1", [
        mission.id,
      ]);
      await tx.query("UPDATE attempts SET state='unknown' WHERE id=$1", [report.attemptId]);
      await this.fireIncident(tx, v, 'command_uncertain');
      await this.missionEvent(tx, mission.id, 'vehicle', 'command.rejected', {
        commandId: cmd.id,
        reservation: 'held',
      });
      await this.audit(tx, null, 'command.rejected', mission.id, { commandId: cmd.id });
      return 'rejected_reservation_held';
    }
    if (report.outcome === 'started') {
      if (mission.state === 'assigned' || mission.state === 'in_progress')
        await tx.query("UPDATE missions SET state='in_progress',version=version+1 WHERE id=$1", [
          mission.id,
        ]);
      await tx.query(
        "UPDATE attempts SET state=CASE WHEN state='canceling' THEN state ELSE 'running' END WHERE id=$1",
        [report.attemptId],
      );
      await tx.query("UPDATE commands SET state='accepted' WHERE id=$1 AND state<>'superseded'", [
        cmd.id,
      ]);
    } else {
      const state =
        report.outcome === 'completed'
          ? 'completed'
          : report.outcome === 'canceled'
            ? 'canceled'
            : 'failed';
      if (state === 'completed') {
        await tx.query(
          'UPDATE missions SET eta_observed_seconds=GREATEST(0,EXTRACT(EPOCH FROM ($2::timestamptz-created_at))),eta_reconciled=$3 WHERE id=$1 AND eta_observed_seconds IS NULL',
          [
            mission.id,
            receivedAt,
            ['uncertain', 'canceling'].includes(mission.state) ||
              receivedAt.getTime() - Date.parse(report.at) > policy.freshMs,
          ],
        );
      }
      await tx.query('UPDATE missions SET state=$2,finished_at=$3,version=version+1 WHERE id=$1', [
        mission.id,
        state,
        this.db.now(),
      ]);
      await tx.query('UPDATE attempts SET state=$2,terminal_at=$3 WHERE id=$1', [
        report.attemptId,
        state,
        this.db.now(),
      ]);
      await tx.query(
        "UPDATE commands SET state=CASE WHEN id=$2 THEN 'completed' ELSE 'superseded' END WHERE attempt_id=$1 AND state<>'completed'",
        [report.attemptId, cmd.id],
      );
      await this.clearIncident(tx, v.id, 'command_uncertain');
    }
    await this.missionEvent(tx, mission.id, 'vehicle', report.outcome, {
      attemptId: report.attemptId,
      commandId: cmd.id,
    });
    await this.audit(tx, null, `mission.${report.outcome}`, mission.id, {
      attemptId: report.attemptId,
    });
    return report.outcome;
  }
  async sweep(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const vs = await tx.query<VehicleRow>(
        "SELECT * FROM vehicles WHERE (online AND contact_at<$1) OR EXISTS(SELECT 1 FROM commands c JOIN missions m ON m.current_attempt_id=c.attempt_id WHERE c.vehicle_id=vehicles.id AND c.state IN ('pending','accepted') AND c.expires_at<$2 AND m.state=ANY($3::text[])) ORDER BY id FOR UPDATE SKIP LOCKED",
        [new Date(this.db.now().getTime() - policy.offlineMs), this.db.now(), activeStates],
      );
      for (const v of vs.rows) {
        const now = this.db.now();
        if (v.online && v.contact_at && now.getTime() - v.contact_at.getTime() > policy.offlineMs) {
          await tx.query('UPDATE vehicles SET online=false,revision=revision+1 WHERE id=$1', [
            v.id,
          ]);
          await this.interruptConditions(tx, v.id);
          await this.fireIncident(tx, v, 'offline');
        }
        const cmds = await tx.query<CommandRow>(
          "SELECT c.* FROM commands c JOIN missions m ON m.current_attempt_id=c.attempt_id WHERE c.vehicle_id=$1 AND c.state IN ('pending','accepted') AND c.expires_at<$2 AND m.state=ANY($3::text[]) FOR UPDATE OF c",
          [v.id, now, activeStates],
        );
        for (const cmd of cmds.rows) {
          // Receipt alone is inconclusive. Started commands stay accepted until terminal evidence.
          const m = (
            await tx.query<MissionRow>(
              'SELECT * FROM missions WHERE current_attempt_id=$1 FOR UPDATE',
              [cmd.attempt_id],
            )
          ).rows[0];
          if (cmd.kind === 'start' && m?.state === 'in_progress') continue;
          await tx.query("UPDATE commands SET state='expired' WHERE id=$1", [cmd.id]);
          await tx.query(
            "UPDATE missions SET state='uncertain',version=version+1 WHERE current_attempt_id=$1 AND state<>'uncertain'",
            [cmd.attempt_id],
          );
          await tx.query("UPDATE attempts SET state='unknown' WHERE id=$1", [cmd.attempt_id]);
          await this.fireIncident(tx, v, 'command_uncertain');
          if (m)
            await this.missionEvent(tx, m.id, 'system', 'command.expired', {
              commandId: cmd.id,
              reservation: 'held',
            });
        }
      }
      if (vs.rowCount) await changed(tx);
      await tx.query('DELETE FROM sessions WHERE expires_at<$1', [this.db.now()]);
    });
  }
  async commands(siteId: string, vehicleId: string): Promise<unknown[]> {
    return this.db.transaction(async (tx) => {
      const v = (
        await tx.query<VehicleRow>('SELECT * FROM vehicles WHERE id=$1 AND site_id=$2 FOR UPDATE', [
          vehicleId,
          siteId,
        ])
      ).rows[0];
      if (!v) throw new Problem(404, 'vehicle_not_found', 'Vehicle not found.');
      const rows = await tx.query<CommandRow>(
        "SELECT c.* FROM commands c JOIN missions m ON m.current_attempt_id=c.attempt_id WHERE c.vehicle_id=$1 AND c.state IN ('pending','accepted') AND c.expires_at>$2 AND ((c.kind='start' AND m.state IN ('assigned','in_progress')) OR (c.kind='cancel' AND m.state='canceling')) ORDER BY c.created_at FOR UPDATE OF c",
        [vehicleId, this.db.now()],
      );
      for (const cmd of rows.rows)
        await tx.query('UPDATE commands SET last_sent_at=$2,deliveries=deliveries+1 WHERE id=$1', [
          cmd.id,
          this.db.now(),
        ]);
      return rows.rows.map((c) => ({
        id: c.id,
        attemptId: c.attempt_id,
        kind: c.kind,
        expiresAt: c.expires_at,
        payload: c.payload,
      }));
    });
  }
  async dispatch(
    actor: Actor,
    key: string,
    body: { vehicleId: string; destination: string },
  ): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      const hash = digest(body);
      const inserted = await tx.query(
        "INSERT INTO idempotency_keys(actor_id,operation,key,body_hash) VALUES($1,'dispatch',$2,$3) ON CONFLICT DO NOTHING RETURNING key",
        [actor.id, key, hash],
      );
      if (!inserted.rowCount) {
        const old = (
          await tx.query<{ body_hash: string; response: unknown }>(
            "SELECT body_hash,response FROM idempotency_keys WHERE actor_id=$1 AND operation='dispatch' AND key=$2",
            [actor.id, key],
          )
        ).rows[0];
        if (old?.body_hash !== hash)
          throw new Problem(
            422,
            'idempotency_key_reuse',
            'This key was used for a different dispatch.',
          );
        return old.response;
      }
      const v = (
        await tx.query<VehicleRow>('SELECT * FROM vehicles WHERE id=$1 FOR UPDATE', [
          body.vehicleId,
        ])
      ).rows[0];
      if (!v) throw new Problem(404, 'vehicle_not_found', 'Vehicle not found.');
      const now = this.db.now();
      const reserved = await tx.query(
        'SELECT id FROM missions WHERE vehicle_id=$1 AND state=ANY($2::text[])',
        [v.id, activeStates],
      );
      const observedAge = v.observed_at ? now.getTime() - v.observed_at.getTime() : Infinity;
      const contactAge = v.contact_at ? now.getTime() - v.contact_at.getTime() : Infinity;
      const receiptAge = v.snapshot_received_at
        ? now.getTime() - v.snapshot_received_at.getTime()
        : Infinity;
      if (reserved.rowCount)
        throw new Problem(
          409,
          'vehicle_reserved',
          'This vehicle has an active or uncertain attempt.',
        );
      if (
        !v.online ||
        contactAge > policy.offlineMs ||
        receiptAge > policy.freshMs ||
        receiptAge < -1000 ||
        observedAge > policy.freshMs ||
        observedAge < -5000 ||
        v.status !== 'idle' ||
        v.battery < 25
      )
        throw new Problem(
          409,
          'vehicle_ineligible',
          'Dispatch requires an idle vehicle, fresh telemetry, live contact, and at least 25% battery.',
        );
      const critical = await tx.query(
        "SELECT 1 FROM incidents WHERE vehicle_id=$1 AND severity='critical' AND state<>'resolved'",
        [v.id],
      );
      if (critical.rowCount)
        throw new Problem(
          409,
          'vehicle_ineligible',
          'Resolve the critical condition before dispatch.',
        );
      const id = randomUUID(),
        attemptId = randomUUID(),
        commandId = randomUUID();
      const congestion = await this.congestion(tx, v.site_id);
      const destination = nodes.find((n) => n.id === body.destination);
      if (!destination) throw new Problem(422, 'invalid_destination', 'Unknown destination.');
      const eta = this.eta.estimate(v, destination, congestion, now);
      await tx.query(
        "INSERT INTO missions(id,vehicle_id,destination,state,current_attempt_id,created_at,created_by,eta) VALUES($1,$2,$3,'assigned',$4,$5,$6,$7)",
        [id, v.id, body.destination, attemptId, now, actor.id, eta],
      );
      await tx.query(
        "INSERT INTO attempts(id,mission_id,vehicle_id,state,created_at) VALUES($1,$2,$3,'reserved',$4)",
        [attemptId, id, v.id, now],
      );
      await tx.query(
        "INSERT INTO commands(id,attempt_id,vehicle_id,kind,created_at,expires_at,payload) VALUES($1,$2,$3,'start',$4,$5,$6)",
        [
          commandId,
          attemptId,
          v.id,
          now,
          new Date(now.getTime() + policy.commandTtlMs),
          { destination: body.destination, node: destination, congestion },
        ],
      );
      const response = { id, attemptId, commandId, state: 'assigned', version: 1, eta };
      await this.missionEvent(tx, id, actor.name, 'assigned', {
        vehicleId: v.id,
        destination: body.destination,
      });
      await this.audit(tx, actor, 'mission.dispatched', id, body);
      await tx.query(
        "UPDATE idempotency_keys SET response=$3 WHERE actor_id=$1 AND operation='dispatch' AND key=$2",
        [actor.id, key, response],
      );
      await changed(tx);
      return response;
    });
  }
  async cancel(actor: Actor, id: string, version: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const hint = (await tx.query<MissionRow>('SELECT * FROM missions WHERE id=$1', [id])).rows[0];
      if (!hint) throw new Problem(404, 'mission_not_found', 'Mission not found.');
      await tx.query('SELECT id FROM vehicles WHERE id=$1 FOR UPDATE', [hint.vehicle_id]);
      const m = (await tx.query<MissionRow>('SELECT * FROM missions WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!m || m.version !== version)
        throw new Problem(
          409,
          'version_conflict',
          'The mission changed. Review its current state.',
          m,
        );
      if (!activeStates.includes(m.state))
        throw new Problem(409, 'invalid_transition', 'This mission is already terminal.', m);
      const now = this.db.now();
      await tx.query(
        "UPDATE commands SET state='superseded' WHERE attempt_id=$1 AND kind='start' AND state<>'completed'",
        [m.current_attempt_id],
      );
      await tx.query(
        "UPDATE commands SET state='superseded' WHERE attempt_id=$1 AND kind='cancel' AND state<>'completed'",
        [m.current_attempt_id],
      );
      await tx.query(
        "INSERT INTO commands(id,attempt_id,vehicle_id,kind,created_at,expires_at,payload) VALUES($1,$2,$3,'cancel',$4,$5,'{}')",
        [
          randomUUID(),
          m.current_attempt_id,
          m.vehicle_id,
          now,
          new Date(now.getTime() + policy.commandTtlMs),
        ],
      );
      await tx.query("UPDATE missions SET state='canceling',version=version+1 WHERE id=$1", [id]);
      await tx.query("UPDATE attempts SET state='canceling' WHERE id=$1", [m.current_attempt_id]);
      await this.missionEvent(tx, id, actor.name, 'cancel.requested', {
        reservation: 'held_until_confirmation',
      });
      await this.audit(tx, actor, 'mission.cancel_requested', id);
      await changed(tx);
    });
  }
  async incidentAction(
    actor: Actor,
    id: string,
    body: { action: 'acknowledge' | 'assign' | 'resolve'; version: number; note?: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const hint = (await tx.query<IncidentRow>('SELECT * FROM incidents WHERE id=$1', [id]))
        .rows[0];
      if (!hint) throw new Problem(404, 'incident_not_found', 'Incident not found.');
      await tx.query('SELECT id FROM vehicles WHERE id=$1 FOR UPDATE', [hint.vehicle_id]);
      const i = (
        await tx.query<IncidentRow>('SELECT * FROM incidents WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!i || i.version !== body.version)
        throw new Problem(
          409,
          'version_conflict',
          'Another operator or an automatic transition changed this incident.',
          i,
        );
      if (i.state === 'resolved')
        throw new Problem(409, 'invalid_transition', 'This incident is resolved.', i);
      if (body.action === 'acknowledge') {
        if (i.state !== 'open')
          throw new Problem(
            409,
            'invalid_transition',
            'This incident has already been acknowledged.',
            i,
          );
        await tx.query(
          "UPDATE incidents SET state='acknowledged',acknowledged_at=$2,version=version+1 WHERE id=$1",
          [id, this.db.now()],
        );
      } else if (body.action === 'assign')
        await tx.query('UPDATE incidents SET assignee_id=$2,version=version+1 WHERE id=$1', [
          id,
          actor.id,
        ]);
      else {
        if (i.condition_active)
          throw new Problem(
            409,
            'condition_active',
            'The condition is still active. Acknowledge it and investigate; recovery clears it.',
          );
        if (!body.note?.trim())
          throw new Problem(422, 'resolution_required', 'Add a resolution note.');
        await tx.query(
          "UPDATE incidents SET state='resolved',resolved_at=$2,resolution=$3,version=version+1 WHERE id=$1",
          [id, this.db.now(), body.note],
        );
      }
      await tx.query(
        'INSERT INTO incident_events(incident_id,at,actor,kind,data) VALUES($1,$2,$3,$4,$5)',
        [id, this.db.now(), actor.name, body.action, { note: body.note ?? null }],
      );
      await this.audit(tx, actor, `incident.${body.action}`, id, { note: body.note ?? null });
      await changed(tx);
    });
  }
  async state(): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      const vehicles = (await tx.query('SELECT * FROM vehicles ORDER BY name LIMIT 500')).rows;
      const incidents = (
        await tx.query(
          "WITH visible AS (SELECT * FROM incidents WHERE state<>'resolved' UNION ALL SELECT * FROM (SELECT * FROM incidents WHERE state='resolved' ORDER BY opened_at DESC LIMIT 100) history) SELECT i.*,v.name AS vehicle_name,u.name AS assignee FROM visible i JOIN vehicles v ON v.id=i.vehicle_id LEFT JOIN users u ON u.id=i.assignee_id ORDER BY (i.state='resolved'),i.opened_at DESC",
        )
      ).rows;
      const missions = (
        await tx.query(
          "WITH visible AS (SELECT * FROM missions WHERE state IN ('assigned','in_progress','uncertain','canceling') UNION ALL SELECT * FROM (SELECT * FROM missions WHERE state IN ('completed','canceled','failed') ORDER BY created_at DESC LIMIT 100) history) SELECT m.*,v.name AS vehicle_name FROM visible m JOIN vehicles v ON v.id=m.vehicle_id ORDER BY m.created_at DESC",
        )
      ).rows;
      const audit = (
        await tx.query(
          "SELECT a.*,COALESCE(u.name,'System') AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 40",
        )
      ).rows;
      const health = (
        await tx.query(
          "SELECT count(*) FILTER(WHERE processed_at IS NULL)::int AS pending,count(*) FILTER(WHERE outcome='unauthorized_report')::int AS rejected_reports,count(*)::int AS admitted,MIN(received_at) FILTER(WHERE processed_at IS NULL) AS oldest_pending FROM inbox",
        )
      ).rows[0];
      const site = (await tx.query('SELECT * FROM sites LIMIT 1')).rows[0];
      return {
        at: this.db.now().toISOString(),
        site,
        vehicles,
        incidents,
        missions,
        audit,
        health,
        nodes,
        eta: this.etaStatus(),
      };
    }, true);
  }
  private async congestion(tx: Tx, siteId: string): Promise<number> {
    const row = (
      await tx.query<{ total: string; busy: string }>(
        'SELECT count(*) AS total,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM missions m WHERE m.vehicle_id=v.id AND m.state=ANY($2::text[]))) AS busy FROM vehicles v WHERE site_id=$1',
        [siteId, activeStates],
      )
    ).rows[0]!;
    return Number(row.busy) / Math.max(1, Number(row.total));
  }
  etaStatus() {
    return {
      enabled: this.eta.enabled,
      available: !!this.eta.model,
      promoted: this.eta.model?.promoted ?? false,
      version: this.eta.model?.version ?? null,
      artifactSha256: this.eta.artifactSha256,
      trainingDataSha256: this.eta.model?.trainingDataSha256 ?? null,
      loadError: this.eta.loadError,
      boundary: 'Synthetic dispatch estimate. No real fleet accuracy claim.',
    };
  }
  async previewEta(vehicleId: string, destinationId: string) {
    return this.db.transaction(async (tx) => {
      const vehicle = (
        await tx.query<VehicleRow>('SELECT * FROM vehicles WHERE id=$1', [vehicleId])
      ).rows[0];
      const destination = nodes.find((n) => n.id === destinationId);
      if (!vehicle) throw new Problem(404, 'vehicle_not_found', 'Vehicle not found.');
      if (!destination) throw new Problem(422, 'invalid_destination', 'Unknown destination.');
      return this.eta.estimate(
        vehicle,
        destination,
        await this.congestion(tx, vehicle.site_id),
        this.db.now(),
      );
    }, true);
  }
  async etaMonitoring() {
    const recent = (
      await this.db.pool.query(
        `WITH recent AS (SELECT * FROM missions WHERE eta IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 500)
       SELECT eta->>'source' AS source,eta->>'modelVersion' AS model_version,count(*)::int AS predictions,
       count(*) FILTER(WHERE eta_observed_seconds IS NOT NULL AND NOT eta_reconciled)::int AS labeled,
       count(*) FILTER(WHERE eta_observed_seconds IS NOT NULL AND eta_reconciled)::int AS reconciled_excluded,
       avg(abs(eta_observed_seconds-(eta->>'seconds')::float8)) FILTER(WHERE NOT eta_reconciled) AS mae_seconds,
       avg(abs(eta_observed_seconds-(eta->>'baselineSeconds')::float8)) FILTER(WHERE NOT eta_reconciled) AS baseline_mae_seconds,
       avg((eta_observed_seconds BETWEEN (eta->>'lowerSeconds')::float8 AND (eta->>'upperSeconds')::float8)::int) FILTER(WHERE NOT eta_reconciled) AS interval_coverage
       FROM recent GROUP BY eta->>'source',eta->>'modelVersion'`,
      )
    ).rows;
    return {
      ...this.etaStatus(),
      window:
        'Most recent 500 predictions; receipt-based completion labels; reconciled outcomes excluded from error metrics.',
      recent,
    };
  }
  async detail(kind: 'vehicle' | 'incident' | 'mission', id: string): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      if (kind === 'vehicle')
        return {
          history: (
            await tx.query(
              'SELECT id,body,received_at,processed_at,outcome FROM inbox WHERE vehicle_id=$1 ORDER BY id DESC LIMIT 60',
              [id],
            )
          ).rows,
        };
      if (kind === 'incident')
        return {
          events: (
            await tx.query('SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY id', [id])
          ).rows,
        };
      return {
        events: (
          await tx.query('SELECT * FROM mission_events WHERE mission_id=$1 ORDER BY id', [id])
        ).rows,
        commands: (
          await tx.query(
            'SELECT c.* FROM commands c JOIN attempts a ON a.id=c.attempt_id WHERE a.mission_id=$1 ORDER BY c.created_at',
            [id],
          )
        ).rows,
      };
    }, true);
  }
}
