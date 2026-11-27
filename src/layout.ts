/**
 * Weighted (power) Voronoi partition clipped to the window frame.
 *
 * A point i owns exactly the locations x where
 *
 *     |x - p_i|² - w_i  <=  |x - p_j|² - w_j   for every other point j
 *
 * which is the intersection of half-planes
 *
 *     (p_j - p_i) · x  <=  (|p_j|² - |p_i|² + w_i - w_j) / 2.
 *
 * Equal weights give the ordinary Voronoi diagram. Raising w_i moves the seam
 * with j by  Δw / (2·|p_i - p_j|)  millimetres toward j — a linear, exactly
 * predictable shift, which is what the "seam push" overlay reports.
 *
 * Cells are convex, so they are built by half-plane clipping and only then
 * intersected with the (possibly concave) frame. A deep notch can therefore
 * cut one numbered pane into several disjoint pieces without ever bridging
 * the notch void.
 */

import {
  clipHalfPlane,
  cleanRing,
  dist,
  frameBoundaryDistance,
  intersectWithFrame,
  isStrictlyInsideRect,
  notchVoidRect,
  pointInMultiPoly,
  pointInRing,
  polyArea,
  poleOfInaccessibility,
  ringBBox,
  ringAreaAbs,
  pt,
} from './geometry';
import type {
  Diagnostic,
  FrameSpec,
  Layout,
  LayoutEdge,
  LayoutStats,
  MultiPoly,
  Piece,
  PointSpec,
  Pt,
  QueryResult,
  Ring,
} from './types';

/** Half-width of the "practically on the seam" band, in millimetres. */
export const TIE_BAND_MM = 0.35;
/** Two points closer than this fraction of the frame's short side are flagged. */
export const CLOSE_FRACTION = 0.03;
/** Relative area mismatch tolerated before reporting a warning. */
export const AREA_REL_TOL = 1e-7;

const COINCIDENT_EPS = 1e-6;
const WEIGHT_EPS = 1e-9;

/** Build a box covering the frame and every site, to start convex cell clipping. */
function clipBox(frame: FrameSpec, sites: PointSpec[]): Ring {
  const b = ringBBox(frame.ring);
  for (const s of sites) {
    if (s.x < b.minX) b.minX = s.x;
    if (s.y < b.minY) b.minY = s.y;
    if (s.x > b.maxX) b.maxX = s.x;
    if (s.y > b.maxY) b.maxY = s.y;
  }
  const pad = Math.max(10, Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.1);
  return [
    pt(b.minX - pad, b.minY - pad),
    pt(b.maxX + pad, b.minY - pad),
    pt(b.maxX + pad, b.maxY + pad),
    pt(b.minX - pad, b.maxY + pad),
  ];
}

interface CellResult {
  multipoly: MultiPoly;
  empty: boolean;
  reason: string | null;
  dominator: number | null;
}

/**
 * Convex power cell of point `i`, clipped to the frame.
 * Deterministic in three degenerate cases:
 *  - coincident sites with different weights → the lighter one owns nothing;
 *  - exactly coincident sites with equal weights → the lower id keeps the area;
 *  - a site pushed entirely out of its own cell → empty (surrounded / dominated).
 */
function computeCell(
  i: number,
  sites: PointSpec[],
  frame: FrameSpec,
  baseBox: Ring,
): CellResult {
  const self = sites[i]!;
  let ring: Ring | null = baseBox.slice();
  let empty = false;
  let dominator: number | null = null;

  for (let j = 0; j < sites.length && ring; j++) {
    if (j === i) continue;
    const other = sites[j]!;
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    const d2 = dx * dx + dy * dy;
    const dw = self.weight - other.weight;

    if (d2 <= COINCIDENT_EPS * COINCIDENT_EPS) {
      // Constraint degenerates to  0 <= dw.
      if (dw < -WEIGHT_EPS) {
        empty = true;
        dominator = other.id;
        ring = null;
        break;
      }
      if (dw <= WEIGHT_EPS) {
        // Exactly tied: lowest id wins, higher ids surrender.
        if (self.id > other.id) {
          empty = true;
          dominator = other.id;
          ring = null;
          break;
        }
      }
      // dw > 0 or tied lower id: constraint imposed by j is vacuous.
      continue;
    }

    const n = pt(dx, dy);
    const d =
      (other.x * other.x + other.y * other.y - self.x * self.x - self.y * self.y + dw) / 2;
    const clipped = clipHalfPlane(ring, n, d);
    if (!clipped) {
      empty = true;
      dominator = other.id;
      ring = null;
      break;
    }
    ring = clipped;
  }

  if (empty || !ring) return { multipoly: [], empty: true, reason: 'dominated', dominator };

  const mp = intersectWithFrame(ring, frame);
  const area = mp.reduce((s, p) => s + polyArea(p), 0);
  if (mp.length === 0 || area <= 1e-7) {
    return { multipoly: [], empty: true, reason: 'no-area', dominator: null };
  }
  return { multipoly: mp, empty: false, reason: null, dominator: null };
}

