/**
 * 三个程序化演示网格的生成器。
 * 全部为本地生成，不加载任何外部模型。
 * 每个原始网格三角形数量都控制在 12000 以内（生成后在 UI 中如实显示）。
 */
import * as THREE from 'three';
import { MeshData, normalizeMesh, weldByPosition } from './meshTypes';

function fromThreeGeometry(geom: THREE.BufferGeometry): MeshData {
  const position = geom.getAttribute('position') as THREE.BufferAttribute;
  let positions: Float32Array;
  let indices: Uint32Array;
  if (geom.index) {
    positions = new Float32Array(position.array as Float32Array);
    const src = geom.index.array;
    indices = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) indices[i] = src[i];
  } else {
    // 非索引几何：位置数组即每个三角形 3 个顶点
    positions = new Float32Array(position.array as Float32Array);
    indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
  }
  geom.dispose();
  return { positions, indices };
}

/**
 * 1) 曲面球：光滑参数球面，宽 64 段 × 高 40 段，约 5040 个三角形。
 * 极与经度缝的焊接顶点保证网格闭合（边界边为 0）。
 */
export function generateSphere(): MeshData {
  const geom = new THREE.SphereGeometry(1.5, 64, 40);
  return normalizeMesh(fromThreeGeometry(geom), 4);
}

/**
 * 2) 带尖角的低矮建筑：L 形平面挤出体，平着色、硬边，带斜面檐口与坡屋顶。
 * 硬边两侧是重复顶点（非焊接），尖角在简化时是典型的形状损失来源。
 * 做一次均匀 1:4 细分把面数提高到千级，便于观察 25% 比例下的误差，
 * 细分保持所有尖角与平面不变（中点仍在原平面上）。
 */
export function generateBuilding(): MeshData {
  // L 形平面（逆时针，单位为任意局部单位，之后统一归一化）
  const shape = new THREE.Shape();
  const pts: Array<[number, number]> = [
    [0, 0],
    [4, 0],
    [4, 1.4],
    [2.4, 1.4],
    [2.4, 3],
    [0, 3],
  ];
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 1.6,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.12,
    bevelSegments: 1,
    steps: 1,
  });
  // ExtrudeGeometry 在 XY 平面、沿 +Z 挤出；旋转让高度沿 +Y，建筑落在地面上
  geom.rotateX(-Math.PI / 2);

  let mesh = fromThreeGeometry(geom);
  // 三次 1:4 细分：44 -> 2816 面，量级与另外两个样例接近；
  // 细分只在平面内插入中点，所有尖角、硬边与平面保持不变
  mesh = subdivideUniform(mesh, 3);
  mesh = addPitchedRoof(mesh);
  return normalizeMesh(mesh, 4);
}

/**
 * 均匀 1:4 三角形细分：每条边取中点，一个三角形变四个。
 * 入口先按位置焊接（硬边两侧仍保留各自的顶点副本，着色裂缝不变），
 * 这样同一条几何边的中点才能在相邻三角形间共享，真正把面数放大 4 倍；
 * 中点落在原平面/原边上，尖角与平面形状保持不变。
 */
function subdivideUniform(mesh: MeshData, iterations: number): MeshData {
  let current = weldByPosition(mesh);
  for (let iter = 0; iter < iterations; iter++) {
    const { positions, indices } = current;
    const vertexCount = positions.length / 3;
    const edgeMidpoint = new Map<number, number>();
    const newPositions: number[] = Array.from(positions);
    const newIndices: number[] = [];

    const midpoint = (a: number, b: number): number => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * vertexCount + hi;
      const cached = edgeMidpoint.get(key);
      if (cached !== undefined) return cached;
      const idx = newPositions.length / 3;
      newPositions.push(
        (positions[a * 3] + positions[b * 3]) / 2,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      );
      edgeMidpoint.set(key, idx);
      return idx;
    };

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      newIndices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    current = {
      positions: Float32Array.from(newPositions),
      indices: Uint32Array.from(newIndices),
    };
  }
  return current;
}

