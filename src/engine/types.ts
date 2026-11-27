// 山馆升降台 —— 纯类型定义，引擎与渲染共享

/** 门侧 */
export type Side = 'L' | 'R';

/** 区域：轿厢 / 楼层站台暂存位 / 楼层展柜 */
export type Region = 'car' | 'stage' | 'case';

/** 画箱是否需要保持水平放置（占连续两格、只能走低过梁） */
export interface BoxDef {
  id: string;
  label: string;
  /** 占用货位格数：1 小箱 / 2 长箱 */
  len: 1 | 2;
  /** 是否只能水平放置（内置的水平画箱） */
  horizontalOnly: boolean;
  /** 高度：low 可通过低过梁，tall 不行 */
  height: 'low' | 'tall';
  color: string;
}

export interface BoxPlacement {
  boxId: string;
  region: Region;
  /** 楼层；轿厢内为 null */
  floor: number | null;
  /** 仅站台 / 展柜有 L/R 侧 */
  side: Side | null;
  /** 占用的起始货位索引（靠门为 0，向远离门的方向递增） */
  index: number;
}

/** 展柜定义：每个画箱在某楼层某侧展柜有一个目标 */
export interface CaseGoal {
  boxId: string;
  floor: number;
  side: Side;
}

/** 站台（一侧）的结构 */
export interface PlatformSpec {
  /** 暂存货位数 */
  stageSlots: number;
  /** 展柜货位数（每个长目标占 2 格） */
  caseSlots: number;
  /** 门上过梁高度：low 只允许矮箱通过 */
  lintel: 'normal' | 'low';
}

export type DoorMode =
  | { kind: 'fixed'; side: Side } // 只开一侧
  | { kind: 'both' } // 两侧都开
  | { kind: 'alternating' }; // 按回合交替开门

export interface FloorSpec {
  id: number;
  doorMode: DoorMode;
  L: PlatformSpec;
  R: PlatformSpec;
}

export interface LevelDef {
  id: number;
  name: string;
  brief: string;
  floors: FloorSpec[];
  carSlots: number;
  startFloor: number;
  boxes: BoxDef[];
  initialPlacements: BoxPlacement[];
  goals: CaseGoal[];
  /** 回合预算；通关评分按剩余回合计 */
  budget: number;
}

export interface GameState {
  levelId: number;
  turn: number;
  carFloor: number;
  placements: BoxPlacement[];
  /** 已经进柜的画箱 id，按入柜先后排列 */
  deliveredInOrder: string[];
}

export interface HistoryEntry {
  turn: number;
  kind: 'move' | 'wait' | 'transfer' | 'deliver';
  text: string;
  state: GameState;
}

/** 搬运动作的目标描述 */
export interface TransferTarget {
  region: Region;
  floor: number;
  side: Side;
  /** 指定起始格；不指定时由引擎按靠门原则自动落位 */
  index?: number;
}

export type Action =
  | { type: 'move'; toFloor: number }
  | { type: 'wait' }
  | { type: 'transfer'; boxId: string; target: TransferTarget };

/** 规则校验失败的原因（直接给玩家看的中文说明） */
export interface RejectReason {
  message: string;
  /** 关联的门侧，用于画面上高亮哪条通道过不去 */
  side?: Side;
  /** 关联的挡路画箱 */
  blockerId?: string;
}

export interface ActionResult {
  ok: boolean;
  state?: GameState;
  reason?: RejectReason;
  /** 动作预计 / 实际花费的回合 */
  cost: number;
}
