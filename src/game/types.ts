// 核心类型定义：所有游戏状态都是普通数据，引擎为纯函数，方便撤销、模拟和测试。

/** 面团所在位置 */
export type Zone = 'bench' | 'proof' | 'rack' | 'oven' | 'delivered' | 'failed';

/** 温箱档位：0=关火（+0），1=低温（+1），2=高温（+2） */
export type Gear = 0 | 1 | 2;

export interface DoughSpec {
  id: string;
  name: string;
  startDoneness: number;
  /** 合格熟度窗口（闭区间，刻度值） */
  window: [number, number];
  /** 订单截止回合（该回合末交单仍算准时） */
  deadline: number;
  startZone: Zone;
}

export interface DoughState {
  id: string;
  name: string;
  doneness: number;
  zone: Zone;
  window: [number, number];
  deadline: number;
  /** 在炉中剩余烘烤回合数；不在炉中为 null */
  ovenRemaining: number | null;
}

export interface ProofSlot {
  index: number;
  doughId: string | null;
}

export interface LevelSpec {
  id: string;
  title: string;
  brief: string;
  proofSlots: number;
  ovenBakeTurns: number;
  rackRate: number;
  gearRates: Record<Gear, number>;
  maxDoneness: number;
  doughs: DoughSpec[];
}

/** 玩家本拍选择的主要操作；pass = 本回合不移动任何面团 */
export type Action =
  | { type: 'move'; doughId: string; target: Exclude<Zone, 'delivered' | 'failed'> }
  | { type: 'pass' };

export type Result = 'early' | 'success' | 'late' | 'overdue' | null;

export interface DeliveryRecord {
  turn: number;
  doughId: string;
  doneness: number;
  result: Exclude<Result, null>;
  reasons: string[];
}

export interface LogEntry {
  turn: number;
  text: string;
  kind: 'move' | 'gear' | 'tick' | 'result' | 'info';
}

/** 结算事件：按固定顺序产出，UI 逐行展示「先换位、后结算」 */
export type GameEvent =
  | { kind: 'move'; turn: number; doughId: string; from: Zone; to: Zone }
  | { kind: 'pass'; turn: number }
  | { kind: 'oven-tick'; turn: number; doughId: string; remaining: number }
  | { kind: 'bake-done'; turn: number; doughId: string }
  | { kind: 'delivery'; turn: number; delivery: DeliveryRecord }
  | { kind: 'proof-tick'; turn: number; doughId: string; amount: number; doneness: number }
  | { kind: 'rack-tick'; turn: number; doughId: string; amount: number; doneness: number };

export interface GameState {
  levelId: string;
  turn: number;
  gear: Gear;
  doughs: DoughState[];
  proofSlots: ProofSlot[];
  ovenDoughId: string | null;
  /** 已交单记录（含成功与失败），失败不会清掉其他面团的状态 */
  deliveries: DeliveryRecord[];
  log: LogEntry[];
  status: 'playing' | 'won' | 'lost';
}

export interface SimulationResult {
  state: GameState;
  events: GameEvent[];
  rejected: string | null;
}
