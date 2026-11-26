/** 共享类型与常量。物理模块保持纯逻辑，不依赖 DOM / canvas。 */

export type Dir = 1 | -1;
export type Axis = 'x' | 'y';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Wall extends Rect {
  /** 仅用于调试面板标记，如 "ceiling"/"alcove" */
  tag: string;
}

/** 检验槽：可被箱子完整占据的判定体，本身不是墙（容纳箱的空间） */
export interface Slot extends Rect {
  /** 重力朝向：'down' 槽在地板上，'up' 槽在天花板上 */
  gravity: 'down' | 'up';
}

export interface Body extends Rect {
  id: string;
  kind: 'player' | 'box';
  vx: number;
  vy: number;
  /** 本 tick 是否贴着重力方向的支撑面（人、箱都用同一套判定） */
  grounded: boolean;
  /** 上一 substep 与其他体的接触方向，调试用 */
  contacts: Set<string>;
}

export interface RoomDef {
  id: string;
  name: string;
  width: number;
  height: number;
  wallThickness: number;
  walls: Wall[];
  slots: Slot[];
  player: Rect;
  box: Rect;
  startGravity: Dir;
  hint: string;
}

export type Status = 'playing' | 'won' | 'failed';
export type FlipPhase = 'idle' | 'flipping';

export type RejectReason =
  | 'not-grounded'
  | 'same-direction'
  | 'flip-in-progress'
  | 'game-over';

export interface LogEntry {
  tick: number;
  kind: 'flip-start' | 'flip-settle' | 'flip-reject' | 'win' | 'fail' | 'info';
  text: string;
}

export interface InputState {
  left: boolean;
  right: boolean;
  /** 请求切到重力向上（W / ↑），边沿触发，每 tick 最多一个 */
  flipUp: boolean;
  /** 请求切到重力向下（S / ↓），边沿触发 */
  flipDown: boolean;
}

export interface GameState {
  room: RoomDef;
  player: Body;
  box: Body;
  gravity: Dir;
  flipPhase: FlipPhase;
  flipAgeTicks: number;
  flipFromGravity: Dir;
  status: Status;
  tick: number;
  /** 箱子完整在槽内的连续 tick 数 */
  seatedTicks: number;
  /** 本次被拒绝的原因（保留到下次成功输入或 90 tick） */
  lastReject: { reason: RejectReason; tick: number } | null;
  logs: LogEntry[];
}

export const TICK = 1 / 60;
export const GRAVITY_ACC = 1500;
export const MAX_FALL = 900;
export const MOVE_SPEED = 210;
export const PUSH_SPEED = 210;
export const GROUND_FRICTION = 12;
export const AIR_DRAG = 2.5;

/** 每个 tick 的内部细分步数，防止高速穿墙 */
export const SUBSTEPS = 4;
/** 每个 substep 的位置修正迭代次数 */
export const RELAX_ITERS = 2;

/** 结算后仍存在超过该深度的重叠 => 判挤压失败（像素） */
export const CRUSH_EPS = 0.5;
/** 出界容忍，超出即属于穿透 bug 的硬断言（像素） */
export const CONTAIN_EPS = 0.25;

export const FLIP_TIMEOUT_TICKS = 180;
export const FLIP_MIN_AGE_TICKS = 4;
export const SEAT_REQUIRED_TICKS = 24;

export const MAX_LOGS = 8;
