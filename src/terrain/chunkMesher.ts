/**
 * 分块网格生成器(纯函数,可在 Worker 与 Node 测试中运行)。
 *
 * 无缝策略:
 * - 块边缘(4 条边)始终以最高分辨率(步长 1)生成顶点,内部按 LOD 步长 k(1/2/4)稀疏;
 * - 以 k×k 个基础单元组成"宏单元":内部宏单元是粗四边形(2 个三角形),
 *   贴边界的宏单元在边界侧带上全部细分点,按多边形环扇形三角化;
 * - 宏单元之间严格共享端点、多边形环恰好铺满块面积,因此无洞、无重叠;
 * - 相邻块共享同一条世界坐标边缘:无论各自内部 LOD 是多少,边缘顶点位置完全一致,
 *   公共边缘不会裂开露背景,也不会产生重叠面闪烁;角点被 4 块共享,多块交界闭合。
 */
import { BASE_RES, CHUNK_SIZE, LOD_STEPS, WORLD_MIN } from './config';
import { sampleHeight } from './heightfield';
import { lodTint, terrainColor } from './coloring';

export interface ChunkMeshData {
  cx: number;
  cz: number;
  lod: number;
  seed: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

const NORMAL_EPS = 0.6;

export function buildChunkMesh(
  cx: number,
  cz: number,
  lod: number,
  seed: number,
): ChunkMeshData {
  const k = LOD_STEPS[lod] ?? 1;
  const B = BASE_RES;
  const M = B / k; // 每边宏单元数
  const originX = WORLD_MIN + cx * CHUNK_SIZE;
  const originZ = WORLD_MIN + cz * CHUNK_SIZE;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const vertexCache = new Map<number, number>();
  const tint = lodTint(lod);

  function vertexId(i: number, j: number): number {
    const key = i * (B + 1) + j;
    const cached = vertexCache.get(key);
    if (cached !== undefined) return cached;

    const wx = originX + (i / B) * CHUNK_SIZE;
    const wz = originZ + (j / B) * CHUNK_SIZE;
    const h = sampleHeight(wx, wz, seed);

    // 有限差分法线:同一点在任意块/任意 LOD 下法线一致
    const hL = sampleHeight(wx - NORMAL_EPS, wz, seed);
    const hR = sampleHeight(wx + NORMAL_EPS, wz, seed);
    const hD = sampleHeight(wx, wz - NORMAL_EPS, seed);
    const hU = sampleHeight(wx, wz + NORMAL_EPS, seed);
    let nx = (hL - hR) / (2 * NORMAL_EPS);
    let nz = (hD - hU) / (2 * NORMAL_EPS);
    let ny = 1;
    const invLen = 1 / Math.hypot(nx, ny, nz);
    nx *= invLen;
    ny *= invLen;
    nz *= invLen;

    const slope = Math.hypot(hR - hL, hU - hD) / (2 * NORMAL_EPS);
    const c = terrainColor(h, slope);

    const id = positions.length / 3;
    positions.push(wx, h, wz);
    normals.push(nx, ny, nz);
    colors.push(c.r * tint.r, c.g * tint.g, c.b * tint.b);
    vertexCache.set(key, id);
    return id;
  }

  /** 该格点是否存在:边界全部细点存在;内部仅 LOD 对齐点存在 */
  function latticeExists(i: number, j: number): boolean {
    if (i === 0 || i === B || j === 0 || j === B) return true;
    return i % k === 0 && j % k === 0;
  }

  /** 沿一条边收集存在的顶点(含两端) */
  function edgeRing(i0: number, j0: number, i1: number, j1: number): number[] {
    const out: number[] = [];
    const steps = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
    for (let s = 0; s <= steps; s++) {
      const i = i0 + ((i1 - i0) * s) / steps;
      const j = j0 + ((j1 - j0) * s) / steps;
      if (latticeExists(i, j)) out.push(vertexId(i, j));
    }
    return out;
  }

  // 逐宏单元构建多边形环(逆时针:底→右→顶→左),再以首点扇形三角化
  for (let a = 0; a < M; a++) {
    for (let b = 0; b < M; b++) {
      const i0 = a * k;
      const i1 = (a + 1) * k;
      const j0 = b * k;
      const j1 = (b + 1) * k;

      const ring: number[] = [];
      // 底边(向南,j=j0)
      edgeRing(i0, j0, i1, j0).forEach((v, idx) => idx === 0 || ring.push(v));
      // 右边(向东,i=i1)
      edgeRing(i1, j0, i1, j1).forEach((v, idx) => idx === 0 || ring.push(v));
      // 顶边(向北,j=j1),反向
      edgeRing(i1, j1, i0, j1).forEach((v, idx) => idx === 0 || ring.push(v));
      // 左边(向西,i=i0),反向
      edgeRing(i0, j1, i0, j0).forEach((v, idx) => idx === 0 || ring.push(v));

      const anchor = ring[0];
      for (let r = 1; r < ring.length - 1; r++) {
        indices.push(anchor, ring[r], ring[r + 1]);
      }
    }
  }

  return {
    cx,
    cz,
    lod,
    seed,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

export type EdgeSide = 'north' | 'south' | 'east' | 'west';

/** 抽取某条边上的顶点世界坐标(按边顺序),供接缝测试使用 */
export function extractEdgePositions(mesh: ChunkMeshData, side: EdgeSide): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const minX = WORLD_MIN + mesh.cx * CHUNK_SIZE;
  const maxX = minX + CHUNK_SIZE;
  const minZ = WORLD_MIN + mesh.cz * CHUNK_SIZE;
  const maxZ = minZ + CHUNK_SIZE;
  const eps = 1e-4;
  for (let idx = 0; idx < mesh.vertexCount; idx++) {
    const x = mesh.positions[idx * 3];
    const z = mesh.positions[idx * 3 + 2];
    let match = false;
    if (side === 'west' && Math.abs(x - minX) < eps) match = true;
    if (side === 'east' && Math.abs(x - maxX) < eps) match = true;
    if (side === 'south' && Math.abs(z - minZ) < eps) match = true;
    if (side === 'north' && Math.abs(z - maxZ) < eps) match = true;
    if (match) out.push([x, mesh.positions[idx * 3 + 1], z]);
  }
  out.sort((a, b) => (side === 'west' || side === 'east' ? a[2] - b[2] : a[0] - b[0]));
  return out;
}
