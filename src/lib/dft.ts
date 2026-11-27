// 离散傅里叶圆链核心：一条闭合周期曲线 z(t) -> 一串「带旋转方向的圆」
//
// 约定（相位 t ∈ [0,1)，对应屏幕坐标复数 z = x + i*y）：
//   z(t) ≈ Σ_k c_k · e^(i·2π·k·t)
//   每个非零成分是一个圆：半径 r=|c_k|，初相 arg(c_k)，有符号转速 k
//   k>0 屏幕上逆时针旋转（数学正向），k<0 顺时针，k=0 是不动的中心圆
// 全部为纯函数，DOM 与 Node 测试共用。

import type { Vec2 } from './geometry';
import { wrapAngle } from './geometry';

export interface CircleComponent {
  /** 有符号频率（旋转方向与圈数） */
  k: number;
  /** 复系数实部/虚部（c0 即图形重心） */
  re: number;
  im: number;
  /** 半径 |c| */
  r: number;
  /** 初相 arg(c) ∈ (-π, π] */
  phase: number;
}

export interface Epicycle {
  k: number;
  r: number;
  phase: number;
  /** 该圆起点（上一级末端） */
  origin: Vec2;
  /** 该圆末端（下一级起点）；最后一个即笔尖 */
  tip: Vec2;
}

/** 对 N 个闭合周期采样点做 DFT，返回按频率从负到正排列的全部成分 */
export function dft(samples: Vec2[]): CircleComponent[] {
  const n = samples.length;
  const out: CircleComponent[] = [];
  for (let k = 0; k < n; k++) {
    let re = 0;
    let im = 0;
    const fk = k <= n / 2 ? k : k - n; // 有符号频率
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * fk * t) / n;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      re += samples[t].x * ca - samples[t].y * sa;
      im += samples[t].x * sa + samples[t].y * ca;
    }
    re /= n;
    im /= n;
    out.push({ k: fk, re, im, r: Math.hypot(re, im), phase: wrapAngle(Math.atan2(im, re)) });
  }
  return out.sort((a, b) => a.k - b.k);
}

/** 取直流成分 c0（重心） */
export function dcComponent(components: CircleComponent[]): CircleComponent {
  const c0 = components.find((c) => c.k === 0);
  if (!c0) throw new Error('DFT 结果缺少 k=0 成分');
  return c0;
}

/**
 * 按振幅保留 keep 个旋转圆（c0 始终保留，不计入 keep）。
 * 这是「圆转得越来越少时丢了哪部分形状」的控制入口：
 * 先丢的永远是半径最小的高频细节。
 */
export function retainByAmplitude(
  components: CircleComponent[],
  keep: number,
): CircleComponent[] {
  const c0 = dcComponent(components);
  const rest = components
    .filter((c) => c.k !== 0)
    .slice()
    .sort((a, b) => b.r - a.r);
  return [c0, ...rest.slice(0, Math.max(0, keep))];
}

export type OrderMode = 'frequency' | 'amplitude' | 'reverse';

/**
 * 在「同一批成分」下换展示顺序。末端位置是复数加法，可交换，
 * 所以三种顺序走出的一圈曲线完全一致 —— 只是圆链的嵌套长相不同。
 */
export function orderComponents(
  retained: CircleComponent[],
  mode: OrderMode,
): CircleComponent[] {
  const c0 = dcComponent(retained);
  const rest = retained.filter((c) => c.k !== 0);
  switch (mode) {
    case 'frequency':
      return [c0, ...rest.slice().sort((a, b) => Math.abs(a.k) - Math.abs(b.k) || a.k - b.k)];
    case 'amplitude':
      return [c0, ...rest.slice().sort((a, b) => b.r - a.r)];
    case 'reverse':
      // 与 frequency 完全相反的装配顺序，末端与轨迹不变
      return [
        c0,
        ...rest
          .slice()
          .sort((a, b) => Math.abs(a.k) - Math.abs(b.k) || a.k - b.k)
          .reverse(),
      ];
  }
}

/** 单个成分在相位 t 处的复位移 */
function componentVector(c: CircleComponent, t: number): Vec2 {
  const ang = c.phase + 2 * Math.PI * c.k * t;
  return { x: c.r * Math.cos(ang), y: c.r * Math.sin(ang) };
}

/**
 * 按给定成分顺序，在相位 t 处装配整条圆链。
 * 末端 tip 与成分顺序无关，只与「保留了哪些成分」有关。
 */
export function buildEpicycles(ordered: CircleComponent[], t: number): Epicycle[] {
  const c0 = dcComponent(ordered);
  let pos: Vec2 = { x: c0.re, y: c0.im };
  const chain: Epicycle[] = [
    { k: 0, r: c0.r, phase: 0, origin: { x: pos.x, y: pos.y }, tip: { x: pos.x, y: pos.y } },
  ];
  for (const c of ordered.slice(1)) {
    const origin = { ...pos };
    const d = componentVector(c, t);
    pos = { x: pos.x + d.x, y: pos.y + d.y };
    chain.push({ k: c.k, r: c.r, phase: c.phase, origin, tip: { ...pos } });
  }
  return chain;
}

/** 圆链末端（当前笔尖） */
export function chainTip(chain: Epicycle[]): Vec2 {
  return chain[chain.length - 1].tip;
}

/** 用保留成分重建整圈曲线（N 个相位等分点，闭合） */
export function reconstruct(ordered: CircleComponent[], n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let x = 0;
    let y = 0;
    for (const c of ordered) {
      const d = componentVector(c, t);
      x += d.x;
      y += d.y;
    }
    out.push({ x, y });
  }
  return out;
}

/**
 * 反向遍历同一条曲线（点序反转 + 共轭坐标 y→-y 只用于验证旋转方向镜像；
 * 纯点序反转也会让所有 k 的旋转方向取反）。
 * 返回适合再次喂给 dft 的采样：z_rev[t] = z[-t]。
 */
export function reverseTraversal(samples: Vec2[]): Vec2[] {
  const n = samples.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push(samples[(n - i) % n]);
  return out;
}
