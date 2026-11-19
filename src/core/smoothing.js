// 表面显示与顶点拆分。
//
// 思路（与主流建模软件的 smoothing group 一致）：
//   1. 以"面"为节点做并查集；一条两边共享、方向连续、法线夹角 <= 临界角的边
//      才把两个面并入同一平滑组。
//   2. 输出网格的每个角点 key = (原顶点, 所在面的平滑组根)。
//      只有真正需要断开的棱边两侧才会产生不同的新顶点 —— 相邻无关区域共享
//      顶点的关系完全保留，不会被波及。
//   3. 新顶点法线 = 同组内相邻面法线的面积加权平均；平面模式每个角点独立，
//      法线即面法线。
// 不做补洞、不重建拓扑，只允许"复制顶点"这一种操作。

import { normalize, add, scale, degToRad } from './math3d.js';

class DSU {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// mode: 'flat' | 'smooth'；creaseAngleDeg 仅 smooth 模式生效
// 返回可直接渲染/导出的拆分后网格与硬边清单
export function buildShadedMesh(mesh, options = {}) {
  const mode = options.mode === 'flat' ? 'flat' : 'smooth';
  const creaseAngleDeg = options.creaseAngleDeg ?? 35;
  const creaseRad = degToRad(creaseAngleDeg);

  const faceNormals = mesh.allFaceNormals();
  const valid = []; // 非退化面才参与
  const skippedDegenerate = [];
  for (let fi = 0; fi < mesh.faceCount; fi++) {
    if (mesh.isDegenerate(fi)) skippedDegenerate.push(fi);
    else valid.push(fi);
  }
  const validSet = new Set(valid);

  // 按几何位置焊接建边：同位置顶点（含导出回读后的拆分副本）视为同一条边，
  // 这样回读模型才能还原与导出时相同的平滑组与硬边。
  const weldEps = 1e-9;
  const posKey = (vi) => {
    const o = vi * 3;
    return `${Math.round(mesh.positions[o] / weldEps)},`
      + `${Math.round(mesh.positions[o + 1] / weldEps)},`
      + `${Math.round(mesh.positions[o + 2] / weldEps)}`;
  };
  const geoEdgeMap = new Map();
  mesh.faces.forEach(([a, b, c], fi) => {
    const corners = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const u = corners[k];
      const v = corners[(k + 1) % 3];
      const ku = posKey(u);
      const kv = posKey(v);
      const key = ku < kv ? `${ku}|${kv}` : `${kv}|${ku}`;
      let rec = geoEdgeMap.get(key);
      if (!rec) {
        rec = { a: Math.min(u, v), b: Math.max(u, v), dirs: [] };
        geoEdgeMap.set(key, rec);
      }
      rec.dirs.push({ face: fi, u, v, sign: ku < kv ? '+' : '-' });
    }
  });

  const dsu = new DSU(mesh.faceCount);
  const edgeInfo = []; // {u,v,fi,fj,angleDeg,reason,hard}

  for (const rec of geoEdgeMap.values()) {
    const [u, v] = [rec.a, rec.b];
    if (rec.dirs.length === 1) {
      edgeInfo.push({ u, v, fi: rec.dirs[0].face, fj: null,
        angleDeg: null, reason: 'boundary', hard: true });
      continue;
    }
    if (rec.dirs.length > 2) {
      edgeInfo.push({ u, v, fi: rec.dirs[0].face, fj: rec.dirs[1].face,
        angleDeg: null, reason: 'non-manifold', hard: true });
      continue;
    }
    const [x, y] = rec.dirs;
    const fi = x.face;
    const fj = y.face;
    const consistent = x.sign !== y.sign;
    const angleDeg = mesh.dihedralAngleDeg(fi, fj);
    let reason = null;
    let hard = false;
    if (!consistent) {
      reason = 'orientation';
      hard = true; // 方向不连续：绝不能跨边平均法线
    } else if (mode === 'flat' || angleDeg > creaseAngleDeg + 1e-9) {
      reason = mode === 'flat' ? 'flat-mode' : 'angle';
      hard = true;
    }
    if (!hard && validSet.has(fi) && validSet.has(fj)) {
      dsu.union(fi, fj);
    }
    edgeInfo.push({ u, v, fi, fj, angleDeg, reason, hard });
  }