export function frameArea(frame: FrameSpec): number {
  return ringAreaAbs(cleanRing(frame.ring));
}

interface RawEdge {
  pieceId: number;
  a: Pt;
  b: Pt;
  kind: 'frame' | 'shared';
  otherId: number | null;
}

/**
 * Classify the boundary edges of each pane by probing a point on either side of
 * each edge midpoint: one side outside the frame means a frame edge, two
 * different pane ids means a shared seam. If an edge ever straddles more than
 * two owners (should not happen for a proper partition) it is split in half.
 */
function collectEdges(pieces: Piece[], frame: FrameSpec): RawEdge[] {
  const ownerOf = (p: Pt, skip: number): number | null => {
    for (const piece of pieces) {
      if (piece.id === skip || piece.polygons.length === 0) continue;
      if (pointInMultiPoly(p, piece.polygons)) return piece.id;
    }
    // Fall back to checking the skipped piece (point-in-poly can miss boundary-adjacent points).
    const skipped = pieces.find((pc) => pc.id === skip);
    if (skipped && skipped.polygons.length > 0 && pointInMultiPoly(p, skipped.polygons)) {
      return skipped.id;
    }
    return null;
  };

  const edges: RawEdge[] = [];
  for (const piece of pieces) {
    if (piece.polygons.length === 0) continue;
    for (const poly of piece.polygons) {
      for (const ring of poly) {
        const n = ring.length;
        for (let k = 0; k < n; k++) {
          const a = ring[k]!;
          const b = ring[(k + 1) % n]!;
          const len = dist(a, b);
          if (len < 1e-6) continue;
          classifyEdge(piece.id, a, b, len, frame, ownerOf, edges, 0);
        }
      }
    }
  }
  return edges;
}

function classifyEdge(
  pieceId: number,
  a: Pt,
  b: Pt,
  len: number,
  frame: FrameSpec,
  ownerOf: (p: Pt, skip: number) => number | null,
  out: RawEdge[],
  depth: number,
): void {
  const mid = pt((a.x + b.x) / 2, (a.y + b.y) / 2);
  const tx = (b.x - a.x) / len;
  const ty = (b.y - a.y) / len;
  const n = pt(-ty, tx);
  // A probe small enough not to skip over a neighbouring sliver, but large
  // enough to beat floating-point noise.
  const eps = Math.min(0.3, Math.max(0.02, len * 0.05));
  const p1 = pt(mid.x + n.x * eps, mid.y + n.y * eps);
  const p2 = pt(mid.x - n.x * eps, mid.y - n.y * eps);
  const in1 = pointInRing(p1, frame.ring);
  const in2 = pointInRing(p2, frame.ring);
  const o1 = in1 ? ownerOf(p1, pieceId) : null;
  const o2 = in2 ? ownerOf(p2, pieceId) : null;

  // Multiple owners on either side indicates the edge straddles a junction;
  // split and retry (bounded).
  if ((o1 !== null && o1 !== pieceId) || (o2 !== null && o2 !== pieceId)) {
    if (depth < 6) {
      const m = pt((a.x + b.x) / 2, (a.y + b.y) / 2);
      classifyEdge(pieceId, a, m, dist(a, m), frame, ownerOf, out, depth + 1);
      classifyEdge(pieceId, m, b, dist(m, b), frame, ownerOf, out, depth + 1);
      return;
    }
  }

  if (in1 !== in2) {
    // Exactly one side is outside the window → frame boundary.
    out.push({ pieceId, a, b, kind: 'frame', otherId: null });
    return;
  }
  if (in1 && in2) {
    const pa = o1 === pieceId ? o2 : o1;
    if (pa !== null && pa !== pieceId) {
      out.push({ pieceId, a, b, kind: 'shared', otherId: pa });
      return;
    }
    // Same owner both sides: this edge is not a real boundary (numerical overlap);
    // treat it as a frame edge only if it lies on the frame ring, else skip.
    if (p1 && p2) {
      const { distance } = frameBoundaryDistance(mid, frame);
      if (distance < 1e-4) {
        out.push({ pieceId, a, b, kind: 'frame', otherId: null });
        return;
      }
    }
    return;
  }
  // Both probes outside: the edge is part of the frame ring.
  out.push({ pieceId, a, b, kind: 'frame', otherId: null });
}

