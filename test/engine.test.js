import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnose,
  diffReports,
  cameraGroundPolygon,
  convexHullXZ,
  pointInConvexXZ,
  buildLightFrame,
  toLightSpace,
  LIMITS,
} from '../src/diag/engine.js';
import {
  OBJECT_DEFS,
  objectRadius,
  DEFAULT_PARAMS,
  DEFAULT_VIEW,
  PARAM_PRESETS,
  lightDirection,
} from '../src/diag/scene-config.js';

function makeObjects(overrides = {}) {
  return OBJECT_DEFS.map((d) => ({
    id: d.id,
    label: d.label,
    position: [...d.position],
    radius: objectRadius(d),
    height: d.size ? d.size[1] : d.height,
    ...overrides[d.id],
  }));
}

function makeDesc(params = {}, camera = DEFAULT_VIEW, objects = makeObjects()) {
  const p = { ...DEFAULT_PARAMS, ...params };
  return {
    scene: { groundSize: 40 },
    params: {
      ...p,
      lightDir: lightDirection(p.azimuth, p.elevation),
      lightTarget: [0, 0, 0],
    },
    camera: {
      position: [...camera.position],
      target: [...camera.target],
      fov: 50,
      aspect: 1.6,
    },
    objects,
  };
}

const findById = (report, id) => report.findings.find((f) => f.id === id);

// ---------------------------------------------------------- 几何基础

test('光空间：原点位于目标点，z 轴沿光传播方向', () => {
  const frame = buildLightFrame([0, 1, 0], [0, 0, 0]);
  const origin = toLightSpace([0, 0, 0], frame);
  assert.ok(Math.abs(origin[2]) < 1e-9);
  // 光沿 +Y 传播，点 [0,5,0] 沿光方向更远，光空间 z 应为 +5
  const q = toLightSpace([0, 5, 0], frame);
  assert.ok(Math.abs(q[2] - 5) < 1e-9);
  // 近平面 0.5 位于光源侧，对应光空间深度 -0.5
  assert.ok(Math.abs(toLightSpace([0, -0.5, 0], frame)[2] + 0.5) < 1e-9);
});

test('相机地面多边形：透视相机返回凸多边形，俯视返回 null', () => {
  const poly = cameraGroundPolygon(makeDesc().camera);
  assert.ok(poly);
  assert.ok(poly.length >= 3 && poly.length <= 8);
  assert.ok(poly.every((p) => Math.abs(p[1]) < 1e-9));
  const top = cameraGroundPolygon({
    position: [0, 30, 0],
    target: [0, 0, 0],
    fov: 50,
    aspect: 1.6,
  });
  assert.equal(top, null);
});

test('凸包与点包含：框内点在内、远处点在外', () => {
  const hull = convexHullXZ([
    [-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5], [0, 0, 0],
  ]);
  assert.equal(hull.length, 4);
  assert.equal(pointInConvexXZ([0, 0, 0], hull), true);
  assert.equal(pointInConvexXZ([20, 0, 20], hull), false);
});

// ---------------------------------------------------------- 基线

test('基线预设：无 error 级诊断，视野覆盖率 100%', () => {
  const r = diagnose(makeDesc());
  assert.equal(r.stats.visibleUncovered, 0);
  assert.equal(r.viewCoverage, 1);
  assert.ok(!r.findings.some((f) => f.severity === 'error'));
  assert.ok(findById(r, 'all-ok'), '应给出正常条目');
});

// ---------------------------------------------------------- 覆盖范围

test('正交框缩小：水平越界物体被标记，且与偏移类问题区分', () => {
  const r = diagnose(makeDesc({ orthoSize: 10 }));
  const f = findById(r, 'coverage-horizontal');
  assert.ok(f, '应报告水平覆盖不足');
  assert.equal(f.kind, 'coverage');
  assert.ok(r.stats.outsideH > 0);
  // 不能只给笼统警告：必须有具体物体名与量化依据
  assert.match(f.basis, /单位/);
  assert.match(f.suggestion, /覆盖范围/);
  // 覆盖问题不应被误诊为偏移问题
  assert.ok(!findById(r, 'bias-peter'));
  assert.ok(r.objectReports.every((o) => ['inside', 'outside-h'].includes(o.state)));
});

test('增大覆盖范围到建议值后，水平越界消失', () => {
  const small = diagnose(makeDesc({ orthoSize: 10 }));
  const suggested = Number(
    small.findings.find((f) => f.id === 'coverage-horizontal').suggestion
      .match(/增大到至少 ([\d.]+)/)[1],
  );
  const fixed = diagnose(makeDesc({ orthoSize: suggested }));
  assert.equal(fixed.stats.outsideH, 0);
  assert.ok(!findById(fixed, 'coverage-horizontal'));
});

