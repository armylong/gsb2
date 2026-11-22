/**
 * 极简 OBJ 解析器（面向小文件）
 *
 * - 仅取 `v`（顶点）与 `f`（面），忽略 vt/vn、注释与材质指令
 * - 支持 `o` / `g` 分块；没有分组时整体作为一个块
 * - 面支持 v、v/vt、v//vn、v/vt/vn 写法，支持负索引与多边形（扇形三角化）
 * - 顶点原样保留（含重复顶点，交由重复顶点检测处理）
 */
import type { MeshChunk, MeshModel } from './types';

let objId = 1000;

export function parseOBJ(text: string, name = 'OBJ 模型'): MeshModel {
  const globalVerts: number[] = [];
  /** 当前块收集到的面（全局 0 基顶点号） */
  let currentFaces: number[][] = [];
  let currentName = 'default';
  const raw: { name: string; faces: number[][] }[] = [];

  const flush = () => {
    if (currentFaces.length > 0) raw.push({ name: currentName, faces: currentFaces });
    currentFaces = [];
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    switch (cmd) {
      case 'v': {
        globalVerts.push(Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0));
        break;
      }
      case 'o':
      case 'g': {
        flush();
        currentName = parts.slice(1).join(' ') || `group ${raw.length + 1}`;
        break;
      }
      case 'f': {
        const face: number[] = [];
        for (let k = 1; k < parts.length; k++) {
          const token = parts[k].split('/')[0];
          let idx = parseInt(token, 10);
          if (Number.isNaN(idx)) throw new Error(`无法解析面索引: "${parts[k]}"`);
          if (idx < 0) idx = globalVerts.length / 3 + idx; // OBJ 负索引
          else idx -= 1;
          face.push(idx);
        }
        if (face.length >= 3) currentFaces.push(face);
        break;
      }
      default:
        // vt / vn / mtllib / usemtl / s ... 全部忽略
        break;
    }
  }
  flush();

  if (globalVerts.length === 0) throw new Error('OBJ 中没有找到任何顶点（v）');
  if (raw.length === 0) raw.push({ name: currentName, faces: [] });

  const chunks: MeshChunk[] = [];
  for (const group of raw) {
    // 只保留该块实际引用的顶点，重映射为局部索引；顶点值原样复制
    const used = new Set<number>();
    for (const face of group.faces) for (const vi of face) used.add(vi);
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const sortedUsed = [...used].sort((a, b) => a - b);
    for (const vi of sortedUsed) {
      remap.set(vi, positions.length / 3);
      positions.push(globalVerts[vi * 3], globalVerts[vi * 3 + 1], globalVerts[vi * 3 + 2]);
    }
    const indices: number[] = [];
    for (const face of group.faces) {
      const local = face.map((vi) => remap.get(vi)!);
      for (let k = 1; k < local.length - 1; k++) {
        indices.push(local[0], local[k], local[k + 1]);
      }
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (positions[i + a] < min[a]) min[a] = positions[i + a];
        if (positions[i + a] > max[a]) max[a] = positions[i + a];
      }
    }
    chunks.push({
      id: objId++,
      name: group.name,
      positions: Float64Array.from(positions),
      indices: Uint32Array.from(indices),
      bbox: { min, max },
    });
  }

  const bbox: BBox = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  let vertexCount = 0;
  let triangleCount = 0;
  for (const c of chunks) {
    for (let a = 0; a < 3; a++) {
      bbox.min[a] = Math.min(bbox.min[a], c.bbox.min[a]);
      bbox.max[a] = Math.max(bbox.max[a], c.bbox.max[a]);
    }
    vertexCount += c.positions.length / 3;
    triangleCount += c.indices.length / 3;
  }
  return { name, chunks, bbox, vertexCount, triangleCount };
}

type BBox = MeshModel['bbox'];
