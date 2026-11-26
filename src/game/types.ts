export type ScopeId = 0 | 1;
export type CellId = 'w0' | 'walk' | 'w1';
export type FilterId = 'clear' | 'red' | 'blue';
export type Phase = 'day' | 'night';

export interface EaveDef {
  /** Offset from the window centre in degrees, along increasing bearing. */
  from: number;
  to: number;
  label: string;
}

export interface WindowDef {
  id: string;
  name: string;
  short: string;
  centre: number;
  halfWidth: number;
  eave: EaveDef;
}

export interface BodyDef {
  id: string;
  name: string;
  color: string;
  shape: 'star' | 'planet';
  initialAngle: number;
  speed: number;
  dir: 1 | -1;
  orbitRadius: number;
  designated: boolean;
  filter: FilterId;
  requiredBeats: number;
  hint: string;
}

export interface ScopeDef {
  id: ScopeId;
  name: string;
  short: string;
  startCell: CellId;
  startHeading: number;
  slew: number;
  filter: FilterId;
}

export interface LevelDef {
  id: string;
  name: string;
  tagline: string;
  brief: string[];
  totalBeats: number;
  /** Fixed deterministic day/night cycle, measured in beats. */
  cycleBeats: number;
  /** First dayBeats beats of every cycle are daytime. */
  dayBeats: number;
  aimTolerance: number;
  windows: [WindowDef, WindowDef];
  scopes: [ScopeDef, ScopeDef];
  bodies: BodyDef[];
  /** A built-in strategy / demonstration script. null means wait that beat. */
  script: (Command | null)[];
  demo?: boolean;
}

export type CommandType = 'idle' | 'rotate' | 'filter' | 'start' | 'stop' | 'move';

export interface Command {
  type: CommandType;
  scopeId?: ScopeId;
  /** rotate: -1 left / +1 right; move: -1 toward w0 / +1 toward w1. */
  dir?: -1 | 1;
  filter?: FilterId;
}

export interface BodyState {
  id: string;
  angle: number;
}

export interface ScopeState {
  id: ScopeId;
  cell: CellId;
  heading: number;
  filter: FilterId;
  observing: boolean;
  targetId: string | null;
  streak: number;
  streakStartBeat: number | null;
  attemptQualified: boolean;
}

export interface QualifiedRecord {
  key: string;
  targetId: string;
  targetName: string;
  scopeId: ScopeId;
  scopeName: string;
  startBeat: number;
  endBeat: number;
  beats: number;
  filter: FilterId;
}

export type LossKind = 'conflict' | 'interruption' | 'missed' | 'window-miss';

export interface LossEvent {
  id: string;
  beat: number;
  scopeId?: ScopeId;
  targetId?: string;
  code: string;
  message: string;
  kind: LossKind;
  brokeStreak?: number;
}

export interface ObservationTick {
  beat: number;
  scopeId: ScopeId;
  targetId: string | null;
  credited: boolean;
  code: string;
  message: string;
  streak: number;
  recordKey?: string;
}

export interface GameState {
  elapsed: number;
  scopes: [ScopeState, ScopeState];
  bodies: BodyState[];
  records: QualifiedRecord[];
  losses: LossEvent[];
}

export interface BeatReport {
  beat: number;
  round: number;
  phase: Phase;
  command: Command | null;
  accepted: boolean;
  rejectionCode?: string;
  rejection?: string;
  ticks: ObservationTick[];
  losses: LossEvent[];
  state: GameState;
}

export interface VisibilityBeat {
  beat: number;
  angle: number;
  inside: boolean;
  blockedBy?: 'eave';
  phase: Phase;
}

export interface VisibilityRun {
  bodyId: string;
  windowIndex: 0 | 1;
  startBeat: number;
  endBeat: number;
  beats: number;
  eaveBeats: number[];
  dayBeats: number[];
}

export interface SimulationResult {
  level: LevelDef;
  commands: (Command | null)[];
  states: GameState[];
  reports: BeatReport[];
  runs: VisibilityRun[];
  passed: boolean;
  records: QualifiedRecord[];
  losses: LossEvent[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}
