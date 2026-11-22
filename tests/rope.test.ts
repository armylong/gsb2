import assert from 'node:assert/strict';
import { test } from 'node:test';
import { v } from '../src/math.js';
import {
  ObstacleDef,
  RopeCorner,
  segmentVisible,
  solveRopePath,
} from '../src/rope.js';
import { RopeSim } from '../src/sim.js';
import { getScenario } from '../src/scenarios.js';

test('直线可见时没有拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(160, 100), v(160, 300), v(100, 300)],
  };
  const a = v(20, 20);
  const b = v(260, 20);
  assert.equal(segmentVisible(a, b, [pillar]), true);
  const path = solveRopePath(a, b, [pillar], null);
  assert.equal(path.corners.length, 0);
  assert.equal(path.points.length, 2);
  assert.ok(Math.abs(path.totalLength - Math.hypot(240, 0)) < 1e-9);
});

test('贴角但不接触的直线仍可见，不产生拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(160, 100), v(160, 300), v(100, 300)],
  };
  // 擦过右上角 (160,100) 上方 3px
  const a = v(60, 40);
  const b = v(260, 40);
  assert.equal(segmentVisible(a, b, [pillar]), true);
  assert.equal(solveRopePath(a, b, [pillar], null).corners.length, 0);
  // 目的地在柱子右下方，直线必然穿过柱子，必须绕角
  const c = v(300, 300);
  const path = solveRopePath(a, c, [pillar], null);
  assert.ok(path.corners.length >= 1);
  assert.ok(path.totalLength > Math.hypot(c.x - a.x, c.y - a.y) + 1);
});

test('连续绕两个拐角时长度按实际折线累计', () => {
  // 锚点在左，角色在右；两堵墙一上一下错开，直线被挡两次，
  // 绳必须先绕过第一堵墙的下角，再绕过第二堵墙的下角。
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
  const path = solveRopePath(anchor, body, [pillar, beam], null);
  const keys = path.corners.map((c: RopeCorner) => c.key);
  assert.deepEqual(keys, ['p#3', 'b#2']);
  // 实际折线长度必须严格大于直线距离
  const straight = Math.hypot(body.x - anchor.x, body.y - anchor.y);
  assert.ok(path.totalLength > straight + 50);
  let sum = 0;
  for (const seg of path.segments) sum += seg.length;
  assert.ok(Math.abs(sum - path.totalLength) < 1e-9);
  // 逐段长 = 相邻拐点欧氏距离
  const pts = [anchor, ...path.corners.map((c) => c.point), body];
  for (let i = 0; i < path.segments.length; i++) {
    assert.ok(Math.abs(path.segments[i].length - Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)) < 1e-9);
  }
});

test('路径经过边时稳定且不产生虚构拐点', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(200, 100), v(200, 200), v(100, 200)],
  };
  // 从正上方沿边界延长线到正下方：直线贴着左边界 (100, ...)，允许。
  const a = v(100, 20);
  const b = v(100, 280);
  assert.equal(segmentVisible(a, b, [pillar]), true);
  const first = solveRopePath(a, b, [pillar], null);
  const second = solveRopePath(a, b, [pillar], first);
  const third = solveRopePath(a, b, [pillar], second);
  assert.equal(first.corners.length, 0);
  assert.deepEqual(second.corners.map((c) => c.key), first.corners.map((c) => c.key));
  assert.deepEqual(third.corners.map((c) => c.key), first.corners.map((c) => c.key));
});

test('绳恰好压过拐角时保留上一帧取舍', () => {
  const pillar: ObstacleDef = {
    id: 'p',
    label: '柱',
    points: [v(100, 100), v(200, 100), v(200, 200), v(100, 200)],
    vertexLabels: ['左上', '右上', '右下', '左下'],
  };
  const a = v(20, 20);
  const b = v(300, 300);
  const base = solveRopePath(a, b, [pillar], null);
  assert.ok(base.corners.length > 0);
  // 两条路径长度相同的构造下，传入上一帧应原样保留
  const kept = solveRopePath(a, b, [pillar], base);
  assert.deepEqual(
    kept.corners.map((c) => c.key),
    base.corners.map((c) => c.key),
  );
});

test('样例 A 的绳路确实连绕两个拐点', () => {
  const scene = getScenario('double-wrap');
  const sim = new RopeSim(
    {
      anchor: scene.anchor,
      radius: scene.radius,
      obstacles: scene.obstacles,
      ropeLength: scene.ropeLength,
      autoWrap: true,
      autoRelease: true,
    },
    { pos: scene.start.pos, vel: scene.start.vel },
  );
  let maxCorners = 0;
  for (let i = 0; i < 200; i++) {
    sim.step(1 / 60, { swing: 0, ropeTrim: 0 });
    maxCorners = Math.max(maxCorners, sim.path.corners.length);
  }
  assert.ok(maxCorners >= 2, `应至少同时绕过两个拐点，实际 ${maxCorners}`);
});

test('样例 B 的直线贴角通过时没有拐点', () => {
  const scene = getScenario('near-corner');
  const sim = new RopeSim(
    {
      anchor: scene.anchor,
      radius: scene.radius,
      obstacles: scene.obstacles,
      ropeLength: scene.ropeLength,
      autoWrap: true,
      autoRelease: true,
    },
    { pos: scene.start.pos, vel: scene.start.vel },
  );
  for (let i = 0; i < 120; i++) sim.step(1 / 120, { swing: 0, ropeTrim: 0 });
  assert.equal(sim.path.corners.length, 0);
});

test('相同初始状态重放，关键拐点事件时间一致', () => {
  const scene = getScenario('double-wrap');
  const run = () => {
    const sim = new RopeSim(
      {
        anchor: scene.anchor,
        radius: scene.radius,
        obstacles: scene.obstacles,
        ropeLength: scene.ropeLength,
        autoWrap: true,
        autoRelease: true,
      },
      { pos: scene.start.pos, vel: scene.start.vel },
    );
    const log: string[] = [];
    for (let i = 0; i < 360; i++) {
      sim.step(1 / 60, { swing: 0, ropeTrim: 0 });
      for (const e of sim.events.slice(log.length)) log.push(`${e.kind}@${e.t.toFixed(4)}:${e.cornerKey ?? ''}`);
    }
    return log;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.ok(a.some((s) => s.startsWith('wrap')));
});
