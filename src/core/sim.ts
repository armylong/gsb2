// 确定性模拟核心: 纯函数, 不依赖 DOM / 随机数 / 时钟。
// 规则版本变更时必须 bump RULE_VERSION, 导入校验会按它拒绝不兼容数据。

export const RULE_VERSION = "1.0.0";

export const WIDTH = 10;
export const HEIGHT = 8;
export const WALL_X = 8; // 竖墙所在列, 墙上开一扇门

export interface Pos {
  x: number;
  y: number;
}

export const SWITCH: Pos = { x: 6, y: 4 };
export const DOOR: Pos = { x: WALL_X, y: 4 };

export type Input = "up" | "down" | "left" | "right" | "wait";
export const INPUTS: readonly Input[] = ["up", "down", "left", "right", "wait"];

export interface SimState {
  player: Pos;
  box: Pos;
  switchOn: boolean; // 规则: 只有箱子能压住开关
  doorOpen: boolean; // 规则: 开关被压住时门开, 否则门关
}

export function initialState(): SimState {
  return derive({ player: { x: 2, y: 4 }, box: { x: 4, y: 4 }, switchOn: false, doorOpen: false });
}

function derive(s: SimState): SimState {
  const switchOn = s.box.x === SWITCH.x && s.box.y === SWITCH.y;
  return {
    player: { ...s.player },
    box: { ...s.box },
    switchOn,
    doorOpen: switchOn,
  };
}

export function isWall(x: number, y: number, doorOpen: boolean): boolean {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return true;
  if (x === WALL_X) return !(y === DOOR.y && doorOpen);
  return false;
}

const DELTA: Record<Input, Pos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  wait: { x: 0, y: 0 },
};

// 唯一的规则推进函数: 同一份 (state, input) 永远得到同一个结果。
export function step(state: SimState, input: Input): SimState {
  const d = DELTA[input];
  if (d.x === 0 && d.y === 0) return derive(state);

  const nx = state.player.x + d.x;
  const ny = state.player.y + d.y;
  if (isWall(nx, ny, state.doorOpen)) return derive(state); // 撞墙/撞关着的门: 原地不动

  const next: SimState = {
    player: { x: nx, y: ny },
    box: { ...state.box },
    switchOn: false,
    doorOpen: false,
  };
  if (state.box.x === nx && state.box.y === ny) {
    // 推箱子: 箱子前方必须是空格
    const bx = nx + d.x;
    const by = ny + d.y;
    if (isWall(bx, by, state.doorOpen)) return derive(state);
    next.box = { x: bx, y: by };
  }
  return derive(next);
}

// ---- 状态指纹 (确定性哈希, 浏览器与 Node 结果一致) ----

export function canonical(s: SimState): string {
  return [
    `p${s.player.x},${s.player.y}`,
    `b${s.box.x},${s.box.y}`,
    `s${s.switchOn ? 1 : 0}`,
    `d${s.doorOpen ? 1 : 0}`,
  ].join("|");
}

export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function hashState(s: SimState): string {
  return fnv1a(canonical(s));
}
