import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Triangle,
  Vector3,
} from 'three';
import type { ClosestSurfaceHit, SegmentPath, SurfaceAnchor } from './types';

export interface HoleCircle {
  center: [number, number];
  radius: number;
}

export interface SurfaceMeshData {
  /** 网格局部坐标，xyz 连续排列 */
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  name?: string;
  /** 仅供样例/测试使用的孔洞描述（x,z 平面） */
  holes?: HoleCircle[];
}

interface NeighborEdge {
  tri: number;
  /** 共享边的两个顶点（升序无关，仅用于取 3D 端点） */
  v0: number;
  v1: number;
}

const EPS = 1e-9;

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();
const _bary = new Vector3();
const _closest = new Vector3();
const _segA = new Vector3();
const _segB = new Vector3();
const _faceNormal = new Vector3();
const _edge0 = new Vector3();
const _edge1 = new Vector3();
const scratchTriangle = [new Vector3(), new Vector3(), new Vector3()];

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const { ids, keys } = this;
    ids.push(id);
    keys.push(key);
    let i = ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length > 0) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < ids.length && keys[l] < keys[smallest]) smallest = l;
        if (r < ids.length && keys[r] < keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    const { ids, keys } = this;
    const ti = ids[i];
    ids[i] = ids[j];
    ids[j] = ti;
    const tk = keys[i];
    keys[i] = keys[j];
    keys[j] = tk;
  }
}

/**
 * 三角网格表面：邻接关系、连通分量、A* 三角走廊、把走廊变成贴在表面上的折线。
 *
 * 关键性质：最终折线中每一段都完整落在某一个三角形所在的平面内，
 * 因此线段不会穿到模型内部，也不会跨过被挖掉的孔洞。
 */
export class SurfaceMesh {
  readonly dataName: string;
  readonly holes: HoleCircle[];
  readonly geometry: BufferGeometry;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;

  private readonly positionAttr: BufferAttribute;
  private readonly normalAttr: BufferAttribute;
  private readonly triVertices: Uint32Array; // 3 / triangle
  private readonly neighbors: NeighborEdge[][];
  private readonly trianglesOfVertex: number[][];
  private readonly componentOfTriangle: Int32Array;
  private readonly componentCountValue: number;
  private readonly triCentroids: Float32Array; // 3 / triangle
  private readonly triNormals: Float32Array; // 3 / triangle
  private readonly basePositions: Float32Array;

  constructor(data: SurfaceMeshData) {
    this.dataName = data.name ?? 'surface';
    this.holes = data.holes ? data.holes.map((h) => ({ ...h, center: [...h.center] as [number, number] })) : [];

    this.positions = Float32Array.from(data.positions);
    this.basePositions = new Float32Array(this.positions);
    this.indices = Uint32Array.from(data.indices);
    this.vertexCount = this.positions.length / 3;
    this.triangleCount = this.indices.length / 3;
    this.triVertices = new Uint32Array(this.indices);

    const geometry = new BufferGeometry();
    this.positionAttr = new BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setIndex(new BufferAttribute(this.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.normalAttr = geometry.getAttribute('normal') as BufferAttribute;

    this.triCentroids = new Float32Array(this.triangleCount * 3);
    this.triNormals = new Float32Array(this.triangleCount * 3);

    const edgeMap = new Map<string, { t: number; v0: number; v1: number }[]>();
    this.trianglesOfVertex = Array.from({ length: this.vertexCount }, () => [] as number[]);

    for (let t = 0; t < this.triangleCount; t++) {
      const a = this.triVertices[t * 3];
      const b = this.triVertices[t * 3 + 1];
      const c = this.triVertices[t * 3 + 2];
      this.trianglesOfVertex[a].push(t);
      this.trianglesOfVertex[b].push(t);
      this.trianglesOfVertex[c].push(t);
      this.addEdge(edgeMap, a, b, t);
      this.addEdge(edgeMap, b, c, t);
      this.addEdge(edgeMap, c, a, t);
    }

    this.neighbors = Array.from({ length: this.triangleCount }, () => [] as NeighborEdge[]);
    for (const entries of edgeMap.values()) {
      if (entries.length !== 2) continue; // 边界或非流形边：不允许跨越
      const [e0, e1] = entries;
      this.neighbors[e0.t].push({ tri: e1.t, v0: e0.v0, v1: e0.v1 });
      this.neighbors[e1.t].push({ tri: e0.t, v0: e0.v0, v1: e0.v1 });
    }

    this.componentOfTriangle = new Int32Array(this.triangleCount).fill(-1);
    let comp = 0;
    for (let t = 0; t < this.triangleCount; t++) {
      if (this.componentOfTriangle[t] !== -1) continue;
      const stack = [t];
      this.componentOfTriangle[t] = comp;
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nb of this.neighbors[cur]) {
          if (this.componentOfTriangle[nb.tri] === -1) {
            this.componentOfTriangle[nb.tri] = comp;
            stack.push(nb.tri);
          }
        }
      }
      comp++;
    }
    this.componentCountValue = comp;

    const allTris = new Uint32Array(this.triangleCount);
    for (let t = 0; t < this.triangleCount; t++) allTris[t] = t;
    this.refreshTriangles(allTris);
  }

