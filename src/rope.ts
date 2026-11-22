import {
  Vec,
  add,
  clamp,
  cross,
  dist,
  dot,
  len2,
  mul,
  pointInPolygon,
  polygonDistance,
  sub,
} from './math.js';

export interface ObstacleDef {
  id: string;
  label: string;
  points: Vec[];
  /** 每个顶点的中文名称，用于时间线与拐点标记。 */
  vertexLabels?: string[];
  tint?: string;
}

export interface RopeCorner {
  key: string;
  obstacleId: string;
  vertexIndex: number;
  point: Vec;
  label: string;
}

export interface RopeSegmentInfo {
  from: Vec;
  to: Vec;
  length: number;
  /** 0 = 锚点到第一个拐点；之后依次递增。 */
  index: number;
}

export interface RopePath {
  points: Vec[];
  corners: RopeCorner[];
  segments: RopeSegmentInfo[];
  totalLength: number;
}

const EPS = 1e-9;
const COLLINEAR_EPS = 1e-6;
/** 两条长度几乎相同的绳路之间保留既有拐点的宽容度（像素）。 */
export const TIE_EPSILON = 1e-4;

interface GraphNode {
  key: string;
  point: Vec;
  obstacleId?: string;
  vertexIndex?: number;
  label: string;
}

export function cornerLabel(obstacle: ObstacleDef, index: number): string {
  const named = obstacle.vertexLabels?.[index];
  return `${obstacle.label}·${named ?? `角${index + 1}`}`;
}

function strictlyInside(p: Vec, poly: readonly Vec[]): boolean {
  if (!pointInPolygon(p, poly)) return false;
  return polygonDistance(p, poly).d > 1e-7;
}

/**
 * 线段是否无障碍可见。
 * 先取线段与多边形所有边界的交点参数（含顶点接触、沿边重合），
 * 再逐段检查中点是否落在多边形内部；落在边界上的重合段视为允许
 * （绳可以贴着障碍边缘走），这也是“绳恰好经过一条边”时的稳定规则：
 * 只要没有真正穿入内部，就允许直线通过，不会凭空多出一个拐点。
 */
export function segmentVisible(a: Vec, b: Vec, obstacles: readonly ObstacleDef[]): boolean {
  const d = sub(b, a);
  const dLen2 = len2(d);
  if (dLen2 < 1e-18) return true;
  for (const ob of obstacles) {
    const poly = ob.points;
    if (strictlyInside(a, poly) || strictlyInside(b, poly)) return false;

    const ts: number[] = [0, 1];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const e = sub(q, p);
      const den = cross(d, e);
      if (Math.abs(den) > 1e-12) {
        const t = cross(sub(p, a), e) / den;
        const s = cross(sub(p, a), d) / den;
        if (t > -1e-9 && t < 1 + 1e-9 && s > -1e-9 && s < 1 + 1e-9) {
          ts.push(clamp(t, 0, 1));
        }
      } else if (Math.abs(cross(sub(p, a), d)) <= 1e-9 * Math.max(1, Math.sqrt(dLen2))) {
        // 与边共线：把投影重叠区间加入参数列表。
        const t0 = dot(sub(p, a), d) / dLen2;
        const t1 = dot(sub(q, a), d) / dLen2;
        const lo = clamp(Math.min(t0, t1), 0, 1);
        const hi = clamp(Math.max(t0, t1), 0, 1);
        if (hi >= lo) {
          ts.push(lo, hi);
        }
      }
    }
    ts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      if (t1 - t0 < 1e-9) continue;
      const mid = add(a, mul(d, (t0 + t1) / 2));
      if (strictlyInside(mid, poly)) return false;
    }
  }
  return true;
}

function segmentPathLength(points: readonly Vec[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) total += dist(points[i], points[i + 1]);
  return total;
}

function buildPath(points: Vec[], corners: RopeCorner[]): RopePath {
  const segments: RopeSegmentInfo[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    segments.push({
      from: points[i],
      to: points[i + 1],
      length: dist(points[i], points[i + 1]),
      index: i,
    });
  }
  return { points, corners, segments, totalLength: segmentPathLength(points) };
}

function dedupeCorners(corners: RopeCorner[]): RopeCorner[] {
  const out: RopeCorner[] = [];
  for (const c of corners) {
    if (out.length && out[out.length - 1].key === c.key) continue;
    out.push(c);
  }
  return out;
}

