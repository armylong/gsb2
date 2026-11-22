/**
 * 内置示例模型生成器
 *
 * 三个内置模型都刻意包含检查器要处理的边界情形：
 *  - 分块曲面：2x2 瓦片共享边位置，但每块各自拥有顶点（典型的接缝来源）
 *  - 组合件：大底座 + 零厚度平板 + 微型螺钉，尺寸差两个数量级
 *  - 贴边分块条：6 块零厚度薄板严格贴边，且首块内置同位置重复顶点
 */
import type { BBox, MeshChunk, MeshModel } from './types';

let nextId = 1;
function resetIds() {
  nextId = 1;
}

function makeChunk(name: string, positions: number[], indices: number[]): MeshChunk {
  const pos = Float64Array.from(positions);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (pos[i + a] < min[a]) min[a] = pos[i + a];
      if (pos[i + a] > max[a]) max[a] = pos[i + a];
    }
  }
  return {
    id: nextId++,
    name,
    positions: pos,
    indices: Uint32Array.from(indices),
    bbox: { min, max },
  };
}

function finalize(name: string, chunks: MeshChunk[]): MeshModel {
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

/** 轴对齐盒子（24 顶点，面不共享顶点，边界明确） */
function boxGeometry(w: number, h: number, d: number, cx: number, cy: number, cz: number) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const corners: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], // -z
    [4, 6, 5], [4, 7, 6], // +z
    [0, 3, 7], [0, 7, 4], // -x
    [1, 5, 6], [1, 6, 2], // +x
    [0, 4, 5], [0, 5, 1], // -y
    [3, 2, 6], [3, 6, 7], // +y
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c] of faces) {
    const base = positions.length / 3;
    positions.push(...corners[a], ...corners[b], ...corners[c]);
    indices.push(base, base + 1, base + 2);
  }
  return { positions, indices };
}

/** 严格零厚度平板（矩形面，2 个三角形） */
function flatPlateGeometry(x0: number, x1: number, z0: number, z1: number, y: number) {
  const positions = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  const indices = [0, 1, 2, 0, 2, 3];
  return { positions, indices };
}

/** 低段数圆柱（螺钉毛坯），轴沿 Y */
function cylinderGeometry(r: number, h: number, cx: number, cy: number, cz: number, segments = 8) {
  const positions: number[] = [];
  const indices: number[] = [];
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const ring = (y: number) => {
    const start = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      positions.push(cx + r * Math.cos(ang), y, cz + r * Math.sin(ang));
    }
    return start;
  };
  const bottom = ring(y0);
  const top = ring(y1);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(bottom + i, bottom + j, top + j, bottom + i, top + j, top + i);
  }
  // 底面 / 顶面中心封口
  const cb = positions.length / 3;
  positions.push(cx, y0, cz);
  const ct = positions.length / 3;
  positions.push(cx, y1, cz);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(cb, bottom + j, bottom + i);
    indices.push(ct, top + i, top + j);
  }
  return { positions, indices };
}

/**
 * 波浪曲面参数式。瓦片之间留出物理微缝 GAP：相邻瓦片的边并不落在同一坐标上，
 * 这正是真实分块网格的典型情形（建模软件导出的独立块之间常有亚毫米级缝隙）。
 */
const TILE_GAP = 0.008;

function wavePoint(u: number, v: number): [number, number, number] {
  const W = 8;
  const D = 8;
  const x = u * W - W / 2;
  const z = v * D - D / 2;
  const y = Math.sin(u * Math.PI * 2) * Math.cos(v * Math.PI * 2) * 0.8 + u * 0.5;
  return [x, y, z];
}

