// 协议与共享常量：客户端预测端与权威端使用完全相同的时间单位与消息结构。

export const TICK_MS = 1000 / 60; // 固定逻辑步长：60 tick/秒，两端一致
export const SNAPSHOT_EVERY_TICKS = 8; // 权威端每 8 tick 发一次快照
export const SERVER_MAX_INPUTS_PER_TICK = 8; // 权威端每 tick 最多消费的输入数（追赶上限）
export const RTO_BASE_MS = 250; // 输入重传基准超时
export const TRAIL_MAX = 420; // 轨迹采样上限

export interface Vec2 {
  x: number;
  y: number;
}

export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorldDef {
  width: number;
  height: number;
  radius: number; // 角色半径，两端相同
  speed: number; // 像素/秒，两端相同
  walls: Wall[];
  spawn: Vec2;
  pushZone: { x: number; y: number; w: number; h: number; vx: number; vy: number };
}

/** 一个 tick 的方向输入（8 向 + 静止），由键盘或录像产生 */
export interface Input {
  seq: number; // 单调递增的输入序号
  tick: number; // 客户端产生该输入时的逻辑 tick
  keys: number; // 位掩码：1=上 2=下 4=左 8=右
  epoch: number; // 轮次 id，重置后递增，旧轮次消息一律失效
}

export const KEY_UP = 1;
export const KEY_DOWN = 2;
export const KEY_LEFT = 4;
export const KEY_RIGHT = 8;

export type Channel = 'up' | 'down';

export interface InputPayload {
  kind: 'input';
  input: Input;
  attempt: number; // 第几次发送（1=首发，>1=重传）
}

export interface SnapshotPayload {
  kind: 'snapshot';
  epoch: number;
  serverTick: number;
  lastProcessedSeq: number; // 权威端已顺序处理到的输入序号
  pos: Vec2;
}

export type Payload = InputPayload | SnapshotPayload;

/** 模拟链路上的在途数据包 */
export interface Packet {
  id: number;
  channel: Channel;
  payload: Payload;
  sentAtMs: number;
  arriveAtMs: number; // 入链时即确定；改参数不影响已在途包
  attempt: number;
  lost: boolean;
}

export interface LinkConfig {
  delayMs: number;
  jitterMs: number;
  lossPct: number; // 0..100
}

export interface NetConfig {
  up: LinkConfig; // 客户端 -> 权威端
  down: LinkConfig; // 权威端 -> 客户端
}

export interface HarnessEvent {
  timeMs: number;
  level: 'info' | 'warn' | 'ok';
  text: string;
}
