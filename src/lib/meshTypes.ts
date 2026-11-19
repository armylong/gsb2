/**
 * 共享的网格数据结构与工具。
 * MeshData 只存位置与索引，渲染所需的法线/颜色在显示层派生。
 */

export interface MeshData {
  /** 每 3 个浮点数一个顶点 (x, y, z) */
  positions: Float32Array;
  /** 每 3 个无符号整数一个三角形 (i0, i1, i2) */
  indices: Uint32Array;
}

export interface BoundaryInfo {
  /** 仅出现在一个三角形中的边的数量 */
  edgeCount: number;
  /** 落在边界上的顶点数量 */
  vertexCount: number;
  /** 边界闭合回路（环）的数量 */
  loopCount: number;
  /** 每条边界环上的顶点索引，按环顺序排列 */
  loops: number[][];
}

export interface SampleDescriptor {
  id: string;
  label: string;
  description: string;
}

export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

/** 深拷贝一份网格（Float32Array / Uint32Array 是定长类型数组，slice 即复制）。 */
export function cloneMesh(mesh: MeshData): MeshData {
  return {
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
  };
}

/**
 * 将网格居中并缩放到统一尺寸：最长包围盒边归一化为 targetSize，中心移到原点。
 * 所有样例都经过同一变换，因此并排视图可以共用同一相机与坐标刻度，
 * 不会对每边独立适配而掩盖收缩或偏移。
 */
export function normalizeMesh(mesh: MeshData, targetSize = 4): MeshData {
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const s = targetSize / extent;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = (p[i] - cx) * s;
    out[i + 1] = (p[i + 1] - cy) * s;
    out[i + 2] = (p[i + 2] - cz) * s;
  }
  return { positions: out, indices: mesh.indices.slice() };
}

/**
 * 按位置焊接顶点，返回焊接后的新网格。
 * 用途：
 * - 边界统计需要区分“物理开口”与“硬边/参数缝处的重复顶点”，
 *   后者位置相同、仅法线等属性不同，不构成物理边界；
 * - 简化前焊接可避免重复顶点阻断边折叠。
 * 原始网格（含硬边着色所需的重复顶点）保持不变。
 */
export function weldByPosition(mesh: MeshData, tolerance = 1e-6): MeshData {
  const n = mesh.positions.length / 3;
  const remap = new Int32Array(n).fill(-1);
  const quant = 1 / tolerance;
  // 每个哈希桶保存若干“新顶点号”，同桶再逐分量比对
  const buckets = new Map<number, number[]>();
  const newPositions: number[] = [];

  const hashFor = (v: number): number => {
    const x = Math.round(mesh.positions[v * 3] * quant);
    const y = Math.round(mesh.positions[v * 3 + 1] * quant);
    const z = Math.round(mesh.positions[v * 3 + 2] * quant);
    let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return h >>> 0;
  };

  for (let v = 0; v < n; v++) {
    const px = mesh.positions[v * 3];
    const py = mesh.positions[v * 3 + 1];
    const pz = mesh.positions[v * 3 + 2];
    const hash = hashFor(v);
    const bucket = buckets.get(hash);
    let mapped = -1;
    if (bucket) {
      for (const candidate of bucket) {
        if (
          Math.abs(newPositions[candidate * 3] - px) <= tolerance &&
          Math.abs(newPositions[candidate * 3 + 1] - py) <= tolerance &&
          Math.abs(newPositions[candidate * 3 + 2] - pz) <= tolerance
        ) {
          mapped = candidate;
          break;
        }
      }
    }
    if (mapped < 0) {
      mapped = newPositions.length / 3;
      if (!bucket) buckets.set(hash, [mapped]);
      else bucket.push(mapped);
      newPositions.push(px, py, pz);
    }
    remap[v] = mapped;
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) indices[i] = remap[mesh.indices[i]];
  return { positions: Float32Array.from(newPositions), indices };
}

/** 统计边界边、边界顶点与边界环。边界边 = 仅被一个三角形引用的边（忽略方向）。 */
export function computeBoundary(mesh: MeshData): BoundaryInfo {
  // 先按位置焊接，避免把硬边/参数缝的重复顶点误判为物理开口
  const welded = weldByPosition(mesh);
  const { indices } = welded;
  // key = min*N + max，value = 出现次数（正常流形网格只会是 1 或 2）
  const n = welded.positions.length / 3;
  const edgeCount = new Map<number, number>();
  const addEdge = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * n + hi;
    edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < indices.length; i += 3) {
    addEdge(indices[i], indices[i + 1]);
    addEdge(indices[i + 1], indices[i + 2]);
    addEdge(indices[i + 2], indices[i]);
  }

  // 邻接表：边界顶点 -> 相邻边界顶点
  const adjacency = new Map<number, number[]>();
  let boundaryEdgeCount = 0;
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue;
    boundaryEdgeCount++;
    const a = Math.floor(key / n);
    const b = key % n;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  }

  // 沿邻接表走出闭合环
  const visited = new Set<number>();
  const loops: number[][] = [];
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let current = start;
    // 每个边界顶点在流形网格上恰好有 2 个边界邻居；任取其一出发
    let previous = -1;
    while (!visited.has(current)) {
      visited.add(current);
      loop.push(current);
      const neighbors = adjacency.get(current)!;
      const next = neighbors.find((v) => v !== previous && !visited.has(v));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    loops.push(loop);
  }

  return {
    edgeCount: boundaryEdgeCount,
    vertexCount: adjacency.size,
    loopCount: loops.length,
    loops,
  };
}
