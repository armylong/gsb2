/**
 * 几何处理：三角面输入 -> 确定性顶点焊接 -> 折边提取。
 *
 * 输入网格允许是带共面剖分对角线的三角汤（如 ExtrudeGeometry 的非索引输出）。
 * 焊接后按"二面角阈值"筛选边：共面三角之间的对角线二面角≈0，会被丢弃；
 * 真正的外形边、折边、开孔轮廓边都会保留。
 */

import type { Vec3, Mat4 } from './math3d.ts';
import {
  v3, add, sub, scale, cross, normalize, dot,
  transformPoint, identityMat4, length
} from './math3d.ts';

export interface RawPart {
  id: string;
  label: string;
  color: number;
  /** 世界变换（列主序 4x4，与 three.js 一致）。 */
  matrix: Mat4;
  /** 三角汤：长度 = 三角面数 * 3，每个顶点是世界变换前的局部坐标。 */
  positions: Vec3[];
}

export interface Triangle {
  /** 焊接后的顶点索引。 */
  v: [number, number, number];
  normal: Vec3;
  partIndex: number;
}

export interface EdgeInfo {
  id: string;
  a: number;
  b: number;
  /** 入射面（焊接后面索引），用于同零件自身面的剔除。 */
  faces: number[];
  partIndex: number;
  /** 二面角（度）：两个入射面的夹角，平面=0，折边>阈值。 */
  dihedralDeg: number;
}

export interface WorldMesh {
  parts: RawPart[];
  vertices: Vec3[];
  triangles: Triangle[];
  edges: EdgeInfo[];
  /** 边 id -> 边索引，阈值变动重算后物理边仍对应同一 id。 */
  edgeById: Map<string, number>;
}

/** 10 位十进制量化，焊接误差约 1e-10 * 坐标量级，远小于深度判定 epsilon。 */
const WELD_DIGITS = 10;

function weldKey(p: Vec3): string {
  const q = (n: number): string => {
    // 避免 -0 与 0 产生不同 key
    const r = Math.round(n * 1e10) / 1e10;
    return Object.is(r, -0) ? '0' : r.toFixed(WELD_DIGITS);
  };
  return `${q(p.x)}|${q(p.y)}|${q(p.z)}`;
}

function faceNormal(p0: Vec3, p1: Vec3, p2: Vec3): Vec3 {
  return normalize(cross(sub(p1, p0), sub(p2, p0)));
}

/**
 * 按零件分别焊接顶点、提取边并按二面角阈值筛选。
 * 结果与输入顺序解耦：所有顶点/边/面的顺序只由确定的排序规则决定。
 */