// ---------------------------------------------------------- 远平面

test('far 太小：远处高塔被远平面裁剪，归类为 coverage 而非 bias', () => {
  const r = diagnose(makeDesc({ far: 18 }));
  const f = findById(r, 'coverage-far');
  assert.ok(f);
  assert.equal(f.kind, 'coverage');
  assert.ok(r.stats.outsideFar >= 1);
  assert.ok(f.basis.includes('远平面'));
  // 建议必须是调 far，而不是 orthoSize
  assert.match(f.suggestion, /far/);
});

test('far 恢复默认后远裁剪消失，而缩小 orthoSize 不能解决远裁剪', () => {
  const r1 = diagnose(makeDesc({ far: 60 }));
  assert.equal(r1.stats.outsideFar, 0);
  const r2 = diagnose(makeDesc({ far: 18, orthoSize: 60 }));
  assert.ok(r2.stats.outsideFar >= 1, '只扩大正交框不应解决远平面问题');
});

// ---------------------------------------------------------- 近平面

test('near 过大：近平面穿过物体时报 error', () => {
  // 物体光空间 z 最小约 -12.7；near=5 使近平面位于 z=-5，光源侧物体被裁
  const r = diagnose(makeDesc({ near: 5, far: 80 }));
  assert.ok(findById(r, 'coverage-near'));
  assert.equal(findById(r, 'coverage-near').severity, 'error');
});

// ---------------------------------------------------------- 偏移：条纹

test('bias≈0 且 texel 偏大：报告阴影条纹，建议向负方向调 bias', () => {
  const r = diagnose(makeDesc({ bias: 0, normalBias: 0, orthoSize: 56, mapSize: 512 }));
  const f = findById(r, 'bias-acne');
  assert.ok(f);
  assert.equal(f.kind, 'bias');
  assert.match(f.suggestion, /深度偏移/);
  assert.ok(r.texel > LIMITS.texelSoft * 0.5);
});

test('bias 正常时不报告条纹', () => {
  const r = diagnose(makeDesc());
  assert.ok(!findById(r, 'bias-acne'));
});

// ---------------------------------------------------------- 偏移：脱离

test('bias/normalBias 过大：报告阴影脱离，建议往回降', () => {
  const r = diagnose(makeDesc({ bias: -0.012, normalBias: 0.25 }));
  const f = findById(r, 'bias-peter');
  assert.ok(f);
  assert.equal(f.kind, 'bias');
  assert.match(f.detail, /浮/);
  assert.match(f.suggestion, /法向偏移/);
});

test('条纹与脱离互斥：同一组参数不会同时报两类 bias 问题', () => {
  const acne = diagnose(makeDesc(PARAM_PRESETS.find((p) => p.id === 'acne').params));
  const peter = diagnose(makeDesc(PARAM_PRESETS.find((p) => p.id === 'peter').params));
  assert.ok(findById(acne, 'bias-acne') && !findById(acne, 'bias-peter'));
  assert.ok(findById(peter, 'bias-peter') && !findById(peter, 'bias-acne'));
});

// ---------------------------------------------------------- 清晰度

test('大框+小贴图：texel 超阈值报 resolution，并优先建议收缩范围', () => {
  const r = diagnose(makeDesc({ orthoSize: 80, mapSize: 256 }));
  const f = findById(r, 'resolution-low');
  assert.ok(f);
  assert.equal(f.kind, 'resolution');
  assert.ok(r.texel > LIMITS.texelCoarse);
  assert.equal(f.severity, 'error');
});

test('贴图翻倍：texel 减半，清晰度诊断解除', () => {
  const low = diagnose(makeDesc({ orthoSize: 60, mapSize: 512 }));
  const high = diagnose(makeDesc({ orthoSize: 60, mapSize: 4096 }));
  assert.ok(Math.abs(high.texel - low.texel / 8) < 1e-9);
  assert.ok(!findById(high, 'resolution-low'));
});

// ---------------------------------------------------------- 相机视角联动

test('切换视角：视野覆盖率与视野内未覆盖物体数随之更新', () => {
  // 覆盖框只罩住原点附近；远眺视角把远处塔放进视野中央
  const params = { orthoSize: 12 };
  const rPersp = diagnose(makeDesc(params, { position: [16, 12, 20], target: [0, 1.5, -3] }));
  const rFar = diagnose(makeDesc(params, { position: [6, 5, 14], target: [4, 2.5, -11] }));
  assert.notDeepEqual(
    rPersp.objectReports.map((o) => o.inView),
    rFar.objectReports.map((o) => o.inView),
    '两个视角下物体的在视野内标记必须不同',
  );
  const farVisibleUncovered = rFar.stats.visibleUncovered;
  assert.ok(farVisibleUncovered >= 1, '远眺视角应看到未覆盖的远处物体');
});

