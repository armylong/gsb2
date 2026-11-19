// 端到端流程测试：加载 → 检查 → 平面/平滑切换 → 顶点拆分 → 导出 → 回读，
// 覆盖需求中的完整使用路径与角度边界。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShadedMesh } from '../src/core/smoothing.js';
import { inspectMesh, ISSUE_TYPES } from '../src/core/inspect.js';
import { parseOBJ, exportOBJ, MeshLoadError } from '../src/io/meshio.js';
import { makeCube, makeLShape, SAMPLE_LIBRARY } from '../src/samples/generators.js';

test('端到端：立方体在不同临界角下的硬边数单调不减', () => {
  const mesh = makeCube();
  const counts = [0, 10, 35, 89, 90, 91, 180].map((a) =>
    buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: a }).hardEdges.length);
  // 临界角越小硬边越多：序列应单调不增（随角度增大）
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1],
      `角度增大硬边不应增多：${counts.join(',')}`);
  }
  assert.equal(counts[0], 12); // 0°：12 条 90° 几何棱全硬
  assert.equal(counts.at(-1), 0); // 180°：全软
});

test('端到端：90° 恰好为边界（夹角 > 临界角才硬，等于不硬）', () => {
  const mesh = makeCube();
  const at90 = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 90 });
  const below90 = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 89.999 });
  assert.equal(at90.hardEdges.length, 0, '夹角等于临界角时不拆（<= 合并）');
  assert.equal(below90.hardEdges.length, 12, '夹角略大于临界角时 12 条几何棱全部保留');
});

test('端到端：L 形棱柱同时保留 90° 棱并平滑共面切面', () => {
  const mesh = makeLShape();
  const report = inspectMesh(mesh);
  assert.equal(report.issues.filter((i) => i.severity === 'error').length, 0);
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  const angleEdges = shaded.hardEdges.filter((e) => e.reason === 'angle');
  assert.ok(angleEdges.length >= 6, 'L 形截面转角处应有多条角度硬边');
  // 共面切面被平滑：输出顶点少于全平面的 3×面数
  assert.ok(shaded.positions.length / 3 < mesh.faceCount * 3);
  // 相邻无关区域不受影响：面数完全保持
  assert.equal(shaded.faces.length, mesh.faceCount);
});

test('端到端：导出 OBJ 回读后再次检查，问题类型不丢失', () => {
  const factory = SAMPLE_LIBRARY
    .flatMap((g) => g.items)
    .find(([label]) => label === '非流形边')[1];
  const mesh = factory();
  const before = inspectMesh(mesh);
  assert.ok(before.issues.some((i) => i.type === ISSUE_TYPES.NON_MANIFOLD));

  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  const text = exportOBJ(shaded, 'nm.obj');
  const back = parseOBJ(text, 'nm_roundtrip.obj');
  const after = inspectMesh(back);
  // 顶点拆分后非流形边依然存在（同位置顶点仍被 3+ 面共享一条几何边）
  assert.ok(after.issues.some((i) => i.type === ISSUE_TYPES.NON_MANIFOLD));
  assert.equal(back.faceCount, shaded.faces.length);
});

test('端到端：全部样例工厂都能产出网格并通过检查流程，不抛异常', () => {
  for (const group of SAMPLE_LIBRARY) {
    for (const [label, factory] of group.items) {
      const mesh = factory();
      assert.ok(mesh.faceCount > 0, `${label} 应至少含一个面`);
      const report = inspectMesh(mesh);
      assert.ok(Array.isArray(report.issues), `${label} 检查结果结构正确`);
      const flat = buildShadedMesh(mesh, { mode: 'flat' });
      const smooth = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
      assert.equal(flat.faces.length, smooth.faces.length,
        `${label} 两种模式有效面数一致`);
    }
  }
});

test('端到端：加载损坏输入时错误带 code，调用方可以阻止空导出', () => {
  try {
    parseOBJ('v not a number\n', 'bad.obj');
    assert.fail('应当抛出异常');
  } catch (err) {
    assert.ok(err instanceof MeshLoadError);
    assert.equal(err.code, 'corrupt');
    assert.ok(err.message.length > 0);
  }
});
