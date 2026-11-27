/**
 * Seam probing for the boundary inspector.
 *
 * Given a click near a boundary, report both owners, classify the edge as an
 * outer-frame edge or a shared seam, and explain the seam's weight response.
 *
 * Owner attribution on the two sides is done analytically rather than by
 * re-querying the whole diagram: on a shared seam the owner is decided by the
 * sign of the pair's power difference, which is exactly zero on the edge. That
 * keeps the answer stable even though the probe offsets sit inside the near-seam
 * tie band that the hover readout deliberately blurs.
 */

import { dist, distToSegment, pointInRing, pt } from './geometry';
import { seamLengths } from './layout';
import type { Layout, LayoutEdge, MultiPoly, PointSpec, Pt } from './types';

export interface BoundaryPick {
  edge: LayoutEdge;
  distanceMm: number;
  /** The point on the edge closest to the query. */
  point: Pt;
  /** World position just off the edge, on side A and B. */
  probeA: Pt;
  probeB: Pt;
  /** Pane id on each probe side (null on a side facing outside the window). */
  ownerA: number | null;
  ownerB: number | null;
  /** "外框边" or "公共边". */
  kindLabel: string;
  /** Human readable explanation of the current weight balance. */
  explanation: string;
}

/**
 * Probe offset. Must be large enough to be measurable, small enough to stay on
 * the same two cells away from junction corners.
 */
const PROBE_MM = 0.25;

export function pickBoundary(
  layout: Layout,
  x: number,
  y: number,
  maxMm: number,
): BoundaryPick | null {
  let bestEdge: LayoutEdge | null = null;
  let bestD = maxMm;
  let bestT = 0;
  for (const e of layout.edges) {
    const { d, t } = pointSegmentProjection(pt(x, y), e.a, e.b);
    if (d < bestD) {
      bestD = d;
      bestEdge = e;
      bestT = t;
    }
  }
  if (!bestEdge) return null;

  const e = bestEdge;
  const closest = pt(e.a.x + (e.b.x - e.a.x) * bestT, e.a.y + (e.b.y - e.a.y) * bestT);
  const n = e.normal;
  const probeA = pt(closest.x + n.x * PROBE_MM, closest.y + n.y * PROBE_MM);
  const probeB = pt(closest.x - n.x * PROBE_MM, closest.y - n.y * PROBE_MM);
  const site = layout.points.find((p) => p.id === e.pieceId);
  const other = e.otherId !== null ? layout.points.find((p) => p.id === e.otherId) : null;
  const kindLabel = e.kind === 'frame' ? '外框边' : '公共边';

  let ownerA: number | null;
  let ownerB: number | null;
  if (e.kind === 'shared' && site && other) {
    // Power difference f(p) = |p-site|² - w_site - (|p-other|² - w_other).
    // It is linear, so its sign tells which side of the seam the probe is on.
    ownerA = withinFrame(layout, probeA)
      ? powerDiff(probeA, site, other) < 0
        ? site.id
        : other.id
      : null;
    ownerB = withinFrame(layout, probeB)
      ? powerDiff(probeB, site, other) < 0
        ? site.id
        : other.id
      : null;
    // A seam can only separate these two ids; guard against a probe that slid
    // past a junction into a third cell by checking the diagram too.
    if (ownerA !== null && pieceAt(layout, probeA) !== ownerA) ownerA = pieceAt(layout, probeA);
    if (ownerB !== null && pieceAt(layout, probeB) !== ownerB) ownerB = pieceAt(layout, probeB);
  } else {
    const inA = withinFrame(layout, probeA);
    const inB = withinFrame(layout, probeB);
    ownerA = inA ? pieceAt(layout, probeA) : null;
    ownerB = inB ? pieceAt(layout, probeB) : null;
  }

  const explanation = explain(layout, e, site, other ?? undefined);

  return {
    edge: e,
    distanceMm: bestD,
    point: closest,
    probeA,
    probeB,
    ownerA,
    ownerB,
    kindLabel,
    explanation,
  };
}

function withinFrame(layout: Layout, p: Pt): boolean {
  return pointInRing(p, layout.frame.ring);
}

function powerDiff(p: Pt, a: PointSpec, b: PointSpec): number {
  return (
    (p.x - a.x) * (p.x - a.x) +
    (p.y - a.y) * (p.y - a.y) -
    a.weight -
    ((p.x - b.x) * (p.x - b.x) + (p.y - b.y) * (p.y - b.y) - b.weight)
  );
}

/** Owner by containment in the computed, clipped pieces (strictly inside). */
function pieceAt(layout: Layout, p: Pt): number | null {
  for (const piece of layout.pieces) {
    if (piece.parts === 0) continue;
    if (pointInMultiPolyRaw(p, piece.polygons)) return piece.id;
  }
  return null;
}

function pointInMultiPolyRaw(p: Pt, mp: MultiPoly): boolean {
  for (const poly of mp) {
    if (!pointInRing(p, poly[0] ?? [])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (pointInRing(p, poly[i]!)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function explain(
  layout: Layout,
  e: LayoutEdge,
  site: PointSpec | undefined,
  other: PointSpec | undefined,
): string {
  if (e.kind === 'frame' || !site || !other) {
    const id = e.pieceId;
    const length = e.length.toFixed(1);
    const piece = layout.pieces.find((p) => p.id === id);
    return `外框边：#${id}（面积 ${(piece?.area ?? 0).toFixed(1)} mm²）与窗口外轮廓相接，这一段长 ${length} mm。外框边只属于一块玻璃。`;
  }
  const d = dist(site, other);
  const shift = d > 1e-9 ? (site.weight - other.weight) / (2 * d) : 0;
  const side =
    Math.abs(shift) < 1e-4 ? '基本居中' : shift > 0 ? `向 #${other.id} 一侧偏移` : `向 #${site.id} 一侧偏移`;
  const perDelta = d > 1e-9 ? 1000 / (2 * d) : 0;
  return (
    `公共边：#${site.id}（分量 ${site.weight.toFixed(0)}）与 #${other.id}（分量 ${other.weight.toFixed(0)}）` +
    `，点距 ${d.toFixed(1)} mm。接缝按功率距离平分，相对等权位置${side} ${Math.abs(shift).toFixed(2)} mm。` +
    `#${site.id} 每增加 1000 mm² 分量，这条缝朝 #${other.id} 移动 ${perDelta.toFixed(2)} mm。`
  );
}

function pointSegmentProjection(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return { d: dist(p, a), t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = pt(a.x + dx * t, a.y + dy * t);
  return { d: Math.hypot(p.x - q.x, p.y - q.y), t };
}

/** Describe all shared neighbours and their seam distances for the info card. */
export function neighbourSummary(
  layout: Layout,
  id: number,
): { other: PointSpec; gapMm: number; seamLengthMm: number }[] {
  const site = layout.points.find((p) => p.id === id);
  if (!site) return [];
  const lengths = seamLengths(layout, id);
  const out: { other: PointSpec; gapMm: number; seamLengthMm: number }[] = [];
  for (const [oid, len] of lengths) {
    const other = layout.points.find((p) => p.id === oid);
    if (!other) continue;
    const d = dist(site, other);
    const gapMm = d > 1e-9 ? (site.weight - other.weight) / (2 * d) : 0;
    out.push({ other, gapMm, seamLengthMm: len });
  }
  return out.sort((a, b) => a.gapMm - b.gapMm);
}

/** Kept for callers that only need a point-to-edge distance. */
export function edgeDistance(p: Pt, a: Pt, b: Pt): number {
  return distToSegment(p, a, b);
}
