// geom.ts — 平面几何核心：三次贝塞尔自适应采样、法线偏移、自交检测与清理。
// 该文件不依赖 DOM，可同时被浏览器端 (app.ts) 和 Node 端验证脚本 (verify.ts) 使用。

export interface Vec { x: number; y: number }

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const normalize = (a: Vec): Vec => {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
/** 单位切向的右法线 */
export const rightNormal = (t: Vec): Vec => ({ x: t.y, y: -t.x });
/** 单位切向的左法线 */
export const leftNormal = (t: Vec): Vec => ({ x: -t.y, y: t.x });

// ---------------------------------------------------------------- 三次贝塞尔

export interface CubicSeg { p0: Vec; p1: Vec; p2: Vec; p3: Vec }

export function evalCubic(s: CubicSeg, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * s.p0.x + b * s.p1.x + c * s.p2.x + d * s.p3.x,
    y: a * s.p0.y + b * s.p1.y + c * s.p2.y + d * s.p3.y,
  };
}

export function derivCubic(s: CubicSeg, t: number): Vec {
  const u = 1 - t;
  return {
    x: 3 * u * u * (s.p1.x - s.p0.x) + 6 * u * t * (s.p2.x - s.p1.x) + 3 * t * t * (s.p3.x - s.p2.x),
    y: 3 * u * u * (s.p1.y - s.p0.y) + 6 * u * t * (s.p2.y - s.p1.y) + 3 * t * t * (s.p3.y - s.p2.y),
  };
}

function splitCubic(s: CubicSeg): [CubicSeg, CubicSeg] {
  const m01 = mul(add(s.p0, s.p1), 0.5);
  const m12 = mul(add(s.p1, s.p2), 0.5);
  const m23 = mul(add(s.p2, s.p3), 0.5);
  const m012 = mul(add(m01, m12), 0.5);
  const m123 = mul(add(m12, m23), 0.5);
  const m0123 = mul(add(m012, m123), 0.5);
  return [
    { p0: s.p0, p1: m01, p2: m012, p3: m0123 },
    { p0: m0123, p1: m123, p2: m23, p3: s.p3 },
  ];
}

// ---------------------------------------------------------------- 自适应采样

export interface Sample { p: Vec; tan: Vec /* 单位切向 */ }

function subdiv(s: CubicSeg, t0: number, t1: number, tol: number, depth: number, ts: number[]): void {
  const chord = sub(s.p3, s.p0);
  const cl = len(chord);
  let d1: number, d2: number;
  if (cl < 1e-9) {
    d1 = dist(s.p1, s.p0);
    d2 = dist(s.p2, s.p3);
  } else {
    d1 = Math.abs(cross(chord, sub(s.p1, s.p0))) / cl;
    d2 = Math.abs(cross(chord, sub(s.p2, s.p0))) / cl;
  }
  if (depth >= 20 || Math.max(d1, d2) <= tol) {
    ts.push(t1);
    return;
  }
  const tm = (t0 + t1) / 2;
  const [a, b] = splitCubic(s);
  subdiv(a, t0, tm, tol, depth + 1, ts);
  subdiv(b, tm, t1, tol, depth + 1, ts);
}

/**
 * 把闭合三次样条（段 i 的 p3 与段 i+1 的 p0 重合）按弦高误差 tol 自适应采样。
 * 返回采样点（不重复闭合点），接缝处切向取两侧平均以保证法线平滑。
 */
export function sampleSpline(segs: CubicSeg[], tol: number): Sample[] {
  const out: Sample[] = [];
  const joints: number[] = [];
  const endTans: Vec[] = [];
  for (const s of segs) {
    const ts: number[] = [0];
    subdiv(s, 0, 1, tol, 0, ts);
    joints.push(out.length);
    for (let k = 0; k < ts.length - 1; k++) {
      const t = ts[k];
      out.push({ p: evalCubic(s, t), tan: normalize(derivCubic(s, t)) });
    }
    endTans.push(normalize(derivCubic(s, 1)));
  }
  const m = segs.length;
  for (let j = 0; j < m; j++) {
    const idx = joints[j];
    const tPrev = endTans[(j - 1 + m) % m];
    out[idx].tan = normalize(add(tPrev, out[idx].tan));
  }
  return out;
}

