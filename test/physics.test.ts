/**
 * 物理与几何单元测试（node --test，CommonJS 构建产物）。
 * 覆盖：坐标可逆、可见性遮挡、直射/反射物理、有色墙染色、
 * 关墙与挪挡板的真实更新、两档取样一致性、灯功率线性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  raySegment,
  isVisible,
  angularSpan,
  angleTo,
  angleMod,
  hexToRgb,
  rgbToHex,
  pointSegmentDistance,
  v,
} from '../src/geometry.js';
import { LightEngine } from '../src/engine.js';
import { createDefaultWorld, QUALITY_SPECS } from '../src/scene.js';
import { Camera } from '../src/camera.js';

const luma = (c: { r: number; g: number; b: number }): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

test('射线与线段求交：命中、平行、反向不命中', () => {
  const o = v(0, 0);
  assert.ok(raySegment(o, v(1, 0), v(2, -1), v(2, 1)));
  assert.equal(raySegment(o, v(1, 0), v(2, 1), v(3, 1)), null); // 平行
  assert.equal(raySegment(o, v(-1, 0), v(2, -1), v(2, 1)), null); // 反方向
});

test('张角：线段正对观察点张角随距离减小', () => {
  const near = angularSpan(v(0, 0), v(1, -1), v(1, 1));
  const far = angularSpan(v(0, 0), v(2, -1), v(2, 1));
  assert.ok(near > far);
  assert.ok(near > 0 && near < Math.PI);
});

test('角度工具：atan2 与模 2π', () => {
  assert.equal(angleTo(v(0, 0), v(1, 0)), 0);
  assert.ok(Math.abs(angleTo(v(0, 0), v(0, 1)) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(angleMod(-0.1) - (Math.PI * 2 - 0.1)) < 1e-12);
});

test('点到线段距离', () => {
  assert.equal(pointSegmentDistance(v(0, 1), v(-1, 0), v(1, 0)).dist, 1);
  const r = pointSegmentDistance(v(5, 0), v(-1, 0), v(1, 0));
  assert.equal(r.dist, 4);
  assert.equal(r.u, 1);
});

test('颜色往返：hex → 线性 → hex 近似一致', () => {
  const c = hexToRgb('#c0392b');
  assert.ok(c.r > c.g && c.r > c.b); // 红墙红通道最大
  const back = rgbToHex(c);
  const a = parseInt(back.slice(1), 16);
  const b = parseInt('c0392b', 16);
  for (const shift of [16, 8, 0]) {
    assert.ok(Math.abs(((a >> shift) & 255) - ((b >> shift) & 255)) <= 2);
  }
});

test('相机变换严格互逆，缩放不漂移世界坐标', () => {
  const cam = new Camera();
  cam.fit({ x: 0, y: 0, w: 12, h: 8 }, 800, 600);
  const p = v(3.21, 5.67);
  const back = cam.toWorld(cam.toScreen(p));
  assert.ok(Math.abs(back.x - p.x) < 1e-12);
  assert.ok(Math.abs(back.y - p.y) < 1e-12);
  cam.zoomAt({ x: 400, y: 300 }, 2.5);
  const back2 = cam.toWorld(cam.toScreen(p));
  assert.ok(Math.abs(back2.x - p.x) < 1e-12);
  assert.ok(Math.abs(back2.y - p.y) < 1e-12);
});

test('可见性：中间有墙则不可见，墙关闭后恢复可见', () => {
  const walls = [{ id: 'w1', ax: 1, ay: -1, bx: 1, by: 1, enabled: true }];
  assert.equal(isVisible(v(0, 0), v(2, 0), walls), false);
  assert.equal(isVisible(v(0, 0), v(2, 0), [{ ...walls[0], enabled: false }]), true);
  assert.equal(isVisible(v(0, 0), v(2, 0), walls, 'w1'), true); // 忽略自身
});

test('默认场景：灯附近有显著直射，暗角直射为零', () => {
  const world = createDefaultWorld();
  const eng = new LightEngine(world, QUALITY_SPECS.quick);
  const near = eng.analyzeFloor(
    world.samples.find((s) => s.id === 'sample-near-lamp')!.pos,
    false,
  );
  const dark = eng.analyzeFloor(
    world.samples.find((s) => s.id === 'sample-dark-corner')!.pos,
    false,
  );
  assert.ok(luma(near.direct) > 1, '灯附近应有直射');
  assert.equal(luma(dark.direct), 0, '双层挡板暗角应无直射');
});

test('红墙亮角：直射被挡板挡住，但存在带红色调的一次反射，红墙是最大有色贡献', () => {
  const world = createDefaultWorld();
  const eng = new LightEngine(world, QUALITY_SPECS.quick);
  const red = eng.analyzeFloor(
    world.samples.find((s) => s.id === 'sample-red-corner')!.pos,
    false,
  );
  assert.equal(luma(red.direct), 0, '亮角看不到灯');
  assert.ok(luma(red.reflected) > 0, '亮角应被墙反射照亮');
  const rr = red.reflected.r / luma(red.reflected);
  assert.ok(rr > 1.18, `反射应偏红（红通道占比>1.18），实际 ${rr}`);
  // 红墙是所有非白墙（红/灰挡板）里贡献最大的一个
  const colored = red.contributions.filter((c) => c.wallId.includes('red') || c.wallId.includes('baffle'));
  assert.equal(colored[0].wallId, 'wall-red');
  const redC = red.contributions.find((c) => c.wallId === 'wall-red')!;
  assert.ok(luma(redC.irradiance) > 0.4, '红墙反射贡献应显著');
});

test('暗角无直射且显著暗于灯附近，并暗于亮角的合计', () => {
  const world = createDefaultWorld();
  const eng = new LightEngine(world, QUALITY_SPECS.quick);
  const red = eng.analyzeFloor(
    world.samples.find((s) => s.id === 'sample-red-corner')!.pos,
    false,
  );
  const dark = eng.analyzeFloor(
    world.samples.find((s) => s.id === 'sample-dark-corner')!.pos,
    false,
  );
  const near = eng.analyzeFloor(
    world.samples.find((s) => s.id === 'sample-near-lamp')!.pos,
    false,
  );
  assert.equal(luma(dark.direct), 0, '暗角无直射');
  assert.ok(luma(dark.total) < luma(near.total) * 0.15, '暗角远暗于灯附近');
  assert.ok(luma(dark.total) < luma(red.total), '暗角暗于红墙亮角');
});

test('关闭红墙：亮角反射的红色分量下降（红墙是红光来源）', () => {
  const world = createDefaultWorld();
  const eng = new LightEngine(world, QUALITY_SPECS.quick);
  const pos = world.samples.find((s) => s.id === 'sample-red-corner')!.pos;
  const before = eng.analyzeFloor(pos, false);
  const after = eng.analyzeFloor(pos, false, new Set(['wall-red']));
  // 总亮度可能因高反照率白墙补位而升高，但红色光一定减少
  assert.ok(after.reflected.r < before.reflected.r, '关掉红墙后红色反射分量应下降');
  assert.ok(
    after.reflected.r / Math.max(luma(after.reflected), 1e-9) <
      before.reflected.r / Math.max(luma(before.reflected), 1e-9),
    '关掉红墙后色温应变冷（红通道占比下降）',
  );
});

test('真实开关墙段：禁用挡板后暗角获得直射', () => {
  const world = createDefaultWorld();
  const pos = { ...world.samples.find((s) => s.id === 'sample-dark-corner')!.pos };
  const blocked = new LightEngine(world, QUALITY_SPECS.quick).analyzeFloor(pos, false);
  assert.equal(luma(blocked.direct), 0);

  const world2 = createDefaultWorld();
  for (const id of ['wall-baffle-b1', 'wall-baffle-b2']) {
    world2.walls.find((x) => x.id === id)!.enabled = false;
  }
  const opened = new LightEngine(world2, QUALITY_SPECS.quick).analyzeFloor(pos, false);
  assert.ok(luma(opened.direct) > 1, '移开两层挡板后暗角应有直射');
});

test('挪动挡板挡住视线：直射实时归零，反射仍在', () => {
  const world = createDefaultWorld();
  const mid = world.samples.find((s) => s.id === 'sample-mid')!.pos;
  const before = new LightEngine(world, QUALITY_SPECS.quick).analyzeFloor(mid, false);
  assert.ok(luma(before.direct) > 0);

  world.walls.push({
    id: 'new-blocker',
    a: { x: mid.x - 3, y: mid.y - 0.05 },
    b: { x: mid.x + 3, y: mid.y - 0.05 },
    color: hexToRgb('#888888'),
    enabled: true,
  });
  const after = new LightEngine(world, QUALITY_SPECS.quick).analyzeFloor(mid, false);
  assert.equal(luma(after.direct), 0);
  assert.ok(luma(after.reflected) > 0, '直射消失但反射仍在');
});

test('灯功率与照度线性', () => {
  const world = createDefaultWorld();
  const pos = world.samples.find((s) => s.id === 'sample-near-lamp')!.pos;
  const a = new LightEngine(world, QUALITY_SPECS.quick).analyzeFloor(pos, false);
  world.lamp.power *= 2;
  const b = new LightEngine(world, QUALITY_SPECS.quick).analyzeFloor(pos, false);
  assert.ok(Math.abs(luma(b.total) / luma(a.total) - 2) < 1e-9);
});

test('快预览与密集取样：同一点合计相对差小于 6%', () => {
  const world = createDefaultWorld();
  const q = new LightEngine(world, QUALITY_SPECS.quick);
  const d = new LightEngine(world, QUALITY_SPECS.dense);
  for (const s of world.samples) {
    const a = luma(q.analyzeFloor(s.pos, false).total);
    const b = luma(d.analyzeFloor(s.pos, false).total);
    const rel = b > 1e-9 ? Math.abs(a - b) / b : Math.abs(a - b);
    assert.ok(rel < 0.06, `${s.id} 两档相对差 ${rel}`);
  }
});

test('热图：两档 diffStats 均值差占平均亮度比例小', () => {
  const world = createDefaultWorld();
  const hq = new LightEngine(world, QUALITY_SPECS.quick).computeHeatMap();
  const hd = new LightEngine(world, QUALITY_SPECS.dense).computeHeatMap();
  const stats = LightEngine.diffStats(hq, hd);
  assert.ok(stats.meanLuma > 0);
  // 角度射线在锐利阴影边界处有量化误差，全房间平均相对差控制在 12% 以内即视为两档一致
  assert.ok(stats.meanAbsDiff / stats.meanLuma < 0.12);
});

test('探针射线数量等于档位配置且等角覆盖整圆', () => {
  const world = createDefaultWorld();
  const eng = new LightEngine(world, QUALITY_SPECS.quick);
  const a = eng.analyzeFloor({ x: 6, y: 4 }, true);
  assert.equal(a.rays.length, QUALITY_SPECS.quick.floorRays);
  const span = (2 * Math.PI) / QUALITY_SPECS.quick.floorRays;
  assert.ok(Math.abs(a.rays[1].angle - a.rays[0].angle - span) < 1e-12);
});