  private addEdge(
    map: Map<string, { t: number; v0: number; v1: number }[]>,
    a: number,
    b: number,
    t: number,
  ): void {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push({ t, v0: a, v1: b });
  }

  get componentCount(): number {
    return this.componentCountValue;
  }

  getTriangleVertexIndices(tri: number): [number, number, number] {
    return [this.triVertices[tri * 3], this.triVertices[tri * 3 + 1], this.triVertices[tri * 3 + 2]];
  }

  getTrianglePoints(tri: number, target?: Vector3[]): Vector3[] {
    const out = target ?? [new Vector3(), new Vector3(), new Vector3()];
    for (let k = 0; k < 3; k++) {
      const vi = this.triVertices[tri * 3 + k];
      out[k].set(this.positions[vi * 3], this.positions[vi * 3 + 1], this.positions[vi * 3 + 2]);
    }
    return out;
  }

  componentOf(tri: number): number {
    return this.componentOfTriangle[tri];
  }

  trianglesAdjacentToVertex(index: number): number[] {
    return this.trianglesOfVertex[index] ?? [];
  }

  /** 返回三角形的世界（网格局部）面法线 */
  faceNormal(tri: number, target = new Vector3()): Vector3 {
    return target.set(
      this.triNormals[tri * 3],
      this.triNormals[tri * 3 + 1],
      this.triNormals[tri * 3 + 2],
    );
  }

  centroid(tri: number, target = new Vector3()): Vector3 {
    return target.set(
      this.triCentroids[tri * 3],
      this.triCentroids[tri * 3 + 1],
      this.triCentroids[tri * 3 + 2],
    );
  }

  /** 把 anchor 解析成局部坐标点 */
  anchorPosition(anchor: SurfaceAnchor, target = new Vector3()): Vector3 {
    const [b0, b1, b2] = anchor.bary;
    const [v0, v1, v2] = this.getTriangleVertexIndices(anchor.tri);
    const p = this.positions;
    target.set(
      p[v0 * 3] * b0 + p[v1 * 3] * b1 + p[v2 * 3] * b2,
      p[v0 * 3 + 1] * b0 + p[v1 * 3 + 1] * b1 + p[v2 * 3 + 1] * b2,
      p[v0 * 3 + 2] * b0 + p[v1 * 3 + 2] * b1 + p[v2 * 3 + 2] * b2,
    );
    return target;
  }

