/**
 * 封闭网格与平面求交的纯 TypeScript 实现（不依赖 three.js，便于命令行验证）。
 *
 * 稳定性策略：
 * - 距离按模型尺寸做相对容差判断，落在容差带内的顶点视为"在平面上"；
 * - 所有交点按空间网格（snap grid）合并，保证"经过顶点"时相邻三角形
 *   产生的交点与顶点本身是同一个节点；
 * - 共面三角形只贡献顶点、不产生截面线段，避免"贴着面"时出现重复边；
 * - 截面线段构成无向图，度为 1 的端点走出未闭合链，其余走出闭合环。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MeshData {
  /** 顶点坐标，长度 = 顶点数 * 3 */
  positions: Float64Array;
  /** 三角形索引，长度 = 三角面数 * 3 */
  indices: Uint32Array;
}

/** 平面方程：normal · x = w，要求 normal 为单位向量 */
export interface Plane {
  normal: Vec3;
  w: number;
}

export interface Loop {
  /** 闭合环顶点（首尾不重复存储），均在截平面上 */
  points: Vec3[];
  /** 嵌套深度：0 = 外环，1 = 内环（孔洞），2 = 外环 … */
  depth: number;
  /** 平面二维坐标系下的有向面积 */
  signedArea2D: number;
  /** 该环的周长 */
  perimeter: number;
}

export interface OpenChain {
  /** 未闭合截交链的顶点序列 */
  points: Vec3[];
  length: number;
}

export interface Basis2D {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
}

export interface SectionResult {
  loops: Loop[];
  openChains: OpenChain[];
  /** 参与截面的三角面截交线段总数 */
  segmentCount: number;
  /** 填成截面后的净面积（外环为正、内环孔洞为负） */
  sectionArea: number;
  /** 所有闭合环周长之和（外轮廓 + 孔轮廓） */
  totalPerimeter: number;
  basis: Basis2D;
}

export interface BoundaryEdge {
  a: number;
  b: number;
  pa: Vec3;
  pb: Vec3;
}

export interface MeshCheck {
  isClosed: boolean;
  boundaryEdges: BoundaryEdge[];
  edgeCount: number;
  triangleCount: number;
}

// ---------- 小向量工具 ----------

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const normalize = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export function meshVertex(mesh: MeshData, i: number): Vec3 {
  return {
    x: mesh.positions[i * 3],
    y: mesh.positions[i * 3 + 1],
    z: mesh.positions[i * 3 + 2],
  };
}

function bboxDiagonal(mesh: MeshData): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]);
    maxX = Math.max(maxX, mesh.positions[i]);
    minY = Math.min(minY, mesh.positions[i + 1]);
    maxY = Math.max(maxY, mesh.positions[i + 1]);
    minZ = Math.min(minZ, mesh.positions[i + 2]);
    maxZ = Math.max(maxZ, mesh.positions[i + 2]);
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/**
 * 网格封闭性检查：每条无向边应恰好被两个三角面共享。
 * 只出现一次的边即破口（边界边）。
 */
export function checkMesh(mesh: MeshData): MeshCheck {
  const edgeMap = new Map<string, { a: number; b: number; count: number }>();
  const triCount = mesh.indices.length / 3;
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3];
    const i1 = mesh.indices[t * 3 + 1];
    const i2 = mesh.indices[t * 3 + 2];
    for (const [a, b] of [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ] as const) {
      const k = edgeKey(a, b);
      const e = edgeMap.get(k);
      if (e) e.count++;
      else edgeMap.set(k, { a: Math.min(a, b), b: Math.max(a, b), count: 1 });
    }
  }
  const boundaryEdges: BoundaryEdge[] = [];
  for (const e of edgeMap.values()) {
    if (e.count === 1) {
      boundaryEdges.push({ a: e.a, b: e.b, pa: meshVertex(mesh, e.a), pb: meshVertex(mesh, e.b) });
    }
  }
  return {
    isClosed: boundaryEdges.length === 0,
    boundaryEdges,
    edgeCount: edgeMap.size,
    triangleCount: triCount,
  };
}

