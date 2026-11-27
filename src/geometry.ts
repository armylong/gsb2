/**
 * Pure 2-D geometry helpers. World units are millimetres, y points down.
 *
 * Rings are stored open (the closing vertex is implied). Boolean set operations on
 * non-convex shapes are delegated to `polygon-clipping`; convex power cells are
 * computed here with half-plane clipping so that coincident / near-degenerate
 * point pairs stay deterministic.
 */

import pc from 'polygon-clipping';
import type { FrameSpec, MultiPoly, Pt, Ring } from './types';

export const EPS = 1e-9;

export const dot = (p: Pt, n: Pt): number => p.x * n.x + p.y * n.y;
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const pt = (x: number, y: number): Pt => ({ x, y });

/** Signed shoelace area of an open ring. */
export function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function ringAreaAbs(ring: Ring): number {
  return Math.abs(ringArea(ring));
}

/** Outer ring minus holes. */
export function polyArea(poly: Ring[]): number {
  const outer = poly[0];
  if (!outer || outer.length < 3) return 0;
  let a = Math.abs(ringArea(outer));
  for (let i = 1; i < poly.length; i++) a -= Math.abs(ringArea(poly[i]!));
  return a;
}

export function multiPolyArea(mp: MultiPoly): number {
  let a = 0;
  for (const p of mp) a += polyArea(p);
  return a;
}

export function ringBBox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Ray-casting; returns false for points on the boundary is not guaranteed, so callers
 *  that need a strict inside/outside test should offset a probe away from seams. */
export function pointInRing(p: Pt, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const crosses =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || EPS) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInPoly(a: Pt, poly: Ring[]): boolean {
  const outer = poly[0];
  if (!outer || !pointInRing(a, outer)) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(a, poly[i]!)) return false;
  return true;
}

export function pointInMultiPoly(a: Pt, mp: MultiPoly): boolean {
  for (const poly of mp) if (pointInPoly(a, poly)) return true;
  return false;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < EPS * EPS) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function distToRing(p: Pt, ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const d = distToSegment(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

export function distToMultiPolyBoundary(p: Pt, mp: MultiPoly): number {
  let best = Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      const d = distToRing(p, ring);
      if (d < best) best = d;
    }
  }
  return best;
}

export function frameBoundaryDistance(p: Pt, frame: FrameSpec): { distance: number; inside: boolean } {
  return { distance: distToRing(p, frame.ring), inside: pointInRing(p, frame.ring) };
}

/** Remove duplicate / near-duplicate consecutive vertices and the closing duplicate. */
export function cleanRing(ring: Ring, tol = 1e-7): Ring {
  if (ring.length === 0) return ring;
  const out: Pt[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= tol) continue;
    out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.hypot(first.x - last.x, first.y - last.y) > tol) break;
    out.pop();
  }
  return out;
}

/** Drop a repeated closing vertex from polygon-clipping output. */
export function openRing(ring: Ring, tol = 1e-7): Ring {
  if (ring.length === 0) return [];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) return ring.slice(0, -1);
  return ring.slice();
}

export function toPcRing(ring: Ring): [number, number][] {
  const r: [number, number][] = ring.map((p) => [p.x, p.y]);
  if (r.length > 0) r.push([r[0]![0], r[0]![1]]);
  return r;
}

/** Convert a MultiPoly to the closed form polygon-clipping expects. */
export function toPcMultiPoly(mp: MultiPoly): [number, number][][][] {
  return mp.map((poly) => poly.map((ring) => toPcRing(ring)));
}

export function fromPc(mp: [number, number][][][]): MultiPoly {
  const out: MultiPoly = [];
  for (const poly of mp) {
    const rings: Ring[] = [];
    for (const ring of poly) {
      const open = openRing(ring.map(([x, y]) => ({ x, y })));
      if (open.length >= 3) rings.push(open);
    }
    if (rings.length > 0 && rings[0]!.length >= 3) out.push(rings);
  }
  return out;
}

/**
 * Clip a **convex** ring against the closed half-plane `p · n <= d`.
 * Returns null when nothing survives.
 */
