/**
 * 固定几何：穿线路径、滑轮位置、行程与窗格位置。
 * 全部单位：像素、秒。只描述这一条固定绕线，不含任何通用绳索建模。
 *
 * 穿线（自左向右）：
 *   左固定锚点 → 下绕托架1(动滑轮) → 上绕定滑轮FP1 → 水平段 H
 *   → 上绕定滑轮FP2 → 下绕纸灯(动滑轮) → 上绕定滑轮FP3
 *   → 下绕托架2(动滑轮) → 右固定锚点
 *
 * 绳长不变量：L = 2(h1 + hL + h2) + H + 6πr = 常量
 * 运动学约束（对时间求导）：v1 + vL + v2 = 0（向下为正）
 */

export const PULLEY_R = 18; // 滑轮半径
export const Y_TANGENT = 120; // 定滑轮切线高度（竖直线段的上端）
export const PULLEY_CY = Y_TANGENT - PULLEY_R; // 定滑轮中心高度

// 切线列：每条竖直绳段对应一个固定 x，从左到右共 8 列。
// 相邻滑轮在共用切线列处半圆相接（列间距 2R）；
// FP1→FP2、FP3→托架2 之间留长水平段（列间距 > 2R）。
const G = 2 * PULLEY_R; // 紧贴列间距 36
export const TANGENT_X = [
  92, // 0：左锚点 / 托架1左
  92 + G, // 1：托架1右 / FP1左
  92 + 2 * G, // 2：FP1右
  346, // 3：FP2左（与列2之间是长水平段）
  346 + G, // 4：FP2右 / 纸灯左
  346 + 2 * G, // 5：纸灯右 / FP3左
  346 + 3 * G, // 6：FP3右
  642, // 7：托架2左（与列6之间是长水平段）
  678, // 8：托架2右 / 右锚点
];

// 动滑轮中心 = 各自两条切线列的中点
export const X_CARRIAGE1 = (TANGENT_X[0] + TANGENT_X[1]) / 2; // 110
export const X_LANTERN = (TANGENT_X[4] + TANGENT_X[5]) / 2; // 400
export const X_CARRIAGE2 = (TANGENT_X[7] + TANGENT_X[8]) / 2; // 660

// 定滑轮中心
export const X_FP1 = (TANGENT_X[1] + TANGENT_X[2]) / 2; // 146
export const X_FP2 = (TANGENT_X[3] + TANGENT_X[4]) / 2; // 364
export const X_FP3 = (TANGENT_X[5] + TANGENT_X[6]) / 2; // 436

export const X_LEFT_ANCHOR = TANGENT_X[0];
export const X_RIGHT_ANCHOR = TANGENT_X[8];

/** 两段水平绳段的总长（FP1→FP2 + FP3→托架2），绳长不变量用 */
export const H_GAP = TANGENT_X[3] - TANGENT_X[2] + (TANGENT_X[7] - TANGENT_X[6]);

/** 绕滑轮的半圆弧总长（3 个定滑轮 + 3 个动滑轮） */
export const WRAP_LENGTH = 6 * Math.PI * PULLEY_R;

// 行程（以 h = y - Y_TANGENT 表示）
export const H_MIN = 60;
export const H_MAX = 430;
export const Y_MIN = Y_TANGENT + H_MIN;
export const Y_MAX = Y_TANGENT + H_MAX;

// 初始摆位：三个动滑轮等高
export const H_INITIAL = 220;
/** 绳长不变量里的动滑轮高度和：h1 + hL + h2 恒等于该值 */
export const ROPE_SUM = 3 * H_INITIAL;

// 两处窗格卡榫的高度区间（按灯笼的 h）
export interface LatchBand {
  id: 'upper' | 'lower';
  label: string;
  hMin: number;
  hMax: number;
  /** 只有 |v| 不超过该值才允许卡住（px/s） */
  vMax: number;
}

export const LATCH_BANDS: LatchBand[] = [
  { id: 'upper', label: '上窗格', hMin: 95, hMax: 135, vMax: 22 },
  { id: 'lower', label: '下窗格', hMin: 305, hMax: 345, vMax: 22 },
];

export const GRAVITY = 150; // px/s²
export const LINEAR_DRAG = 0.6; // 线性阻尼系数 k：合力含 -m·k·v
export const FRAME_DT = 1 / 60;
export const SUBSTEPS = 2;

/** 给定三个 h，返回绳的总长度 */
export function ropeLength(h1: number, hL: number, h2: number): number {
  return 2 * (h1 + hL + h2) + H_GAP + WRAP_LENGTH;
}

/** 六段竖直绳段的长度（按穿线顺序），用于单步观察 */
export function verticalStrandLengths(h1: number, hL: number, h2: number): number[] {
  return [h1, h1, hL, hL, h2, h2];
}