  /** 在三角形内插值顶点法线，用于把线/点沿表面微微抬起，避免 z-fighting */
  anchorNormal(anchor: SurfaceAnchor, target = new Vector3()): Vector3 {
    const [b0, b1, b2] = anchor.bary;
    const [v0, v1, v2] = this.getTriangleVertexIndices(anchor.tri);
    const n = this.normalAttr;
    target.set(
      n.getX(v0) * b0 + n.getX(v1) * b1 + n.getX(v2) * b2,
      n.getY(v0) * b0 + n.getY(v1) * b1 + n.getY(v2) * b2,
      n.getZ(v0) * b0 + n.getZ(v1) * b1 + n.getZ(v2) * b2,
    );
    if (target.lengthSq() < 1e-12) this.faceNormal(anchor.tri, target);
    return target.normalize();
  }

  /** 任意表面点（已知所属三角形）处的插值法线 */
  pointNormal(point: Vector3, tri: number, target = new Vector3()): Vector3 {
    const pts = this.getTrianglePoints(tri, scratchTriangle);
    if (Triangle.getBarycoord(point, pts[0], pts[1], pts[2], _bary) === null) {
      return this.faceNormal(tri, target);
    }
    const [v0, v1, v2] = this.getTriangleVertexIndices(tri);
    const n = this.normalAttr;
    const b0 = Math.max(0, _bary.x);
    const b1 = Math.max(0, _bary.y);
    const b2 = Math.max(0, _bary.z);
    target.set(
      n.getX(v0) * b0 + n.getX(v1) * b1 + n.getX(v2) * b2,
      n.getY(v0) * b0 + n.getY(v1) * b1 + n.getY(v2) * b2,
      n.getZ(v0) * b0 + n.getZ(v1) * b1 + n.getZ(v2) * b2,
    );
    if (target.lengthSq() < 1e-12) return this.faceNormal(tri, target);
    return target.normalize();
  }

  /** 求任意点在本网格上的最近点（用于把外部坐标吸附到表面） */
  closestPoint(point: Vector3): ClosestSurfaceHit | null {
    let bestDistSq = Infinity;
    let bestTri = -1;
    let bestBary: [number, number, number] = [0, 0, 0];

    for (let t = 0; t < this.triangleCount; t++) {
      const a = this.triVertices[t * 3];
      const b = this.triVertices[t * 3 + 1];
      const c = this.triVertices[t * 3 + 2];
      _a.fromArray(this.positions, a * 3);
      _b.fromArray(this.positions, b * 3);
      _c.fromArray(this.positions, c * 3);
      if (Triangle.getBarycoord(point, _a, _b, _c, _bary) === null) continue;
      clampBaryInside(_bary);
      _closest
        .copy(_a)
        .multiplyScalar(_bary.x)
        .addScaledVector(_b, _bary.y)
        .addScaledVector(_c, _bary.z);
      const d = _closest.distanceToSquared(point);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestTri = t;
        bestBary = [_bary.x, _bary.y, _bary.z];
      }
    }

