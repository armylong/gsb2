import type { Axial, CellKey, Offset, Vec2 } from './types';

/**
 * Pointy-top hexes, axial coordinates.
 *   centre(q, r) = (√3·(q + r/2), 3/2·r)   with circumradius 1.
 * The six edge normals are at k·60°, so edge midpoints point along
 * 0°, 60°, 120°, … — no irrational axis-aligned normals are involved.
 */
export const SQRT3 = Math.sqrt(3);

export const MAP_COLS = 15;
export const MAP_ROWS = 12;

/** Neighbour order: E, NE, NW, W, SW, SE. */
export const HEX_DIRECTIONS: ReadonlyArray<Readonly<Axial>> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function axialKey(q: number, r: number): CellKey {
  return `${q},${r}`;
}

/** Offset "odd-r": odd rows are pushed half a hex to the right. */
export function offsetToAxial(col: number, row: number): Axial {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function axialToOffset(q: number, r: number): Offset {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

export function inMap(q: number, r: number): boolean {
  const { col, row } = axialToOffset(q, r);
  return col >= 0 && col < MAP_COLS && row >= 0 && row < MAP_ROWS;
}

export function hexCentre(q: number, r: number, size = 1): Vec2 {
  return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
}

/** Axial distance (cube / 2). */
export function hexDistance(aq: number, ar: number, bq: number, br: number): number {
  const dq = aq - bq;
  const dr = ar - br;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/** The six corner unit vectors of a pointy-top hex, in the same order as the normals. */
function hexCorners(size = 1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    // Corners lie between edge normals; -30° puts corner 0 top-right.
    const angle = (Math.PI / 180) * (-30 + i * 60);
    out.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return out;
}

const CORNERS = hexCorners(1);

/**
 * Corner points of one cell. `scale` shrinks the hexagon about its own centre
 * (used for insets and wall caps); it never moves the cell's world position.
 */
export function hexCornersAt(q: number, r: number, scale = 1): Vec2[] {
  const c = hexCentre(q, r);
  return CORNERS.map((p) => ({ x: c.x + p.x * scale, y: c.y + p.y * scale }));
}

function hexVertexAt(q: number, r: number, index: number, scale = 1): Vec2 {
  const c = hexCentre(q, r);
  const v = CORNERS[((index % 6) + 6) % 6]!;
  return { x: c.x + v.x * scale, y: c.y + v.y * scale };
}

/**
 * Nearest hex to a world point. Fractional axial coordinates are rounded in cube
 * space with a fixed tie-break order, which keeps picking deterministic on edges.
 * `size` must match the size used to place the point.
 */
export function pixelToAxial(x: number, y: number, size = 1): Axial {
  const qf = ((SQRT3 / 3) * x - y / 3) / size;
  const rf = ((2 / 3) * y) / size;
  const xf = qf;
  const zf = rf;
  const yf = -xf - zf;
  let rx = Math.round(xf);
  let ry = Math.round(yf);
  let rz = Math.round(zf);
  const dx = Math.abs(rx - xf);
  const dy = Math.abs(ry - yf);
  const dz = Math.abs(rz - zf);
  // Smaller rounding error wins; equal errors resolve to the same order every time.
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  // Normalise -0 so callers can compare with Object.is / deep equality.
  return { q: rx === 0 ? 0 : rx, r: rz === 0 ? 0 : rz };
}

// ---------------------------------------------------------------------------
// Line-of-sight geometry
// ---------------------------------------------------------------------------

/** A segment in cell-local space: a cell is grazed while the segment parameter t ∈ [t0,t1]. */
export interface Span {
  t0: number;
  t1: number;
}

function segmentHexSpan(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  centre: Vec2,
  shrink: number,
): Span | null {
  // Unit hex: intersection of six half-planes dot(p - centre, n) <= apothem - shrink.
  // Apothem of a unit-circumradius hex is √3/2.
  const apothem = SQRT3 / 2;
  const limit = apothem - shrink;
  const dx = ex - sx;
  const dy = ey - sy;
  const ox = sx - centre.x;
  const oy = sy - centre.y;
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 6; k++) {
    const angle = (k * Math.PI) / 3;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const f0 = ox * nx + oy * ny;
    const fd = dx * nx + dy * ny;
    if (Math.abs(fd) < 1e-12) {
      if (f0 > limit) return null;
    } else if (fd > 0) {
      t1 = Math.min(t1, (limit - f0) / fd);
    } else {
      t0 = Math.max(t0, (limit - f0) / fd);
    }
    if (t0 > t1) return null;
  }
  if (t1 < t0) return null;
  return { t0, t1 };
}

/** Segment length inside a hex: exactly zero means a mere corner/edge touch. */
export function segmentHexOverlapLength(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  centre: Vec2,
  shrink = 0,
): number {
  const span = segmentHexSpan(sx, sy, ex, ey, centre, shrink);
  if (!span) return 0;
  const len = Math.hypot(ex - sx, ey - sy);
  return Math.max(0, span.t1 - span.t0) * len;
}

/**
 * The agreed line-of-sight rule between two cell centres.
 *
 * 1. Candidates are the cells between the two centres at axial distance
 *    1 … distance-1 (endpoints excluded), sorted by where the segment enters them.
 * 2. A candidate can only block when the centre-to-centre segment passes through
 *    its interior. A cell the segment merely grazes — hugging one of its edges or
 *    clipping one of its corners — has overlap length ≈ 0 and is *transparent*.
 *    This is tested exactly (half-plane clipping), so the rule does not depend on
 *    floating-point luck near the edge: collinear edges and exact vertex touches
 *    are handled by the same overlap test and always resolve the same way.
 * 3. The first blocking terrrain wins and is reported as the blocker. A closed
 *    door blocks; an open door does not. The blocker itself is visible when it
 *    lies within the observer's radius (handled by the caller).
 */
export const LOS_CORNER_EPSILON = 1e-9;

export interface SegmentCell {
  q: number;
  r: number;
  entryT: number;
  overlap: number;
}

/**
 * Enumerates every cell whose *interior* the segment crosses. The hex is
 * shrunk by `LOS_CORNER_EPSILON` before clipping, so a segment that runs
 * exactly along one of its edges, or clips exactly one of its corners, has
 * zero interior overlap and is not reported. Endpoint cells are included with
 * their own spans; callers filter them out. Pure geometry, no terrain rules.
 */
export function cellsAlongSegment(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  candidates: Iterable<Axial>,
  shrink = LOS_CORNER_EPSILON,
): SegmentCell[] {
  const out: SegmentCell[] = [];
  const length = Math.hypot(ex - sx, ey - sy);
  for (const cell of candidates) {
    const centre = hexCentre(cell.q, cell.r);
    const span = segmentHexSpan(sx, sy, ex, ey, centre, shrink);
    if (!span) continue;
    const overlap = Math.max(0, span.t1 - span.t0) * length;
    if (overlap > LOS_CORNER_EPSILON) {
      out.push({ q: cell.q, r: cell.r, entryT: span.t0, overlap });
    }
  }
  out.sort((a, b) => a.entryT - b.entryT || a.q - b.q || a.r - b.r);
  return out;
}

/** Every cell in an axial radius, used as the candidate set for a line segment. */
export function cellsInRange(q: number, r: number, radius: number): Axial[] {
  const out: Axial[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      out.push({ q: q + dq, r: r + dr });
    }
  }
  return out;
}

/**
 * Cells strictly between two hexes that the centre-to-centre segment passes
 * through. Corner-only and edge-only encounters are excluded — that is the
 * documented tie-break. Used by both the vision engine and the tests.
 */
export function intermediateCells(
  from: Axial,
  to: Axial,
  candidates?: Iterable<Axial>,
): SegmentCell[] {
  const a = hexCentre(from.q, from.r);
  const b = hexCentre(to.q, to.r);
  const distance = hexDistance(from.q, from.r, to.q, to.r);
  const set: Iterable<Axial> =
    candidates ?? cellsInRange(from.q, from.r, Math.max(1, distance));
  return cellsAlongSegment(a.x, a.y, b.x, b.y, set).filter(
    (c) =>
      !(c.q === from.q && c.r === from.r) &&
      !(c.q === to.q && c.r === to.r) &&
      // Only truly between: entry parameter strictly past the source cell.
      c.entryT > 0,
  );
}

/** True when the segment only grazes the given hex (edge hug or corner clip). */
export function grazesHex(sx: number, sy: number, ex: number, ey: number, cell: Axial): boolean {
  const centre = hexCentre(cell.q, cell.r);
  const closed = segmentHexSpan(sx, sy, ex, ey, centre, 0);
  if (!closed) return false;
  const shrunk = segmentHexSpan(sx, sy, ex, ey, centre, 1e-6);
  const openLength = closed.t1 - closed.t0;
  if (openLength <= LOS_CORNER_EPSILON) return false;
  if (!shrunk) return true;
  return shrunk.t1 - shrunk.t0 <= LOS_CORNER_EPSILON;
}

export function hexVertex(q: number, r: number, index: number, size = 1): Vec2 {
  return hexVertexAt(q, r, index, size);
}

/**
 * Which neighbour sits across each edge. Edge i runs between corner i and
 * corner i+1, so its outward normal bisects those corners.
 */
export const EDGE_NEIGHBOURS: ReadonlyArray<Readonly<Axial>> = (() => {
  const out: Axial[] = [];
  for (let i = 0; i < 6; i++) {
    const a = CORNERS[i]!;
    const b = CORNERS[((i + 1) % 6 + 6) % 6]!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let best = HEX_DIRECTIONS[0]!;
    let bestDot = -Infinity;
    for (const dir of HEX_DIRECTIONS) {
      const c = hexCentre(dir.q, dir.r);
      const dot = (c.x * mx + c.y * my) / (Math.hypot(c.x, c.y) || 1);
      if (dot > bestDot) {
        bestDot = dot;
        best = dir;
      }
    }
    out.push(best);
  }
  return out;
})();
