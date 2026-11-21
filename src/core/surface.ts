/**
 * 双三次 Bézier 曲面、细分网格、接缝修正与缝差测量。
 *
 * 为什么会裂开：
 * 两块曲面的共享边是同一条 3 次 Bézier 曲线（数学上完全重合），但各自离散成
 * 网格时，边被折成了分段数不同的折线。折线只是曲线的弦逼近，弦在曲线内侧，
 * 于是细分少的一侧与细分多的一侧的边折线之间出现空间间隙 —— 这就是 T 型接
 * 缝裂缝。控制点/曲率变化越大、两侧密度差越大，缝隙越宽。
 *
 * 修正思路（只动密侧，不动疏侧）：
 * 把细分多的一侧边上的内部顶点，吸附到细分少的一侧边折线上的精确点，使两条
 * 边折线逐点共线共点。疏侧曲面一个顶点都不动，因此它的外边界不会被挪动；
 * 密侧只改自己边上的点，其自身外边界同样不受影响。
 */
import {
  Vec3,
  v3,
  add,
  sub,
  normalize,
  cross,
  distance,
  pointPolylineDistance,
  lerp,
  cloneVec,
} from './vec3';

export type EdgeSide = 'u0' | 'u1';

export interface Patch {
  name: string;
  /** 4x4 控制点，grid[u][v]，u/v 均在 [0,1] */
  grid: Vec3[][];
  /** u 方向分段数（横跨曲面内部） */
  subdivU: number;
  /** v 方向分段数（沿共享边的方向） */
  subdivV: number;
  /** 共享边位于 u=0 列还是 u=1 列 */
  sharedEdge: EdgeSide;
  /**
   * 反转本曲面边的参数方向：以 v' = 1-v 重参数化整块曲面。
   * 共享曲线本身不变（三次 Bézier 控制点逆序仍是同一条曲线），
   * 只是本曲面的局部 v 增长方向与对侧相反。
   */
  edgeReversed: boolean;
}

export interface MeshData {
  positions: Vec3[];
  /** 三角形索引，每 3 个一组 */
  indices: number[];
  nu: number;
  nv: number;
  /** 边上顶点在 positions 中的索引，沿本曲面 v 参数递增排列 */
  edgeIndices: number[];
  /** 边上顶点对应的归一化边参数 s ∈ [0,1]（已计入 edgeReversed） */
  edgeS: number[];
}

const BERNSTEIN = [
  (t: number) => (1 - t) ** 3,
  (t: number) => 3 * (1 - t) ** 2 * t,
  (t: number) => 3 * (1 - t) * t * t,
  (t: number) => t ** 3,
];

/** 双三次 Bézier 曲面求值 */
export function evaluateSurface(grid: Vec3[][], u: number, v: number): Vec3 {
  const bu = BERNSTEIN.map((b) => b(u));
  const bv = BERNSTEIN.map((b) => b(v));
  const result = v3(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const w = bu[i] * bv[j];
      result.x += w * grid[i][j].x;
      result.y += w * grid[i][j].y;
      result.z += w * grid[i][j].z;
    }
  }
  return result;
}

/** 取共享边上局部参数 vLocal 处的点（vLocal 是本曲面自身的 v 参数，未做方向归一） */
export function evaluateSharedEdge(patch: Patch, vLocal: number): Vec3 {
  const edgeU = patch.sharedEdge === 'u0' ? 0 : 1;
  return evaluateSurface(patch.grid, edgeU, vLocal);
}

/**
 * 统一的共享边参数 s ∈ [0,1]，沿共享控制点列的物理顺序递增。
 * s 是与“反转”无关的物理参数：任一侧、无论是否反转，传入同一个 s 都取到
 * 同一条曲线上的同一个点。反转仅改变各曲面自身局部 v 与 s 的对应关系
 * （反转侧 v_local = 1-s，见 tessellate），不改变曲线本身。
 */
export function sharedPointAt(patch: Patch, s: number): Vec3 {
  return evaluateSharedEdge(patch, s);
}

