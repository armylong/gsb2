import * as THREE from 'three';
import { FrameSet } from './frames';

export interface PipeParams {
  radius: number;
  /** 沿路径的分段数 */
  segments: number;
  /** 圆形截面的边数（方形固定为 4） */
  sides: number;
  shape: 'circle' | 'square';
  /** 开放路径是否封端盖 */
  caps: boolean;
  closed: boolean;
}

export interface PipeData {
  /** xyz 连续排列的顶点 */
  positions: number[];
  /** 三角形索引（0 基） */
  indices: number[];
  ringCount: number;
  sides: number;
  frames: FrameSet;
  /** 每个截面顶点在 (N, B) 平面内的偏移，顶点 0 即角标记位置 */
  crossOffsets: THREE.Vector2[];
  vertexCount: number;
  triangleCount: number;
}

/** 截面多边形顶点偏移。顶点 0 固定在 +N 方向，作为角标记。 */
export function crossSectionOffsets(params: PipeParams): THREE.Vector2[] {
  const n = params.shape === 'square' ? 4 : Math.max(3, Math.round(params.sides));
  const offs: THREE.Vector2[] = [];
  for (let j = 0; j < n; j++) {
    const a = (j / n) * Math.PI * 2;
    offs.push(new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(params.radius));
  }
  return offs;
}

/**
 * 由标架生成管道网格。
 * 闭环时最后一环的三角形直接回绕引用第 0 环顶点（共享顶点，非重叠面），
 * 因此接缝在网格连接关系上闭合，也没有重复端盖。
 */
export function buildPipe(frames: FrameSet, params: PipeParams): PipeData {
  const offs = crossSectionOffsets(params);
  const sides = offs.length;
  const rings = frames.points.length; // 闭环: segments 环；开放: segments+1 环

  const positions: number[] = [];
  for (let i = 0; i < rings; i++) {
    const p = frames.points[i], N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j < sides; j++) {
      const o = offs[j];
      positions.push(
        p.x + N.x * o.x + B.x * o.y,
        p.y + N.y * o.x + B.y * o.y,
        p.z + N.z * o.x + B.z * o.y,
      );
    }
  }

  const indices: number[] = [];
  const span = params.closed ? rings : rings - 1; // 闭环时每个环都向后连，末环回绕到环 0
  for (let i = 0; i < span; i++) {
    const i1 = (i + 1) % rings;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      const a = i * sides + j, b = i * sides + j1;
      const c = i1 * sides + j1, d = i1 * sides + j;
      indices.push(a, c, d, a, b, c);
    }
  }

  // 端盖：仅开放路径可选；每端一个中心点 + 扇形三角
  if (params.caps && !params.closed) {
    const addCap = (ring: number, flip: boolean) => {
      const centerIdx = positions.length / 3;
      const p = frames.points[ring];
      positions.push(p.x, p.y, p.z);
      for (let j = 0; j < sides; j++) {
        const j1 = (j + 1) % sides;
        const v0 = ring * sides + j, v1 = ring * sides + j1;
        if (flip) indices.push(centerIdx, v1, v0);
        else indices.push(centerIdx, v0, v1);
      }
    };
    addCap(0, true);
    addCap(rings - 1, false);
  }

  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  return { positions, indices, ringCount: rings, sides, frames, crossOffsets: offs, vertexCount, triangleCount };
}

/** 取第 ring 环、第 j 个截面顶点的世界坐标（用于角标记线） */
export function ringVertex(data: PipeData, ring: number, j: number): THREE.Vector3 {
  const idx = ((ring % data.ringCount) * data.sides + j) * 3;
  return new THREE.Vector3(data.positions[idx], data.positions[idx + 1], data.positions[idx + 2]);
}
