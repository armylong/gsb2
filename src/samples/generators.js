// 程序生成的规则模型与含问题小样例。
// 全部直接构造 TriangleMesh，不做任何"修复"，坏样例就是坏的，供检查器定位。

import { TriangleMesh } from '../core/mesh.js';

class Builder {
  constructor() {
    this.positions = [];
    this.faces = [];
  }
  v(x, y, z) {
    this.positions.push(x, y, z);
    return this.positions.length / 3 - 1;
  }
  f(a, b, c) {
    this.faces.push([a, b, c]);
    return this.faces.length - 1;
  }
  build(name, format = 'procedural', warnings = []) {
    return new TriangleMesh(this.positions, this.faces,
      { fileName: name, format, warnings });
  }
}

// 闭合流形网格的外向定向传播（仅用于构造程序样例，不是检查器的自动修复）：
// 沿共享边 BFS，强制相邻面在共享边上方向相反；最后按有向体积符号统一整体朝外。
// 保证结果 0 条方向不连续边，且法线整体朝外。
function orientOutward(positions, faces, eps = 1e-9) {
  const q = (vi) => {
    const o = vi * 3;
    return [positions[o], positions[o + 1], positions[o + 2]]
      .map((x) => Math.round(x / eps)).join(',');
  };
  const edgeRefs = new Map();
  faces.forEach((f, fi) => {
    for (let k = 0; k < 3; k++) {
      const u = f[k];
      const v = f[(k + 1) % 3];
      const ku = q(u);
      const kv = q(v);
      const key = ku < kv ? `${ku}|${kv}` : `${kv}|${ku}`;
      if (!edgeRefs.has(key)) edgeRefs.set(key, []);
      edgeRefs.get(key).push({ fi, u, v });
    }
  });
  const adj = faces.map(() => []);
  for (const refs of edgeRefs.values()) {
    if (refs.length === 2) {
      adj[refs[0].fi].push(refs[1].fi);
      adj[refs[1].fi].push(refs[0].fi);
    }
  }
  const flip = new Array(faces.length).fill(false);
  const visited = new Array(faces.length).fill(false);
  const hasUV = (face, u, v) =>
    face.some((x, k) => x === u && face[(k + 1) % 3] === v);
  for (let start = 0; start < faces.length; start++) {
    if (visited[start]) continue;
    visited[start] = true;
    const queue = [start];
    while (queue.length) {
      const a = queue.shift();
      for (const b of adj[a]) {
        if (visited[b]) continue;
        visited[b] = true;
        const shared = faces[a].filter((v) => faces[b].includes(v));
        if (shared.length === 2) {
          const [u, v] = shared;
          const fa = flip[a] ? [...faces[a]].reverse() : faces[a];
          if (hasUV(fa, u, v) === hasUV(faces[b], u, v)) flip[b] = !flip[b];
        }
        queue.push(b);
      }
    }
  }
  let oriented = faces.map((f, fi) => (flip[fi] ? [...f].reverse() : [...f]));
  let vol = 0;
  for (const f of oriented) {
    const p = f.map((vi) => { const o = vi * 3; return positions.slice(o, o + 3); });
    vol += p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1])
         - p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0])
         + p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0]);
  }
  if (vol < 0) oriented = oriented.map((f) => [f[0], f[2], f[1]]);
  return oriented;
}

// 规则立方体：外向绕序，6 面 12 三角，棱边天然 90°
export function makeCube(size = 1) {
  const b = new Builder();
  const s = size / 2;
  const c = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ].map((p) => b.v(...p));
  // 每个面按"从面外侧看为逆时针"给出四角，再对角线三角化，保证法线严格朝外
  const quad = (i, j, k, l) => { b.f(c[i], c[j], c[k]); b.f(c[i], c[k], c[l]); };
  quad(0, 3, 2, 1); // -Z
  quad(4, 5, 6, 7); // +Z
  quad(0, 4, 7, 3); // -X
  quad(1, 2, 6, 5); // +X
  quad(0, 1, 5, 4); // -Y
  quad(3, 7, 6, 2); // +Y
  return b.build('规则立方体 cube.obj');
}