/** 细分生成网格（规则栅格 + 三角剖分），同时记录共享边上的顶点 */
export function tessellate(patch: Patch): MeshData {
  const nu = patch.subdivU;
  const nv = patch.subdivV;
  const positions: Vec3[] = [];
  const edgeU = patch.sharedEdge === 'u0' ? 0 : nu;

  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const u = i / nu;
      // 反转侧整块曲面按 v' = 1-v 重参数化，保证边列与内部列连续不撕裂
      const vLocal = patch.edgeReversed ? 1 - j / nv : j / nv;
      positions.push(evaluateSurface(patch.grid, u, vLocal));
    }
  }

  const idx = (i: number, j: number) => i * (nv + 1) + j;
  // 边顶点与统一参数 s 都按 s 递增排列；反转时沿局部 v 递减遍历
  const edgeIndices: number[] = [];
  const edgeS: number[] = [];
  for (let k = 0; k <= nv; k++) {
    const j = patch.edgeReversed ? nv - k : k;
    edgeIndices.push(idx(edgeU, j));
    edgeS.push(k / nv);
  }

  const indices: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i + 1, j + 1);
      const d = idx(i, j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  return { positions, indices, nu, nv, edgeIndices, edgeS };
}

/** 取网格共享边折线（世界坐标），顺序按统一参数 s 递增 */
export function edgePolyline(mesh: MeshData): Vec3[] {
  return mesh.edgeIndices.map((posIdx) => mesh.positions[posIdx]);
}

export interface GapReport {
  /** 密侧边顶点到疏侧边折线的最大距离（世界单位） */
  maxFineToCoarse: number;
  /** 疏侧边顶点到密侧边折线的最大距离 */
  maxCoarseToFine: number;
  /** 双向最大值，作为“最大偏离”的复现指标 */
  maxDeviation: number;
  /** 发生最大偏离时的统一边参数 s */
  worstS: number;
  fineVertexCount: number;
  coarseVertexCount: number;
}

/**
 * 测量两条共享边折线之间的缝差。
 * 两条折线按统一参数 s 采样自同一条曲线，端点严格相同，差异只来自弦逼近。
 */
export function measureGap(fine: MeshData, coarse: MeshData): GapReport {
  const fineLine = edgePolyline(fine);
  const coarseLine = edgePolyline(coarse);

  let maxFineToCoarse = 0;
  let worstS = 0;
  fine.edgeS.forEach((s, k) => {
    const { dist } = pointPolylineDistance(fineLine[k], coarseLine);
    if (dist > maxFineToCoarse) {
      maxFineToCoarse = dist;
      worstS = s;
    }
  });

  let maxCoarseToFine = 0;
  coarse.edgeS.forEach((_s, k) => {
    const { dist } = pointPolylineDistance(coarseLine[k], fineLine);
    maxCoarseToFine = Math.max(maxCoarseToFine, dist);
  });

  return {
    maxFineToCoarse,
    maxCoarseToFine,
    maxDeviation: Math.max(maxFineToCoarse, maxCoarseToFine),
    worstS,
    fineVertexCount: fineLine.length,
    coarseVertexCount: coarseLine.length,
  };
}

/**
 * 接缝修正（T 型接缝消除）：
 * 1. 密侧边上的每个顶点吸附到疏侧边折线的精确点；
 * 2. 疏侧边的每个顶点作为新顶点插入密侧边（若该处原本没有密侧顶点），
 *    并对密侧贴边的第一环三角形按合并后的边链做扇形重三角化。
 *
 * 为什么两步都要做：只吸附不插入，疏侧顶点会落在密侧某条边线段的中部，
 * 密侧折线在该关节处“切角”，反向缝差依然不为零。
 *
 * @returns 修正后的两个网格（输入不被修改）。疏侧网格原样返回（同一引用），
 *          保证“单侧改密度不挪动另一侧外边界”；密侧也只有贴边一列发生变化，
 *          其内部顶点与外边界逐坐标不变。
 */
