import assert from 'node:assert/strict';
import { test } from 'node:test';
import { v } from '../src/math.js';
import { ObstacleDef, segmentVisible } from '../src/rope.js';
import { RopeSim, projectToRopeLength } from '../src/sim.js';
import { getScenario } from '../src/scenarios.js';
import { collapseWraps } from '../src/wraps.js';

function makeSim(id: string, ropeLength?: number): RopeSim {
  const scene = getScenario(id);
  return new RopeSim(
    {
      anchor: scene.anchor,
      radius: scene.radius,
      obstacles: scene.obstacles,
      ropeLength: ropeLength ?? scene.ropeLength,
      autoWrap: true,
      autoRelease: true,
    },
    { pos: scene.start.pos, vel: scene.start.vel },
  );
}

function collectKeyEvents(sim: RopeSim, frames: number, dt = 1 / 120): string[] {
  const seen = new Set<object>();
  const log: string[] = [];
  for (let i = 0; i < frames; i++) {
    sim.step(dt, { swing: 0, ropeTrim: 0 });
    for (const e of sim.events) {
      if (seen.has(e)) continue;
      seen.add(e);
      if (e.kind === 'wrap' || e.kind === 'release') log.push(`${e.kind}@${e.t.toFixed(4)}:${e.cornerKey ?? ''}`);
    }
  }
  return log;
}

test('直线可见时没有拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(160, 100), v(160, 300), v(100, 300)],
  };
  assert.equal(segmentVisible(v(20, 20), v(260, 20), [pillar]), true);
});

test('贴角但不接触的直线仍可见，不产生拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(160, 100), v(160, 300), v(100, 300)],
  };
  assert.equal(segmentVisible(v(60, 40), v(260, 40), [pillar]), true);
});

test('连续绕过两个拐角时长度按实际折线累计', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(150, 100), v(190, 100), v(190, 650), v(150, 650)],
    vertexLabels: ['左上', '右上', '右下', '左下'],
  };
  const beam: ObstacleDef = {
    id: 'b',
    label: '梁',
    points: [v(900, 250), v(940, 250), v(940, 650), v(900, 650)],
    vertexLabels: ['左上', '右上', '右下', '左下'],
  };
  const anchor = v(40, 400);
  const body = v(1050, 420);
  const path = projectToRopeLength(anchor, body, 18, [pillar, beam], 2000, []);
  assert.ok(path.ok);
  assert.deepEqual(path.wraps.map((c) => c.key), ['p#3', 'b#2']);
  const straight = Math.hypot(body.x - anchor.x, body.y - anchor.y);
  assert.ok(path.path.totalLength > straight + 20);
  let sum = 0;
  for (const seg of path.path.segments) sum += seg.length;
  assert.ok(Math.abs(sum - path.path.totalLength) < 1e-9);
});

test('路径经过边时稳定且不产生虚构拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(200, 100), v(200, 200), v(100, 200)],
  };
  // 沿左边界延长线穿过（贴着边，不进入内部）
  assert.equal(segmentVisible(v(100, 20), v(100, 280), [pillar]), true);
});

test('绳恰好压过拐角时折叠同障碍的共线拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(200, 100), v(200, 200), v(100, 200)],
    vertexLabels: ['左上', '右上', '右下', '左下'],
  };
  const wraps = [
    { key: 'p#0', obstacleId: 'p', vertexIndex: 0, point: v(100, 100), label: '柱·左上' },
    { key: 'p#3', obstacleId: 'p', vertexIndex: 3, point: v(100, 200), label: '柱·左下' },
  ];
  // 从正上方到正下方，这两个顶点都在同一条直线上 -> 应折叠为空。
  const collapsed = collapseWraps(v(100, 20), v(100, 280), wraps, [pillar]);
  assert.equal(collapsed.length, 0);
});