    if (bestTri < 0) return null;
    return {
      tri: bestTri,
      bary: bestBary,
      point: this.anchorPosition({ tri: bestTri, bary: bestBary }),
      distance: Math.sqrt(bestDistSq),
    };
  }

  /** 用最近点把 anchor 投影到合法范围（恢复存档时做健壮性检查） */
  sanitizeAnchor(anchor: SurfaceAnchor): SurfaceAnchor | null {
    if (!Number.isFinite(anchor.tri)) return null;
    if (anchor.tri < 0 || anchor.tri >= this.triangleCount) return null;
    const [b0, b1, b2] = anchor.bary;
    if (![b0, b1, b2].every((x) => Number.isFinite(x))) return null;
    const sum = b0 + b1 + b2;
    if (sum <= EPS) return null;
    return { tri: anchor.tri, bary: [b0 / sum, b1 / sum, b2 / sum] };
  }

  /**
   * 计算两个表面锚点之间的“贴面”折线。
   *
   * 1. A* 在三角形对偶图上找一条不跨孔洞、不跨断面的走廊；
   * 2. 在走廊的每条公共边上取一个穿越点，用带约束的坐标下降把折线拉紧；
   * 3. 因为相邻穿越点一定属于同一个三角形，每一小段都精确落在该三角形平面上。
   */
  findPath(start: SurfaceAnchor, end: SurfaceAnchor): SegmentPath {
    const s = this.sanitizeAnchor(start);
    const e = this.sanitizeAnchor(end);
    if (!s || !e) return emptyPath('invalid-anchor');

    const startPoint = this.anchorPosition(s);
    const endPoint = this.anchorPosition(e);

    if (s.tri === e.tri) {
      const points = [startPoint, endPoint];
      return {
        ok: true,
        points,
        pointTriangles: [s.tri],
        triangles: [s.tri],
        length: startPoint.distanceTo(endPoint),
        method: 'same-triangle',
      };
    }

    if (this.componentOfTriangle[s.tri] !== this.componentOfTriangle[e.tri]) {
      return emptyPath('disconnected');
    }

    const triSeq = this.searchTrianglePath(s.tri, e.tri, endPoint);
    if (!triSeq) return emptyPath('no-path');

    const portals: { a: Vector3; b: Vector3 }[] = [];
    for (let i = 0; i < triSeq.length - 1; i++) {
      const edge = this.neighbors[triSeq[i]].find((nb) => nb.tri === triSeq[i + 1]);
      if (!edge) return emptyPath('no-path');
      portals.push({
        a: this.vertexPoint(edge.v0),
        b: this.vertexPoint(edge.v1),
      });
    }

    if (portals.length === 0) return emptyPath('no-path');

    const points: Vector3[] = [startPoint];
    for (const portal of portals) {
      points.push(new Vector3().addVectors(portal.a, portal.b).multiplyScalar(0.5));
    }
    points.push(endPoint);

    // 先在每条公共边上做一次离散动态规划，得到全局较优的穿越点；
    // 再做几轮连续坐标下降，把离散采样的误差磨掉。
    this.optimizePortalsDP(points, portals, startPoint, endPoint);
    this.tauten(points, portals);

    let length = 0;
    for (let i = 0; i < points.length - 1; i++) length += points[i].distanceTo(points[i + 1]);

    // 第 j 段位于 triSeq[j]；首点在 triSeq[0] 上，尾点在 triSeq[n] 上
    const pointTriangles: number[] = [...triSeq];

    return {
      ok: true,
      points,
      pointTriangles,
      triangles: triSeq,
      length,
      method: portals.length > 1 ? 'smoothed' : 'midpoint',
    };
  }

  private vertexPoint(index: number): Vector3 {
    return new Vector3(
      this.positions[index * 3],
      this.positions[index * 3 + 1],
      this.positions[index * 3 + 2],
    );
  }

  /**
   * 在三角形走廊上求一条更短的折线：每条公共边上采样若干点，做动态规划。
   *
   * DP 状态 = 第 i 条边上的采样点；转移代价 = 两点欧氏距离。
   * 由于相邻两个穿越点一定同属某个三角形，段内直线天然落在该三角形平面内。
   */
  private optimizePortalsDP(
    points: Vector3[],
    portals: { a: Vector3; b: Vector3 }[],
    start: Vector3,
    end: Vector3,
  ): void {
    const m = portals.length;
    if (m === 0) return;
    // 走廊越长，采样越稀，保证 O(m·K²) 可控
    const samples = m > 900 ? 3 : m > 400 ? 5 : m > 150 ? 7 : 9;

    const samplePoints: Vector3[][] = portals.map(({ a, b }) => {
      const list: Vector3[] = [];
      for (let k = 0; k < samples; k++) {
        list.push(new Vector3().lerpVectors(a, b, k / (samples - 1)));
      }
      return list;
    });

    const INF = Number.POSITIVE_INFINITY;
    const costs: Float32Array[] = [];
    const froms: Int32Array[] = [];

    let prevCost = new Float32Array(samples).fill(INF);
    let prevFrom = new Int32Array(samples).fill(-1);
    for (let k = 0; k < samples; k++) prevCost[k] = start.distanceTo(samplePoints[0][k]);
    costs.push(prevCost);
    froms.push(prevFrom);

    for (let i = 1; i < m; i++) {
      const cost = new Float32Array(samples).fill(INF);
      const from = new Int32Array(samples).fill(-1);
      for (let b = 0; b < samples; b++) {
        const pb = samplePoints[i][b];
        let best = INF;
        let bestA = -1;
        for (let a = 0; a < samples; a++) {
          const pc = prevCost[a];
          if (!Number.isFinite(pc)) continue;
          const c = pc + samplePoints[i - 1][a].distanceTo(pb);
          if (c < best) {
            best = c;
            bestA = a;
          }
        }
        cost[b] = best;
        from[b] = bestA;
      }
      prevCost = cost;
      prevFrom = from;
      costs.push(cost);
      froms.push(from);
    }

    let bestEnd = INF;
    let bestEndIndex = -1;
    for (let k = 0; k < samples; k++) {
      if (!Number.isFinite(prevCost[k])) continue;
      const c = prevCost[k] + samplePoints[m - 1][k].distanceTo(end);
      if (c < bestEnd) {
        bestEnd = c;
        bestEndIndex = k;
      }
    }
    if (bestEndIndex < 0) return;

    let index = bestEndIndex;
    for (let i = m - 1; i >= 0; i--) {
      points[i + 1].copy(samplePoints[i][index]);
      index = froms[i][index];
      if (index < 0) break;
    }
  }

  private tauten(points: Vector3[], portals: { a: Vector3; b: Vector3 }[]): void {
    const m = portals.length;
    if (m === 0) return;
    const sweeps = m > 400 ? 8 : m > 120 ? 16 : 28;
    _segA.set(0, 0, 0);
    _segB.set(0, 0, 0);

    for (let sweep = 0; sweep < sweeps; sweep++) {
      for (let i = 0; i < m; i++) {
        const { a, b } = portals[i];
        const index = i + 1;
        const prev = points[index - 1];
        const next = points[index + 1];
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 22; k++) {
          const t1 = lo + (hi - lo) / 3;
          const t2 = hi - (hi - lo) / 3;
          _segA.lerpVectors(a, b, t1);
          _segB.lerpVectors(a, b, t2);
          const f1 = _segA.distanceTo(prev) + next.distanceTo(_segA);
          const f2 = _segB.distanceTo(prev) + next.distanceTo(_segB);
          if (f1 <= f2) hi = t2;
          else lo = t1;
        }
        points[index].lerpVectors(a, b, (lo + hi) * 0.5);
      }
    }
  }

  private searchTrianglePath(sTri: number, eTri: number, endPoint: Vector3): number[] | null {
    const n = this.triangleCount;
    const g = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const heur = (tri: number): number => {
      const cx = this.triCentroids[tri * 3];
      const cy = this.triCentroids[tri * 3 + 1];
      const cz = this.triCentroids[tri * 3 + 2];
      return Math.hypot(cx - endPoint.x, cy - endPoint.y, cz - endPoint.z);
    };

    g[sTri] = 0;
    heap.push(sTri, heur(sTri));

    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === eTri) break;

      const cx = this.triCentroids[cur * 3];
      const cy = this.triCentroids[cur * 3 + 1];
      const cz = this.triCentroids[cur * 3 + 2];

      for (const nb of this.neighbors[cur]) {
        if (closed[nb.tri]) continue;
        const nx = this.triCentroids[nb.tri * 3];
        const ny = this.triCentroids[nb.tri * 3 + 1];
        const nz = this.triCentroids[nb.tri * 3 + 2];
        const step = Math.hypot(nx - cx, ny - cy, nz - cz);
        const tentative = g[cur] + step;
        if (tentative < g[nb.tri]) {
          g[nb.tri] = tentative;
          cameFrom[nb.tri] = cur;
          heap.push(nb.tri, tentative + heur(nb.tri));
        }
      }
    }

    if (!Number.isFinite(g[eTri])) return null;

    const seq: number[] = [];
    let cur = eTri;
    while (cur !== -1) {
      seq.push(cur);
      if (cur === sTri) break;
      cur = cameFrom[cur];
    }
    if (seq[seq.length - 1] !== sTri) return null;
    seq.reverse();
    return seq;
  }

  /**
   * 编辑一个网格顶点，返回受影响的三角形。
   * 注意：只重算法线 / 派生数据，路线是否更新由 RouteModel 决定。
   */
  moveVertex(vertexIndex: number, x: number, y: number, z: number): number[] {
    if (vertexIndex < 0 || vertexIndex >= this.vertexCount) return [];
    const oldX = this.positions[vertexIndex * 3];
    const oldY = this.positions[vertexIndex * 3 + 1];
    const oldZ = this.positions[vertexIndex * 3 + 2];
    if (Math.abs(oldX - x) < 1e-12 && Math.abs(oldY - y) < 1e-12 && Math.abs(oldZ - z) < 1e-12) {
      return [];
    }
    this.positions[vertexIndex * 3] = x;
    this.positions[vertexIndex * 3 + 1] = y;
    this.positions[vertexIndex * 3 + 2] = z;
    this.commitVertexChanges();
    return [...this.trianglesOfVertex[vertexIndex]];
  }

  /** 批量恢复顶点偏移（相对程序生成的基础形状），返回受影响三角形 */
  applyVertexOffsets(offsets: Map<number, [number, number, number]>): number[] {
    if (offsets.size === 0) return [];
    const affected = new Set<number>();
    for (const [index, offset] of offsets) {
      if (index < 0 || index >= this.vertexCount) continue;
      this.positions[index * 3] = this.basePositions[index * 3] + offset[0];
      this.positions[index * 3 + 1] = this.basePositions[index * 3 + 1] + offset[1];
      this.positions[index * 3 + 2] = this.basePositions[index * 3 + 2] + offset[2];
      for (const t of this.trianglesOfVertex[index] ?? []) affected.add(t);
    }
    if (affected.size > 0) this.commitVertexChanges();
    return [...affected];
  }

  /** 当前所有偏离基础形状的顶点，用于存档 */
  collectVertexOffsets(): Record<number, [number, number, number]> {
    const result: Record<number, [number, number, number]> = {};
    for (let i = 0; i < this.vertexCount; i++) {
      const dx = this.positions[i * 3] - this.basePositions[i * 3];
      const dy = this.positions[i * 3 + 1] - this.basePositions[i * 3 + 1];
      const dz = this.positions[i * 3 + 2] - this.basePositions[i * 3 + 2];
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9 || Math.abs(dz) > 1e-9) {
        result[i] = [dx, dy, dz];
      }
    }
    return result;
  }

  getBaseVertexPosition(index: number, target = new Vector3()): Vector3 {
    return target.fromArray(this.basePositions, index * 3);
  }

  getVertexPosition(index: number, target = new Vector3()): Vector3 {
    return target.fromArray(this.positions, index * 3);
  }

  private commitVertexChanges(): void {
    this.positionAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.normalAttr.needsUpdate = true;
    const all = new Uint32Array(this.triangleCount);
    for (let t = 0; t < this.triangleCount; t++) all[t] = t;
    this.refreshTriangles(all);
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  private refreshTriangles(tris: ArrayLike<number>): void {
    for (let k = 0; k < tris.length; k++) {
      const t = tris[k];
      const [v0, v1, v2] = this.getTriangleVertexIndices(t);
      _a.fromArray(this.positions, v0 * 3);
      _b.fromArray(this.positions, v1 * 3);
      _c.fromArray(this.positions, v2 * 3);
      this.triCentroids[t * 3] = (_a.x + _b.x + _c.x) / 3;
      this.triCentroids[t * 3 + 1] = (_a.y + _b.y + _c.y) / 3;
      this.triCentroids[t * 3 + 2] = (_a.z + _b.z + _c.z) / 3;
      _edge0.subVectors(_b, _a);
      _edge1.subVectors(_c, _a);
      _faceNormal.crossVectors(_edge0, _edge1).normalize();
      if (_faceNormal.lengthSq() < 1e-12) _faceNormal.set(0, 1, 0);
      this.triNormals[t * 3] = _faceNormal.x;
      this.triNormals[t * 3 + 1] = _faceNormal.y;
      this.triNormals[t * 3 + 2] = _faceNormal.z;
    }
  }

  /**
   * 对一段路径做完整校验：
   * - 每段都在声明的三角形内；
   * - 三角形序列前后相邻；
   * - 长度与折线一致。
   */
  validatePath(path: SegmentPath, tolerance = 1e-4): string[] {
    const issues: string[] = [];
    if (!path.ok) return issues;

    if (path.points.length < 2) {
      issues.push('路径点数少于 2');
      return issues;
    }
    if (path.pointTriangles.length !== path.points.length - 1) {
      issues.push('pointTriangles 与线段数量不一致');
    }
    if (path.triangles.length !== path.points.length - 1) {
      issues.push('三角形序列长度与折线段数不一致');
    }

    let total = 0;
    for (let i = 0; i < path.points.length - 1; i++) {
      const tri = path.pointTriangles[i];
      if (tri === undefined || tri < 0 || tri >= this.triangleCount) {
        issues.push(`第 ${i} 段三角形索引非法`);
        continue;
      }
      const pts = this.getTrianglePoints(tri);
      const p0 = path.points[i];
      const p1 = path.points[i + 1];
      for (const s of [0, 0.5, 1]) {
        _p.lerpVectors(p0, p1, s);
        if (Triangle.getBarycoord(_p, pts[0], pts[1], pts[2], _bary) === null) {
          issues.push(`第 ${i} 段不在三角形 ${tri} 所在平面内`);
          break;
        }
        if (_bary.x < -tolerance || _bary.y < -tolerance || _bary.z < -tolerance) {
          issues.push(
            `第 ${i} 段超出三角形 ${tri} 范围 (bary=${_bary.x.toFixed(5)},${_bary.y.toFixed(5)},${_bary.z.toFixed(5)})`,
          );
          break;
        }
      }
      total += p0.distanceTo(p1);
    }

    if (Math.abs(total - path.length) > Math.max(1e-5, path.length * 1e-6)) {
      issues.push('记录长度与折线长度不一致');
    }

    for (let i = 0; i < path.triangles.length - 1; i++) {
      const a = path.triangles[i];
      const b = path.triangles[i + 1];
      if (!this.neighbors[a]?.some((nb) => nb.tri === b)) {
        issues.push(`三角形序列在 ${a} -> ${b} 处不连续`);
      }
    }

    return issues;
  }
}

function clampBaryInside(bary: Vector3): void {
  let x = Math.min(1, Math.max(0, bary.x));
  let y = Math.min(1, Math.max(0, bary.y));
  let z = Math.min(1, Math.max(0, bary.z));
  const sum = x + y + z;
  if (sum <= EPS) {
    x = 1;
    y = 0;
    z = 0;
  } else {
    x /= sum;
    y /= sum;
    z /= sum;
  }
  bary.set(x, y, z);
}

function emptyPath(reason: 'disconnected' | 'no-path' | 'invalid-anchor'): SegmentPath {
  return {
    ok: false,
    reason,
    points: [],
    pointTriangles: [],
    triangles: [],
    length: 0,
  };
}