export function fixSeam(
  meshA: MeshData,
  meshB: MeshData,
): { fixedA: MeshData; fixedB: MeshData } {
  const segmentsA = meshA.nv;
  const segmentsB = meshB.nv;

  if (segmentsA === segmentsB) {
    // 分段相同：折线顶点一一对应，本就无裂缝，不做任何修改
    return { fixedA: meshA, fixedB: meshB };
  }

  const fineIsA = segmentsA > segmentsB;
  const fine = fineIsA ? meshA : meshB;
  const coarse = fineIsA ? meshB : meshA;

  const nvf = fine.nv;
  const nvc = coarse.nv;
  const coarseLine = edgePolyline(coarse);

  // 合并两边的边参数位置（有理数比较，避免浮点误差）：
  // 统一分母 nvf*nvc，密侧 k/nvf → key=k*nvc，疏侧 j/nvc → key=j*nvf
  interface MergedEntry {
    key: number;
    s: number;
    fineK: number | null;
    coarseJ: number | null;
    posIndex: number;
  }
  const merged: MergedEntry[] = [];
  let k = 0;
  let j = 0;
  while (k <= nvf || j <= nvc) {
    const keyFine = k <= nvf ? k * nvc : Infinity;
    const keyCoarse = j <= nvc ? j * nvf : Infinity;
    const key = Math.min(keyFine, keyCoarse);
    merged.push({
      key,
      s: key / (nvf * nvc),
      fineK: keyFine === key ? k : null,
      coarseJ: keyCoarse === key ? j : null,
      posIndex: -1,
    });
    if (keyFine === key) k++;
    if (keyCoarse === key) j++;
  }

  const positions = fine.positions.map(cloneVec);
  merged.forEach((entry) => {
    if (entry.coarseJ !== null) {
      // 疏侧顶点：位置必须与疏侧逐位相同
      const pos = coarseLine[entry.coarseJ];
      if (entry.fineK !== null) {
        const fineEdgeIdx = fine.edgeIndices[entry.fineK];
        positions[fineEdgeIdx] = cloneVec(pos);
        entry.posIndex = fineEdgeIdx;
      } else {
        entry.posIndex = positions.length;
        positions.push(cloneVec(pos));
      }
    } else {
      // 仅密侧有的顶点：吸附到疏侧折线上的精确投影点
      const fineEdgeIdx = fine.edgeIndices[entry.fineK!];
      const hit = pointPolylineDistance(positions[fineEdgeIdx], coarseLine);
      positions[fineEdgeIdx] = lerp(
        coarseLine[hit.segmentIndex],
        coarseLine[hit.segmentIndex + 1],
        hit.t,
      );
      entry.posIndex = fineEdgeIdx;
    }
  });

  // 重建索引：内部格点三角形保持不变，贴边环用合并边链扇形三角化
  const edgeAtU0 = fine.edgeIndices[0] % (nvf + 1) === 0;
  const edgeI = edgeAtU0 ? 0 : fine.nu;
  const innerI = edgeAtU0 ? 1 : fine.nu - 1;
  const idx = (i: number, jj: number) => i * (nvf + 1) + jj;
  const indices: number[] = [];

  for (let i = 0; i < fine.nu; i++) {
    for (let jj = 0; jj < nvf; jj++) {
      const touchesEdge = i === edgeI || i + 1 === edgeI;
      if (!touchesEdge) {
        const a = idx(i, jj);
        const b = idx(i + 1, jj);
        const c = idx(i + 1, jj + 1);
        const d = idx(i, jj + 1);
        indices.push(a, b, d, b, c, d);
      }
    }
  }

  // 每个密侧区间 [k/nvf, (k+1)/nvf] 取合并链的对应切片做扇形三角化
  for (let kk = 0; kk < nvf; kk++) {
    const lo = kk * nvc;
    const hi = (kk + 1) * nvc;
    const slice = merged.filter((e) => e.key >= lo && e.key <= hi); // 已按 s 排序
    const chain = slice.map((e) => e.posIndex);
    const i0 = idx(innerI, kk);
    const i1 = idx(innerI, kk + 1);
    if (edgeAtU0) {
      // 边在 u=0 列：边界序 I1 → Qm → … → Q0，自 I0 扇形展开
      const seq = [i1, ...chain.slice(1, -1).reverse(), chain[0]];
      for (let r = 0; r < seq.length - 1; r++) indices.push(i0, seq[r], seq[r + 1]);
    } else {
      // 边在 u=nu 列：边界序 Q0 → Q1 → … → Qm → I1，自 I0 扇形展开
      const seq = [...chain, i1];
      for (let r = 0; r < seq.length - 1; r++) indices.push(i0, seq[r], seq[r + 1]);
    }
  }

  const fixedFine: MeshData = {
    ...fine,
    positions,
    indices,
    edgeIndices: merged.map((e) => e.posIndex),
    edgeS: merged.map((e) => e.s),
  };
  return fineIsA
    ? { fixedA: fixedFine, fixedB: coarse }
    : { fixedA: coarse, fixedB: fixedFine };
}

