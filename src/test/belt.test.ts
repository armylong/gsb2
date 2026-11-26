import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBelt,
  sampleAt,
  externalTangent,
  type Pulley,
  v,
  dist,
  mod2pi,
} from '../math/belt.ts';
import { generateMarkers, remapMarkers, selectedDistanceToSeam, worldS } from '../math/markers.ts';

const defaultPulleys: Pulley[] = [
  { center: v(-4, 0), radius: 1.2 },
  { center: v(0, 2.4), radius: 0.9 },
  { center: v(4, 0), radius: 1.5 },
];

test('默认三轮机：构建成功且路径闭合', () => {
  const r = buildBelt(defaultPulleys);
  assert.equal(r.ok, true, r.conflicts.map((c) => c.message).join('; '));
  const path = r.path!;
  assert.equal(path.segments.length, 6);
  assert.ok(path.length > 10);

  // 首尾相接
  const first = path.segments[0];
  const last = path.segments[path.segments.length - 1];
  assert.ok(Math.abs(first.s0) < 1e-9);
  assert.ok(Math.abs(last.s1 - path.length) < 1e-9);

  // 接触包角均在 (0, 2π)
  for (const c of path.contacts) {
    assert.ok(c.wrap > 0.05 && c.wrap < 2 * Math.PI);
  }

  // 弧段 + 直线段长度之和等于总带长
  let sum = 0;
  for (const seg of path.segments) sum += seg.s1 - seg.s0;
  assert.ok(Math.abs(sum - path.length) < 1e-9);
});

test('采样：切向单位化、法线正交、整圈连续', () => {
  const path = buildBelt(defaultPulleys).path!;
  let prev = sampleAt(path, 0);
  for (let s = 0.1; s <= path.length + 0.05; s += 0.1) {
    const cur = sampleAt(path, s % path.length);
    assert.ok(Math.abs(cur.tangent.x ** 2 + cur.tangent.y ** 2 - 1) < 1e-9);
    assert.ok(Math.abs(cur.tangent.x * cur.normal.x + cur.tangent.y * cur.normal.y) < 1e-9);
    // 相邻采样点距离与步长一致（弧长参数化）
    const d = dist(prev.p, cur.p);
    assert.ok(d < 0.2, `采样间距异常 ${d} @s=${s}`);
    prev = cur;
  }
  // 接缝处闭合
  const a = sampleAt(path, 0);
  const b = sampleAt(path, path.length);
  assert.ok(dist(a.p, b.p) < 1e-9);
  assert.ok(Math.abs(a.tangent.x - b.tangent.x) < 1e-9);
});

test('采样：弯段上的点到轮心距离恒为半径', () => {
  const path = buildBelt(defaultPulleys).path!;
  const arc = path.segments.find((s) => s.kind === 'arc')!;
  for (let s = arc.s0 + 0.01; s < arc.s1; s += 0.05) {
    const smp = sampleAt(path, s);
    assert.equal(smp.pulley, (arc as { pulley: number }).pulley);
    const pulley = path.pulleys[smp.pulley];
    assert.ok(Math.abs(dist(smp.p, pulley.center) - pulley.radius) < 1e-9);
  }
});

test('外切线：等径两轮给出平行于连心线的外侧切线', () => {
  const t = externalTangent({ center: v(0, 0), radius: 1 }, { center: v(4, 0), radius: 1 })!;
  assert.ok(t);
  assert.ok(Math.abs(t.p.y - 1) < 1e-9); // 逆时针凸包约定下取上侧（连心线右侧）
  assert.ok(Math.abs(t.q.y - 1) < 1e-9);
  assert.ok(Math.abs(t.t.x - 1) < 1e-9);
  assert.ok(Math.abs(t.n.y - 1) < 1e-9); // 外法线向上、背离轮心
});

test('外切线：不等径切点落在各自圆周且连线垂直法线', () => {
  const a = { center: v(0, 0), radius: 1 };
  const b = { center: v(5, 0), radius: 2 };
  const t = externalTangent(a, b)!;
  assert.ok(Math.abs(dist(t.p, a.center) - 1) < 1e-9);
  assert.ok(Math.abs(dist(t.q, b.center) - 2) < 1e-9);
  const pq = v(t.q.x - t.p.x, t.q.y - t.p.y);
  assert.ok(Math.abs(t.n.x * pq.x + t.n.y * pq.y) < 1e-9);
});

