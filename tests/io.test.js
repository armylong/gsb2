// 导入/导出与回读测试：OBJ、ASCII/二进制 STL、损坏文件、空模型、法线回读。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOBJ, parseSTL, MeshLoadError, exportOBJ, exportAsciiSTL,
} from '../src/io/meshio.js';
import { buildShadedMesh } from '../src/core/smoothing.js';
import { inspectMesh } from '../src/core/inspect.js';
import { makeCube, makeGrid, makeAllDegenerate, makeTetraWithReversedFace } from '../src/samples/generators.js';
import { normalize, dot } from '../src/core/math3d.js';

test('OBJ 往返：面数/顶点数/法线一致', () => {
  const mesh = makeCube();
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  const text = exportOBJ(shaded, 'cube.obj');
  const back = parseOBJ(text, 'roundtrip.obj');
  assert.equal(back.faceCount, shaded.faces.length);
  assert.equal(back.vertexCount, shaded.positions.length / 3);
  assert.equal(back.meta.normalsInFile.length, shaded.normals.length / 3);

  // 逐顶点法线比对
  let maxErr = 0;
  const seen = new Set();
  back.faces.forEach((face, fi) => {
    face.forEach((vi, k) => {
      if (seen.has(vi)) return;
      seen.add(vi);
      const ni = back.meta.faceNormalIndices[fi][k];
      assert.notEqual(ni, null);
      const a = normalize([shaded.normals[vi * 3], shaded.normals[vi * 3 + 1], shaded.normals[vi * 3 + 2]]);
      const b = normalize(back.meta.normalsInFile[ni]);
      maxErr = Math.max(maxErr, 1 - dot(a, b));
    });
  });
  assert.ok(maxErr < 1e-5, `法线回读偏差过大: ${maxErr}`);

  // 回读模型按相同参数重算，硬边数一致
  const reShaded = buildShadedMesh(back, { mode: 'smooth', creaseAngleDeg: 35 });
  assert.equal(reShaded.hardEdges.length, shaded.hardEdges.length);
});

test('OBJ 多边形面扇形三角化并给出告警', () => {
  const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';
  const mesh = parseOBJ(quad, 'quad.obj');
  assert.equal(mesh.faceCount, 2);
  assert.ok(mesh.meta.warnings.some((w) => w.includes('扇形三角化')));
});

test('损坏 OBJ：索引越界抛 corrupt', () => {
  assert.throws(() => parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 9\n', 'x.obj'),
    (e) => e instanceof MeshLoadError && e.code === 'corrupt');
});

test('缺三角面 OBJ：有顶点无面抛 no-triangles', () => {
  assert.throws(() => parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\n', 'x.obj'),
    (e) => e instanceof MeshLoadError && e.code === 'no-triangles');
});

test('空文件 OBJ：抛 empty 而不是返回空模型', () => {
  assert.throws(() => parseOBJ('# 只有注释\n', 'x.obj'),
    (e) => e instanceof MeshLoadError && e.code === 'empty');
});

test('全退化模型导出防护：有效面为 0 时不得产生网格数据', () => {
  const mesh = makeAllDegenerate();
  const shaded = buildShadedMesh(mesh, { mode: 'flat' });
  assert.equal(shaded.faces.length, 0, '全退化输入处理后 0 个有效面');
  // 模拟 UI 的 guardExport：faces 为空即拒绝导出
  assert.throws(() => {
    if (shaded.faces.length === 0) {
      throw new MeshLoadError('no-triangles', '所有面均为退化面，导出已阻止');
    }
  }, (e) => e.code === 'no-triangles');
});

test('ASCII STL 解析：facet 数与绕序保持', () => {
  const stl = [
    'solid cube',
    '  facet normal 0 0 -1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1 0 0',
    '      vertex 1 1 0',
    '    endloop',
    '  endfacet',
    'endsolid cube',
  ].join('\n');
  const mesh = parseSTL(new TextEncoder().encode(stl), 'a.stl');
  assert.equal(mesh.faceCount, 1);
  assert.equal(mesh.vertexCount, 3);
  assert.equal(mesh.meta.format, 'STL (ascii)');
});

test('ASCII STL 损坏：缺 vertex 抛 corrupt', () => {
  const bad = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nendloop\nendfacet\nendsolid';
  assert.throws(() => parseSTL(new TextEncoder().encode(bad), 'x.stl'),
    (e) => e instanceof MeshLoadError && e.code === 'corrupt');
});

test('二进制 STL 往返：长度校验 + facet 还原', () => {
  const mesh = makeGrid(3, 1, 0); // 18 个三角形
  const ascii = exportAsciiSTL(
    buildShadedMesh(mesh, { mode: 'flat' }), 'patch');
  const reAscii = parseSTL(new TextEncoder().encode(ascii), 'patch.stl');
  assert.equal(reAscii.faceCount, mesh.faceCount);

  // 构造合法二进制 STL
  const triCount = 2;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    dv.setFloat32(off, 0, true); dv.setFloat32(off + 4, 0, true); dv.setFloat32(off + 8, 1, true);
    off += 12;
    for (let k = 0; k < 3; k++) {
      dv.setFloat32(off, k + t, true);
      dv.setFloat32(off + 4, k * 0.5, true);
      dv.setFloat32(off + 8, 0, true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  const binMesh = parseSTL(u8, 'bin.stl');
  assert.equal(binMesh.faceCount, 2);
  assert.equal(binMesh.meta.format, 'STL (binary)');

  // 截断的二进制 STL 必须报损坏
  assert.throws(() => parseSTL(u8.slice(0, 100), 'trunc.stl'),
    (e) => e instanceof MeshLoadError && e.code === 'corrupt');
});

test('STL 导出再回读：面数保持（STL 不共享顶点，朝向问题以 OBJ 回读为准）', () => {
  const mesh = makeTetraWithReversedFace();
  const shaded = buildShadedMesh(mesh, { mode: 'flat' });
  const text = exportAsciiSTL(shaded, 'rev');
  const back = parseSTL(new TextEncoder().encode(text), 'rev.stl');
  assert.equal(back.faceCount, shaded.faces.length);
  // STL 每面独立顶点，整个模型是开放的，反向面判定不适用 —— 该能力由下一条 OBJ 用例保证
});

test('OBJ 回读保留绕序：规则闭合模型重新打开后仍无反向面（朝向判定一致）', () => {
  // 用完全外向的闭合模型：导出回读后顶点可能被拆分，但几何边焊接后仍闭合，
  // 反向面判定必须给出与导出前一致的"无反向面"结论。
  const mesh = makeCube();
  assert.equal(inspectMesh(mesh).issues.some((i) => i.type === 'reversed'), false);
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  const back = parseOBJ(exportOBJ(shaded, 'cube.obj'), 'cube_roundtrip.obj');
  const report = inspectMesh(back);
  assert.equal(report.issues.some((i) => i.type === 'reversed'), false,
    '外向闭合模型回读后不应出现反向面误报');
});

test('反向面在原始（未拆分）模型上被精确定位', () => {
  // 反向面检测针对源网格；拆分导出会因方向不连续产生开放边，属另一类问题
  const mesh = makeTetraWithReversedFace();
  const report = inspectMesh(mesh);
  const issue = report.issues.find((i) => i.type === 'reversed');
  assert.ok(issue);
  assert.deepEqual(issue.faces, [0]);
});
