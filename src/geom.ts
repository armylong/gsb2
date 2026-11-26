export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  name?: string;
}

export interface Pad extends Rect {
  id: string;
  label: string;
}

export interface Goal extends Rect {
  angle: number;
  label: string;
}

export type SubjectKind = 'porter0' | 'porter1' | 'frame';

export interface BlockInfo {
  subject: SubjectKind;
  obstacle: string;
  at: Vec;
}

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function normAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += Math.PI * 2;
  while (x > Math.PI) x -= Math.PI * 2;
  return x;
}

/** Signed shortest rotation from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return normAngle(to - from);
}

export function pointInRect(p: Vec, r: Rect, eps = 0): boolean {
  return p.x >= r.x - eps && p.x <= r.x + r.w + eps && p.y >= r.y - eps && p.y <= r.y + r.h + eps;
}

export function circleRectOverlap(p: Vec, radius: number, r: Rect): boolean {
  const nx = clamp(p.x, r.x, r.x + r.w);
  const ny = clamp(p.y, r.y, r.y + r.h);
  return dist(p, { x: nx, y: ny }) < radius;
}

export interface OBB {
  cx: number;
  cy: number;
  angle: number;
  length: number;
  width: number;
}

export function frameOBB(h0: Vec, h1: Vec, frameLength: number, frameWidth: number): OBB {
  return {
    cx: (h0.x + h1.x) / 2,
    cy: (h0.y + h1.y) / 2,
    angle: Math.atan2(h1.y - h0.y, h1.x - h0.x),
    length: frameLength,
    width: frameWidth,
  };
}

export function obbVertices(o: OBB): Vec[] {
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  const lx = o.length / 2;
  const ly = o.width / 2;
  const corners: Array<[number, number]> = [
    [-lx, -ly],
    [lx, -ly],
    [lx, ly],
    [-lx, ly],
  ];
  return corners.map(([x, y]) => ({
    x: o.cx + x * c - y * s,
    y: o.cy + x * s + y * c,
  }));
}

function rectVertices(r: Rect): Vec[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

function axesOf(vertices: Vec[]): Vec[] {
  const axes: Vec[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const e = sub(b, a);
    const len = Math.hypot(e.x, e.y) || 1;
    axes.push({ x: -e.y / len, y: e.x / len });
  }
  return axes;
}

function project(vertices: Vec[], axis: Vec): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of vertices) {
    const d = p.x * axis.x + p.y * axis.y;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return [min, max];
}

export function polygonsOverlap(a: Vec[], b: Vec[]): boolean {
  const axes = [...axesOf(a), ...axesOf(b)];
  for (const axis of axes) {
    const [aMin, aMax] = project(a, axis);
    const [bMin, bMax] = project(b, axis);
    if (aMax <= bMin || bMax <= aMin) return false;
  }
  return true;
}

export function obbRectOverlap(o: OBB, r: Rect): boolean {
  return polygonsOverlap(obbVertices(o), rectVertices(r));
}

/** Circle vs oriented box, used for grounded people walking around the frame. */
export function circleOBBOverlap(p: Vec, radius: number, o: OBB): boolean {
  const c = Math.cos(-o.angle);
  const s = Math.sin(-o.angle);
  const dx = p.x - o.cx;
  const dy = p.y - o.cy;
  const local = { x: dx * c - dy * s, y: dx * s + dy * c };
  const nx = clamp(local.x, -o.length / 2, o.length / 2);
  const ny = clamp(local.y, -o.width / 2, o.width / 2);
  return Math.hypot(local.x - nx, local.y - ny) < radius;
}

export function rectContainsRect(outer: Rect, inner: Rect, eps = 0): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  );
}

export function obbInsideRect(o: OBB, r: Rect, eps = 0): boolean {
  return obbVertices(o).every((p) => pointInRect(p, r, eps));
}

export function circleInsideRect(p: Vec, radius: number, r: Rect, eps = 0): boolean {
  return (
    p.x - radius >= r.x - eps &&
    p.x + radius <= r.x + r.w + eps &&
    p.y - radius >= r.y - eps &&
    p.y + radius <= r.y + r.h + eps
  );
}

export function angleMatches(a: number, target: number, tolerance = 0.14): boolean {
  // A long frame has the same rack fit after 180 degrees; markings are drawn separately.
  const d = Math.abs(normAngle(a - target));
  return Math.min(d, Math.abs(Math.PI - d)) <= tolerance;
}
