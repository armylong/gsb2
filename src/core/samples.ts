import { Vector3 } from 'three';
import { SurfaceMesh } from './SurfaceMesh';
import type { HoleCircle, SurfaceMeshData } from './SurfaceMesh';
import type { SurfaceAnchor } from './types';

export type SampleId = 'curved-holey' | 'twin-islands';

export interface SampleMeta {
  id: SampleId;
  name: string;
  description: string;
}

export const SAMPLE_METAS: SampleMeta[] = [
  {
    id: 'curved-holey',
    name: '弯曲带孔薄壳',
    description: '程序生成的起伏曲面，中间挖去一个椭圆孔；路线必须贴着表面绕孔通过。',
  },
  {
    id: 'twin-islands',
    name: '双岛断开表面',
    description: '两块互不相连的曲面；跨岛路线会明确提示“表面断开”，不会画穿空气的直线。',
  },
];

interface HeightFieldOptions {
  nx: number;
  nz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: (x: number, z: number) => number;
  holes: HoleCircle[];
}

/**
 * 高度场三角化：每个网格单元拆成两个三角形。
 * 位于孔洞内的单元直接跳过，从而留下真正的孔洞（没有面可走）。
 */
function buildHeightField(options: HeightFieldOptions): { positions: number[]; indices: number[] } {
  const { nx, nz, minX, maxX, minZ, maxZ, height, holes } = options;
  const positions: number[] = [];
  const indices: number[] = [];

  const xs: number[] = [];
  const zs: number[] = [];
  for (let ix = 0; ix <= nx; ix++) xs.push(minX + ((maxX - minX) * ix) / nx);
  for (let iz = 0; iz <= nz; iz++) zs.push(minZ + ((maxZ - minZ) * iz) / nz);

  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const x = xs[ix];
      const z = zs[iz];
      positions.push(x, height(x, z), z);
    }
  }

  const idx = (ix: number, iz: number): number => iz * (nx + 1) + ix;
  const used = new Set<number>();
  const cells: [number, number, number, number][] = [];

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const corners: [number, number, number, number] = [
        idx(ix, iz),
        idx(ix + 1, iz),
        idx(ix, iz + 1),
        idx(ix + 1, iz + 1),
      ];
      // 单元中心落在孔内就整块删掉：保留的单元构成真正的拓扑孔洞
      const centerX = (xs[ix] + xs[ix + 1]) / 2;
      const centerZ = (zs[iz] + zs[iz + 1]) / 2;
      if (holes.some((h) => insideHole(centerX, centerZ, h))) continue;
      cells.push(corners);
      for (const v of corners) used.add(v);
    }
  }

  // 把落在孔内的顶点沿径向吸附到椭圆边界，让孔沿尽量贴合平滑曲线
  for (const v of used) {
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    for (const hole of holes) {
      if (!insideHole(x, z, hole)) continue;
      const nxDir = (x - hole.center[0]) / hole.radius;
      const nzDir = (z - hole.center[1]) / (hole.radius * 0.74);
      const len = Math.hypot(nxDir, nzDir) || 1;
      const px = hole.center[0] + (nxDir / len) * hole.radius;
      const pz = hole.center[1] + (nzDir / len) * (hole.radius * 0.74);
      positions[v * 3] = px;
      positions[v * 3 + 1] = height(px, pz);
      positions[v * 3 + 2] = pz;
      break;
    }
  }

  const pushTriangle = (a: number, b: number, c: number): void => {
    // 吸附后可能出现退化三角形，直接丢掉
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax;
    const e1y = positions[b * 3 + 1] - ay;
    const e1z = positions[b * 3 + 2] - az;
    const e2x = positions[c * 3] - ax;
    const e2y = positions[c * 3 + 1] - ay;
    const e2z = positions[c * 3 + 2] - az;
    const crx = e1y * e2z - e1z * e2y;
    const cry = e1z * e2x - e1x * e2z;
    const crz = e1x * e2y - e1y * e2x;
    if (crx * crx + cry * cry + crz * crz < 1e-12) return;
    indices.push(a, b, c);
  };

  for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
    const [a, b, c, d] = cells[cellIndex];
    // 交替对角线，避免规则的人字形条纹
    if (cellIndex % 2 === 0) {
      pushTriangle(a, c, b);
      pushTriangle(b, c, d);
    } else {
      pushTriangle(a, c, d);
      pushTriangle(a, d, b);
    }
  }

  return { positions, indices };
}

