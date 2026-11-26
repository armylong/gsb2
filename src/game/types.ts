export type Side = 'left' | 'right';
export type BeadColor = 'red' | 'blue';
export type BinId = 'L' | 'R';

export interface Point {
  x: number;
  y: number;
}

export interface BoardNode extends Point {
  id: string;
  kind?: 'cell' | 'exit';
  bin?: BinId;
  label?: string;
}

export interface SwitchTrigger {
  /** Stable id used in the single-step inspector. */
  id: string;
  /** Chutes toggled when a bead really traverses this chute. */
  toggles: string[];
}

export interface ChuteDef {
  id: string;
  entry: string;
  outputs: Record<Side, string | null>;
  initial: Side;
  adjustable?: boolean;
  trigger?: SwitchTrigger;
  label?: string;
}

export interface LaunchSlotDef {
  id: string;
  /** Board node occupied when the bead launches. */
  node: string;
  releaseTick: number;
  /** Rack marker; falls back to a point above node. */
  at?: Point;
  color: BeadColor | null;
  lockedColor?: boolean;
}

export type PriorityRule =
  | {
      kind: 'color-rank';
      rank: BeadColor[];
      label: string;
    }
  | {
      kind: 'launch-order';
      label: string;
    };

export interface GoalEntry {
  color: BeadColor;
  bin: BinId;
  note?: string;
}

export interface LevelDef {
  id: string;
  name: string;
  subtitle: string;
  brief: string[];
  width: number;
  height: number;
  nodes: Record<string, BoardNode>;
  chutes: ChuteDef[];
  slots: LaunchSlotDef[];
  priority: PriorityRule;
  goal: GoalEntry[];
  maxTicks: number;
}

export interface SetupState {
  tilts: Record<string, Side>;
  colors: Record<string, BeadColor | null>;
}

export type BeadStatus = 'queued' | 'active' | 'exited' | 'jammed';

export interface BeadState {
  id: string;
  slotId: string;
  slotIndex: number;
  color: BeadColor;
  releaseTick: number;
  status: BeadStatus;
  node: string | null;
  exitNode?: string;
  bin?: BinId;
  arrivedTick?: number;
}

export interface ArrivalRecord {
  order: number;
  tick: number;
  beadId: string;
  color: BeadColor;
  bin: BinId;
  node: string;
}

export interface ConflictTrace {
  node: string;
  /** Claimants sorted by the level's priority rule. */
  claimants: string[];
  winnerId: string;
  ruleLabel: string;
}

export interface MoveTrace {
  beadId: string;
  color: BeadColor;
  chuteId: string;
  from: string;
  to: string;
  side: Side;
  exited: boolean;
}

export type BlockKind =
  | 'lost-priority'
  | 'occupied'
  | 'deadend'
  | 'missing-route'
  | 'launch-blocked'
  | 'cycle';

export interface BlockTrace {
  tick: number;
  beadId: string;
  color: BeadColor;
  kind: BlockKind;
  message: string;
  target?: string;
  chuteId?: string;
  side?: Side;
  winnerId?: string;
  blockerId?: string;
}

export interface SwitchEffectTrace {
  switchId: string;
  sourceChuteId: string;
  beadId: string;
  targetChuteId: string;
}

export interface SwitchResolutionTrace {
  targetChuteId: string;
  from: Side;
  to: Side;
  netToggles: number;
  changed: boolean;
  /** Switch effects in the deterministic resolution order. */
  sources: SwitchEffectTrace[];
  rule: string;
}

export interface StepTrace {
  /** Zero-based simulation step; UI shows beat + 1. */
  tick: number;
  spawned: string[];
  conflicts: ConflictTrace[];
  moves: MoveTrace[];
  blocks: BlockTrace[];
  switchEffects: SwitchEffectTrace[];
  switchResolutions: SwitchResolutionTrace[];
}

export type SimStatus = 'running' | 'won' | 'failed';

export interface FailureInfo {
  code:
    | 'wrong-arrival'
    | 'deadend'
    | 'missing-route'
    | 'gridlock'
    | 'timeout'
    | 'invalid-setup';
  message: string;
  tick: number;
  beadId?: string;
}

export interface SimFrame {
  tick: number;
  tilts: Record<string, Side>;
  beads: BeadState[];
  occupancy: Record<string, string>;
  arrivals: ArrivalRecord[];
  status: SimStatus;
  failure?: FailureInfo;
  trace?: StepTrace;
}

export interface SimulationResult {
  levelId: string;
  setup: SetupState;
  frames: SimFrame[];
  final: SimFrame;
  won: boolean;
}

export interface HintResult {
  setup: SetupState;
  tiltChanges: Array<{ chuteId: string; from: Side; to: Side }>;
  colorChanges: Array<{ slotId: string; from: BeadColor | null; to: BeadColor }>;
  result: SimulationResult;
  summary: string[];
}