// 细分平面（XY 平面，+Z 朝外），带可选弯曲；用于观察纯平滑效果
export function makeGrid(segments = 8, size = 2, bend = 0) {
  const b = new Builder();
  const ids = [];
  const step = size / segments;
  for (let j = 0; j <= segments; j++) {
    ids[j] = [];
    for (let i = 0; i <= segments; i++) {
      const x = -size / 2 + i * step;
      const y = -size / 2 + j * step;
      const z = bend ? bend * Math.cos((x / size) * Math.PI) * Math.cos((y / size) * Math.PI) : 0;
      ids[j][i] = b.v(x, y, z);
    }
  }
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = ids[j][i], c = ids[j][i + 1], d = ids[j + 1][i + 1], e = ids[j + 1][i];
      b.f(a, c, d);
      b.f(a, d, e);
    }
  }
  return b.build(bend ? '弯曲细分网格 curved_grid.obj' : '规则细分平面 grid.obj');
}

// UV 球：经线/纬线细分，平滑显示的经典样例
export function makeSphere(radius = 1, latSegments = 12, lonSegments = 18) {
  const b = new Builder();
  const grid = [];
  for (let i = 0; i <= latSegments; i++) {
    const theta = (i / latSegments) * Math.PI;
    grid[i] = [];
    for (let j = 0; j <= lonSegments; j++) {
      const phi = (j / lonSegments) * Math.PI * 2;
      grid[i][j] = b.v(
        -radius * Math.cos(phi) * Math.sin(theta),
        radius * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta));
    }
  }
  for (let i = 0; i < latSegments; i++) {
    for (let j = 0; j < lonSegments; j++) {
      const a = grid[i][j], c = grid[i][j + 1], d = grid[i + 1][j + 1], e = grid[i + 1][j];
      b.f(a, c, d);
      b.f(a, d, e);
    }
  }
  return b.build('规则 UV 球 sphere.obj');
}

// 带折角的 L 形棱柱：同一网格内同时存在 90° 棱和共面切面
export function makeLShape() {
  const b = new Builder();
  // L 形截面（XY，逆时针），沿 Z 拉伸。凹多边形手算绕序易错，
  // 这里先用朴素四边形 + 扇形端盖生成，再用 orientOutward 做定向传播，
  // 保证侧面/端盖在所有共享边上方向相反且整体朝外。
  const pts = [[0, 0], [2, 0], [2, 0.6], [0.6, 0.6], [0.6, 2], [0, 2]];
  const z0 = -0.5, z1 = 0.5;
  const bot = pts.map(([x, y]) => b.v(x, y, z0));
  const top = pts.map(([x, y]) => b.v(x, y, z1));
  const n = pts.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    b.f(bot[k], bot[k2], top[k2]);
    b.f(bot[k], top[k2], top[k]);
  }
  for (let k = 1; k < n - 1; k++) {
    b.f(bot[0], bot[k + 1], bot[k]);
    b.f(top[0], top[k], top[k + 1]);
  }
  b.faces = orientOutward(b.positions, b.faces);
  return b.build('L 形棱柱 l_shape.obj');
}

// ---------- 含问题样例 ----------

// 规则四面体：4 顶点 4 三角面，闭合外向，最小的可判定整体朝向的网格
export function makeTetrahedron() {
  const b = new Builder();
  const v = [
    b.v(1, 1, 1),
    b.v(-1, -1, 1),
    b.v(-1, 1, -1),
    b.v(1, -1, -1),
  ];
  // 外向绕序（每个面法线背离重心 (0,0,0)）
  b.f(v[0], v[2], v[1]);
  b.f(v[0], v[1], v[3]);
  b.f(v[0], v[3], v[2]);
  b.f(v[1], v[2], v[3]);
  return b.build('规则四面体 tetra.obj');
}

// 四面体 + 单个反向面：保持流形邻接（共享边仍一正一反），只反转一个面的绕序。
// 这样检查器既能定位反向面，导出回读后朝向判定依然成立。
export function makeTetraWithReversedFace() {
  const mesh = makeTetrahedron();
  const bad = mesh.faces[0];
  mesh.faces[0] = [bad[0], bad[2], bad[1]];
  mesh.meta.fileName = '问题样例-反向面 tetra_reversed.obj';
  mesh.meta.warnings.push('第 1 个三角形绕序被故意反转，邻接关系保持流形');
  return mesh;
}

// 含退化面：把一个三角形的两个顶点指向同一索引，并追加一个零面积几何面
export function makeCubeWithDegenerateFace() {
  const b = new Builder();
  const mesh = makeCube();
  b.positions = mesh.positions;
  b.faces = mesh.faces.map((f) => [...f]);
  const dup = b.faces[2][0];
  b.f(dup, dup, b.faces[2][1]); // 重复索引退化面
  const p0 = b.v(0, 0, 0);
  const p1 = b.v(1, 0, 0);
  const p2 = b.v(0.5, 0, 0); // 三点共线，零面积
  b.f(p0, p1, p2);
  return b.build('问题样例-退化面 cube_degenerate.obj', 'procedural',
    ['追加了 1 个重复索引面和 1 个三点共线零面积面']);
}

