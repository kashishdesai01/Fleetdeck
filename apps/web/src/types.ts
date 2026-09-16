import type { EtaPrediction } from '../../../packages/eta/src/predict.js';
export type { EtaPrediction };
export interface Vehicle {
  id: string;
  name: string;
  model: string;
  revision: string;
  online: boolean;
  contact_at: string | null;
  observed_at: string | null;
  snapshot_received_at: string | null;
  processed_at: string | null;
  x: number;
  y: number;
  heading: number;
  speed: number;
  battery: number;
  status: string;
}
export interface Incident {
  id: string;
  vehicle_id: string;
  vehicle_name: string;
  type: string;
  title: string;
  severity: 'critical' | 'warning';
  state: 'open' | 'acknowledged' | 'resolved';
  condition_active: boolean;
  assignee: string | null;
  version: number;
  opened_at: string;
  note: { source: string; summary: string; evidence: string[]; actions: string[] };
}
export interface Mission {
  id: string;
  vehicle_id: string;
  vehicle_name: string;
  destination: string;
  state: string;
  version: number;
  created_at: string;
  current_attempt_id: string;
  eta: EtaPrediction | null;
  eta_observed_seconds: number | null;
  eta_reconciled: boolean;
}
export interface Audit {
  id: string;
  actor: string;
  action: string;
  subject_id: string;
  at: string;
  data: Record<string, unknown>;
}
export interface SiteNode {
  id: string;
  label: string;
  x: number;
  y: number;
  kind: string;
}
export interface FleetState {
  at: string;
  site: { id: string; name: string };
  vehicles: Vehicle[];
  incidents: Incident[];
  missions: Mission[];
  audit: Audit[];
  health: {
    pending: number;
    admitted: number;
    rejected_reports: number;
    oldest_pending: string | null;
  };
  nodes: SiteNode[];
  eta: {
    enabled: boolean;
    available: boolean;
    promoted: boolean;
    version: string | null;
    boundary: string;
  };
}
export interface User {
  id: string;
  name: string;
  role: string;
}
export interface TimelineEvent {
  id: string;
  at: string;
  actor: string;
  kind: string;
  data: Record<string, unknown>;
}