  // ---- 生成拆分后的顶点/面 ----
  const outPositions = [];
  const outNormals = [];
  const outFaces = [];
  const faceMap = [];      // 新面 -> 旧面
  const cornerIndex = new Map(); // `${fi}:${oldV}` -> 新顶点
  const keyToNew = new Map();    // 角点 key -> 新顶点
  const normalAccum = new Map(); // 新顶点 -> 累加法线
  const splitCounts = new Map(); // 原顶点 -> 复制出的角点数

  const getOrCreate = (fi, oldV) => {
    const ck = `${fi}:${oldV}`;
    const existing = cornerIndex.get(ck);
    if (existing !== undefined) return existing;

    const root = mode === 'flat' ? `f${fi}` : `r${dsu.find(fi)}`;
    const key = `${oldV}|${root}`;
    let ni = keyToNew.get(key);
    if (ni === undefined) {
      ni = outPositions.length / 3;
      keyToNew.set(key, ni);
      const o = oldV * 3;
      outPositions.push(
        mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]);
      outNormals.push(0, 0, 0);
      normalAccum.set(ni, [0, 0, 0]);
      splitCounts.set(oldV, (splitCounts.get(oldV) ?? 0) + 1);
    }
    cornerIndex.set(ck, ni);
    return ni;
  };

  for (const fi of valid) {
    const [a, b, c] = mesh.faces[fi];
    const na = getOrCreate(fi, a);
    const nb = getOrCreate(fi, b);
    const nc = getOrCreate(fi, c);
    outFaces.push([na, nb, nc]);
    faceMap.push(fi);
    // 面积加权累加（退化面已剔除，权重安全）
    const w = mesh.faceArea(fi);
    const n = scale(faceNormals[fi], w);
    for (const ni of [na, nb, nc]) {
      const acc = normalAccum.get(ni);
      const merged = add(acc, n);
      normalAccum.set(ni, merged);
    }
  }
  for (const [ni, acc] of normalAccum) {
    const nn = normalize(acc);
    const o = ni * 3;
    outNormals[o] = nn[0];
    outNormals[o + 1] = nn[1];
    outNormals[o + 2] = nn[2];
  }

  // ---- 硬边线段（使用拆分后的新索引，直接叠加渲染；按几何位置去重）----
  const hardEdges = [];
  const creaseAngleEdges = [];
  const hardEdgeSeen = new Set();
  for (const e of edgeInfo) {
    if (!e.hard || !validSet.has(e.fi)) continue;
    const i0 = cornerIndex.get(`${e.fi}:${e.u}`);
    const i1 = cornerIndex.get(`${e.fi}:${e.v}`);
    if (i0 === undefined || i1 === undefined) continue;
    // 同一条几何边可能被两个面各引用一次，按位置 key 去重
    const pKey = (vi) => {
      const o = vi * 3;
      return `${Math.round(outPositions[o] / 1e-9)},`
        + `${Math.round(outPositions[o + 1] / 1e-9)},`
        + `${Math.round(outPositions[o + 2] / 1e-9)}`;
    };
    const dedupKey = [pKey(i0), pKey(i1)].sort().join('|');
    if (hardEdgeSeen.has(dedupKey)) continue;
    hardEdgeSeen.add(dedupKey);
    const seg = { a: i0, b: i1, reason: e.reason, angleDeg: e.angleDeg };
    hardEdges.push(seg);
    if (e.reason === 'angle') creaseAngleEdges.push(seg);
  }

  // 实际被拆成多份的原顶点
  const splitVertices = [...splitCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([vertex, copies]) => ({ vertex, copies }));

  return {
    mode,
    creaseAngleDeg,
    positions: outPositions,
    normals: outNormals,
    faces: outFaces,
    faceMap,
    hardEdges,
    creaseAngleEdges,
    edgeInfo,
    splitVertices,
    skippedDegenerate,
    groupCount: mode === 'smooth'
      ? new Set(valid.map((fi) => dsu.find(fi))).size
      : valid.length,
    stats: {
      inputVertexCount: mesh.vertexCount,
      outputVertexCount: outPositions.length / 3,
      inputFaceCount: mesh.faceCount,
      outputFaceCount: outFaces.length,
      splitVertexCount: splitVertices.reduce((n, s) => n + s.copies - 1, 0),
    },
  };
}
