import type { MeshData, Vec3 } from './types';
import { v3 } from './math';

export interface Bounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
  /** 包围球半径 */
  radius: number;
}

export function cloneMesh(mesh: MeshData): MeshData {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}

export function meshBounds(mesh: MeshData): Bounds {
  const p = mesh.positions;
  const n = Math.floor(p.length / 3);
  if (n === 0) {
    const z = v3();
    return { min: z, max: v3(), center: v3(), size: v3(), radius: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const min = v3(minX, minY, minZ);
  const max = v3(maxX, maxY, maxZ);
  const center = v3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const size = v3(maxX - minX, maxY - minY, maxZ - minZ);
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = p[i * 3] - center.x;
    const dy = p[i * 3 + 1] - center.y;
    const dz = p[i * 3 + 2] - center.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return { min, max, center, size, radius: Math.sqrt(r2) };
}

/** 统计所有顶点被面引用的次数、以及未引用顶点数。 */
export function referencedVertexCount(mesh: MeshData): number {
  const used = new Uint8Array(Math.floor(mesh.positions.length / 3));
  for (const v of mesh.indices) if (v >= 0 && v < used.length) used[v] = 1;
  let n = 0;
  for (let i = 0; i < used.length; i++) n += used[i];
  return n;
}

export function meshStats(mesh: MeshData): { vertices: number; faces: number; unusedVertices: number } {
  const vertices = Math.floor(mesh.positions.length / 3);
  const faces = Math.floor(mesh.indices.length / 3);
  return { vertices, faces, unusedVertices: vertices - referencedVertexCount(mesh) };
}

export interface CompactResult {
  mesh: MeshData;
  /** 旧顶点 -> 新顶点；未引用顶点为 -1 */
  oldToNew: Int32Array;
  newToOld: number[];
  removedVertices: number[];
}

/**
 * 压缩顶点数组：去掉未被引用的顶点，并重映射索引。
 * 用于写入后得到干净的网格（撤销时使用历史里的完整快照）。
 */
export function compactMesh(mesh: MeshData): CompactResult {
  const n = Math.floor(mesh.positions.length / 3);
  const oldToNew = new Int32Array(n).fill(-1);
  const newToOld: number[] = [];
  for (const v of mesh.indices) {
    if (v < 0 || v >= n) continue;
    if (oldToNew[v] === -1) {
      oldToNew[v] = newToOld.length;
      newToOld.push(v);
    }
  }
  const positions = new Array<number>(newToOld.length * 3);
  for (let i = 0; i < newToOld.length; i++) {
    const src = newToOld[i];
    positions[i * 3] = mesh.positions[src * 3];
    positions[i * 3 + 1] = mesh.positions[src * 3 + 1];
    positions[i * 3 + 2] = mesh.positions[src * 3 + 2];
  }
  const indices = new Array<number>(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) indices[i] = oldToNew[mesh.indices[i]];
  const removedVertices: number[] = [];
  for (let i = 0; i < n; i++) if (oldToNew[i] === -1) removedVertices.push(i);
  return { mesh: { positions, indices }, oldToNew, newToOld, removedVertices };
}
