/**
 * 导航网格(NavMesh)。
 *
 * 构造方式 —— 矩形空间分解(slab decomposition):
 *   1. 把每个障碍矩形按角色半径向外膨胀(角色体积在建网格阶段就纳入);
 *   2. 收集所有膨胀矩形的竖边 x 坐标, 把房间切成若干竖条(slab);
 *   3. 每个 slab 内部, 用膨胀矩形的横边区间做差集, 得到若干矩形可行走单元(cell);
 *   4. 相邻 slab 中 y 区间重叠的两个 cell 之间建立门户(portal),
 *      门户长度(重叠开口)必须 > 2*radius 才允许该半径的角色通过。
 *
 * 寻路: 在 cell 图上 A*(cell 中心欧氏距离), 再用漏斗算法(funnel/string pulling)
 * 把 cell 路径收紧成折线。漏斗结果会经独立碰撞模块校验, 失败则回退到
 * 门户中点路径(同样校验), 保证返回的路线绝不穿障碍。
 */
import { Vec2, Rect, EPS, inflateRect, dist, cross } from './geometry';
import { checkRouteClearance } from './collision';

export interface Cell {
  id: number;
  slab: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  center: Vec2;
}

export interface Portal {
  a: Vec2;
  b: Vec2;
  fromCell: number;
  toCell: number;
}

export interface CellPathResult {
  cellIds: number[];
  portals: Portal[];
}

export interface PathResult {
  route: Vec2[];
  cellIds: number[];
  portals: Portal[];
  method: 'funnel' | 'centers';
}

export class NavMesh {
  readonly cells: Cell[] = [];
  /** cellId -> 相邻 cell 及共享门户 */
  readonly neighbors = new Map<number, { neighborId: number; portal: Portal }[]>();
  readonly slabBounds: { x0: number; x1: number }[] = [];

  constructor(
    readonly roomW: number,
    readonly roomH: number,
    readonly radius: number,
    readonly inflatedObstacles: Rect[],
  ) {}

  cellById(id: number): Cell {
    return this.cells[id];
  }

  /** 定位点所在 cell; 点落在障碍内或房间外时返回 null */
  findCell(p: Vec2): Cell | null {
    if (p.x < -EPS || p.y < -EPS || p.x > this.roomW + EPS || p.y > this.roomH + EPS) return null;
    for (const c of this.cells) {
      if (
        p.x >= c.x0 - EPS && p.x <= c.x1 + EPS &&
        p.y >= c.y0 - EPS && p.y <= c.y1 + EPS
      ) {
        return c;
      }
    }
    return null;
  }

  /** A* 搜索 cell 序列与门户序列 */
  findCellPath(start: Vec2, goal: Vec2): CellPathResult | null {
    const startCell = this.findCell(start);
    const goalCell = this.findCell(goal);
    if (!startCell || !goalCell) return null;
    if (startCell.id === goalCell.id) {
      return { cellIds: [startCell.id], portals: [] };
    }

    const gScore = new Map<number, number>([[startCell.id, 0]]);
    const cameFrom = new Map<number, number>();
    const portalFrom = new Map<number, Portal>();
    const open = new MinHeap();
    open.push(startCell.id, dist(startCell.center, goalCell.center));
    const closed = new Set<number>();

    while (open.size > 0) {
      const current = open.pop()!;
      if (current === goalCell.id) {
        const cellIds: number[] = [];
        const portals: Portal[] = [];
        let c = current;
        while (c !== startCell.id) {
          cellIds.unshift(c);
          portals.unshift(portalFrom.get(c)!);
          c = cameFrom.get(c)!;
        }
        cellIds.unshift(startCell.id);
        return { cellIds, portals };
      }
      closed.add(current);
      const edges = this.neighbors.get(current) ?? [];
      for (const { neighborId, portal } of edges) {
        if (closed.has(neighborId)) continue;
        const tentative =
          (gScore.get(current) ?? Infinity) +
          dist(this.cells[current].center, this.cells[neighborId].center);
        if (tentative < (gScore.get(neighborId) ?? Infinity) - EPS) {
          cameFrom.set(neighborId, current);
          portalFrom.set(neighborId, portal);
          gScore.set(neighborId, tentative);
          open.push(neighborId, tentative + dist(this.cells[neighborId].center, goalCell.center));
        }
      }
    }
    return null;
  }