/**
 * 计算平面与三角网格的截交结果。
 */
export function computeSection(mesh: MeshData, plane: Plane): SectionResult {
  const n = plane.normal;
  const snap = 1e-8 * Math.max(1, bboxDiagonal(mesh));

  const vertexCount = mesh.positions.length / 3;
  const dist = new Float64Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const d = mesh.positions[i * 3] * n.x + mesh.positions[i * 3 + 1] * n.y + mesh.positions[i * 3 + 2] * n.z - plane.w;
    // 容差带内吸附到 0，保证"经过顶点"行为确定
    dist[i] = Math.abs(d) <= snap ? 0 : d;
  }

  // 节点（去重后的截交点）
  const nodes: Vec3[] = [];
  const snapMap = new Map<string, number>();
  const nodeId = (p: Vec3): number => {
    const key = `${Math.round(p.x / snap)}|${Math.round(p.y / snap)}|${Math.round(p.z / snap)}`;
    const existing = snapMap.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push(p);
    snapMap.set(key, id);
    return id;
  };
  const vertexNode = (i: number): number => nodeId(meshVertex(mesh, i));

  // 无向图邻接表（Map 允许重边计数），半边消耗后即移除
  const adjacency: Map<number, number>[] = [];
  const undirectedKeys = new Set<string>();
  const ensureAdj = (id: number) => {
    while (adjacency.length <= id) adjacency.push(new Map());
    return adjacency[id];
  };
  /** 同一对节点只接受一条截交线，避免共面/共棱相邻面重复计数 */
  const addSegment = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}~${b}` : `${b}~${a}`;
    if (undirectedKeys.has(key)) return;
    undirectedKeys.add(key);
    const ma = ensureAdj(a);
    const mb = ensureAdj(b);
    ma.set(b, (ma.get(b) ?? 0) + 1);
    mb.set(a, (mb.get(a) ?? 0) + 1);
  };

  let segmentCount = 0;
  const triCount = mesh.indices.length / 3;
  const zeroEdgeKey = (a: number, b: number) => (a < b ? `${a}#${b}` : `${b}#${a}`);
  // 完全共面三角形的三条边属于"贴在平面上的面"，不是截交线，预先排除。
  const coplanarEdgeSet = new Set<string>();
  // 第一遍收集异号求交产生的节点；零-零边只在连接到这些节点时才是真截交线。
  const crossNodeSet = new Set<number>();
  const pendingZeroEdges: [number, number][] = [];
  // 记录每条边两侧三角形第三顶点的符号：真正的截交棱两侧必跨平面，
  // 贴面网格内部的边两侧三角形在同一侧（或共面），据此剔除伪截交线。
  const edgeSideSigns = new Map<string, Set<number>>();
  const signOf = (d: number) => (d > 0 ? 1 : d < 0 ? -1 : 0);
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    if (dist[ia] === 0 && dist[ib] === 0 && dist[ic] === 0) {
      coplanarEdgeSet.add(zeroEdgeKey(ia, ib));
      coplanarEdgeSet.add(zeroEdgeKey(ib, ic));
      coplanarEdgeSet.add(zeroEdgeKey(ic, ia));
    }
    // 严格异号边的求交点
    const triEdges: [number, number, number][] = [
      [ia, ib, ic],
      [ib, ic, ia],
      [ic, ia, ib],
    ];
    for (const [i, j, k] of triEdges) {
      if (dist[i] * dist[j] < 0) {
        const tHit = dist[i] / (dist[i] - dist[j]);
        crossNodeSet.add(nodeId(lerp(meshVertex(mesh, i), meshVertex(mesh, j), tHit)));
      }
      if (dist[i] === 0 && dist[j] === 0 && dist[k] !== 0) {
        const key = zeroEdgeKey(i, j);
        if (!edgeSideSigns.has(key)) edgeSideSigns.set(key, new Set());
        edgeSideSigns.get(key)!.add(signOf(dist[k]));
      }
    }
    // 暂存"两顶点在平面上、第三点不在"的零-零边候选
    const onPlane: number[] = [];
    if (dist[ia] === 0) onPlane.push(ia);
    if (dist[ib] === 0) onPlane.push(ib);
    if (dist[ic] === 0) onPlane.push(ic);
    if (onPlane.length === 2) pendingZeroEdges.push([onPlane[0], onPlane[1]]);
  }

  // 零-零边：满足以下任一条件才是真截交线——
  // (a) 至少一端连接严格异号求交节点；
  // (b) 棱两侧的三角形跨平面（同时出现 +1 与 -1 侧），如环体 x=0。
  const zeroEdgeSeen = new Set<string>();
  for (const [va, vb] of pendingZeroEdges) {
    const k = zeroEdgeKey(va, vb);
    if (zeroEdgeSeen.has(k) || coplanarEdgeSet.has(k)) continue;
    const na = vertexNode(va);
    const nb = vertexNode(vb);
    const sides = edgeSideSigns.get(k);
    const straddles = !!sides && sides.has(1) && sides.has(-1);
    if (straddles || crossNodeSet.has(na) || crossNodeSet.has(nb)) {
      zeroEdgeSeen.add(k);
      addSegment(na, nb);
      segmentCount++;
    }
  }

  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    const da = dist[ia];
    const db = dist[ib];
    const dc = dist[ic];

    // 整个三角面在平面上（贴着面）：不产生截面线段
    if (da === 0 && db === 0 && dc === 0) continue;

    const pointIds: number[] = [];
    const pushVertex = (i: number) => {
      const id = vertexNode(i);
      if (!pointIds.includes(id)) pointIds.push(id);
    };
    const pushEdgeCross = (i: number, di: number, j: number, dj: number) => {
      // 仅处理严格异号边；一端在平面上的情况由顶点交点负责
      if (di * dj < 0) {
        const tHit = di / (di - dj);
        const id = nodeId(lerp(meshVertex(mesh, i), meshVertex(mesh, j), tHit));
        if (!pointIds.includes(id)) pointIds.push(id);
      }
    };

    if (da === 0) pushVertex(ia);
    if (db === 0) pushVertex(ib);
    if (dc === 0) pushVertex(ic);
    pushEdgeCross(ia, da, ib, db);
    pushEdgeCross(ib, db, ic, dc);
    pushEdgeCross(ic, dc, ia, da);

    // 纯零-零边（贴面网格内部边）已在第一遍按跨面判据处理；
    // 这里只在出现严格异号求交点时建段，避免把贴面网格当成截面。
    const hasStrictCross = da * db < 0 || db * dc < 0 || dc * da < 0;
    if (!hasStrictCross) continue;

    // 合法截交恰为一条线段（两个不同节点）；
    // >2 只可能出现在数值退化情况下；共线时只保留两端。
    if (pointIds.length >= 3 && collinearNodes(pointIds, nodes)) {
      const ends = farthestPair(pointIds, nodes);
      pointIds.length = 0;
      pointIds.push(ends[0], ends[1]);
    }
    if (pointIds.length >= 2) {
      addSegment(pointIds[0], pointIds[1]);
      segmentCount++;
    }
  }

  // ---------- 图规范化：半边实例配对，拆分 T 型/十字节点 ----------
  // 细分网格的截面上会出现同一空间点挂 4 条半边的节点（T 型/十字），
  // 直接贪心选边会在非流形节点处串错环。做法：
  // 1) 每条截交线段生成两个半边实例（h1,h2），记录各自所属节点；
  // 2) 每个节点把挂在它上面的半边按平面内出射角排序，相邻两两配对；
  // 3) 遍历到达某半边的对端后，直接走该节点上与它配对的半边。
  // 这样无须真正复制节点，环与链的拓扑由半边配对关系唯一确定。
  const basis = makeBasis(n, plane.w);
  const angleOf = (from: number, to: number): number => {
    const d = sub(nodes[to], nodes[from]);
    return Math.atan2(dot(d, basis.v), dot(d, basis.u));
  };

  interface HalfEdge {
    /** 半边起点（节点 id） */
    origin: number;
    /** 半边终点（节点 id） */
    end: number;
    /** 同一条截交线段的反向半边 id */
    reverse: number;
    /** 同一节点上与本半边配对的半边 id（-1 = 未配对，即链端点） */
    pair: number;
  }
  const halfEdges: HalfEdge[] = [];
  const halvesAtNode = new Map<number, number[]>();
  const addHalfEdge = (origin: number, end: number, reverse: number): number => {
    const id = halfEdges.length;
    halfEdges.push({ origin, end, reverse, pair: -1 });
    if (!halvesAtNode.has(origin)) halvesAtNode.set(origin, []);
    halvesAtNode.get(origin)!.push(id);
    return id;
  };

  for (let i = 0; i < adjacency.length; i++) {
    if (!adjacency[i]) continue;
    for (const [neighbor, count] of adjacency[i]) {
      // 重边（同节点对出现 count 次）：只让 i<neighbor 的一侧生成，避免重复
      if (i >= neighbor) continue;
      for (let k = 0; k < count; k++) {
        const h1 = addHalfEdge(i, neighbor, -1);
        const h2 = addHalfEdge(neighbor, i, h1);
        halfEdges[h1].reverse = h2;
      }
    }
  }

  // 节点内按出射角排序，相邻半边两两配对（度为奇数时最后一条保持未配对）
  for (const [nodeId, halfIds] of halvesAtNode) {
    halfIds.sort((a, b) => angleOf(nodeId, halfEdges[a].end) - angleOf(nodeId, halfEdges[b].end));
    for (let p = 0; p + 1 < halfIds.length; p += 2) {
      halfEdges[halfIds[p]].pair = halfIds[p + 1];
      halfEdges[halfIds[p + 1]].pair = halfIds[p];
    }
  }

  const usedHalf = new Uint8Array(halfEdges.length);
  const openChains: OpenChain[] = [];
  const loopPaths: Vec3[][] = [];

  /** 从半边 h 出发沿配对关系行走，返回经过的节点序列 */
  const walkFrom = (startHalf: number): number[] => {
    const pathNodes = [halfEdges[startHalf].origin];
    let h = startHalf;
    usedHalf[h] = 1;
    while (true) {
      pathNodes.push(halfEdges[h].end);
      const reverse = halfEdges[h].reverse;
      usedHalf[reverse] = 1;
      const next = halfEdges[reverse].pair;
      if (next === -1) break; // 链端点
      h = next;
      usedHalf[h] = 1;
      if (h === startHalf) break; // 闭合环
    }
    return pathNodes;
  };

  // 1) 未闭合链：从未配对半边（链端点）出发
  for (let id = 0; id < halfEdges.length; id++) {
    if (!usedHalf[id] && halfEdges[id].pair === -1) {
      const path = walkFrom(id);
      if (path.length >= 2) {
        const pts = path.map((nid) => nodes[nid]);
        openChains.push({ points: pts, length: polylineLength(pts) });
      }
    }
  }

  // 2) 闭合环：剩余已配对半边
  for (let id = 0; id < halfEdges.length; id++) {
    if (!usedHalf[id]) {
      const path = walkFrom(id);
      if (path.length >= 4 && path[0] === path[path.length - 1]) {
        loopPaths.push(path.slice(0, -1).map((nid) => nodes[nid]));
      }
    }
  }

  // ---------- 计算面积 / 周长 / 内外环嵌套 ----------

  const loops: Loop[] = loopPaths.map((pts) => buildLoop(pts, basis));
  assignNesting(loops, basis);

  let sectionArea = 0;
  let totalPerimeter = 0;
  for (const loop of loops) {
    const a = Math.abs(loop.signedArea2D);
    sectionArea += loop.depth % 2 === 0 ? a : -a;
    totalPerimeter += loop.perimeter;
  }

  return {
    loops,
    openChains,
    segmentCount,
    sectionArea: Math.abs(sectionArea),
    totalPerimeter,
    basis,
  };
}