export function clipHalfPlane(ring: Ring, n: Pt, d: number): Ring | null {
  const out: Pt[] = [];
  let prev = ring[ring.length - 1]!;
  let prevIn = dot(prev, n) <= d;
  for (const cur of ring) {
    const curIn = dot(cur, n) <= d;
    if (curIn) {
      if (!prevIn) out.push(lineIntersect(prev, cur, n, d));
      out.push(cur);
    } else if (prevIn) {
      out.push(lineIntersect(prev, cur, n, d));
    }
    prev = cur;
    prevIn = curIn;
  }
  const cleaned = cleanRing(out);
  if (cleaned.length < 3 || Math.abs(ringArea(cleaned)) < 1e-10) return null;
  return cleaned;
}

function lineIntersect(a: Pt, b: Pt, n: Pt, d: number): Pt {
  const fa = dot(a, n) - d;
  const fb = dot(b, n) - d;
  const denom = fa - fb;
  const t = Math.abs(denom) < EPS ? 0 : fa / denom;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Intersection with a (possibly non-convex) polygon. Returns MultiPolygon. */
export function intersectWithFrame(convexRing: Ring, frame: FrameSpec): MultiPoly {
  if (convexRing.length < 3) return [];
  try {
    const result = pc.intersection([toPcRing(convexRing)], [toPcRing(frame.ring)]);
    return fromPc(result);
  } catch {
    return [];
  }
}

export function intersectionOfMultiPolys(a: MultiPoly, b: MultiPoly): MultiPoly {
  if (a.length === 0 || b.length === 0) return [];
  try {
    return fromPc(pc.intersection(toPcMultiPoly(a), toPcMultiPoly(b)));
  } catch {
    return [];
  }
}

export function differenceMultiPolys(a: MultiPoly, b: MultiPoly): MultiPoly {
  if (a.length === 0) return [];
  if (b.length === 0) return a.map((p) => p.map((r) => r.slice()));
  try {
    return fromPc(pc.difference(toPcMultiPoly(a), toPcMultiPoly(b)));
  } catch {
    return [];
  }
}

export function unionMultiPolys(a: MultiPoly, b: MultiPoly): MultiPoly {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  try {
    return fromPc(pc.union(toPcMultiPoly(a), toPcMultiPoly(b)));
  } catch {
    return [];
  }
}

/** Signed distance from a point to the boundary of a shape (negative inside). */
export function signedDistanceToMultiPoly(p: Pt, mp: MultiPoly): number {
  const d = distToMultiPolyBoundary(p, mp);
  return pointInMultiPoly(p, mp) ? -d : d;
}

/**
 * Pole of inaccessibility: the interior point farthest from the boundary.
 * A coarse polylabel; adequate for label placement at pane sizes.
 */
export function poleOfInaccessibility(poly: Ring[], precision = 0.5): Pt {
  const outer = poly[0];
  if (!outer || outer.length === 0) return pt(0, 0);
  const box = ringBBox(outer);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (w <= 0 || h <= 0) return pt(box.minX, box.minY);
  const cellSize = Math.min(w, h);
  if (cellSize <= 0) return pt(outer[0]!.x, outer[0]!.y);
  const holes: Ring[] = poly.slice(1);
  const signed = (p: Pt): number => {
    let d = distToRing(p, outer);
    if (!pointInRing(p, outer)) d = -d;
    for (const hole of holes) {
      const hd = distToRing(p, hole);
      if (pointInRing(p, hole)) d = Math.min(d, -hd);
      else d = Math.min(d, hd);
    }
    return d;
  };
  const cells: Cell[] = [];
  const half = cellSize / 2;
  for (let x = box.minX; x < box.maxX; x += cellSize) {
    for (let y = box.minY; y < box.maxY; y += cellSize) {
      const c = pt(x + half, y + half);
      cells.push({ p: c, h: half, d: signed(c), max: signed(c) + half * Math.SQRT2 });
    }
  }
  const heap = new MaxHeap(cells);
  let best = { p: pt(box.minX + w / 2, box.minY + h / 2), d: -Infinity };
  let guard = 0;
  // Seed best with bbox centre and a few decent picks.
  for (const c of cells) if (c.d > best.d) best = { p: c.p, d: c.d };
  while (heap.size > 0 && guard++ < 200000) {
    const cell = heap.pop()!;
    if (cell.d > best.d) best = { p: cell.p, d: cell.d };
    if (cell.max - best.d <= precision) continue;
    const hh = cell.h / 2;
    const subCells: Cell[] = [];
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const c = pt(cell.p.x + dx * hh, cell.p.y + dy * hh);
      const d = signed(c);
      subCells.push({ p: c, h: hh, d, max: d + hh * Math.SQRT2 });
    }
    heap.pushAll(subCells);
  }
  return best.p;
}