  /**
   * 完整寻路: cell 路径 -> 漏斗收紧 -> 独立碰撞校验 -> 必要时回退。
   * 返回 null 表示当前导航状态下不可达(或起终点本身不合法)。
   */
  findPath(start: Vec2, goal: Vec2, rawObstacles: Rect[]): PathResult | null {
    const cellPath = this.findCellPath(start, goal);
    if (!cellPath) return null;

    const centerOf = (id: number): Vec2 => this.cells[id].center;
    const funnelRoute = stringPull(start, goal, cellPath.portals, centerOf);
    const funnelCheck = checkRouteClearance(
      funnelRoute,
      this.radius,
      rawObstacles,
      this.roomW,
      this.roomH,
    );
    if (funnelCheck.ok) {
      return { route: funnelRoute, cellIds: cellPath.cellIds, portals: cellPath.portals, method: 'funnel' };
    }

    // 回退: 依次经过各门户中点, 仍需通过独立碰撞校验
    const fallback = buildCenterRoute(start, goal, cellPath);
    const fallbackCheck = checkRouteClearance(
      fallback,
      this.radius,
      rawObstacles,
      this.roomW,
      this.roomH,
    );
    if (fallbackCheck.ok) {
      return { route: fallback, cellIds: cellPath.cellIds, portals: cellPath.portals, method: 'centers' };
    }
    return null;
  }

  /** 供渲染/调试: 所有门户线段 */
  allPortals(): Portal[] {
    const seen = new Set<string>();
    const out: Portal[] = [];
    for (const edges of this.neighbors.values()) {
      for (const e of edges) {
        const key = [e.portal.fromCell, e.portal.toCell].sort((a, b) => a - b).join('-');
        if (!seen.has(key)) {
          seen.add(key);
          out.push(e.portal);
        }
      }
    }
    return out;
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    this.bubbleUp(this.ids.length - 1);
  }

  pop(): number | undefined {
    if (this.ids.length === 0) return undefined;
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.ids.length;
    while (true) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
      if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    [this.ids[i], this.ids[j]] = [this.ids[j], this.ids[i]];
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
  }
}

/**
 * 构建导航网格。
 * @param obstacles 原始(未膨胀)障碍矩形
 * @param radius    角色半径, 障碍按此值膨胀、房间按此值内缩
 */
