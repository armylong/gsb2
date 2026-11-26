export type Dir = 'N' | 'E' | 'S' | 'W';
export type PieceType = 'thin' | 'wide';
export type PlayableKind = PieceType;
export type FixedKind = 'launcher' | 'flag' | 'post' | 'gate';
export type RuntimeKind = PieceType | FixedKind;

export interface SlotDef {
  id: string;
  x: number;
  y: number;
  /** 只有宽片可以摆放/生效的指定槽位 */
  wideBase?: boolean;
  /** 禁碰槽：连锁碰撞进入即判负 */
  forbidden?: boolean;
  label?: string;
}

export interface FixedObject {
  id: string;
  kind: FixedKind;
  slotId: string;
  /** launcher / gate 倒下后产生碰撞的方向 */
  facing?: Dir;
  /** gate 只接受的碰撞入射方向（source -> gate） */
  acceptDir?: Dir;
  flagId?: string;
  order?: number;
  label?: string;
}

export interface WinCriteria {
  requiredFlags: [string, string];
  /** 第二旗落地拍 - 第一旗落地拍必须 >= 此值 */
  minIntervalBeats: number;
  maxIntervalBeats?: number;
  maxPieces: number;
}

export interface LevelDef {
  id: string;
  name: string;
  subtitle: string;
  brief: string;
  /** 只给方向性提示，不直接给完整摆法 */
  hint: string;
  width: number;
  height: number;
  slots: SlotDef[];
  fixed: FixedObject[];
  inventory: Record<PieceType, number>;
  win: WinCriteria;
  /** 仅可重复样例使用：一键载入的已知摆法 */
  samplePlacement?: Placement[];
  sampleNote?: string;
  sampleButtonLabel?: string;
}

export interface Placement {
  slotId: string;
  type: PieceType;
  facing: Dir;
}

export type EditActionType = 'place' | 'rotate' | 'remove' | 'clear' | 'load-sample' | 'start';

export interface EditAction {
  seq: number;
  type: EditActionType;
  atLogicalMs: number;
  slotId?: string;
  pieceType?: PieceType;
  fromFacing?: Dir;
  toFacing?: Dir;
  placement?: Placement[];
}

export interface TimingSpec {
  beatMs: number;
  contactAfterBeats: number;
  landAfterBeats: number;
}

export type CollisionOutcome =
  | 'triggered'
  | 'merged-same-beat'
  | 'duplicate-route'
  | 'already-falling'
  | 'already-fallen'
  | 'blocked-post'
  | 'blocked-wrong-side'
  | 'empty';

export interface CollisionRecord {
  id: string;
  beat: number;
  groupId: string;
  sourceSlotId: string | null;
  targetSlotId: string | null;
  dir: Dir;
  outcome: CollisionOutcome;
  simultaneous: boolean;
  forbidden: boolean;
  note: string;
}

export interface CollisionGroup {
  id: string;
  beat: number;
  targetSlotId: string | null;
  collisionIds: string[];
  simultaneous: boolean;
  triggeredSlotId: string | null;
  blockedReason: string | null;
}

export type RuntimeStatus = 'idle' | 'falling' | 'fallen' | 'standing';

export interface RuntimePiece {
  slotId: string;
  kind: RuntimeKind;
  status: RuntimeStatus;
  facing: Dir | null;
  outputs: Dir[];
  touchedBeat: number | null;
  contactBeat: number | null;
  landBeat: number | null;
  incomingDir: Dir | null;
  triggeredByCollisionId: string | null;
  acceptedHitCount: number;
  collisionIds: string[];
}

export interface Snapshot {
  beat: number;
  pieces: RuntimePiece[];
  forbiddenTouchedSlotIds: string[];
}

export interface BeatRecord {
  beat: number;
  collisionIds: string[];
  touchedSlotIds: string[];
  landedSlotIds: string[];
}

export interface FlagTiming {
  flagId: string;
  order: number;
  touchedBeat: number | null;
  landedBeat: number | null;
  touchedMs: number | null;
  landedMs: number | null;
}

export interface CheckItem {
  id: 'legality' | 'flags' | 'order' | 'interval' | 'forbidden' | 'pieces';
  label: string;
  pass: boolean;
  detail: string;
}

export interface SimulationResult {
  levelId: string;
  win: boolean;
  lastBeat: number;
  pieceCount: number;
  snapshots: Snapshot[];
  beats: BeatRecord[];
  collisions: CollisionRecord[];
  groups: CollisionGroup[];
  flags: FlagTiming[];
  forbiddenTouchedSlotIds: string[];
  checks: CheckItem[];
  timing: Record<RuntimeKind, TimingSpec>;
  beatMs: number;
}

export interface ReplayRecord {
  schema: 'wood-relay-replay/v1';
  levelId: string;
  levelName: string;
  placement: Placement[];
  actions: EditAction[];
  generatedLogicalBeat: number;
  result: SimulationResult;
  /** 同一拍内发生的碰撞分组，单独冗余出来便于回看/导出 */
  sameBeatCollisionGroups: CollisionGroup[];
  winningActions: EditAction[];
}