export function signedArea(pts: Vec[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// ---------------------------------------------------------------- 距离索引

export function distPointSeg(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-18) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

/** 闭合折线的最近距离查询（均匀网格加速） */
export class PolylineIndex {
  private pts: Vec[];
  private cell: number;
  private grid: Map<string, number[]> = new Map();

  constructor(pts: Vec[]) {
    this.pts = pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const area = Math.max((maxX - minX) * (maxY - minY), 1);
    this.cell = Math.max(Math.sqrt(area / Math.max(pts.length, 1)), 1e-3);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const x0 = Math.floor(Math.min(a.x, b.x) / this.cell);
      const x1 = Math.floor(Math.max(a.x, b.x) / this.cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / this.cell);
      const y1 = Math.floor(Math.max(a.y, b.y) / this.cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = cx + ":" + cy;
          let arr = this.grid.get(key);
          if (!arr) { arr = []; this.grid.set(key, arr); }
          arr.push(i);
        }
      }
    }
  }

  dist(p: Vec): number {
    const n = this.pts.length;
    const cx = Math.floor(p.x / this.cell);
    const cy = Math.floor(p.y / this.cell);
    let best = Infinity;
    for (let ring = 0; ring < 1024; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const ids = this.grid.get((cx + dx) + ":" + (cy + dy));
          if (!ids) continue;
          for (const i of ids) {
            const d = distPointSeg(p, this.pts[i], this.pts[(i + 1) % n]);
            if (d < best) best = d;
          }
        }
      }
      // 未搜索的格子与 p 的距离至少为 ring*cell，可以安全停止
      if (best < Infinity && ring * this.cell >= best) break;
    }
    if (best === Infinity) {
      for (let i = 0; i < n; i++) best = Math.min(best, distPointSeg(p, this.pts[i], this.pts[(i + 1) % n]));
    }
    return best;
  }
}

// ---------------------------------------------------------------- 线段求交

export function segSeg(p: Vec, p2: Vec, q: Vec, q2: Vec): { t: number; s: number; p: Vec } | null {
  const r = sub(p2, p), s = sub(q2, q);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(q, p);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  const tc = Math.max(0, Math.min(1, t));
  return { t: tc, s: Math.max(0, Math.min(1, u)), p: add(p, mul(r, tc)) };
}

/** 射线 p + t*dir (t>=0) 与线段 ab 的交点参数 t，无交返回 null */
export function raySegT(p: Vec, dir: Vec, a: Vec, b: Vec): number | null {
  const s = sub(b, a);
  const den = cross(dir, s);
  if (Math.abs(den) < 1e-12) return null;
  const ap = sub(a, p);
  const t = cross(ap, s) / den;
  const u = cross(ap, dir) / den;
  if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) return t;
  return null;
}

export interface Intersection { i: number; t: number; j: number; s: number; p: Vec }

/** 闭合折线的全部自交点（跳过相邻线段，网格加速） */
export function selfIntersections(pts: Vec[]): Intersection[] {
  const n = pts.length;
  const res: Intersection[] = [];
  if (n < 4) return res;

  let avg = 0;
  for (let i = 0; i < n; i++) avg += dist(pts[i], pts[(i + 1) % n]);
  const cell = Math.max((avg / n) * 4, 1e-6);

  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const x0 = Math.floor(Math.min(a.x, b.x) / cell);
    const x1 = Math.floor(Math.max(a.x, b.x) / cell);
    const y0 = Math.floor(Math.min(a.y, b.y) / cell);
    const y1 = Math.floor(Math.max(a.y, b.y) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx + ":" + cy;
        let arr = grid.get(key);
        if (!arr) { arr = []; grid.set(key, arr); }
        arr.push(i);
      }
    }
  }

  const tested = new Set<number>();
  for (const ids of grid.values()) {
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = Math.min(ids[a], ids[b]);
        const j = Math.max(ids[a], ids[b]);
        const key = i * n + j;
        if (tested.has(key)) continue;
        tested.add(key);
        if (j === i + 1 || (i === 0 && j === n - 1)) continue; // 相邻段
        const hit = segSeg(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]);
        if (hit) res.push({ i, t: hit.t, j, s: hit.s, p: hit.p });
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------- 偏移与清理

export interface OffsetResult {
  raw: Vec[];            // 原始偏移折线（未清理）
  ints: Intersection[];  // 全部自交点
  loops: Vec[][];        // 清理后的有效闭合轮廓（可能多条 = 分裂，可能为空）
}