export function buildNavMesh(obstacles: Rect[], radius: number, roomW: number, roomH: number): NavMesh {
  // 1. 膨胀障碍并夹到房间内; 房间内缩等价于把可行走区域限制在 [r, W-r]×[r, H-r]
  const inflated: Rect[] = [];
  for (const o of obstacles) {
    const r = inflateRect(o, radius, roomW, roomH);
    if (r) inflated.push(r);
  }

  const mesh = new NavMesh(roomW, roomH, radius, inflated);

  // 2. slab 切分: 所有膨胀矩形的竖边, 再加上房间内缩边界
  const xSet = new Set<number>([radius, roomW - radius]);
  for (const r of inflated) {
    xSet.add(clampNum(r.x, radius, roomW - radius));
    xSet.add(clampNum(r.x + r.w, radius, roomW - radius));
  }
  const sortedX = [...xSet].sort((a, b) => a - b);
  const uniqueX: number[] = [];
  for (const x of sortedX) {
    if (uniqueX.length === 0 || Math.abs(x - uniqueX[uniqueX.length - 1]) > EPS) uniqueX.push(x);
  }

  // 3. 每个 slab 求自由 y 区间并生成 cell
  const slabCells: Cell[][] = [];
  let cellId = 0;
  for (let i = 0; i < uniqueX.length - 1; i++) {
    const x0 = uniqueX[i];
    const x1 = uniqueX[i + 1];
    if (x1 - x0 <= EPS) continue;
    const midX = (x0 + x1) / 2;
    const blocked: [number, number][] = [];
    for (const r of inflated) {
      if (r.x <= midX + EPS && r.x + r.w >= midX - EPS) {
        const y0 = Math.max(r.y, radius);
        const y1 = Math.min(r.y + r.h, roomH - radius);
        if (y1 - y0 > EPS) blocked.push([y0, y1]);
      }
    }
    const freeIntervals = subtractIntervals([[radius, roomH - radius]], mergeIntervals(blocked));
    const cells: Cell[] = [];
    for (const [y0, y1] of freeIntervals) {
      if (y1 - y0 <= EPS) continue;
      const cell: Cell = {
        id: cellId++,
        slab: i,
        x0,
        x1,
        y0,
        y1,
        center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
      };
      cells.push(cell);
      mesh.cells.push(cell);
    }
    slabCells.push(cells);
    mesh.slabBounds.push({ x0, x1 });
  }

  // 4. 相邻 slab 的 cell 按 y 区间重叠建立门户
  for (let i = 0; i < slabCells.length - 1; i++) {
    const left = slabCells[i];
    const right = slabCells[i + 1];
    const boundaryX = mesh.slabBounds[i].x1;
    for (const lc of left) {
      for (const rc of right) {
        const y0 = Math.max(lc.y0, rc.y0);
        const y1 = Math.min(lc.y1, rc.y1);
        const opening = y1 - y0;
        // 门户开口必须容得下直径(严格大于, 留 EPS 容差)
        if (opening > 2 * radius + EPS) {
          const portal: Portal = {
            a: { x: boundaryX, y: y0 },
            b: { x: boundaryX, y: y1 },
            fromCell: lc.id,
            toCell: rc.id,
          };
          addNeighbor(mesh, lc.id, rc.id, portal);
        }
      }
    }
  }

  return mesh;
}

function addNeighbor(mesh: NavMesh, a: number, b: number, portal: Portal): void {
  if (!mesh.neighbors.has(a)) mesh.neighbors.set(a, []);
  if (!mesh.neighbors.has(b)) mesh.neighbors.set(b, []);
  mesh.neighbors.get(a)!.push({ neighborId: b, portal });
  mesh.neighbors.get(b)!.push({
    neighborId: a,
    portal: { ...portal, fromCell: b, toCell: a },
  });
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1] + EPS) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      out.push(sorted[i]);
    }
  }
  return out;
}

function subtractIntervals(base: [number, number][], blocked: [number, number][]): [number, number][] {
  let result: [number, number][] = base.map((b) => [b[0], b[1]]);
  for (const [bs, be] of blocked) {
    const next: [number, number][] = [];
    for (const [s, e] of result) {
      if (be <= s + EPS || bs >= e - EPS) {
        next.push([s, e]);
      } else {
        if (bs > s + EPS) next.push([s, bs]);
        if (be < e - EPS) next.push([be, e]);
      }
    }
    result = next;
  }
  return result;
}

/**
 * 漏斗算法(string pulling), 移植 Recast Navigation 的 dtFindStraightPath。
 *
 * 双数组约定:
 *   left[0] = right[0] = start(零长度门户);
 *   left[i]/right[i] (1..n-1) 为第 i-1 个真实门户的左右顶点;
 *   left[n] = right[n] = goal。
 * 坐标系 y 向下, 叉积判左右:
 *   triArea2(A,B,C) > 0 表示 C 在有向线段 A→B 的左侧。
 * 带迭代上限, 退化情况下不会死循环(调用方另有碰撞校验与中点回退兜底)。
 */