test('两轮距离不足：报告 overlap 冲突及轮编号', () => {
  const r = buildBelt([
    { center: v(-4, 0), radius: 1.2 },
    { center: v(0, 0), radius: 1.5 }, // 与轮 0 中心距 4，半径和 2.7，正常
    { center: v(0.8, 0), radius: 1.5 }, // 与轮 1 中心距 0.8，相交
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.reason === 'overlap'));
  const c = r.conflicts.find((c) => c.reason === 'overlap')!;
  assert.deepEqual([...c.wheels].sort(), [1, 2]);
});

test('包含关系：报告 containment 冲突', () => {
  const r = buildBelt([
    { center: v(0, 0), radius: 4 },
    { center: v(1, 0), radius: 0.5 }, // 被轮 0 完全包住
    { center: v(6, 0), radius: 1 },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.reason === 'containment'));
});

test('偏心布置 A：中间轮贴近两轮连线，两段切线内部交叉', () => {
  const r = buildBelt([
    { center: v(-4, 0), radius: 1.2 },
    { center: v(0, 0.004), radius: 0.9 }, // 几乎落在轮 0、轮 2 的连线上
    { center: v(4, 0), radius: 1.5 },
  ]);
  assert.equal(r.ok, false);
  const crossing = r.conflicts.find((c) => c.reason === 'crossing');
  assert.ok(crossing, '应报告直线交叉冲突');
  assert.ok(crossing!.wheels.includes(1));
});

test('偏心布置 B：中间轮下移使接触包角低于阈值，指出该轮', () => {
  const r = buildBelt([
    { center: v(-4, 0), radius: 1.2 },
    { center: v(0, 0.55), radius: 0.9 }, // 包角约 4.3° < 阈值
    { center: v(4, 0), radius: 1.5 },
  ]);
  assert.equal(r.ok, false);
  const wrap = r.conflicts.find((c) => c.reason === 'wrap');
  assert.ok(wrap, '应报告包角失效');
  assert.deepEqual(wrap!.wheels, [1]);
});

test('几何变更后再次构建：中间轮拉开后带路恢复有效', () => {
  const bad = buildBelt([
    { center: v(-4, 0), radius: 1.2 },
    { center: v(0, 0.55), radius: 0.9 },
    { center: v(4, 0), radius: 1.5 },
  ]);
  assert.equal(bad.ok, false);
  const good = buildBelt([
    { center: v(-4, 0), radius: 1.2 },
    { center: v(0, 2.4), radius: 0.9 },
    { center: v(4, 0), radius: 1.5 },
  ]);
  assert.equal(good.ok, true);
  assert.ok(good.path!.contacts.every((c) => c.wrap >= 0.05));
});

test('标记：材料坐标固定，phase 改变世界位置且周期闭合', () => {
  const set = generateMarkers(20, 1);
  const m = set.markers.find((m) => m.label === 3)!;
  assert.ok(Math.abs(worldS(m, 0, 20) - 3) < 1e-9);
  assert.ok(Math.abs(worldS(m, 2.5, 20) - 5.5) < 1e-9);
  assert.ok(Math.abs(worldS(m, 20, 20) - 3) < 1e-9);
  assert.ok(Math.abs(worldS(m, -3, 20) - 0) < 1e-9);
});

test('几何变更：标记按相对位置 u 重映射，编号身份保留', () => {
  const old = generateMarkers(20, 1, 5);
  assert.equal(old.selectedLabel, 5);
  const next = remapMarkers(old, 30, 1);
  const sel = next.markers.find((m) => m.selected)!;
  // u = 5/20 = 0.25 → 新位置 7.5，最近编号 7 或 8
  assert.ok(Math.abs(sel.s - 7.5) < 1.01);
  assert.ok(next.markers.every((m) => !m.selected || m === sel));
});

test('选中刻度到接缝距离：随走带单调变化并在接缝处归零', () => {
  const set = generateMarkers(20, 1, 5); // 选中刻度材料坐标 5
  assert.ok(Math.abs(selectedDistanceToSeam(set, 0)! - 15) < 1e-9);
  assert.ok(Math.abs(selectedDistanceToSeam(set, 15)! - 0) < 1e-9); // 世界位置到接缝
  assert.ok(Math.abs(selectedDistanceToSeam(set, 16)! - 19) < 1e-9); // 跨过接缝
});

test('mod2pi 边界', () => {
  assert.ok(Math.abs(mod2pi(-0.5) - (2 * Math.PI - 0.5)) < 1e-12);
  assert.ok(Math.abs(mod2pi(2 * Math.PI)) < 1e-12);
});
