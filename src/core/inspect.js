// 网格检查：退化面、反向面、相邻面方向不连续，以及无法可靠处理的区域
// （边界边、非流形边、零面积法线、重复顶点、开放/多分量）。
// 只检查、只报告，绝不补洞或重建拓扑。

import { length, dot, sub, cross } from './math3d.js';

export const ISSUE_TYPES = {
  DEGENERATE: 'degenerate',
  REVERSED: 'reversed',
  ORIENTATION_DISCONTINUITY: 'orientation-discontinuity',
  NON_MANIFOLD: 'non-manifold',
  BOUNDARY: 'boundary',
  ZERO_NORMAL: 'zero-normal',
  DUPLICATE_VERTEX: 'duplicate-vertex',
  OPEN_COMPONENT: 'open-component',
};

export const ISSUE_LABELS = {
  [ISSUE_TYPES.DEGENERATE]: '退化面（零面积/重复索引）',
  [ISSUE_TYPES.REVERSED]: '反向面（与所在分量主方向相反）',
  [ISSUE_TYPES.ORIENTATION_DISCONTINUITY]: '相邻面方向不连续（共享边同向）',
  [ISSUE_TYPES.NON_MANIFOLD]: '非流形边（≥3 个面共享）',
  [ISSUE_TYPES.BOUNDARY]: '边界边（开放边，法线平均不可靠）',
  [ISSUE_TYPES.ZERO_NORMAL]: '零法线面（叉积为零向量）',
  [ISSUE_TYPES.DUPLICATE_VERTEX]: '重复坐标顶点（可能存在未焊接裂缝）',
  [ISSUE_TYPES.OPEN_COMPONENT]: '开放分量（存在边界边，非封闭）',
};

// 严重级别：error 会阻止/警告导出；warning 表示平滑结果不可靠但仍可导出
export const ISSUE_SEVERITY = {
  [ISSUE_TYPES.DEGENERATE]: 'error',
  [ISSUE_TYPES.REVERSED]: 'error',
  [ISSUE_TYPES.ORIENTATION_DISCONTINUITY]: 'error',
  [ISSUE_TYPES.NON_MANIFOLD]: 'warning',
  [ISSUE_TYPES.BOUNDARY]: 'warning',
  [ISSUE_TYPES.ZERO_NORMAL]: 'error',
  [ISSUE_TYPES.DUPLICATE_VERTEX]: 'warning',
  [ISSUE_TYPES.OPEN_COMPONENT]: 'warning',
};

