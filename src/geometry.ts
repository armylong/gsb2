// 几何核心:环规范化、冲突检测、带孔耳切三角剖分。
// 约定:坐标系无关(canvas y 向下也能用),只要求外环与内环(洞)绕向相反;
// triangulate 内部会统一规范化,因此调用方交换点序/反转绕向不影响结果。

export interface Pt {
  x: number;
  y: number;
}
export type Ring = Pt[];

export interface Tri {
  a: Pt;
  b: Pt;
  c: Pt;
  area: number;
}

const EPS = 1e-9;

/** 有符号面积,正值表示在数学坐标系下逆时针(canvas 下视觉相反,但只需自洽)。 */
export function signedArea(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** 严格交叉(两条边的内部相交,不含端点接触)。 */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  );
}

/** p 是否落在线段 ab 上(含端点,带误差)。 */
export function pointOnSegment(p: Pt, a: Pt, b: Pt): boolean {
  if (Math.abs(cross(a, b, p)) > 1e-7) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < -1e-7) return false;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= len2 + 1e-7;
}

/** 射线法点在环内(边界上的点结果不稳定,调用方应避免)。 */
export function pointInRing(p: Pt, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function samePt(p: Pt, q: Pt): boolean {
  return Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
}

/** 严格在三角形内部(不含边界)。 */
export function pointInTriStrict(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos) && Math.abs(d1) > EPS && Math.abs(d2) > EPS && Math.abs(d3) > EPS;
}

/** 在三角形内或边界上。 */
export function pointInTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

// ---------------------------------------------------------------- 冲突检测

export interface Conflict {
  kind: 'cross' | 'hole-outside' | 'hole-overlap';
  /** 环编号:0 = 外环,1.. = 内环(洞) */
  ringA: number;
  edgeA: number;
  ringB: number;
  /** -1 表示该冲突不涉及具体边(如洞跑到外环外) */
  edgeB: number;
}

function ringEdges(r: Ring): [Pt, Pt][] {
  const edges: [Pt, Pt][] = [];
  for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
  return edges;
}

/**
 * 检测:环自交、环之间互穿、洞跑出外环、洞嵌套洞。
 * 返回空数组表示几何合法,可以三角化。
 */
export function findConflicts(outer: Ring, holes: Ring[]): Conflict[] {
  const rings = [outer, ...holes];
  const conflicts: Conflict[] = [];

  for (let r = 0; r < rings.length; r++) {
    for (let s = r; s < rings.length; s++) {
      const A = rings[r];
      const B = rings[s];
      for (let i = 0; i < A.length; i++) {
        for (let j = 0; j < B.length; j++) {
          if (r === s) {
            if (j <= i) continue;
            if (j === i + 1) continue; // 相邻边共享端点,不算自交
            if (i === 0 && j === A.length - 1) continue;
          }
          const a1 = A[i];
          const a2 = A[(i + 1) % A.length];
          const b1 = B[j];
          const b2 = B[(j + 1) % B.length];
          if (segmentsCross(a1, a2, b1, b2)) {
            conflicts.push({ kind: 'cross', ringA: r, edgeA: i, ringB: s, edgeB: j });
          } else if (
            r !== s &&
            (pointOnSegment(a1, b1, b2) || pointOnSegment(b1, a1, a2))
          ) {
            // 一个环的顶点压在另一个环的边上,也算冲突
            conflicts.push({ kind: 'cross', ringA: r, edgeA: i, ringB: s, edgeB: j });
          }
        }
      }
    }
  }

  holes.forEach((h, hi) => {
    if (h.length > 0 && !pointInRing(h[0], outer)) {
      conflicts.push({ kind: 'hole-outside', ringA: hi + 1, edgeA: 0, ringB: 0, edgeB: -1 });
    }
  });
  holes.forEach((h, hi) => {
    holes.forEach((g, gi) => {
      if (gi !== hi && h.length > 0 && pointInRing(h[0], g)) {
        conflicts.push({ kind: 'hole-overlap', ringA: hi + 1, edgeA: 0, ringB: gi + 1, edgeB: -1 });
      }
    });
  });

  return conflicts;
}

// ---------------------------------------------------------------- 三角剖分