function polylineLength(pts: Vec3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += len(sub(pts[i], pts[i - 1]));
  return l;
}

function collinearNodes(ids: number[], nodes: Vec3[]): boolean {
  if (ids.length < 3) return true;
  const a = nodes[ids[0]];
  const b = nodes[ids[1]];
  const ab = sub(b, a);
  for (let i = 2; i < ids.length; i++) {
    if (len(cross(ab, sub(nodes[ids[i]], a))) > 1e-9) return false;
  }
  return true;
}

function farthestPair(ids: number[], nodes: Vec3[]): [number, number] {
  let best: [number, number] = [ids[0], ids[1]];
  let bestD = -1;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = len(sub(nodes[ids[i]], nodes[ids[j]]));
      if (d > bestD) {
        bestD = d;
        best = [ids[i], ids[j]];
      }
    }
  }
  return best;
}

function makeBasis(n: Vec3, w: number): Basis2D {
  const origin = scale(n, w);
  const ref: Vec3 = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = normalize(sub(ref, scale(n, dot(ref, n))));
  const v = cross(n, u); // u × v = n，右手系
  return { origin, u, v };
}

function project2D(p: Vec3, b: Basis2D): { x: number; y: number } {
  const d = sub(p, b.origin);
  return { x: dot(d, b.u), y: dot(d, b.v) };
}