export function buildWorld(parts: RawPart[], thresholdDeg: number): WorldMesh {
  const vertices: Vec3[] = [];
  const triangles: Triangle[] = [];
  const edges: EdgeInfo[] = [];
  const edgeById = new Map<string, number>();

  parts.forEach((part, partIndex) => {
    if (part.positions.length % 3 !== 0) {
      throw new Error(`零件 ${part.id} 的顶点数不是 3 的倍数`);
    }

    // 1) 顶点焊接（局部坐标下焊接，再统一变换到世界坐标）
    const localToWeld = new Map<string, number>();
    const localVerts: Vec3[] = [];
    const weld = (p: Vec3): number => {
      const key = weldKey(p);
      let idx = localToWeld.get(key);
      if (idx === undefined) {
        idx = localVerts.length;
        localToWeld.set(key, idx);
        localVerts.push(p);
      }
      return idx;
    };

    const localTris: Array<[number, number, number]> = [];
    for (let i = 0; i < part.positions.length; i += 3) {
      const i0 = weld(part.positions[i]);
      const i1 = weld(part.positions[i + 1]);
      const i2 = weld(part.positions[i + 2]);
      if (i0 === i1 || i1 === i2 || i0 === i2) continue; // 退化三角形
      localTris.push([i0, i1, i2]);
    }

    // 2) 局部顶点变换到世界坐标（平移后焊接 key 不再可比，所以必须先焊后变换）
    const baseIndex = vertices.length;
    for (const lv of localVerts) vertices.push(transformPoint(part.matrix, lv));

    // 3) 三角面（世界空间法线）
    const baseTri = triangles.length;
    const localFaceIndex: number[] = [];
    localTris.forEach(([a, b, c]) => {
      const wa = vertices[baseIndex + a];
      const wb = vertices[baseIndex + b];
      const wc = vertices[baseIndex + c];
      localFaceIndex.push(triangles.length);
      triangles.push({
        v: [baseIndex + a, baseIndex + b, baseIndex + c],
        normal: faceNormal(wa, wb, wc),
        partIndex
      });
    });

    // 4) 边收集：统一使用世界顶点索引（与三角面 v 数组同一索引空间）；
    //    key 用"小索引,大索引"保证方向无关；入射面按出现顺序登记后排序去重
    const edgeMap = new Map<string, { a: number; b: number; faces: number[] }>();
    localTris.forEach((tri, li) => {
      const corners = [baseIndex + tri[0], baseIndex + tri[1], baseIndex + tri[2]];
      const pairs: Array<[number, number]> = [
        [corners[0], corners[1]],
        [corners[1], corners[2]],
        [corners[2], corners[0]]
      ];
      for (const [u, w] of pairs) {
        const a = Math.min(u, w);
        const b = Math.max(u, w);
        const key = `${a},${b}`;
        let e = edgeMap.get(key);
        if (!e) {
          e = { a, b, faces: [] };
          edgeMap.set(key, e);
        }
        e.faces.push(baseTri + li);
      }
    });

    // 5) 二面角计算 + 阈值筛选 + 确定性排序
    const partEdgeEntries = Array.from(edgeMap.entries()).map(([key, e]) => {
      const uniqFaces = Array.from(new Set(e.faces)).sort((x, y) => x - y);
      let dihedral: number;
      if (uniqFaces.length >= 2) {
        const n0 = triangles[uniqFaces[0]].normal;
        const n1 = triangles[uniqFaces[1]].normal;
        const cosA = dot(n0, n1);
        dihedral = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;
      } else {
        // 仅一个入射面：可能是真实开口边界（开孔轮廓、实体外缘），也可能是
        // 共面剖分中因三角绕向不一致而未配对的"伪边界"。用共面邻居探测：
        // 若存在另一个与入射面共面、也包含该边两端点的三角面，则按共面处理（角度 0）。
        const owner = triangles[uniqFaces[0]];
        let coplanarNeighbor = false;
        for (let ti = baseTri; ti < triangles.length; ti++) {
          if (ti === uniqFaces[0]) continue;
          const t = triangles[ti];
          if (!t.v.includes(e.a) || !t.v.includes(e.b)) continue;
          // 绝对值：容忍共面三角绕向相反（法线翻转）的三角汤输入
          if (Math.abs(dot(t.normal, owner.normal)) > 1 - 1e-8) {
            coplanarNeighbor = true;
            break;
          }
        }
        dihedral = coplanarNeighbor ? 0 : 180;
      }
      return { key: `${part.id}#${key}`, a: e.a, b: e.b, faces: uniqFaces, dihedral };
    });

    partEdgeEntries.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));

    for (const entry of partEdgeEntries) {
      // 二面角不超过阈值的边视为共面内部边（含剖分对角线），过滤掉；
      // 1e-9 容差吸收浮点误差，阈值=0 时精确共面边同样被过滤。
      if (entry.dihedral <= thresholdDeg + 1e-9) continue;
      const id = entry.key;
      edgeById.set(id, edges.length);
      edges.push({
        id,
        a: entry.a,
        b: entry.b,
        faces: entry.faces,
        partIndex,
        dihedralDeg: entry.dihedral
      });
    }
  });

  // 注意：triangles 顺序不可再重排——边的 faces 存的是这里的三角面索引。
  // 确定性由逐零件的固定处理顺序与边 key 排序保证。
  return { parts, vertices, triangles, edges, edgeById };
}

/** 世界 AABB，用于视图取景。 */
export function worldBounds(mesh: WorldMesh): { min: Vec3; max: Vec3; center: Vec3; size: number } {
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const p of mesh.vertices) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  const center = scale(add(min, max), 0.5);
  const size = length(sub(max, min)) || 1;
  return { min, max, center, size };
}

export { identityMat4 };
