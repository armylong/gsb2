// 内置盘面
import { Board, RED, GREEN, BLUE, Dir } from './model.js';

export const GRID_W = 12;
export const GRID_H = 9;

const E = (rot: number, color: number) => ({ type: 'emitter' as const, rot, color });
const M = (rot: number) => ({ type: 'mirror' as const, rot, color: 0 });
const S = (rot: number) => ({ type: 'splitter' as const, rot, color: 0 });
const R = (color: number) => ({ type: 'receiver' as const, rot: 0, color });

/** 盘面一:颜色合成 —— 红绿同向合并成黄,蓝光交叉独立,分束送到多块接收板 */
export function presetCombine(b: Board): void {
  b.clear();
  b.set(0, 3, E(Dir.E, RED));        // 红光向东
  b.set(1, 3, S(0));                 // 分束 '/':红继续向东,分一路向北
  b.set(1, 0, R(RED));               // 要求纯红
  b.set(2, 0, E(Dir.S, GREEN));      // 绿光向南
  b.set(2, 3, S(1));                 // 分束 '\':红绿在此同向合并成黄,向东、向南
  b.set(2, 7, R(RED | GREEN));       // 要求黄
  b.set(5, 8, E(Dir.N, BLUE));       // 蓝光向北,与黄光交叉通过互不干扰
  b.set(5, 0, R(BLUE));              // 要求纯蓝
  b.set(7, 3, S(1));                 // 分束 '\':黄继续向东,分一路向南
  b.set(7, 6, R(RED | GREEN));       // 要求黄
  b.set(10, 3, R(RED | GREEN));      // 要求黄
}

/** 盘面二:反射循环 —— 四块镜面围成封闭回路,模拟有限步收敛并标出回路;离开回路的分束仍点亮接收板 */
export function presetLoop(b: Board): void {
  b.clear();
  b.set(5, 0, E(Dir.S, GREEN));      // 绿光向南
  b.set(5, 2, S(0));                 // 分束 '/':一路向南出回路,一路向西注入回路
  b.set(3, 2, M(0));                 // 四块镜面围成矩形封闭回路
  b.set(3, 6, M(1));
  b.set(7, 6, M(0));
  b.set(7, 2, M(1));
  b.set(5, 7, R(GREEN));             // 离开回路的分束点亮接收板
}

export function presetEmpty(b: Board): void {
  b.clear();
}

export const PRESETS: { name: string; apply: (b: Board) => void }[] = [
  { name: '盘面1 颜色合成', apply: presetCombine },
  { name: '盘面2 反射循环', apply: presetLoop },
  { name: '空白盘面', apply: presetEmpty },
];
