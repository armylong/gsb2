// 全局共享类型：旗位、观测、拍序、收条来源与计分

export type StationId = 'north' | 'west' | 'east';
export type Half = 0 | 1;

/** 八个旗位：0 上，1 右上，2 右，3 右下，4 下，5 左下，6 左，7 左上 */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type SymbolKind = 'start' | 'end' | 'data' | 'check';

export interface SymbolDef {
  id: string;
  label: string;
  /** 无序两面旗的位置（存储时升序） */
  pair: readonly [Dir, Dir];
  kind: SymbolKind;
  /** data 类符号在数据字母表中的下标 0..7 */
  dataIndex?: number;
  /** check 类符号表示的数字 0..9 */
  digit?: number;
  hint: string;
}

export type ObstacleKind = 'cloud' | 'veil' | 'screen' | 'shield';

export type ObstacleShape =
  | { kind: 'cloud'; circles: ReadonlyArray<{ dx: number; dy: number; r: number }> }
  | { kind: 'veil'; r: number }
  | { kind: 'screen'; w: number; h: number }
  | { kind: 'shield'; r: number };

export interface ObstacleDef {
  id: string;
  name: string;
  shape: ObstacleShape;
}

export interface Pose {
  x: number;
  y: number;
}

export type PoseMap = Record<string, Pose>;

export type CueKind = 'origin' | 'resend' | 'forward' | 'custom';

/** 剧本中预埋的「观测台误判」：几何上看得见，但记错了旗位 */
export interface MisreadSpec {
  observer: StationId;
  arm: 0 | 1;
  recordedDir: Dir;
  note: string;
}

export interface Cue {
  id: string;
  txId: string;
  /** 在整条 cue 队列中的下标（载入时写定） */
  stepIndex: number;
  /** 同一发送序列内的拍号 */
  beatIndex: number;
  sender: StationId;
  symbolId: string;
  kind: CueKind;
  /** 补发 / 转发拍显式申报自己属于哪条消息的哪个槽位，避免被时间顺序错配 */
  assign?: { msgId: string; slot: number };
  /** 两个半拍各自的遮挡物布局 */
  layouts: [PoseMap, PoseMap];
  misreads?: MisreadSpec[];
  note?: string;
  /** 剧本给这一拍的标签，如「下一条开头」 */
  tag?: string;
}

export interface HalfArmView {
  seen: boolean;
  /** 该台在这半拍记录到的旗位；没看见为 null */
  recordedDir: Dir | null;
  blockedBy: string | null;
  misread: boolean;
}

export interface ArmEvidence {
  arm: 0 | 1;
  trueDir: Dir;
  halves: [HalfArmView, HalfArmView];
}

/**
 * both   —— 存在某一半拍两面旗同时清楚
 * stitch —— 没有任何半拍两面同清，但两半拼起来两面都见过（遮半拍的临界情形）
 * one    —— 整拍只有一面旗被见过
 * none   —— 两面全程没看见
 */
export type VisLevel = 'both' | 'stitch' | 'one' | 'none';

export interface Observation {
  cueId: string;
  stepIndex: number;
  beatIndex: number;
  txId: string;
  observer: StationId;
  sender: StationId;
  arms: [ArmEvidence, ArmEvidence];
  level: VisLevel;
  simultaneousHalf: Half | null;
  /** 宽松规则：两半证据拼接后识图 */
  lenientValue: string | null;
  /** 严格规则：只在两面同清的半拍识图 */
  strictValue: string | null;
  lenientIssue?: string;
  strictIssue?: string;
}

export type Policy = 'lenient' | 'strict';

export interface ForwardManifest {
  id: string;
  msgId: string;
  fromStation: StationId;
  values: string[];
  /** 转发七拍最后一拍的 stepIndex，走到那里转发件才算收到 */
  readyStep: number;
  label: string;
}

export interface Claim {
  id: string;
  msgId: string;
  slot: number;
  sourceId: string;
  sourceLabel: string;
  provenance: string;
  kind: 'receipt' | 'forward';
  stepIndex?: number;
  cueId?: string;
  observer?: StationId;
  lenientValue: string | null;
  strictValue: string | null;
  roleValid: boolean;
  raw?: Observation;
}

export interface BoardSlot {
  msgId: string;
  slot: number;
  role: 'start' | 'data' | 'check' | 'end';
  claims: Claim[];
  /** 当前策略下、角色合法且非空的不同值 */
  candidateValues: string[];
  conflict: boolean;
  chosenClaimId: string | null;
  /** 经人工选择 / 一致默认后的最终值；无法确定为 null */
  resolvedValue: string | null;
  /** 人工选择了一条空证据，明确留缺 */
  chosenGap: boolean;
  missing: boolean;
}

export interface BoardMessage {
  msgId: string;
  slots: BoardSlot[];
  sender: StationId | null;
  txId: string | null;
  startBeat: number | null;
  complete: boolean;
  checksumOk: boolean;
  text: string | null;
  hasUnresolvedConflict: boolean;
  missingSlots: number[];
}

export interface ScoreRecord {
  serial: number;
  msgKey: string;
  text: string;
  delta: number;
  duplicate: boolean;
  sourceLabel: string;
}

export interface AttemptRecord {
  serial: number;
  ok: boolean;
  reason: string;
  text: string | null;
}

export type ScenarioId = 'clear' | 'half' | 'forward';
export type RunId = ScenarioId | 'custom';

export type TabId = 'script' | 'receipts' | 'decode' | 'checks' | 'rules';

export type ModalState =
  | { type: 'conflict'; msgId: string; slot: number }
  | { type: 'observation'; cueId: string; observer: StationId }
  | null;

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'warn' | 'bad';
}

export interface GameState {
  runId: RunId;
  runName: string;
  cues: Cue[];
  /** 已揭示的 cue 数量：0 表示一拍都没走 */
  cursor: number;
  playing: boolean;
  policy: Policy;
  editHalf: Half;
  tab: TabId;
  observerFilter: StationId | 'all';
  sequences: Record<StationId, string[]>;
  editorStation: StationId;
  previewSymbol: string | null;
  choices: Record<string, string>;
  manifests: ForwardManifest[];
  score: number;
  signedKeys: string[];
  scoreRecords: ScoreRecord[];
  attempts: AttemptRecord[];
  modal: ModalState;
  toast: Toast | null;
  dragTouched: boolean;
  serial: number;
}
