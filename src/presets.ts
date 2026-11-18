/**
 * 三个固定纸模预设：立方体、三棱柱、正四面体。
 *
 * 每个预设直接给出目标实体顶点、面（顶点按外法线逆时针）、以及一棵把所有面
 * 连成树的铰链连接（预设展开关系，不做自动搜索）。
 * TreeEdge 中 parentEdge/childEdge 的顶点顺序严格一致，保证折叠轴方向统一。
 */
import type { PolyhedronDef, Vec3 } from './types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// ---------------------------------------------------------------------------
// 立方体：边长 2，中心在原点，顶点 ±1
// ---------------------------------------------------------------------------
const cube: PolyhedronDef = {
  key: 'cube',
  name: '立方体',
  targetVertices: [
    v(-1, -1, -1), // 0
    v(1, -1, -1), // 1
    v(1, 1, -1), // 2
    v(-1, 1, -1), // 3
    v(-1, -1, 1), // 4
    v(1, -1, 1), // 5
    v(1, 1, 1), // 6
    v(-1, 1, 1), // 7
  ],
  faces: [
    { id: 'C1', targetVertexIds: [0, 3, 2, 1] }, // z=-1（根面）
    { id: 'C2', targetVertexIds: [0, 4, 7, 3] }, // x=-1
    { id: 'C3', targetVertexIds: [1, 2, 6, 5] }, // x=+1
    { id: 'C4', targetVertexIds: [0, 1, 5, 4] }, // y=-1
    { id: 'C5', targetVertexIds: [3, 7, 6, 2] }, // y=+1
    { id: 'C6', targetVertexIds: [4, 5, 6, 7] }, // z=+1
  ],
  rootFaceId: 'C1',
  tree: [
    // childEdge 按子面自身 CCW 遍历，必然与 parentEdge 的实体顶点顺序相反
    { parent: 'C1', child: 'C2', parentEdge: [0, 1], childEdge: [3, 0] }, // 边 0-3
    { parent: 'C1', child: 'C3', parentEdge: [2, 3], childEdge: [0, 1] }, // 边 2-1
    { parent: 'C1', child: 'C4', parentEdge: [3, 0], childEdge: [0, 1] }, // 边 1-0
    { parent: 'C1', child: 'C5', parentEdge: [1, 2], childEdge: [3, 0] }, // 边 3-2
    { parent: 'C3', child: 'C6', parentEdge: [2, 3], childEdge: [1, 2] }, // 边 6-5
  ],
};

// ---------------------------------------------------------------------------
// 正三棱柱：正三角形截面边长 2，棱柱高 2，轴向沿 Z
// 三角形外接圆半径 R=2/√3，内切圆半径 r=1/√3
// ---------------------------------------------------------------------------
const R = 2 / Math.sqrt(3);
const r = 1 / Math.sqrt(3);
const prism: PolyhedronDef = {
  key: 'prism',
  name: '三棱柱',
  targetVertices: [
    v(-1, -r, -1), // 0
    v(1, -r, -1), // 1
    v(0, R, -1), // 2
    v(-1, -r, 1), // 3
    v(1, -r, 1), // 4
    v(0, R, 1), // 5
  ],
  faces: [
    { id: 'P1', targetVertexIds: [0, 2, 1] }, // 底面 z=-1（根面，法线 -Z）
    { id: 'P2', targetVertexIds: [0, 1, 4, 3] }, // 侧面，边 0-1
    { id: 'P3', targetVertexIds: [1, 2, 5, 4] }, // 侧面，边 1-2
    { id: 'P4', targetVertexIds: [2, 0, 3, 5] }, // 侧面，边 2-0
    { id: 'P5', targetVertexIds: [3, 4, 5] }, // 顶面 z=+1
  ],
  rootFaceId: 'P1',
  tree: [
    { parent: 'P1', child: 'P2', parentEdge: [2, 0], childEdge: [0, 1] }, // 边 1-0
    { parent: 'P1', child: 'P3', parentEdge: [1, 2], childEdge: [0, 1] }, // 边 2-1
    { parent: 'P1', child: 'P4', parentEdge: [0, 1], childEdge: [0, 1] }, // 边 0-2
    { parent: 'P2', child: 'P5', parentEdge: [2, 3], childEdge: [0, 1] }, // 边 4-3
  ],
};

// ---------------------------------------------------------------------------
// 正四面体：顶点 (±1,±1,±1) 的偶号组合，边长 2√2
// ---------------------------------------------------------------------------
const tetra: PolyhedronDef = {
  key: 'tetra',
  name: '四面体',
  targetVertices: [
    v(1, 1, 1), // 0
    v(1, -1, -1), // 1
    v(-1, 1, -1), // 2
    v(-1, -1, 1), // 3
  ],
  faces: [
    { id: 'T1', targetVertexIds: [0, 1, 2] }, // 根面
    { id: 'T2', targetVertexIds: [0, 3, 1] },
    { id: 'T3', targetVertexIds: [0, 2, 3] },
    { id: 'T4', targetVertexIds: [1, 3, 2] },
  ],
  rootFaceId: 'T1',
  tree: [
    { parent: 'T1', child: 'T2', parentEdge: [0, 1], childEdge: [2, 0] }, // 边 0-1
    { parent: 'T1', child: 'T3', parentEdge: [2, 0], childEdge: [0, 1] }, // 边 2-0（T3 CCW: 0->2）
    { parent: 'T1', child: 'T4', parentEdge: [1, 2], childEdge: [2, 0] }, // 边 1-2
  ],
};

export const POLYHEDRONS: PolyhedronDef[] = [cube, prism, tetra];

export function getPreset(key: string): PolyhedronDef {
  const def = POLYHEDRONS.find((p) => p.key === key);
  if (!def) throw new Error(`未知纸模：${key}`);
  return def;
}