/** 去掉接近直线的中间点：没有折角就不算拐点。 */
function dropStraightPoints(points: Vec[], corners: RopeCorner[]): { points: Vec[]; corners: RopeCorner[] } {
  if (points.length <= 2) return { points, corners };
  const outP: Vec[] = [points[0]];
  const outC: RopeCorner[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = outP[outP.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const u1 = sub(cur, prev);
    const u2 = sub(next, cur);
    const l1 = Math.hypot(u1.x, u1.y);
    const l2 = Math.hypot(u2.x, u2.y);
    if (l1 < 1e-12 || l2 < 1e-12) continue;
    const turn = Math.abs(cross(mul(u1, 1 / l1), mul(u2, 1 / l2)));
    if (turn < COLLINEAR_EPS && dot(u1, u2) > 0) continue;
    outP.push(cur);
    outC.push(corners[i - 1]);
  }
  outP.push(points[points.length - 1]);
  return { points: outP, corners: outC };
}

function nodeCorners(nodes: readonly GraphNode[], obstacles: readonly ObstacleDef[]): RopeCorner[] {
  const byId = new Map(obstacles.map((o) => [o.id, o]));
  const corners: RopeCorner[] = [];
  for (const node of nodes) {
    if (node.obstacleId === undefined || node.vertexIndex === undefined) continue;
    const ob = byId.get(node.obstacleId);
    if (!ob) continue;
    corners.push({
      key: node.key,
      obstacleId: ob.id,
      vertexIndex: node.vertexIndex,
      point: node.point,
      label: cornerLabel(ob, node.vertexIndex),
    });
  }
  return corners;
}

function makeNodes(anchor: Vec, target: Vec, obstacles: readonly ObstacleDef[]): GraphNode[] {
  const nodes: GraphNode[] = [
    { key: '@anchor', point: anchor, label: '锚点' },
    { key: '@character', point: target, label: '角色' },
  ];
  for (const ob of obstacles) {
    for (let i = 0; i < ob.points.length; i++) {
      nodes.push({
        key: `${ob.id}#${i}`,
        point: ob.points[i],
        obstacleId: ob.id,
        vertexIndex: i,
        label: cornerLabel(ob, i),
      });
    }
  }
  return nodes;
}

/**
 * 从锚点到角色的最短可见折线（拉紧绳子的实际路径）。
 * 中间节点只允许落在障碍顶点上；所有线段必须保持可见。
 * 距离相同用路径键字典序稳定决胜；若上一帧路径仍有效且长度
 * 相同（差 ≤ TIE_EPSILON），则保留上一帧拐点，避免临界处抖动。
 */
export function solveRopePath(
  anchor: Vec,
  target: Vec,
  obstacles: readonly ObstacleDef[],
  previous?: RopePath | null,
): RopePath {
  const nodes = makeNodes(anchor, target, obstacles);
  const n = nodes.length;
  const clear: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ok = segmentVisible(nodes[i].point, nodes[j].point, obstacles);
      clear[i][j] = ok;
      clear[j][i] = ok;
    }
  }

  const start = 0;
  const goal = 1;
  const distArr = new Array(n).fill(Infinity);
  const prevArr = new Array(n).fill(-1);
  const keyArr: string[] = new Array(n).fill('');
  const done = new Array(n).fill(false);
  distArr[start] = 0;
  keyArr[start] = '';

  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      if (u < 0) {
        u = i;
        continue;
      }
      const d = distArr[i];
      const best = distArr[u];
      if (d < best - EPS || (Math.abs(d - best) <= EPS && keyArr[i] < keyArr[u])) u = i;
    }
    if (u < 0 || !Number.isFinite(distArr[u])) break;
    done[u] = true;
    if (u === goal) break;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u || !clear[u][v]) continue;
      const nd = distArr[u] + dist(nodes[u].point, nodes[v].point);
      const nk = keyArr[u] + '>' + nodes[v].key;
      if (nd < distArr[v] - EPS || (Math.abs(nd - distArr[v]) <= EPS && nk < keyArr[v])) {
        distArr[v] = nd;
        prevArr[v] = u;
        keyArr[v] = nk;
      }
    }
  }

  const best = (() => {
    if (!Number.isFinite(distArr[goal])) {
      // 理论上不应发生：退化时退回直线，沿用约束检查兜底。
      return buildPath([anchor, target], []);
    }
    const chain: number[] = [];
    for (let cur = goal; cur >= 0; cur = prevArr[cur]) {
      chain.push(cur);
      if (cur === start) break;
    }
    chain.reverse();
    const nodesOnPath = chain.map((i) => nodes[i]);
    const allPoints = nodesOnPath.map((nd) => nd.point);
    const allCorners = nodeCorners(nodesOnPath, obstacles);
    const clean = dropStraightPoints(allPoints, allCorners);
    return buildPath(clean.points, dedupeCorners(clean.corners));
  })();

  if (previous && previous.corners.length > 0) {
    const prevPoints = [anchor, ...previous.corners.map((c) => c.point), target];
    const prevCorners = dedupeCorners(previous.corners);
    const prevLength = segmentPathLength(prevPoints);
    let valid = true;
    for (let i = 0; i + 1 < prevPoints.length; i++) {
      if (!segmentVisible(prevPoints[i], prevPoints[i + 1], obstacles)) {
        valid = false;
        break;
      }
    }
    if (valid && prevLength <= best.totalLength + TIE_EPSILON) {
      const clean = dropStraightPoints(prevPoints, prevCorners);
      return buildPath(clean.points, dedupeCorners(clean.corners));
    }
  }

  return best;
}