test('垂直俯视：视锥不与地面相交时多边形为 null，退化为全覆盖且不崩溃', () => {
  const r = diagnose(makeDesc({ orthoSize: 10 }, { position: [0, 34, 0], target: [0, 0, 0] }));
  assert.equal(r.viewPoly, null);
  assert.equal(r.viewCoverage, 1);
  // 水平越界仍然按物体状态正常报告
  assert.ok(r.stats.outsideH > 0);
});

// ---------------------------------------------------------- 物体移动联动

test('拖动物体出框：inside -> outside-h，诊断新增 coverage-horizontal', () => {
  const before = diagnose(makeDesc());
  const moved = makeObjects();
  const box = moved.find((o) => o.id === 'box');
  box.position = [30, 1, 4];
  const after = diagnose(makeDesc({}, DEFAULT_VIEW, moved));
  const rep = after.objectReports.find((o) => o.id === 'box');
  assert.equal(rep.state, 'outside-h');
  assert.ok(!findById(before, 'coverage-horizontal'));
  assert.ok(findById(after, 'coverage-horizontal'));
});

test('物体向光源方向移动越过 near：状态变为 outside-near', () => {
  const objs = makeObjects();
  const sphere = objs.find((o) => o.id === 'sphere');
  // 沿默认光反方向（朝向光源）移动 30 单位
  const dir = lightDirection(DEFAULT_PARAMS.azimuth, DEFAULT_PARAMS.elevation);
  sphere.position = sphere.position.map((v, i) => v - dir[i] * 30);
  const r = diagnose(makeDesc({}, DEFAULT_VIEW, objs));
  assert.equal(r.objectReports.find((o) => o.id === 'sphere').state, 'outside-near');
});

// ---------------------------------------------------------- 双组对比

test('diffReports：识别新增/解除的诊断与指标变化', () => {
  const a = diagnose(makeDesc());
  const b = diagnose(makeDesc({ orthoSize: 10 }));
  const d = diffReports(a, b);
  assert.ok(d.entries.some((e) => e.id === 'coverage-horizontal' && e.change === 'introduced'));
  assert.ok(d.entries.some((e) => e.id === 'all-ok' && e.change === 'resolved'));
  const coverageMetric = d.metrics.find((m) => m.key === 'viewCoverage');
  assert.ok(coverageMetric.b < coverageMetric.a);
  assert.ok(d.objDiffs.some((o) => o.to === 'outside-h'));
});

test('diffReports：两组一致时无差异条目', () => {
  const a = diagnose(makeDesc());
  const b = diagnose(makeDesc());
  const d = diffReports(a, b);
  assert.equal(d.entries.length, 0);
  assert.equal(d.objDiffs.length, 0);
});

// ---------------------------------------------------------- 重置

test('重置：默认参数报告与首次加载一致（确定性）', () => {
  const r1 = diagnose(makeDesc());
  const tampered = diagnose(makeDesc({ orthoSize: 8, bias: -0.02, mapSize: 256 }));
  assert.ok(tampered.findings.length !== r1.findings.length);
  const reset = diagnose(makeDesc());
  assert.deepEqual(reset.objectReports, r1.objectReports);
  assert.deepEqual(reset.findings.map((f) => f.id), r1.findings.map((f) => f.id));
});

// ---------------------------------------------------------- 现象区分（需求 5）

test('阴影突然消失的三种成因可区分：水平覆盖 / 远平面 / 近平面', () => {
  const h = diagnose(makeDesc({ orthoSize: 6 }));
  const f = diagnose(makeDesc({ near: 14, far: 18 }));
  const n = diagnose(makeDesc({ near: 5, far: 80 }));
  assert.ok(h.stats.outsideH > 0 && h.stats.outsideFar === 0 && h.stats.outsideNear === 0);
  assert.ok(f.stats.outsideFar > 0 && f.stats.outsideH === 0);
  assert.ok(n.stats.outsideNear > 0);
  const kinds = new Set([...h.findings, ...f.findings, ...n.findings].map((x) => x.kind));
  assert.ok(kinds.has('coverage'));
  // 三种消失都不应被归为 bias 或 resolution
  assert.ok(![...h.findings, ...f.findings, ...n.findings].some((x) => x.id === 'bias-acne'));
});

test('所有预设均可诊断且每个建议都给出量化数值', () => {
  for (const preset of PARAM_PRESETS) {
    const r = diagnose(makeDesc(preset.params));
    assert.ok(r.findings.length >= 1, `${preset.id} 至少有一条诊断`);
    for (const finding of r.findings) {
      assert.ok(finding.basis.length > 0, `${preset.id}/${finding.id} 缺少依据`);
      if (finding.id !== 'all-ok') assert.match(finding.suggestion, /-?\d/);
    }
  }
});