function mergeEdges(raw: RawEdge[]): RawEdge[] {
  // Merge consecutive collinear edges belonging to the same pair/kind inside one
  // piece's ring traversal. Raw edges are pushed in ring order per piece.
  const merged: RawEdge[] = [];
  for (const e of raw) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.pieceId === e.pieceId &&
      last.kind === e.kind &&
      last.otherId === e.otherId &&
      collinear(last, e)
    ) {
      last.b = e.b;
    } else {
      merged.push({ ...e, a: pt(e.a.x, e.a.y), b: pt(e.b.x, e.b.y) });
    }
  }
  return merged;
}

function collinear(e1: RawEdge, e2: RawEdge): boolean {
  if (dist(e1.b, e2.a) > 1e-6) return false;
  const t1x = e1.b.x - e1.a.x;
  const t1y = e1.b.y - e1.a.y;
  const t2x = e2.b.x - e2.a.x;
  const t2y = e2.b.y - e2.a.y;
  const cross = t1x * t2y - t1y * t2x;
  const l1 = Math.hypot(t1x, t1y);
  const l2 = Math.hypot(t2x, t2y);
  return Math.abs(cross) <= 1e-6 * l1 * l2 + 1e-9 && t1x * t2x + t1y * t2y > 0;
}

function toLayoutEdges(raw: RawEdge[], points: PointSpec[]): LayoutEdge[] {
  const site = new Map(points.map((p) => [p.id, p] as const));
  return raw
    .map((e) => {
      const len = dist(e.a, e.b);
      const mid = pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
      let normal = pt(-(e.b.y - e.a.y) / (len || 1), (e.b.x - e.a.x) / (len || 1));
      let seam: LayoutEdge['seam'];
      if (e.kind === 'shared' && e.otherId !== null) {
        const si = site.get(e.pieceId);
        const sj = site.get(e.otherId);
        if (si && sj) {
          const d = dist(si, sj);
          const offset = d > 1e-9 ? (si.weight - sj.weight) / (2 * d) : 0;
          // Orient normal from i toward j, so arrows point "where the seam goes"
          // when i gains weight.
          const toward = pt((sj.x - si.x) / (d || 1), (sj.y - si.y) / (d || 1));
          if (normal.x * toward.x + normal.y * toward.y < 0) {
            normal = pt(-normal.x, -normal.y);
          }
          seam = {
            equalWeightOffsetMm: offset,
            shiftTowardJ: offset,
            nearTie: Math.abs(offset) < 1e-4,
          };
        }
      }
      return {
        pieceId: e.pieceId,
        a: e.a,
        b: e.b,
        length: len,
        kind: e.kind,
        otherId: e.otherId,
        mid,
        normal,
        ...(seam ? { seam } : {}),
      } satisfies LayoutEdge;
    })
    .filter((e) => e.length > 1e-6);
}

export function computeLayout(frame: FrameSpec, pointsRaw: PointSpec[]): Layout {
  const points = pointsRaw.map((p) => ({ ...p }));
  const baseBox = clipBox(frame, points);

  const pieces: Piece[] = points.map((p, i) => {
    const cell = computeCell(i, points, frame, baseBox);
    const anchors = cell.multipoly.map((poly) => poleOfInaccessibility(poly));
    const area = cell.multipoly.reduce((s, poly) => s + polyArea(poly), 0);
    return {
      id: p.id,
      polygons: cell.multipoly,
      area,
      parts: cell.multipoly.length,
      labelAnchors: anchors,
    } satisfies Piece;
  });

  const rawEdges = mergeEdges(collectEdges(pieces, frame));
  const edges = toLayoutEdges(rawEdges, points);

  const fa = frameArea(frame);
  const total = pieces.reduce((s, p) => s + p.area, 0);
  const difference = fa - total;
  const stats: LayoutStats = {
    frameArea: fa,
    pieceAreaTotal: total,
    difference,
    relativeDifference: fa > 0 ? Math.abs(difference) / fa : 0,
    exact: fa > 0 && Math.abs(difference) <= Math.max(fa * AREA_REL_TOL, 1e-6),
    pieceCount: pieces.length,
    emptyPieceIds: pieces.filter((p) => p.parts === 0).map((p) => p.id),
    partCount: pieces.reduce((s, p) => s + p.parts, 0),
  };

  const diagnostics = buildDiagnostics(frame, points, pieces, stats);

  const bbox = ringBBox(frame.ring);
  return {
    frame,
    points,
    pieces,
    edges,
    diagnostics,
    stats,
    bbox,
    input: { frame: cloneFrame(frame), points: points.map((p) => ({ ...p })) },
  };
}