/** 模型 1：2x2 分块波浪曲面，瓦片间有物理微缝、顶点各自独立 */
export function buildSplitSurface(): MeshModel {
  resetIds();
  const chunks: MeshChunk[] = [];
  const NX = 2;
  const NY = 2;
  const SUB = 14; // 每瓦片每方向 subdivisions
  for (let ti = 0; ti < NX; ti++) {
    for (let tj = 0; tj < NY; tj++) {
      const positions: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i <= SUB; i++) {
        for (let j = 0; j <= SUB; j++) {
          // 在瓦片参数区间内缩进半个缝宽，使相邻瓦片之间留出 GAP
          const u0 = ti / NX;
          const u1 = (ti + 1) / NX;
          const v0 = tj / NY;
          const v1 = (tj + 1) / NY;
          const fu = i / SUB;
          const fv = j / SUB;
          const u = u0 + TILE_GAP / 2 / 8 + fu * ((u1 - u0) - TILE_GAP / 8);
          const v = v0 + TILE_GAP / 2 / 8 + fv * ((v1 - v0) - TILE_GAP / 8);
          positions.push(...wavePoint(u, v));
        }
      }
      const row = SUB + 1;
      for (let i = 0; i < SUB; i++) {
        for (let j = 0; j < SUB; j++) {
          const a = i * row + j;
          const b = (i + 1) * row + j;
          const c = (i + 1) * row + j + 1;
          const d = i * row + j + 1;
          indices.push(a, b, d, b, c, d);
        }
      }
      chunks.push(makeChunk(`曲面瓦片 ${ti + 1}-${tj + 1}`, positions, indices));
    }
  }
  return finalize('分块波浪曲面（2×2，带微缝）', chunks);
}

/** 模型 2：大小差别明显的组合件（大底座 / 零厚度平板 / 微型螺钉） */
export function buildAssembly(): MeshModel {
  resetIds();
  const chunks: MeshChunk[] = [];

  const base = boxGeometry(10, 1, 6, 0, 0, 0);
  chunks.push(makeChunk('大底座 10×1×6', base.positions, base.indices));

  // 平板严格零厚度（y 恒为 0.5，即底座顶面）
  const plate = flatPlateGeometry(-2, 2, -1, 1, 0.5);
  chunks.push(makeChunk('零厚度平板（y 恒定）', plate.positions, plate.indices));

  // 4 颗微型螺钉：尺寸比底座小约两个数量级
  const screwPositions: [number, number, number][] = [
    [-4, 0.5 + 0.125, -2],
    [4, 0.5 + 0.125, -2],
    [-4, 0.5 + 0.125, 2],
    [4, 0.5 + 0.125, 2],
  ];
  screwPositions.forEach((p, i) => {
    const s = cylinderGeometry(0.12, 0.25, p[0], p[1], p[2], 8);
    chunks.push(makeChunk(`微型螺钉 #${i + 1}（r=0.12）`, s.positions, s.indices));
  });

  // 一个极小的螺母方块，进一步拉大尺寸差
  const nut = boxGeometry(0.22, 0.18, 0.22, 0, 0.5 + 0.09, 0);
  chunks.push(makeChunk('微型方螺母 0.22', nut.positions, nut.indices));

  return finalize('大小组合件（底座 + 平板 + 螺钉）', chunks);
}

/** 模型 3：6 块贴边但独立分块的零厚度薄板条（板间留物理微缝）；首块内置同位置重复顶点 */
export function buildEdgeStrip(): MeshModel {
  resetIds();
  const chunks: MeshChunk[] = [];
  const N = 6;
  const W = 1.2;
  const D = 2;
  const GAP = 0.002; // 物理微缝，全局低精度量化后会被进一步放大
  const total = N * W + (N - 1) * GAP;
  for (let k = 0; k < N; k++) {
    const x0 = k * (W + GAP) - total / 2;
    const x1 = x0 + W;
    let { positions, indices } = flatPlateGeometry(x0, x1, -D / 2, D / 2, 0);

    if (k === 0) {
      // 显式制造一个同位置重复顶点：复制顶点 0 为顶点 4，让第一个三角形同时引用二者
      positions.push(positions[0], positions[1], positions[2]);
      indices[0] = 4; // 三角形 (4,1,2)，顶点 4 与顶点 0 坐标完全相同
    }
    chunks.push(makeChunk(`贴边薄板 #${k + 1}`, positions, indices));
  }
  return finalize('贴边独立分块条（6 块，零厚度，带微缝）', chunks);
}

export const BUILTIN_MODELS = [
  { id: 'split-surface', label: '分块波浪曲面（2×2 瓦片）', build: buildSplitSurface },
  { id: 'assembly', label: '大小组合件（底座/平板/微型螺钉）', build: buildAssembly },
  { id: 'edge-strip', label: '贴边独立分块条（6 块薄板）', build: buildEdgeStrip },
] as const;

export type BuiltinId = (typeof BUILTIN_MODELS)[number]['id'];