/** 角色圆与多边形的最小间隙；负值表示已嵌入。 */
export function circlePenetration(p: Vec, radius: number, obstacles: readonly ObstacleDef[]): number {
  let worst = 0;
  for (const ob of obstacles) {
    const d = polygonDistance(p, ob.points).d;
    const inside = pointInPolygon(p, ob.points);
    const pen = inside ? d + radius : radius - d;
    if (pen > worst) worst = pen;
  }
  return worst;
}

/**
 * 将角色圆推出所有障碍。返回推出后的位置与最大穿透量（用于验证）。
 * 采用最近边界点 + 外法线，多个障碍时迭代数次。
 */
export function resolveCircleObstacles(
  p: Vec,
  radius: number,
  obstacles: readonly ObstacleDef[],
): { pos: Vec; penetration: number } {
  let pos = { ...p };
  let deepest = 0;
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (const ob of obstacles) {
      const poly = ob.points;
      const inside = pointInPolygon(pos, poly);
      // 最近边界点与所在边
      let bestD = Infinity;
      let bestPoint = poly[0];
      let bestI = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const ab = sub(b, a);
        const l2 = len2(ab);
        const t = l2 < 1e-18 ? 0 : clamp(dot(sub(pos, a), ab) / l2, 0, 1);
        const q = add(a, mul(ab, t));
        const d = dist(pos, q);
        if (d < bestD) {
          bestD = d;
          bestPoint = q;
          bestI = i;
        }
      }
      const pen = inside ? bestD + radius : radius - bestD;
      if (pen > deepest) deepest = pen;
      if (pen <= 1e-9) continue;

      // 求该边的外法线：从边中点向两侧试探，选多边形外部的一侧。
      const a = poly[bestI];
      const b = poly[(bestI + 1) % poly.length];
      const ab = sub(b, a);
      const n = Math.hypot(ab.x, ab.y) < 1e-12 ? { x: 0, y: -1 } : { x: ab.y / Math.hypot(ab.x, ab.y), y: -ab.x / Math.hypot(ab.x, ab.y) };
      const edgeMid = mul(add(a, b), 0.5);
      const outward = pointInPolygon(add(edgeMid, mul(n, 0.5)), poly) ? mul(n, -1) : n;

      if (inside) {
        pos = add(bestPoint, mul(outward, radius + 1e-6));
      } else {
        const away = sub(pos, bestPoint);
        const awayLen = Math.hypot(away.x, away.y);
        const dir = awayLen < 1e-9 ? outward : mul(away, 1 / awayLen);
        pos = add(bestPoint, mul(dir, radius + 1e-6));
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { pos, penetration: Math.max(0, deepest) };
}

/** 判断当前位置是否在障碍内部或贴得太近（用于回滚校验）。 */
export function bodyBlocked(p: Vec, radius: number, obstacles: readonly ObstacleDef[]): boolean {
  return circlePenetration(p, radius, obstacles) > 1e-4;
}

export function clonePath(path: RopePath): RopePath {
  return {
    points: path.points.map((p) => ({ ...p })),
    corners: path.corners.map((c) => ({ ...c, point: { ...c.point } })),
    segments: path.segments.map((s) => ({ ...s, from: { ...s.from }, to: { ...s.to } })),
    totalLength: path.totalLength,
  };
}