export function cloneFrame(frame: FrameSpec): FrameSpec {
  return {
    ...frame,
    ring: frame.ring.map((p) => ({ ...p })),
    ...(frame.notch ? { notch: { ...frame.notch } } : {}),
  };
}

function buildDiagnostics(
  frame: FrameSpec,
  points: PointSpec[],
  pieces: Piece[],
  stats: LayoutStats,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const shortSide = Math.min(frame.width, frame.height);
  const closeThreshold = Math.max(6, shortSide * CLOSE_FRACTION);
  const notch = notchVoidRect(frame);

  for (const p of points) {
    const b = frameBoundaryDistance(p, frame);
    if (!b.inside) {
      out.push({
        severity: 'error',
        code: 'point-outside-frame',
        pointIds: [p.id],
        message: `点 #${p.id} 在外框之外`,
        detail: `该点位于外框外 ${b.distance.toFixed(1)} mm，只保留落在窗口内的那部分地盘。`,
      });
    }
    if (notch && isStrictlyInsideRect(p, notch)) {
      out.push({
        severity: 'error',
        code: 'point-in-notch',
        pointIds: [p.id],
        message: `点 #${p.id} 落在凹口空腔里`,
        detail: '凹口是缺口，不是玻璃；该点能拥有的窗口面积为零。',
      });
    }
  }

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const d = dist(a, b);
      if (d <= COINCIDENT_EPS) {
        out.push({
          severity: 'warning',
          code: 'coincident-points',
          pointIds: [a.id, b.id],
          message: `点 #${a.id} 与 #${b.id} 几乎重合`,
          detail:
            '两点重合时等权无法分出唯一归属；权重不同时权重大者吞并，权重相同时编号小者保留、编号大者地盘为零。',
        });
      } else if (d < closeThreshold) {
        out.push({
          severity: 'warning',
          code: 'points-too-close',
          pointIds: [a.id, b.id],
          message: `点 #${a.id} 与 #${b.id} 距离仅 ${d.toFixed(1)} mm`,
          detail: `两点过近（阈值 ${closeThreshold.toFixed(1)} mm），它们之间的接缝会很窄，分量小幅变化就能让接缝移动很大一段距离。`,
        });
      }
    }
  }

  for (const piece of pieces) {
    if (piece.parts > 0) continue;
    const site = points.find((p) => p.id === piece.id)!;
    const best = otherBest(points, piece.id);
    let reason: string;
    let extra: string;
    if (best && best.margin < 0) {
      reason = `被 #${best.id} 压过`;
      extra =
        `在 #${piece.id} 自己的位置上，#${best.id} 的功率距离还短 ${(-best.margin).toFixed(0)} mm²` +
        `（点距 ${dist(site, best.point).toFixed(1)} mm，分量差 ${(best.point.weight - site.weight).toFixed(0)} mm²）。`;
    } else {
      reason = '被四周邻点夹没';
      extra = '所有邻点的半平面约束把它的地盘切成了空集。';
    }
    out.push({
      severity: 'error',
      code: 'empty-territory',
      pointIds: [piece.id],
      message: `点 #${piece.id} 完全挤不出地盘（${reason}）`,
      detail: `${extra} 提高它的分量或拉开与邻点的距离即可恢复。`,
    });
  }

  if (!stats.exact) {
    out.push({
      severity: 'warning',
      code: 'area-mismatch',
      pointIds: [],
      message: '各分件面积之和与外框面积不一致',
      detail: `外框 ${stats.frameArea.toFixed(3)} mm²，分件合计 ${stats.pieceAreaTotal.toFixed(3)} mm²，差 ${stats.difference.toFixed(6)} mm²。这是浮点裁剪残差，导出前可核对。`,
    });
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function otherBest(
  points: PointSpec[],
  id: number,
): { id: number; point: PointSpec; margin: number } | null {
  const site = points.find((p) => p.id === id);
  if (!site) return null;
  let best: { id: number; point: PointSpec; margin: number } | null = null;
  for (const q of points) {
    if (q.id === id) continue;
    const d = dist(site, q);
    // Difference of power distances at the site's own coordinates:
    //   power_q(site) - power_self(site) = d² - w_q + w_self.
    // Negative means q would take the site's own location (it dominates).
    const margin = d * d - q.weight + site.weight;
    if (!best || margin < best.margin) best = { id: q.id, point: q, margin };
  }
  return best;
}

/**
 * Which pane owns a world location, with a deterministic near-seam readout.
 *
 * `gapMm` is the perpendicular distance to the nearest competing seam — exact,
 * because the power difference is linear. Inside `bandMm` the two candidates
 * are reported as a tie and resolved by the lower id, so cursor jitter never
 * flickers between owners: a location on (or almost on) a seam always names the
 * same pane.
 */
export function queryPoint(
  layout: Layout,
  x: number,
  y: number,
  bandMm = TIE_BAND_MM,
): QueryResult {
  const pts = layout.points;
  if (pts.length === 0) return { id: null, gapMm: Infinity, tie: false, runnerUp: null };
  const inside = pointInRing(pt(x, y), layout.frame.ring);
  if (!inside) return { id: null, gapMm: Infinity, tie: false, runnerUp: null };

  // Power distance per site, then a total order by (power, id) so equal powers
  // resolve to the lower id deterministically.
  let first: PointSpec | null = null;
  let second: PointSpec | null = null;
  let firstV = Infinity;
  let secondV = Infinity;
  for (const p of pts) {
    const v = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y) - p.weight;
    if (
      v < firstV ||
      (v === firstV && first !== null && p.id < first.id)
    ) {
      second = first;
      secondV = firstV;
      first = p;
      firstV = v;
    } else if (v < secondV) {
      second = p;
      secondV = v;
    }
  }
  if (!first) return { id: null, gapMm: Infinity, tie: false, runnerUp: null };
  if (!second) return { id: first.id, gapMm: Infinity, tie: false, runnerUp: null };

  const d = dist(first, second);
  const gapMm = d > 1e-9 ? (secondV - firstV) / (2 * d) : 0;
  const tie = Math.abs(gapMm) <= bandMm;
  // Inside the band the two owners are treated as simultaneous; naming the lower
  // id makes the answer constant across the whole band, so sub-pixel jitter near
  // a seam cannot flip the displayed number.
  const id = tie ? Math.min(first.id, second.id) : first.id;
  return { id, gapMm: Math.max(gapMm, 0), tie, runnerUp: second.id };
}

