// 平滑/平面切换、角度边界、顶点拆分局部性测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShadedMesh } from '../src/core/smoothing.js';
import {
  makeCube, makeGrid, makeSphere, makeLShape, makeCubeWithDegenerateFace,
  makeOrientationDiscontinuity,
} from '../src/samples/generators.js';
import { normalize, dot } from '../src/core/math3d.js';

test('平面模式：每个角点独立，输出顶点 = 3 × 有效面数', () => {
  const mesh = makeCube();
  const flat = buildShadedMesh(mesh, { mode: 'flat' });
  assert.equal(flat.mode, 'flat');
  assert.equal(flat.positions.length / 3, mesh.faceCount * 3);
  assert.equal(flat.faces.length, mesh.faceCount);
  // 平面法线等于面法线：检查任意面的三个角点法线一致且平行面法线
  const srcN = mesh.faceNormal(0);
  const o = flat.faces[0][0] * 3;
  const outN = [flat.normals[o], flat.normals[o + 1], flat.normals[o + 2]];
  assert.ok(Math.abs(dot(normalize(outN), srcN) - 1) < 1e-9);
});

test('平滑模式 + 180°：立方体所有面同组，顶点不拆分（8 个顶点）', () => {
  const mesh = makeCube();
  const smooth = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 180 });
  assert.equal(smooth.groupCount, 1);
  assert.equal(smooth.positions.length / 3, mesh.vertexCount);
  assert.equal(smooth.stats.splitVertexCount, 0);
  // 180° 下没有角度硬边（立方体闭合、无边界）
  assert.equal(smooth.creaseAngleEdges.length, 0);
});

test('平滑模式 + 0°：所有非共面边为硬边，共面对角线（夹角 0°）仍合并', () => {
  const mesh = makeCube();
  const smooth = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 0 });
  // 每个四边形面的两个三角片夹角恰为 0°，不满足"严格大于临界角"，仍合并：6 组
  assert.equal(smooth.groupCount, 6);
  assert.equal(smooth.positions.length / 3, 6 * 4);
  // 12 条 90° 几何棱全部为角度硬边
  assert.equal(smooth.hardEdges.length, 12);
  assert.ok(smooth.hardEdges.every((e) => e.reason === 'angle'));
});

test('角度边界：90° 棱在 35° 临界角下保留，在 91° 下被平滑', () => {
  const mesh = makeCube();
  const kept = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  assert.equal(kept.hardEdges.length, 12, '35° 时立方体 12 条 90° 几何棱全部保留');
  assert.ok(kept.stats.splitVertexCount > 0);

  const softened = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 91 });
  assert.equal(softened.hardEdges.length, 0, '91° 时没有硬边');
  assert.equal(softened.groupCount, 1);
});

test('顶点拆分局部性：仅棱边两侧复制，共面区域顶点保持共享', () => {
  const mesh = makeLShape();
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  // 共面相邻三角面（夹角 0°）必须留在同一平滑组、共享顶点
  // 做法：对每个输出面，检查源网格中夹角为 0 的相邻面是否仍共享拆分后顶点
  const { adjacency } = mesh.buildEdges();
  let sharedCount = 0;
  let coplanarPairs = 0;
  const outIndexByCorner = new Map();
  shaded.faces.forEach((face, outFi) => {
    const srcFi = shaded.faceMap[outFi];
    face.forEach((newV, k) => {
      outIndexByCorner.set(`${srcFi}:${mesh.faces[srcFi][k]}`, newV);
    });
  });
  for (let fi = 0; fi < mesh.faceCount; fi++) {
    for (const fj of adjacency[fi]) {
      if (fj === null || fj <= fi) continue;
      const shared = mesh.faces[fi].filter((v) => mesh.faces[fj].includes(v));
      if (shared.length !== 2) continue;
      if (mesh.dihedralAngleDeg(fi, fj) > 1e-9) continue; // 只看共面片
      coplanarPairs++;
      const same = shared.every((v) =>
        outIndexByCorner.get(`${fi}:${v}`) === outIndexByCorner.get(`${fj}:${v}`));
      if (same) sharedCount++;
    }
  }
  assert.ok(coplanarPairs > 0, 'L 形棱柱应包含共面三角片对');
  assert.equal(sharedCount, coplanarPairs, '共面片顶点必须保持共享，不被拆分波及');
});

test('平滑球体：单一平滑组且法线为单位向量', () => {
  const mesh = makeSphere(1, 10, 14);
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 60 });
  assert.equal(shaded.groupCount, 1);
  for (let i = 0; i < shaded.normals.length; i += 3) {
    const n = [shaded.normals[i], shaded.normals[i + 1], shaded.normals[i + 2]];
    assert.ok(Math.abs(dot(n, n) - 1) < 1e-9, '法线必须归一化');
  }
});

test('退化面被跳过：输出面数 = 输入面数 - 退化面数', () => {
  const mesh = makeCubeWithDegenerateFace();
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  assert.equal(shaded.skippedDegenerate.length, 2);
  assert.equal(shaded.faces.length, mesh.faceCount - 2);
});

test('方向不连续边在任何角度下都保持为硬边', () => {
  const mesh = makeOrientationDiscontinuity();
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 180 });
  assert.ok(shaded.hardEdges.some((e) => e.reason === 'orientation'),
    '即使 180° 全平滑，方向不连续边也不允许合并');
});

test('细分平面平滑后法线统一朝向 +Z', () => {
  const mesh = makeGrid(4, 1, 0);
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  for (let i = 0; i < shaded.normals.length; i += 3) {
    assert.ok(shaded.normals[i + 2] > 0.99, '平面法线应朝 +Z');
  }
});
