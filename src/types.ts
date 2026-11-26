export type NodeId = 'L' | 'R' | 'H' | 'A' | 'B' | 'T';
export type EntranceId = 'L' | 'R';
export type RoomId = 'A' | 'B';
export type SlotId = 'base' | 'outer';

export interface StageNode {
  id: NodeId;
  name: string;
  x: number;
  y: number;
  kind: 'entrance' | 'room' | 'hub' | 'relay';
  note?: string;
}

export interface WalkEdge {
  a: NodeId;
  b: NodeId;
  beats: number;
  name: string;
}

export interface ActorDef {
  id: string;
  name: string;
  short: string;
  color: string;
  start: NodeId;
}

export interface GarmentInitial {
  type: 'wornBy' | 'at';
  actor?: string;
  node?: NodeId;
}

export interface GarmentDef {
  id: string;
  name: string;
  slot: SlotId;
  /** 完整换好所需的连续拍数 */
  don: number;
  color: string;
  wearableBy: string[];
  transferable: boolean;
  initial: GarmentInitial;
}

export interface AppearanceDef {
  id: string;
  role: string;
  candidateIds: string[];
  requires: Partial<Record<SlotId, string>>;
  note?: string;
}

export interface SceneDef {
  id: string;
  title: string;
  /** 开演拍 */
  start: number;
  /** 演出持续拍数；演员在这段时间不能离开 */
  duration: number;
  entrance: EntranceId;
  appearances: AppearanceDef[];
}

interface ActionBase {
  id: string;
  actorId: string;
  start: number;
  duration: number;
}

export interface MoveAction extends ActionBase {
  type: 'move';
  /** 包含起点与终点，相邻节点必须在 WalkEdge 中 */
  path: NodeId[];
}

export interface ChangeAction extends ActionBase {
  type: 'change';
  room: RoomId;
  garmentId: string;
}

export interface TransferAction extends ActionBase {
  type: 'leave' | 'take';
  node: 'T';
  garmentId: string;
}

export type PlanAction = MoveAction | ChangeAction | TransferAction;

export interface Plan {
  casting: Record<string, string>;
  actions: PlanAction[];
  /** 玩家标记的可行保留段终点（含该拍状态） */
  preserveThrough?: number | null;
  lockPreserved?: boolean;
}

export interface Level {
  id: string;
  index: number;
  name: string;
  tagline: string;
  brief: string;
  winHint: string;
  horizon: number;
  nodes: StageNode[];
  edges: WalkEdge[];
  actors: ActorDef[];
  garments: GarmentDef[];
  scenes: SceneDef[];
  solution: Plan;
}

export interface Issue {
  code: string;
  message: string;
  beat: number;
  severity: 'error' | 'warning';
  actorId?: string;
  sceneId?: string;
  appearanceId?: string;
  actionId?: string;
}

export interface CueVerdict {
  sceneId: string;
  appearanceId: string;
  actorId: string | null;
  ok: boolean;
  status: 'ok' | 'uncast' | 'wrong-door' | 'late' | 'costume' | 'casting' | 'conflict';
  title: string;
  role: string;
  entrance: EntranceId;
  issues: Issue[];
  arrivalBeat?: number;
  etaBeat?: number;
}

export interface SceneVerdict {
  sceneId: string;
  title: string;
  start: number;
  entrance: EntranceId;
  ok: boolean;
  cues: CueVerdict[];
}

export interface ActorSnapshot {
  id: string;
  location: NodeId;
  /** 整数拍上若仍在走道中段，给出当前移动动作的路径与已走拍数。 */
  transit: { path: NodeId[]; elapsed: number; duration: number } | null;
  worn: Record<SlotId, string | null>;
  carried: string[];
  currentActionId: string | null;
  busySceneId: string | null;
  arrivalBeat: number;
}

export interface GarmentSnapshot extends GarmentDef {
  wornBy: string | null;
  carriedBy: string | null;
  location: NodeId;
}

export interface RoomUsage {
  room: RoomId;
  actionId: string;
  actorId: string;
  start: number;
  end: number;
  accepted: boolean;
  label: string;
}

export interface Snapshot {
  beat: number;
  queues: Record<EntranceId, string[]>;
  actors: ActorSnapshot[];
  garments: GarmentSnapshot[];
  roomUsage: RoomUsage[];
}

export interface SimulationResult {
  levelId: string;
  horizon: number;
  snapshots: Snapshot[];
  violations: Issue[];
  sceneVerdicts: SceneVerdict[];
  cueVerdicts: CueVerdict[];
  statusById: Record<string, 'accepted' | 'rejected'>;
  passed: boolean;
  firstErrorBeat: number | null;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: CheckResult[];
}
