// presets.ts — 可编辑闭合三次曲线的数据模型与内置轮廓（圆形 / 窄腰）。
// 模型：每个节点一个锚点 a 加两个控制柄 out/inn，
// 段 i = { a[i], out[i], inn[i+1], a[i+1] }，天然保证闭合。

import { Vec, CubicSeg, add, sub, mul } from "./geom.js";

export interface Node { a: Vec; out: Vec; inn: Vec }

export function toSegs(nodes: Node[]): CubicSeg[] {
  const n = nodes.length;
  return nodes.map((nd, i) => {
    const nx = nodes[(i + 1) % n];
    return { p0: nd.a, p1: nd.out, p2: nx.inn, p3: nx.a };
  });
}

/** 闭合 Catmull-Rom 转贝塞尔控制柄（C1 平滑） */
export function catmullRomClosed(pts: Vec[]): Node[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const t = mul(sub(next, prev), 1 / 6);
    return { a: p, out: add(p, t), inn: sub(p, t) };
  });
}

/** 圆形（4 段三次贝塞尔逼近，kappa = 4/3·tan(π/8)） */
export function circleNodes(r: number): Node[] {
  const k = 0.5522847498 * r;
  const A: Vec[] = [{ x: r, y: 0 }, { x: 0, y: r }, { x: -r, y: 0 }, { x: 0, y: -r }];
  const T: Vec[] = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }];
  return A.map((a, i) => ({ a, out: add(a, mul(T[i], k)), inn: sub(a, mul(T[i], k)) }));
}

/**
 * 窄腰轮廓（花生形）：极坐标 r(θ) = 85 − 45·cos(2θ)，
 * 腰部半宽 40（θ=0/π 处），上下两个半径约 130 的瓣。
 * 向内偏移超过腰部半宽时会在腰处分裂成两个环。
 */
export function hourglassNodes(): Node[] {
  const N = 12;
  const pts: Vec[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const r = 85 - 45 * Math.cos(2 * th);
    pts.push({ x: r * Math.cos(th), y: r * Math.sin(th) });
  }
  return catmullRomClosed(pts);
}