interface Cell {
  p: Pt;
  h: number;
  d: number;
  max: number;
}

class MaxHeap {
  private arr: Cell[] = [];
  constructor(items: Cell[] = []) {
    this.pushAll(items);
  }
  get size(): number {
    return this.arr.length;
  }
  pushAll(items: Cell[]): void {
    for (const it of items) this.push(it);
  }
  push(c: Cell): void {
    this.arr.push(c);
    let i = this.arr.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arr[parent]!.max >= this.arr[i]!.max) break;
      [this.arr[parent], this.arr[i]] = [this.arr[i]!, this.arr[parent]!];
      i = parent;
    }
  }
  pop(): Cell | undefined {
    const top = this.arr[0];
    const last = this.arr.pop();
    if (last && this.arr.length > 0) {
      this.arr[0] = last;
      let i = 0;
      const n = this.arr.length;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let largest = i;
        if (l < n && this.arr[l]!.max > this.arr[largest]!.max) largest = l;
        if (r < n && this.arr[r]!.max > this.arr[largest]!.max) largest = r;
        if (largest === i) break;
        [this.arr[i], this.arr[largest]] = [this.arr[largest]!, this.arr[i]!];
        i = largest;
      }
    }
    return top;
  }
}

/** Midpoint of a ring, weighted by edge length (stable for degenerate rings). */
export function ringCentroid(ring: Ring): Pt {
  if (ring.length === 0) return pt(0, 0);
  let cx = 0;
  let cy = 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = dist(a, b);
    if (len === 0) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    cx += mx * len;
    cy += my * len;
    total += len;
  }
  if (total === 0) return { ...ring[0]! };
  return pt(cx / total, cy / total);
}

export function makeRectFrame(width: number, height: number): FrameSpec {
  return {
    kind: 'rect',
    width,
    height,
    ring: [pt(0, 0), pt(width, 0), pt(width, height), pt(0, height)],
  };
}

export interface NotchSpec {
  side: 'top' | 'right' | 'bottom' | 'left';
  start: number;
  end: number;
  depth: number;
}

/**
 * Rectangular frame with one rectangular bay cut in from an edge.
 * `start`/`end` are measured left→right (top/bottom) or top→bottom (left/right).
 */
export function makeNotchFrame(
  width: number,
  height: number,
  notch: NotchSpec,
): FrameSpec {
  const ring: Ring = [];
  const point = (x: number, y: number) => ring.push(pt(x, y));
  // Traverse clockwise in y-down space: top → right → bottom → left.
  point(0, 0);
  if (notch.side === 'top') {
    point(notch.start, 0);
    point(notch.start, notch.depth);
    point(notch.end, notch.depth);
    point(notch.end, 0);
  }
  point(width, 0);
  if (notch.side === 'right') {
    point(width, notch.start);
    point(width - notch.depth, notch.start);
    point(width - notch.depth, notch.end);
    point(width, notch.end);
  }
  point(width, height);
  if (notch.side === 'bottom') {
    point(notch.end, height);
    point(notch.end, height - notch.depth);
    point(notch.start, height - notch.depth);
    point(notch.start, height);
  }
  point(0, height);
  if (notch.side === 'left') {
    point(0, notch.end);
    point(notch.depth, notch.end);
    point(notch.depth, notch.start);
    point(0, notch.start);
  }
  const cleaned = cleanRing(ring);
  return {
    kind: 'notch',
    width,
    height,
    ring: cleaned,
    notch: { ...notch },
  };
}

/** Interior rectangle occupied by the notch void (empty for rect frames). */
export function notchVoidRect(frame: FrameSpec): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!frame.notch) return null;
  const { side, start, end, depth } = frame.notch;
  if (side === 'top') return { x0: start, y0: 0, x1: end, y1: depth };
  if (side === 'bottom') return { x0: start, y0: frame.height - depth, x1: end, y1: frame.height };
  if (side === 'left') return { x0: 0, y0: start, x1: depth, y1: end };
  return { x0: frame.width - depth, y0: start, x1: frame.width, y1: end };
}

export function isStrictlyInsideRect(
  p: Pt,
  r: { x0: number; y0: number; x1: number; y1: number },
  tol = 1e-6,
): boolean {
  return p.x > r.x0 + tol && p.x < r.x1 - tol && p.y > r.y0 + tol && p.y < r.y1 - tol;
}