/**
 * 给平顶挤出体加坡屋顶：找出最高的一圈顶面顶点，整体抬升为屋脊，
 * 顶面沿短跨方向倾斜。只移动顶面顶点位置，不改变连通关系，
 * 因此面数与边界统计不变，且所有檐口尖角保留。
 */
function addPitchedRoof(mesh: MeshData): MeshData {
  const p = mesh.positions;
  let maxY = -Infinity;
  for (let i = 1; i < p.length; i += 3) maxY = Math.max(maxY, p[i]);
  const eps = 1e-6;
  // 顶面中心
  let cx = 0, cz = 0, topCount = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (Math.abs(p[i + 1] - maxY) <= eps) {
      cx += p[i];
      cz += p[i + 2];
      topCount++;
    }
  }
  cx /= topCount;
  cz /= topCount;
  const rise = 0.55;
  for (let i = 0; i < p.length; i += 3) {
    if (Math.abs(p[i + 1] - maxY) <= eps) {
      // 离顶面中心越近抬得越高，形成双坡
      const t = Math.max(0, 1 - Math.abs(p[i + 2] - cz) / 1.5);
      p[i + 1] += rise * t;
      void cx;
    }
  }
  return { positions: p, indices: mesh.indices.slice() };
}

/**
 * 3) 带开口的弯曲片：带一个矩形洞口的参数化弯曲薄板（单表面，非实体）。
 * 天然带两条边界环（外轮廓 + 洞口），用于检验“保留开口边界”选项。
 * 80 × 56 网格、挖掉约 18×12 个格子后约 8000 个三角形，低于 12000。
 */
export function generateCurvedSheet(): MeshData {
  const cols = 80; // 沿弯曲方向的格数
  const rows = 56; // 横向格数
  // 洞口覆盖的格子范围（半开区间 [u0,u1) × [v0,v1)）
  const u0 = Math.floor(cols * 0.42);
  const u1 = Math.floor(cols * 0.64);
  const v0 = Math.floor(rows * 0.4);
  const v1 = Math.floor(rows * 0.6);

  const width = 5;
  const depth = 3.4;
  const indexMap = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
  const positions: number[] = [];

  const insideHole = (i: number, j: number) => i >= u0 && i < u1 && j >= v0 && j < v1;
  const vertexId = (i: number, j: number): number => {
    const slot = i * (rows + 1) + j;
    const cached = indexMap[slot];
    if (cached >= 0) return cached;
    const u = i / cols;
    const v = j / rows;
    const x = (u - 0.5) * width;
    const z = (v - 0.5) * depth;
    // 主弯曲：沿 x 的圆柱式弧面；附加轻微横向起伏
    const y = Math.sin(u * Math.PI) * 1.1 + 0.18 * Math.sin(v * Math.PI * 2) * Math.sin(u * Math.PI);
    const id = positions.length / 3;
    positions.push(x, y, z);
    indexMap[slot] = id;
    return id;
  };

  const indices: number[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      // 洞口内的格子整体跳过，保证洞口边沿是干净的直线边
      if (insideHole(i, j)) continue;
      const a = vertexId(i, j);
      const b = vertexId(i + 1, j);
      const c = vertexId(i + 1, j + 1);
      const d = vertexId(i, j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  return normalizeMesh(
    { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
    4,
  );
}

export const SAMPLE_BUILDERS = {
  sphere: { id: 'sphere', label: '曲面球', build: generateSphere },
  building: { id: 'building', label: '尖角低矮建筑', build: generateBuilding },
  sheet: { id: 'sheet', label: '带开口弯曲片', build: generateCurvedSheet },
} as const;

export type SampleId = keyof typeof SAMPLE_BUILDERS;

export const SAMPLE_DESCRIPTIONS: Record<SampleId, string> = {
  sphere: '光滑参数球面，闭合无边界；用来观察曲率均匀表面上误差随保留比例的变化。',
  building: 'L 形平面挤出的低矮建筑，硬边、平着色、坡屋顶；尖角与檐口是简化时最敏感的形状。',
  sheet: '带矩形洞口的弯曲薄板，含外轮廓与洞口两条边界环；用于对照“保留开口边界”开关的效果。',
};