export function inspectMesh(mesh, opts = {}) {
  const degenerateEps = opts.degenerateEps ?? 1e-10;
  const dupEps = opts.duplicateEps ?? 1e-9;

  mesh.buildEdges();
  const faceNormals = mesh.allFaceNormals();
  const components = mesh.faceComponents();
  const componentCount = components.reduce((m, c) => Math.max(m, c + 1), 0);
  const issues = [];

  const push = (type, faces, detail) =>
    issues.push({ type, severity: ISSUE_SEVERITY[type], faces, detail });

  // ---- 逐面：退化 / 零法线 ----
  const degenerateFaces = [];
  const zeroNormalFaces = [];
  for (let fi = 0; fi < mesh.faceCount; fi++) {
    if (mesh.isDegenerate(fi, degenerateEps)) {
      degenerateFaces.push(fi);
      if (length(faceNormals[fi]) === 0) zeroNormalFaces.push(fi);
    } else if (length(faceNormals[fi]) === 0) {
      zeroNormalFaces.push(fi);
    }
  }
  if (degenerateFaces.length) {
    push(ISSUE_TYPES.DEGENERATE, degenerateFaces,
      `${degenerateFaces.length} 个面面积为 0 或索引重复，不参与法线计算，导出时默认剔除`);
  }
  if (zeroNormalFaces.length && zeroNormalFaces.length !== degenerateFaces.length) {
    push(ISSUE_TYPES.ZERO_NORMAL, zeroNormalFaces,
      '叉积为零向量，无法定义面法线');
  }

  // ---- 边分析（按几何位置焊接，容忍重复顶点与导出后的顶点拆分）----
  // 无向 key 标识同一条几何边；有向 key（+/- 后缀）记录环绕方向，
  // 两个面方向连续当且仅当它们在共享几何边上方向相反。
  const q = (vi) => {
    const o = vi * 3;
    return `${Math.round(mesh.positions[o] / dupEps)},`
      + `${Math.round(mesh.positions[o + 1] / dupEps)},`
      + `${Math.round(mesh.positions[o + 2] / dupEps)}`;
  };
  const geoEdges = new Map(); // 无向 key -> { a, b, dirs: [{face, sign}] }
  const discontinuityFaces = new Set();
  const nonManifoldFaces = new Set();
  const boundaryFaces = new Set();
  const boundaryEdges = [];
  const nonManifoldEdges = [];
  const discontinuityEdges = [];

  mesh.faces.forEach(([a, b, c], fi) => {
    const corners = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const u = corners[k];
      const v = corners[(k + 1) % 3];
      const ku = q(u);
      const kv = q(v);
      const undirected = ku < kv ? `${ku}|${kv}` : `${kv}|${ku}`;
      const sign = ku < kv ? '+' : '-'; // 面内方向相对无向 key 的朝向
      let rec = geoEdges.get(undirected);
      if (!rec) {
        rec = { a: Math.min(u, v), b: Math.max(u, v), dirs: [] };
        geoEdges.set(undirected, rec);
      }
      rec.dirs.push({ face: fi, sign });
    }
  });

  for (const rec of geoEdges.values()) {
    if (rec.dirs.length > 2) {
      nonManifoldEdges.push([rec.a, rec.b]);
      rec.dirs.forEach((f) => nonManifoldFaces.add(f.face));
    } else if (rec.dirs.length === 1) {
      boundaryEdges.push([rec.a, rec.b]);
      boundaryFaces.add(rec.dirs[0].face);
    } else {
      // 一正一反 => 连续；同号 => 方向不连续
      const consistent = rec.dirs[0].sign !== rec.dirs[1].sign;
      if (!consistent) {
        discontinuityEdges.push([rec.a, rec.b]);
        rec.dirs.forEach((f) => discontinuityFaces.add(f.face));
      }
    }
  }
  if (discontinuityFaces.size) {
    push(ISSUE_TYPES.ORIENTATION_DISCONTINUITY,
      [...discontinuityFaces].sort((a, b) => a - b),
      `${discontinuityEdges.length} 条共享边上两个面环绕方向相同，光照会出现接缝式翻转`);
  }
  if (nonManifoldFaces.size) {
    push(ISSUE_TYPES.NON_MANIFOLD, [...nonManifoldFaces],
      `${nonManifoldEdges.length} 条边被 3 个以上面共享，顶点拆分/法线平均结果不可靠`);
  }
  if (boundaryFaces.size) {
    push(ISSUE_TYPES.BOUNDARY, [...boundaryFaces],
      `${boundaryEdges.length} 条开放边界边，边界顶点法线只能单侧平均`);
  }

  // ---- 反向面：按连通分量判定，闭合分量才可靠 ----
  // 判定方式：从面心沿面法线发出射线，与闭合网格相交。朝外的面，射线先离开实体
  // （含起点在内的相交次数为奇数）；凹形的重心可能落在实体外，故不用重心法。
  const compFaces = Array.from({ length: componentCount }, () => []);
  components.forEach((c, fi) => compFaces[c].push(fi));
  const reversedFaces = [];
  const openComponents = [];

  // 射线（原点 o，方向 d）与三角形 (p0,p1,p2) 求交，返回 t>eps 的参数或 null
  const rayTriHit = (o, d, p0, p1, p2) => {
    const e1 = sub(p1, p0);
    const e2 = sub(p2, p0);
    const h = cross(d, e2);
    const aa = dot(e1, h);
    if (Math.abs(aa) < 1e-12) return null;
    const f = 1 / aa;
    const s = sub(o, p0);
    const u = f * dot(s, h);
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    const q = cross(s, e1);
    const v = f * dot(d, q);
    if (v < -1e-9 || u + v > 1 + 1e-9) return null;
    const t = f * dot(e2, q);
    return t > 1e-9 ? t : null;
  };

  compFaces.forEach((faces, cid) => {
    let hasBoundary = false;
    for (const fi of faces) if (boundaryFaces.has(fi)) { hasBoundary = true; break; }
    if (hasBoundary) { openComponents.push(cid); return; }

    for (const fi of faces) {
      if (mesh.isDegenerate(fi, degenerateEps)) continue;
      const [p0, p1, p2] = mesh.facePoints(fi);
      const n = faceNormals[fi];
      const center = [
        (p0[0] + p1[0] + p2[0]) / 3,
        (p0[1] + p1[1] + p2[1]) / 3,
        (p0[2] + p1[2] + p2[2]) / 3,
      ];
      // 沿面法线射线：从表面出发，外向面的射线直接离开实体（0 命中）；
      // 反向面法线指向实体内部，射线会再次击中网格（≥1 命中）。
      // 起点所在面用 t>eps 排除，凹形同样成立，不依赖重心位置。
      let inwardHits = 0;
      for (const fj of faces) {
        if (mesh.isDegenerate(fj, degenerateEps)) continue;
        const [q0, q1, q2] = mesh.facePoints(fj);
        if (rayTriHit(center, n, q0, q1, q2) !== null) inwardHits++;
      }
      if (inwardHits > 0) reversedFaces.push(fi);
    }
  });
  if (reversedFaces.length) {
    push(ISSUE_TYPES.REVERSED, reversedFaces.sort((a, b) => a - b),
      `在 ${componentCount} 个分量中发现 ${reversedFaces.length} 个面绕序与主方向相反（仅对闭合分量判定）`);
  }
  if (openComponents.length) {
    const ocFaces = new Set();
    openComponents.forEach((c) => compFaces[c].forEach((f) => ocFaces.add(f)));
    push(ISSUE_TYPES.OPEN_COMPONENT, [...ocFaces],
      `分量 ${openComponents.map((c) => `#${c}`).join(', ')} 含边界边，整体朝向无法可靠判定`);
  }

  // ---- 重复坐标顶点 ----
  const map = new Map();
  const duplicates = new Set();
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 3;
    const key = `${Math.round(mesh.positions[o] / dupEps)},`
      + `${Math.round(mesh.positions[o + 1] / dupEps)},`
      + `${Math.round(mesh.positions[o + 2] / dupEps)}`;
    if (map.has(key)) duplicates.add(i);
    else map.set(key, i);
  }
  if (duplicates.size) {
    const facesTouched = new Set();
    mesh.faces.forEach((f, fi) => f.forEach((v) => {
      if (duplicates.has(v)) facesTouched.add(fi);
    }));
    push(ISSUE_TYPES.DUPLICATE_VERTEX, [...facesTouched],
      `${duplicates.size} 个顶点与其他顶点坐标重合，若本应焊接则平滑时会出现裂缝`);
  }

  const errorCount = issues.filter((i) => i.severity === 'error')
    .reduce((n, i) => n + i.faces.length, 0);
  const warningCount = issues.filter((i) => i.severity === 'warning')
    .reduce((n, i) => n + i.faces.length, 0);

  return {
    issues,
    componentCount,
    boundaryEdges,
    nonManifoldEdges,
    discontinuityEdges,
    counts: {
      errorFaceCount: errorCount,
      warningFaceCount: warningCount,
      boundaryEdgeCount: boundaryEdges.length,
      nonManifoldEdgeCount: nonManifoldEdges.length,
      discontinuityEdgeCount: discontinuityEdges.length,
    },
    // 无法可靠处理的面：检查器不做自动修复，仅在视图中标记
    unreliableFaces: [...new Set([
      ...nonManifoldFaces, ...boundaryFaces, ...discontinuityFaces,
    ])].sort((a, b) => a - b),
  };
}