/**
 * 清理原始偏移折线：
 * 1. 找出全部自交点并在此切断；
 * 2. 对每个子段，用“到原轮廓的距离必须 ≈ |d|”这一真实几何判据裁剪
 *    （凹处塌缩/越过中轴的部分到原轮廓的距离会小于 |d|，被丢弃）；
 * 3. 剩余有向边按“最直前行”规则接成闭合环，丢弃开口链、
 *    面积过小的环以及方向与原轮廓相反的环（内缩过度产生的反向环）。
 */
export function cleanOffset(
  raw: Vec[],
  original: Vec[],
  d: number,
  tol: number,
  orientSign: number
): OffsetResult {
  const n = raw.length;
  const ad = Math.abs(d);
  const ints = selfIntersections(raw);

  const cuts: { t: number; p: Vec }[][] = Array.from({ length: n }, () => []);
  for (const it of ints) {
    cuts[it.i].push({ t: it.t, p: it.p });
    cuts[it.j].push({ t: it.s, p: it.p });
  }

  const vid = new Map<Vec, number>();
  const verts: Vec[] = [];
  const getId = (p: Vec): number => {
    let id = vid.get(p);
    if (id === undefined) { id = verts.length; verts.push(p); vid.set(p, id); }
    return id;
  };

  const index = new PolylineIndex(original);
  const trimTol = Math.max(2 * tol, 0.75);
  const edges: { a: number; b: number }[] = [];

  for (let i = 0; i < n; i++) {
    const pts = [{ t: 0, p: raw[i] }, ...cuts[i].sort((x, y) => x.t - y.t), { t: 1, p: raw[(i + 1) % n] }];
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k].p, B = pts[k + 1].p;
      const m = mul(add(A, B), 0.5);
      if (index.dist(m) >= ad - trimTol) edges.push({ a: getId(A), b: getId(B) });
    }
  }

  // 裁剪边界未必恰好落在交点上，会留下少许“尾巴”死端边。
  // 反复删除通向出度为 0 顶点的边，直到只剩属于闭合分量的边。
  const alive = new Uint8Array(edges.length).fill(1);
  for (;;) {
    const outDeg = new Map<number, number>();
    for (let i = 0; i < edges.length; i++) {
      if (alive[i]) outDeg.set(edges[i].a, (outDeg.get(edges[i].a) ?? 0) + 1);
    }
    let pruned = 0;
    for (let i = 0; i < edges.length; i++) {
      if (alive[i] && !outDeg.has(edges[i].b)) { alive[i] = 0; pruned++; }
    }
    if (pruned === 0) break;
  }

  const out: Map<number, number[]> = new Map();
  edges.forEach((e, idx) => {
    if (!alive[idx]) return;
    let arr = out.get(e.a);
    if (!arr) { arr = []; out.set(e.a, arr); }
    arr.push(idx);
  });

  const used = new Uint8Array(edges.length);
  for (let i = 0; i < edges.length; i++) if (!alive[i]) used[i] = 1;
  const loops: Vec[][] = [];
  const dirOf = (e: { a: number; b: number }): Vec => normalize(sub(verts[e.b], verts[e.a]));
  const areaEps = Math.max(2, tol * 2);

  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    const chain: number[] = [edges[s].a];
    const seen = new Set<number>(chain);
    used[s] = 1;
    let cur = s;
    let closed = false;
    for (let step = 0; step <= edges.length; step++) {
      const v = edges[cur].b;
      chain.push(v);
      if (v === chain[0]) { closed = true; break; }
      if (seen.has(v)) break; // 回到链中间：病态，丢弃
      seen.add(v);
      const cands = (out.get(v) ?? []).filter((ei) => !used[ei]);
      if (cands.length === 0) break;
      const din = dirOf(edges[cur]);
      let best = cands[0], bestAng = Infinity;
      for (const ei of cands) {
        const d2 = dirOf(edges[ei]);
        const ang = Math.abs(Math.atan2(cross(din, d2), dot(din, d2)));
        if (ang < bestAng) { bestAng = ang; best = ei; }
      }
      used[best] = 1;
      cur = best;
    }
    if (closed) {
      const pts = chain.slice(0, -1).map((id) => verts[id]);
      if (pts.length >= 3) {
        const area = signedArea(pts);
        if (Math.abs(area) > areaEps && Math.sign(area) === orientSign) loops.push(pts);
      }
    }
  }

  return { raw, ints, loops };
}
