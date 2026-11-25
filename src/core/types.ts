export type RouteId = 'A' | 'B';
export type LockMode = 'auto' | RouteId;
export type Health = 'ok' | 'stalled' | 'offline';
export type RecoveryMode = 'ff' | 'seek';
export type ScenarioId = 'primary-only' | 'both-sequential' | 'manual';

export type Cue =
  | {
      id: string;
      at: number;
      kind: 'health';
      route: RouteId;
      health: Health;
      recovery?: RecoveryMode;
      label?: string;
    }
  | { id: string; at: number; kind: 'lock'; lock: LockMode; label?: string }
  | { id: string; at: number; kind: 'align'; route: RouteId; label?: string }
  | { id: string; at: number; kind: 'catchup'; route: RouteId; label?: string };

export interface CatchUpState {
  active: boolean;
  mode: RecoveryMode | 'manual';
  fromPts: number;
  targetPts: number;
  initialGapMs: number;
  rate: number;
  startedAt: number;
  deadlineSec: number;
  estimatedSec: number;
  /** Initial gap is too large to close inside the operational deadline. */
  impossible: boolean;
  /** Deadline elapsed while the route was still not synchronized. */
  late: boolean;
  /** Sticky after a predicted or actual deadline miss, even once caught up. */
  deadlineMissed: boolean;
  completedAt?: number;
}

export interface AlignmentState {
  at: number;
  fromPts: number;
  toPts: number;
  deltaMs: number;
  reason: string;
}

export interface SourceState {
  id: RouteId;
  name: string;
  role: '主路' | '备路';
  health: Health;
  /** Deterministic content PTS simulated by the core. */
  pts: number;
  lastGoodPts: number;
  rate: number;
  gapSec: number;
  stableSec: number;
  badSince: number | null;
  confirmedBad: boolean;
  catchUp: CatchUpState | null;
  lastAlignment: AlignmentState | null;
  seekNonce: number;
}

export type SwitchReason =
  | 'startup'
  | 'primary-unavailable'
  | 'route-unavailable'
  | 'both-unavailable'
  | 'signal-restored'
  | 'recovery-primary'
  | 'both-recovered-election'
  | 'manual-lock'
  | 'lock-released'
  | 'manual-align';

export interface SwitchRecord {
  id: string;
  at: number;
  from: RouteId | null;
  to: RouteId | null;
  reason: SwitchReason;
  title: string;
  rule: string;
  targetPts?: number;
  fromPts?: number;
  toPtsBefore?: number;
  deltaBeforeMs?: number;
  deltaAfterMs?: number;
  nearby?: boolean;
  simultaneousRecovery?: boolean;
}

export type ProgramState =
  | 'live'
  | 'confirming'
  | 'no-source'
  | 'locked-bad';

export interface SimState {
  duration: number;
  time: number;
  lock: LockMode;
  scenarioId: ScenarioId;
  sources: Record<RouteId, SourceState>;
  output: RouteId | null;
  lastOutput: RouteId | null;
  programState: ProgramState;
  switches: SwitchRecord[];
}

export interface ActualRouteState {
  id: RouteId;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  seeking: boolean;
  playbackRate: number;
  videoWidth: number;
  videoHeight: number;
  networkState: number;
  error: string | null;
}

export interface SwitchEvidence {
  switchId: string;
  occurrences: number;
  capturedAt: number;
  actualFromPts: number | null;
  actualToBefore: number | null;
  actualDeltaBeforeMs: number | null;
  actualToAfter: number | null;
  actualDeltaAfterMs: number | null;
  settled: boolean;
}

export interface TimelineItem {
  key: string;
  at: number;
  category: 'cue' | 'switch';
  tone: 'info' | 'warn' | 'error' | 'success' | 'lock';
  title: string;
  detail?: string;
  switchId?: string;
}