/** 椭圆孔：x 方向半径 radius，z 方向半径为 radius * 0.74 */
export function insideHole(x: number, z: number, hole: HoleCircle): boolean {
  const dx = (x - hole.center[0]) / hole.radius;
  const dz = (z - hole.center[1]) / (hole.radius * 0.74);
  return dx * dx + dz * dz < 1;
}

function waveA(x: number, z: number): number {
  return (
    0.55 * Math.sin(0.62 * x + 0.25) * Math.cos(0.5 * z) +
    0.22 * Math.sin(1.35 * x - 0.7 * z) +
    0.05 * x
  );
}

function waveB(x: number, z: number): number {
  return 0.45 * Math.cos(0.52 * x - 0.4) * Math.sin(0.6 * z + 0.15) + 0.28 * Math.sin(0.95 * x + 1.25 * z);
}

function mergeMeshes(parts: { positions: number[]; indices: number[] }[]): {
  positions: number[];
  indices: number[];
} {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    for (const v of part.positions) positions.push(v);
    for (const i of part.indices) indices.push(i + base);
  }
  return { positions, indices };
}

const HOLE_MAIN: HoleCircle = { center: [0.35, 0.05], radius: 1.05 };
const HOLE_ISLAND_A: HoleCircle = { center: [-3.4, 0.0], radius: 0.95 };

/** 程序生成样例。所有坐标都在网格局部空间。 */
export function createSample(id: SampleId): SurfaceMeshData {
  if (id === 'curved-holey') {
    const { positions, indices } = buildHeightField({
      nx: 64,
      nz: 44,
      minX: -4.8,
      maxX: 4.8,
      minZ: -3.2,
      maxZ: 3.2,
      height: waveA,
      holes: [HOLE_MAIN],
    });
    return { name: '弯曲带孔薄壳', positions, indices, holes: [HOLE_MAIN] };
  }

  const islandA = buildHeightField({
    nx: 38,
    nz: 30,
    minX: -6.4,
    maxX: -0.7,
    minZ: -2.6,
    maxZ: 2.6,
    height: waveA,
    holes: [HOLE_ISLAND_A],
  });
  const islandB = buildHeightField({
    nx: 30,
    nz: 26,
    minX: 1.5,
    maxX: 6.2,
    minZ: -2.6,
    maxZ: 2.6,
    height: (x, z) => waveB(x, z) + 0.5,
    holes: [],
  });

  const merged = mergeMeshes([islandA, islandB]);
  return {
    name: '双岛断开表面',
    positions: merged.positions,
    indices: merged.indices,
    holes: [HOLE_ISLAND_A],
  };
}

export function createSampleMesh(id: SampleId): SurfaceMesh {
  return new SurfaceMesh(createSample(id));
}

export function defaultAnchors(id: SampleId, mesh: SurfaceMesh): SurfaceAnchor[] {
  const targets =
    id === 'curved-holey'
      ? [
          new Vector3(-3.9, 0, -1.7),
          new Vector3(-2.2, 0, 1.6),
          new Vector3(0.35, 0, -2.15),
          new Vector3(3.1, 0, 1.5),
          new Vector3(4.0, 0, -1.5),
        ]
      : [
          new Vector3(-5.4, 0, -1.5),
          new Vector3(-1.5, 0, 1.5),
          // 下面两点位于另一块断开的曲面上
          new Vector3(2.6, 0, 1.4),
          new Vector3(5.2, 0, -1.3),
        ];

  const anchors: SurfaceAnchor[] = [];
  for (const target of targets) {
    const hit = mesh.closestPoint(target);
    if (hit) anchors.push({ tri: hit.tri, bary: hit.bary });
  }
  return anchors;
}