/** 判断线段 M-V 是否不与 poly/hole 的任何边相交(用于架桥)。 */
function bridgeVisible(M: Pt, V: Pt, poly: Ring, hole: Ring, k: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (i === k || (i + 1) % poly.length === k) continue;
    if (segmentsCross(M, V, poly[i], poly[(i + 1) % poly.length])) return false;
  }
  for (let i = 0; i < hole.length; i++) {
    const a = hole[i];
    const b = hole[(i + 1) % hole.length];
    if (samePt(a, M) || samePt(b, M)) continue;
    if (segmentsCross(M, V, a, b)) return false;
  }
  return true;
}

/**
 * 把洞桥接到主多边形上:取洞上 x 最大的顶点 M,
 * 在主多边形上找一个可见顶点 V,沿 M->洞一周->M->V 缝合。
 */
function bridgeHole(poly: Ring, hole: Ring): Ring {
  let m = 0;
  for (let i = 1; i < hole.length; i++) {
    if (hole[i].x > hole[m].x || (hole[i].x === hole[m].x && hole[i].y < hole[m].y)) m = i;
  }
  const M = hole[m];

  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < poly.length; k++) {
    if (!bridgeVisible(M, poly[k], poly, hole, k)) continue;
    const d = (poly[k].x - M.x) ** 2 + (poly[k].y - M.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best < 0) {
    // 理论上合法几何必有可见点;兜底取最近点,避免崩溃
    for (let k = 0; k < poly.length; k++) {
      const d = (poly[k].x - M.x) ** 2 + (poly[k].y - M.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
  }
  const k = best;
  const V = poly[k];

  const rot: Pt[] = [];
  for (let i = 0; i < hole.length; i++) rot.push(hole[(m + i) % hole.length]);

  return [
    ...poly.slice(0, k + 1),
    ...rot,
    { x: M.x, y: M.y },
    { x: V.x, y: V.y },
    ...poly.slice(k + 1),
  ];
}

/** 耳切法,返回 poly 下标三元组。poly 必须为简单多边形(洞已桥接)。 */
function earClip(poly: Ring): [number, number, number][] {
  const idx: number[] = poly.map((_, i) => i);
  const tris: [number, number, number][] = [];
  const ccw = signedArea(poly) > 0;
  let guard = 0;

  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = poly[i0];
      const b = poly[i1];
      const c = poly[i2];
      const cr = cross(a, b, c);
      if (ccw ? cr <= EPS : cr >= -EPS) continue; // 凹角或退化,不是耳

      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = poly[j];
        // 架桥产生的重复点不算"在耳内"
        if (samePt(p, a) || samePt(p, b) || samePt(p, c)) continue;
        if (pointInTriStrict(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      tris.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // 退化输入,放弃
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/**
 * 带孔三角剖分。
 * - 自动规范化绕向:外环统一为正面积方向,洞统一为反方向;
 *   因此调用方交换/反转点序,结果仍覆盖同一区域。
 * - 调用前请先用 findConflicts 确认几何合法。
 */
export function triangulate(outerIn: Ring, holesIn: Ring[]): Tri[] {
  if (outerIn.length < 3) return [];
  const outer = signedArea(outerIn) > 0 ? outerIn.slice() : outerIn.slice().reverse();
  const holes = holesIn
    .filter((h) => h.length >= 3)
    .map((h) => (signedArea(h) < 0 ? h.slice() : h.slice().reverse()));

  let poly = outer.slice();
  // x 最大顶点靠右的洞先桥接,避免桥穿过未处理的洞
  const sorted = holes
    .map((h) => ({ h, mx: Math.max(...h.map((p) => p.x)) }))
    .sort((p, q) => q.mx - p.mx)
    .map((o) => o.h);
  for (const hole of sorted) poly = bridgeHole(poly, hole);

  return earClip(poly).map(([i, j, k]) => {
    const a = poly[i];
    const b = poly[j];
    const c = poly[k];
    return { a, b, c, area: Math.abs(signedArea([a, b, c])) };
  });
}

/** 期望面积 = |外环| - Σ|洞| */
export function expectedArea(outer: Ring, holes: Ring[]): number {
  return (
    Math.abs(signedArea(outer)) -
    holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0)
  );
}

export function ringEdgesOf(outer: Ring, holes: Ring[]): { ring: number; edge: number; a: Pt; b: Pt }[] {
  const out: { ring: number; edge: number; a: Pt; b: Pt }[] = [];
  [outer, ...holes].forEach((r, ri) => {
    ringEdges(r).forEach(([a, b], ei) => out.push({ ring: ri, edge: ei, a, b }));
  });
  return out;
}