export function stringPull(
  start: Vec2,
  goal: Vec2,
  portals: Portal[],
  cellCenterOf: (id: number) => Vec2,
): Vec2[] {
  const n = portals.length;
  if (n === 0) return [start, goal];

  const left: Vec2[] = new Array(n + 1);
  const right: Vec2[] = new Array(n + 1);
  left[0] = start;
  right[0] = start;
  for (let i = 0; i < n; i++) {
    const lr = portalSidePoints(portals[i], cellCenterOf);
    left[i + 1] = lr.left;
    right[i + 1] = lr.right;
  }
  left[n] = goal;
  right[n] = goal;

  const path: Vec2[] = [start];
  let apex = start;
  let apexIndex = 0;
  let portalLeft = start;
  let portalRight = start;
  let leftIndex = 0;
  let rightIndex = 0;

  const maxIter = (n + 1) * 8;
  let iter = 0;
  let i = 1;
  while (i <= n && iter++ < maxIter) {
    // 更新右边界(条件严格对齐 Recast: 退化共线时靠索引推进)
    if (triArea2(apex, portalRight, right[i]) <= 0) {
      if (apexIndex === rightIndex || triArea2(apex, portalLeft, right[i]) > 0) {
        portalRight = right[i];
        rightIndex = i;
      } else {
        path.push(portalLeft);
        apex = portalLeft;
        apexIndex = leftIndex;
        portalLeft = apex;
        portalRight = apex;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex + 1;
        continue;
      }
    }

    // 更新左边界
    if (triArea2(apex, portalLeft, left[i]) >= 0) {
      if (apexIndex === leftIndex || triArea2(apex, portalRight, left[i]) < 0) {
        portalLeft = left[i];
        leftIndex = i;
      } else {
        path.push(portalRight);
        apex = portalRight;
        apexIndex = rightIndex;
        portalLeft = apex;
        portalRight = apex;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex + 1;
        continue;
      }
    }
    i++;
  }

  path.push(goal);
  return dedupePoints(path);
}

/** 按 from→to 的行走方向给门户分左右(本实现的门户都是竖直线段) */
function portalSidePoints(
  p: Portal,
  cellCenterOf: (id: number) => Vec2,
): { left: Vec2; right: Vec2 } {
  const from = cellCenterOf(p.fromCell);
  const to = cellCenterOf(p.toCell);
  const dirX = to.x - from.x;
  const topIsA = p.a.y <= p.b.y;
  if (Math.abs(dirX) > EPS) {
    // 向右走: 屏幕上方(y 小)是左; 向左走反之
    if (dirX > 0) {
      return topIsA ? { left: p.a, right: p.b } : { left: p.b, right: p.a };
    }
    return topIsA ? { left: p.b, right: p.a } : { left: p.a, right: p.b };
  }
  // 水平门户(当前实现不会产生, 保险处理)
  const dirY = to.y - from.y;
  const leftIsA = p.a.x <= p.b.x;
  if (dirY > 0) {
    return leftIsA ? { left: p.b, right: p.a } : { left: p.a, right: p.b };
  }
  return leftIsA ? { left: p.a, right: p.b } : { left: p.b, right: p.a };
}

function triArea2(a: Vec2, b: Vec2, c: Vec2): number {
  return cross({ x: b.x - a.x, y: b.y - a.y }, { x: c.x - a.x, y: c.y - a.y });
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
}

function dedupePoints(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (out.length === 0 || !samePoint(out[out.length - 1], p)) out.push(p);
  }
  return out;
}

/** 回退路线: 起点 → 各门户中点 → 终点 */
function buildCenterRoute(start: Vec2, goal: Vec2, cellPath: CellPathResult): Vec2[] {
  const route: Vec2[] = [start];
  for (const p of cellPath.portals) {
    route.push({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 });
  }
  route.push(goal);
  return dedupePoints(route);
}
