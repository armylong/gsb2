/**
 * 真实 three.js 程序样例的端到端冒烟测试（Node 环境，不涉及 DOM/WebGL）。
 * 验证：开孔轮廓保留、前景块只挡长边中部、三视图完整出图、阈值变动、SVG 往返。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSampleScene } from '../src/three/sampleScene.ts';
import { buildWorld } from '../src/hlr/geometry.ts';
import { standardViews } from '../src/hlr/view.ts';
import { runHLR } from '../src/hlr/hlr.ts';
import { serializeSvg, parseDrawingMeta, defaultSvgOptions } from '../src/hlr/svg.ts';

function build(thresholdDeg: number) {
  const sample = createSampleScene();
  return {
    sample,
    mesh: buildWorld(sample.parts.map((p) => p.raw), thresholdDeg)
  };
}

test('样例包含三个零件且几何非空', () => {
  const { sample, mesh } = build(1);
  assert.deepEqual(sample.parts.map((p) => p.raw.id), ['A-plate', 'B-blocker', 'C-tilted']);
  assert.ok(mesh.triangles.length > 20);
  assert.ok(mesh.edges.length > 20);
});

test('开孔件：孔圈边被保留（圆心 0,-0.15、半径 0.62 的闭合边链）', () => {
  const { mesh } = build(1);
  const plateEdges = mesh.edges.filter((e) => e.partIndex === 0);
  // 孔边端点在 xy 平面上距孔心 ~0.62，且位于板厚 z∈[-0.175,0.175] 内
  const onHole = (vi: number): boolean => {
    const p = mesh.vertices[vi];
    const r = Math.hypot(p.x - 0, p.y - (-0.15));
    return Math.abs(r - 0.62) < 0.02 && Math.abs(p.z) <= 0.18;
  };
  const holeEdges = plateEdges.filter((e) => onHole(e.a) && onHole(e.b));
  assert.ok(holeEdges.length >= 30, `36 段圆孔（前后两圈+侧壁）应产生大量孔边，实际 ${holeEdges.length}`);

  // 孔边子图必须闭合：每个孔顶点度数 >= 2（前/后孔圈各 2 条，侧壁边使度数达到 3）
  const incident = new Map<number, number>();
  for (const e of holeEdges) {
    incident.set(e.a, (incident.get(e.a) ?? 0) + 1);
    incident.set(e.b, (incident.get(e.b) ?? 0) + 1);
  }
  assert.ok(incident.size >= 60, '圆孔前后两圈共 72 个焊接顶点');
  for (const [, count] of incident) assert.ok(count >= 2, '孔圈顶点至少属于两条孔边（闭合环）');

  // 板的外矩形轮廓四条边同样保留
  const outer = plateEdges.filter((e) => {
    const a = mesh.vertices[e.a];
    const b = mesh.vertices[e.b];
    const onRect = (p: typeof a): boolean =>
      Math.abs(Math.abs(p.x) - 2.2) < 0.01 || Math.abs(Math.abs(p.y) - 1.3) < 0.01;
    return onRect(a) && onRect(b);
  });
  assert.ok(outer.length >= 4, '板外轮廓边必须保留');
});

test('正视：前景块 B 只把板的长边挡在中部，两头保持实线', () => {
  const { mesh } = build(1);
  const view = standardViews(mesh, 1)[0];
  const result = runHLR(mesh, view, 1);

  const hiddenByB = result.segments.filter(
    (s) => s.kind === 'hidden' && s.partId === 'A-plate' && s.occluderPartIds.includes('B-blocker')
  );
  assert.ok(hiddenByB.length >= 1, '应存在被 B 挡住的板边段');
  for (const h of hiddenByB) {
    assert.ok(h.t0 > 0.02 && h.t1 < 0.98, '遮挡区间落在边的中部');
    const sameEdge = result.segments.filter((s) => s.edgeId === h.edgeId);
    const vis = sameEdge.filter((s) => s.kind === 'visible');
    assert.ok(vis.length >= 2, '同一条边两头仍有实线段');
  }
});

test('三个正交视图都完整出图：边记录数一致，没有边被取景框裁没', () => {
  const { mesh } = build(1);
  for (const v of standardViews(mesh, 1)) {
    const r = runHLR(mesh, v, 1);
    const drawnEdges = new Set(r.segments.map((s) => s.edgeId));
    assert.equal(drawnEdges.size, r.edgeRecords.length, `${v.name}：每条边都应至少出一段`);
    assert.ok(r.segments.some((s) => s.kind === 'visible'), `${v.name}：应有实线`);
  }
});

test('零件变换反映到投影：旋转件 C 的边在正视下不是轴对齐矩形', () => {
  const { mesh } = build(1);
  const view = standardViews(mesh, 1)[0];
  const r = runHLR(mesh, view, 1);
  const cSegs = r.segments.filter((s) => s.partId === 'C-tilted');
  assert.ok(cSegs.length >= 12, '旋转件 12 条棱都应出图（含被遮挡的虚线）');
  assert.ok(cSegs.some((s) => s.kind === 'visible'), 'C 位于相机侧，应有可见实线');
  // 绕 Y 旋转 32° 后，原本沿 Z 方向的棱在屏幕 x 方向产生投影：
  // 至少存在一条 x、y 都有变化的斜向边
  const tilted = cSegs.some((s) => Math.abs(s.x1 - s.x0) > 0.01 && Math.abs(s.y1 - s.y0) > 0.01);
  assert.ok(tilted, '旋转件应出现斜向投影边');
});

test('折边阈值变动：边 id 稳定，孔圈在高阈值下仍保留（边界边角度 180°）', () => {
  const low = build(1).mesh;
  const high = build(60).mesh;
  assert.ok(low.edges.length > high.edges.length, '高阈值过滤掉更多浅折边');
  for (const e of high.edges) assert.ok(low.edgeById.has(e.id), '保留边的 id 必须稳定');
  const holeEdgesHigh = high.edges.filter((e) => {
    const pa = high.vertices[e.a];
    const pb = high.vertices[e.b];
    const on = (p: typeof pa): boolean =>
      Math.abs(Math.hypot(p.x, p.y + 0.15) - 0.62) < 0.02 && Math.abs(p.z) <= 0.18;
    return on(pa) && on(pb);
  });
  assert.ok(holeEdgesHigh.length >= 20, '开孔轮廓是边界边，不受折边阈值影响');
});

test('SVG 导出/解析往返：元数据视图、阈值、遮挡关系与重算一致', () => {
  const { mesh } = build(1);
  const view = standardViews(mesh, 1)[0];
  const result = runHLR(mesh, view, 1);
  const opts = defaultSvgOptions(860, 720);
  const text = serializeSvg(result, opts, [
    { id: 'A-plate', label: 'A', color: 0 },
    { id: 'B-blocker', label: 'B', color: 1 },
    { id: 'C-tilted', label: 'C', color: 2 }
  ]);
  const meta = parseDrawingMeta(text);
  assert.equal(meta.view.name, 'front');
  assert.equal(meta.thresholdDeg, 1);
  assert.ok(meta.segments.some((s) => s.kind === 'hidden' && s.occluderPartIds.includes('B-blocker')));

  const live = runHLR(build(1).mesh, meta.view, meta.thresholdDeg);
  const eps = 1e-6;
  const close = (
    a: { edgeId: string; kind: string; t0: number; t1: number },
    b: typeof a
  ): boolean =>
    a.edgeId === b.edgeId && a.kind === b.kind &&
    Math.abs(a.t0 - b.t0) < eps && Math.abs(a.t1 - b.t1) < eps;
  assert.equal(meta.segments.length, live.segments.length);
  for (const s of meta.segments) assert.ok(live.segments.some((l) => close(s, l)));
});