/** Seam movement for `id` if its weight grows by `deltaW` mm². */
export function seamForecast(
  layout: Layout,
  id: number,
  deltaW: number,
): { otherId: number; distanceMm: number; currentMm: number; predictedMm: number }[] {
  const site = layout.points.find((p) => p.id === id);
  if (!site) return [];
  const out: { otherId: number; distanceMm: number; currentMm: number; predictedMm: number }[] = [];
  for (const nid of sharedNeighbours(layout, id)) {
    const other = layout.points.find((p) => p.id === nid);
    if (!other) continue;
    const d = dist(site, other);
    const currentMm = d > 1e-9 ? (site.weight - other.weight) / (2 * d) : 0;
    out.push({
      otherId: nid,
      distanceMm: d,
      currentMm,
      predictedMm: currentMm + (d > 1e-9 ? deltaW / (2 * d) : 0),
    });
  }
  return out.sort((a, b) => a.distanceMm - b.distanceMm);
}

/**
 * Ids sharing a seam with `id`. Only the edges recorded on `id`'s own boundary
 * side are used, so each neighbour appears once and seam lengths are not doubled.
 */
export function sharedNeighbours(layout: Layout, id: number): number[] {
  const ids = new Set<number>();
  for (const e of layout.edges) {
    if (e.kind !== 'shared' || e.pieceId !== id || e.otherId === null) continue;
    ids.add(e.otherId);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Seam length per neighbour on `id`'s own boundary side. */
export function seamLengths(layout: Layout, id: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of layout.edges) {
    if (e.kind !== 'shared' || e.pieceId !== id || e.otherId === null) continue;
    out.set(e.otherId, (out.get(e.otherId) ?? 0) + e.length);
  }
  return out;
}

export function totalAreaCheck(layout: Layout): {
  matches: boolean;
  frame: number;
  total: number;
  diff: number;
  relative: number;
} {
  return {
    matches: layout.stats.exact,
    frame: layout.stats.frameArea,
    total: layout.stats.pieceAreaTotal,
    diff: layout.stats.difference,
    relative: layout.stats.relativeDifference,
  };
}

/** Piece id containing a point (strictly inside), or null. */
export function pieceIdAt(layout: Layout, x: number, y: number): number | null {
  return queryPoint(layout, x, y, 0).id;
}

/** Nearest boundary edge to a world point, within `maxMm`. */
export function nearestEdge(layout: Layout, x: number, y: number, maxMm: number): LayoutEdge | null {
  let best: LayoutEdge | null = null;
  let bestD = maxMm;
  for (const e of layout.edges) {
    const d = distToSegmentLocal(pt(x, y), e.a, e.b);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function distToSegmentLocal(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