function buildLoop(points: Vec3[], basis: Basis2D): Loop {
  let twiceArea = 0;
  let perimeter = 0;
  const xy = points.map((p) => project2D(p, basis));
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i];
    const c = xy[(i + 1) % xy.length];
    twiceArea += a.x * c.y - c.x * a.y;
    perimeter += len(sub(points[(i + 1) % points.length], points[i]));
  }
  return { points, depth: 0, signedArea2D: twiceArea / 2, perimeter };
}

/**
 * 确定内外环嵌套深度。
 * 同心环的形心/顶点平均会重合，射线法与形心法都无法区分谁包含谁；
 * 但在一张截面里"面积更大的环一定包含面积更小的环"（环互不相交），
 * 因此按面积降序排列，每个环的深度 = 包含它的更大环数量（绕数确认）。
 */
function assignNesting(loops: Loop[], basis: Basis2D): void {
  const projected = loops.map((loop) => loop.points.map((p) => project2D(p, basis)));
  const order = loops.map((_, i) => i).sort((a, b) => Math.abs(loops[b].signedArea2D) - Math.abs(loops[a].signedArea2D));
  for (let rank = 0; rank < order.length; rank++) {
    const i = order[rank];
    let depth = 0;
    // 只需检查面积更大（排序更靠前）的环是否包含本环测试点
    for (let k = 0; k < rank; k++) {
      const j = order[k];
      const testPoint = projected[i][0];
      if (windingNumber(testPoint, projected[j]) !== 0) depth++;
    }
    loops[i].depth = depth;
  }
}

/** 绕数：点在多边形内为非 0（符号取决于绕序），外面为 0 */
function windingNumber(p: { x: number; y: number }, poly: { x: number; y: number }[]): number {
  let wn = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y <= p.y) {
      if (b.y > p.y && cross2(a, b, p) > 0) wn++;
    } else if (b.y <= p.y && cross2(a, b, p) < 0) wn--;
  }
  return wn;
}

function cross2(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