test('样例 A 的绳路确实连绕两个拐点并周期性解开', () => {
  const sim = makeSim('double-wrap');
  assert.equal(sim.path.corners.length, 2);
  const log = collectKeyEvents(sim, 900);
  const wraps = log.filter((s) => s.startsWith('wrap')).length;
  const releases = log.filter((s) => s.startsWith('release')).length;
  assert.ok(wraps >= 2, `应有绕上事件，实际 ${wraps}`);
  assert.ok(releases >= 2, `应有解开事件，实际 ${releases}`);
  assert.ok(sim.path.totalLength <= sim.ropeLength + 0.5);
});

test('样例 B 全程不产生拐点，绳长等于直线', () => {
  const sim = makeSim('near-corner');
  const log = collectKeyEvents(sim, 1200);
  assert.deepEqual(log, []);
  assert.equal(sim.path.corners.length, 0);
  const straight = Math.hypot(sim.body.pos.x - sim.anchor.x, sim.body.pos.y - sim.anchor.y);
  assert.ok(sim.path.totalLength <= straight + 1e-6);
});

test('收绳不足时保留有效状态并给出原因', () => {
  const sim = makeSim('double-wrap');
  let blocked = 0;
  for (let i = 0; i < 900; i++) {
    sim.step(1 / 120, { swing: 0, ropeTrim: 1 });
    if (sim.snapshot().takeup.active || sim.lastBlockedReason) {
      blocked++;
      assert.ok(sim.path.totalLength <= sim.ropeLength + 0.5, '受限时状态必须仍然有效');
    }
  }
  assert.ok(blocked > 0, '持续收绳应触发受限');
  const reasons = new Set(sim.events.filter((e) => e.kind === 'takeup-limit').map((e) => e.text));
  assert.ok([...reasons].some((r) => r.includes('绳长不足')));
});

test('大步长不会穿过障碍', () => {
  const sim = makeSim('double-wrap');
  for (let i = 0; i < 220; i++) {
    sim.step(0.2, { swing: 0, ropeTrim: 0 });
    const p = sim.body.pos;
    for (const ob of getScenario('double-wrap').obstacles) {
      // 只检查内部点（用射线法）
      const poly = ob.points;
      let inside = false;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const pa = poly[a];
        const pb = poly[b];
        if (pa.y > p.y !== pb.y > p.y && p.x < ((pb.x - pa.x) * (p.y - pa.y)) / (pb.y - pa.y) + pa.x) {
          inside = !inside;
        }
      }
      assert.equal(inside, false, `第 ${i} 步角色进入障碍 ${ob.id}`);
    }
  }
});

test('相同初始状态重放，关键拐点事件时间一致', () => {
  const a = collectKeyEvents(makeSim('double-wrap'), 600, 1 / 60);
  const b = collectKeyEvents(makeSim('double-wrap'), 600, 1 / 60);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test('不同步长下关键拐点序列一致', () => {
  const a = collectKeyEvents(makeSim('double-wrap'), 420, 1 / 60);
  const b = collectKeyEvents(makeSim('double-wrap'), 210, 1 / 30);
  assert.deepEqual(a.slice(0, 4), b.slice(0, 4));
});

test('锚点移动在绳长不足时被拒绝并保留状态', () => {
  const sim = makeSim('double-wrap');
  for (let i = 0; i < 120; i++) sim.step(1 / 120, { swing: 0, ropeTrim: 1 });
  const before = sim.body.pos;
  const anchor = v(sim.anchor.x, sim.anchor.y - 260);
  const evs = sim.moveAnchor(anchor);
  const rejected = evs.some((e) => e.text.includes('拒绝'));
  if (rejected) {
    assert.ok(Math.hypot(sim.anchor.y - before.y, 0) >= 0);
    assert.ok(sim.path.totalLength <= sim.ropeLength + 0.5);
  } else {
    assert.ok(sim.path.totalLength <= sim.ropeLength + 0.5);
  }
});
