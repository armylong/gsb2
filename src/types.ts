// 核心类型定义：引擎是纯数据、纯函数，不依赖 DOM，方便单测与整条重算。

export type OpCode = 'F' | 'L' | 'R' | 'PICK' | 'DROP' | 'W';

export const OP_LABELS: Record<OpCode, string> = {
  F: '前进',
  L: '左转',
  R: '右转',
  PICK: '拿书',
  DROP: '放书',
  W: '等待',
};

export type Color = 'red' | 'blue';

export const COLOR_NAME: Record<Color, string> = {
  red: '红',
  blue: '蓝',
};

/** 朝向：0=北(上) 1=东(右) 2=南(下) 3=西(左) */
export type Dir = 0 | 1 | 2 | 3;

export interface Pos {
  x: number;
  y: number;
}

export interface Book {
  id: string;
  color: Color;
  /** 当前所在台面；在车箱里时为 null */
  tableId: string | null;
  /** 被哪辆车拿着；在台面上时为 null */
  cartId: string | null;
}

export interface Table {
  id: string;
  pos: Pos;
  /** 角落台面只接受同色书；null 表示普通台面（书的出发点，任意颜色可停留） */
  acceptColor: Color | null;
}

export interface Cart {
  id: string;
  label: string;
  color: Color;
  pos: Pos;
  dir: Dir;
  /** 至多一格的书箱：存书 id 或 null */
  carrying: string | null;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  walls: Pos[];
  tables: Table[];
  carts: Cart[];
  books: Book[];
  /** 各车默认指令序列（可被 localStorage 里保存的版本覆盖） */
  defaultPrograms: Record<string, OpCode[]>;
  /** 给玩家的提示 */
  hint: string;
}

export interface GameState {
  carts: Cart[];
  books: Book[];
}

export type RequestStatus = 'ok' | 'blocked' | 'failed';

export interface ActionResult {
  op: OpCode;
  success: boolean;
  status: RequestStatus;
  /** 人能看懂的判定说明 */
  reason: string;
  /** 移动类请求想去的格（用于画面幽灵标记） */
  targetPos?: Pos;
}

export interface TickRecord {
  /** 第几拍，从 1 开始 */
  tick: number;
  before: GameState;
  after: GameState;
  results: Record<string, ActionResult>;
  /** 该拍执行后是否过关 */
  won: boolean;
}

export interface Simulation {
  scenarioId: string;
  initial: GameState;
  ticks: TickRecord[];
  /** 过关出现的第一拍；null 表示尚未过关 */
  winTick: number | null;
}