/** 由位置与索引估算顶点法线（用于渲染） */
export function computeNormals(mesh: MeshData): Vec3[] {
  const normals: Vec3[] = mesh.positions.map(() => v3(0, 0, 0));
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t];
    const ib = mesh.indices[t + 1];
    const ic = mesh.indices[t + 2];
    const n = normalize(
      cross(
        sub(mesh.positions[ib], mesh.positions[ia]),
        sub(mesh.positions[ic], mesh.positions[ia]),
      ),
    );
    normals[ia] = add(normals[ia], n);
    normals[ib] = add(normals[ib], n);
    normals[ic] = add(normals[ic], n);
  }
  return normals.map(normalize);
}

/**
 * 构造初始样例：两块共享 v=0 边的弯曲四边形曲面。
 *
 * patchA 占据 x∈[-2,0]，patchB 占据 x∈[0,2]，共享边在 x=0。
 * 共享边的 4 个控制点是同一个对象引用 —— 拖动任一侧的共享控制点，两边同时更新。
 */
export function createInitialPatches(): { patchA: Patch; patchB: Patch } {
  const makeGrid = (u0: number): Vec3[][] => {
    const grid: Vec3[][] = [];
    for (let i = 0; i < 4; i++) {
      const column: Vec3[] = [];
      const u = i / 3;
      for (let j = 0; j < 4; j++) {
        const v = j / 3;
        const x = u0 + 2 * u;
        const y = (v - 0.5) * 4;
        // 拱形 + 横向起伏，保证共享边是真正弯曲的空间曲线
        const z =
          1.2 * Math.sin(v * Math.PI) +
          0.5 * Math.cos(u * Math.PI) * Math.sin(v * Math.PI * 2) +
          0.3 * u * v;
        column.push(v3(x, y, z));
      }
      grid.push(column);
    }
    return grid;
  };

  const gridA = makeGrid(-2);
  const gridB = makeGrid(0);
  // 共享边引用绑定：gridA 的 u=1 列 === gridB 的 u=0 列
  for (let j = 0; j < 4; j++) {
    gridB[0][j] = gridA[3][j];
  }

  const patchA: Patch = {
    name: 'Patch A',
    grid: gridA,
    subdivU: 12,
    subdivV: 4, // 疏侧
    sharedEdge: 'u1',
    edgeReversed: false,
  };
  const patchB: Patch = {
    name: 'Patch B',
    grid: gridB,
    subdivU: 12,
    subdivV: 16, // 密侧 —— 默认状态下即可看到裂缝
    sharedEdge: 'u0',
    edgeReversed: false,
  };
  return { patchA, patchB };
}

/** 深拷贝补丁（保留共享边引用关系，供“重置”使用） */
export function clonePatchPreservingSharedEdge(
  patch: Patch,
  sharedColumn: Vec3[] | undefined,
  edgeSide: EdgeSide,
): Patch {
  const grid = patch.grid.map((column) => column.map(cloneVec));
  if (sharedColumn) {
    const edgeU = edgeSide === 'u1' ? 3 : 0;
    for (let j = 0; j < 4; j++) grid[edgeU][j] = sharedColumn[j];
  }
  return { ...patch, grid };
}

/** 量化两条边折线端点是否严格重合（用于验证“共享边位置必须重合”） */
export function endpointsCoincide(meshA: MeshData, meshB: MeshData, eps = 1e-10): boolean {
  const lineA = edgePolyline(meshA);
  const lineB = edgePolyline(meshB);
  return (
    distance(lineA[0], lineB[0]) < eps &&
    distance(lineA[lineA.length - 1], lineB[lineB.length - 1]) < eps
  );
}

export function patchRadius(patch: Patch): number {
  let r = 0;
  for (const column of patch.grid) for (const p of column) r = Math.max(r, Math.hypot(p.x, p.y, p.z));
  return r;
}