// 相邻面方向不连续：两个面在共享边上同向环绕（开放 T 形片，接缝处光照翻转）
export function makeOrientationDiscontinuity() {
  const b = new Builder();
  const a = b.v(0, 0, 0), c = b.v(1, 0, 0);
  const d = b.v(1, -1, 0), e = b.v(0, -1, 0); // 下方四边形
  const f = b.v(0, 0, 1), g = b.v(1, 0, 1);   // 上方竖片
  // 底面朝下（-Y）：边 a->c 在面内出现
  b.f(a, c, d);
  b.f(a, d, e);
  // 竖片面 1 也以 a->c 同向环绕（连续写法应为 c->a），制造方向不连续
  b.f(a, c, g);
  b.f(a, g, f);
  return b.build('问题样例-方向不连续 orientation_seam.obj', 'procedural',
    ['竖片与底面在共享边 a-c 上环绕方向相同，形成光照接缝']);
}

// 重复坐标顶点：立方体的一个角点被复制，相邻面引用不同副本 => 未焊接裂缝
export function makeDuplicateVertexCube() {
  const mesh = makeCube();
  const dupIndex = mesh.vertexCount;
  mesh.positions.push(...mesh.vertex(0)); // 与 0 号顶点完全重合
  // 让引用 0 号顶点的部分面改用新副本
  let moved = 0;
  mesh.faces.forEach((face) => {
    if (moved < 2 && face.includes(0)) {
      face[face.indexOf(0)] = dupIndex;
      moved++;
    }
  });
  mesh.meta.fileName = '问题样例-重复顶点 duplicate_vertex.obj';
  mesh.meta.warnings.push('角点被复制为两个重合但未焊接的顶点，平滑时出现裂缝');
  return mesh;
}

// 非流形：三个面共享同一条边
export function makeNonManifold() {
  const b = new Builder();
  const a = b.v(0, 0, 0), c = b.v(0, 0, 1);
  const p1 = b.v(1, 0, 0), p2 = b.v(0, 1, 0), p3 = b.v(-1, 0, 0);
  b.f(a, c, p1); // 面 1
  b.f(a, p2, c); // 面 2（边 a-c 反向）
  b.f(a, c, p3); // 面 3 再次使用边 a-c => 非流形
  return b.build('问题样例-非流形边 non_manifold.obj', 'procedural',
    ['3 个三角形共享同一条边，法线平均与顶点拆分结果不可靠']);
}

// 开放曲面：带边界边的波浪布，无法判定整体朝向
export function makeOpenPatch() {
  const mesh = makeGrid(6, 2, 0.35);
  mesh.meta.fileName = '问题样例-开放曲面 open_patch.obj';
  mesh.meta.warnings.push('四周均为边界边，整体朝向无法可靠判定');
  return mesh;
}

// 全退化模型：没有任何有效三角面，导出必须被阻止
export function makeAllDegenerate() {
  const b = new Builder();
  const a = b.v(0, 0, 0), c = b.v(1, 0, 0), d = b.v(2, 0, 0);
  b.f(a, c, d); // 共线
  b.f(a, a, c); // 重复索引
  return b.build('问题样例-全退化 all_degenerate.obj', 'procedural',
    ['所有三角形面积为 0，没有可显示/导出的有效面']);
}

export const SAMPLE_LIBRARY = [
  { group: '规则模型', items: [
    ['规则立方体', makeCube],
    ['UV 球', () => makeSphere()],
    ['细分平面', () => makeGrid()],
    ['弯曲网格', () => makeGrid(8, 2, 0.4)],
    ['L 形棱柱（带 90° 棱）', makeLShape],
  ]},
  { group: '含问题样例', items: [
    ['反向面四面体', makeTetraWithReversedFace],
    ['退化面立方体', makeCubeWithDegenerateFace],
    ['相邻面方向不连续', makeOrientationDiscontinuity],
    ['重复顶点裂缝', makeDuplicateVertexCube],
    ['非流形边', makeNonManifold],
    ['开放曲面（边界边）', makeOpenPatch],
    ['全退化模型（禁止导出）', makeAllDegenerate],
  ]},
];
