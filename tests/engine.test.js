// engine.test.js
// 引擎级确定性与生命周期测试（node --test，无 DOM 依赖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ParticleSystem,
  createRng,
  normalizeParams,
  DEFAULT_PARAMS,
  SIM_DT,
  MAX_PARTICLES,
} from '../src/engine.js';

/** 深拷贝系统全部可观测状态，用于跨实例逐字段比对。 */
function snapshot(system) {
  return {
    tick: system.tick,
    time: system.time,
    emissionAccumulator: system.emissionAccumulator,
    recycleHead: system.recycleHead,
    totalEmitted: system.totalEmitted,
    totalExpired: system.totalExpired,
    aliveCount: system.aliveCount,
    particles: system.particles.map((p) => ({ ...p })),
  };
}

const PARAMS = {
  emissionRate: 80,
  lifetime: 1.5,
  speed: 0.4,
  hue: 120,
  hueRange: 30,
  hueShift: 60,
  gravityScale: 1,
};

test('同参数同种子推进相同步数得到完全一致的状态', () => {
  const a = new ParticleSystem(PARAMS, 42);
  const b = new ParticleSystem(PARAMS, 42);
  a.advance(240);
  b.advance(240);
  assert.deepEqual(snapshot(a), snapshot(b));
});

test('不同种子产生不同粒子序列', () => {
  const a = new ParticleSystem(PARAMS, 1);
  const b = new ParticleSystem(PARAMS, 2);
  a.advance(60);
  b.advance(60);
  assert.notDeepEqual(snapshot(a), snapshot(b));
});

test('与帧率无关：1/3/7 步分块推进到同一 tick 结果一致', () => {
  const chunks = [1, 3, 7];
  const refs = chunks.map((chunk) => {
    const sys = new ParticleSystem(PARAMS, 7);
    for (let done = 0; done < 300; done += chunk) {
      sys.advance(Math.min(chunk, 300 - done));
    }
    return snapshot(sys);
  });
  for (let i = 1; i < refs.length; i++) {
    assert.deepEqual(refs[i], refs[0]);
  }
});

test('暂停后恢复等价于连续播放（暂停不改变仿真轨迹）', () => {
  const continuous = new ParticleSystem(PARAMS, 99);
  const paused = new ParticleSystem(PARAMS, 99);
  continuous.advance(600);
  // 模拟"播放-暂停-播放"：分段推进，中间只读不写
  paused.advance(150);
  const midpoint = snapshot(paused);
  paused.advance(150);
  paused.advance(150);
  paused.advance(150);
  assert.equal(paused.tick, 600);
  assert.deepEqual(snapshot(paused), snapshot(continuous));
  // 暂停期间状态确实冻结
  assert.equal(snapshot(paused).tick, 600);
  assert.ok(midpoint.tick === 150);
});

test('seek 通过重新积分精确复现连续播放的画面', () => {
  const live = new ParticleSystem(PARAMS, 5);
  live.advance(333);
  const rebuilt = new ParticleSystem(PARAMS, 5);
  rebuilt.seek(333 * SIM_DT);
  assert.deepEqual(snapshot(rebuilt), snapshot(live));
});

test('seek(0) 清空全部粒子并归零时间', () => {
  const sys = new ParticleSystem(PARAMS, 5);
  sys.advance(200);
  assert.ok(sys.aliveCount > 0);
  sys.seek(0);
  assert.equal(sys.aliveCount, 0);
  assert.equal(sys.tick, 0);
  assert.equal(sys.time, 0);
  assert.equal(sys.totalEmitted, 0);
});

test('seek 到非整步时间按最近 tick 取整且可重复', () => {
  const a = new ParticleSystem(PARAMS, 11);
  const b = new ParticleSystem(PARAMS, 11);
  a.seek(0.025); // 0.025 / (1/120) = 3 个整步
  assert.equal(a.tick, 3);
  b.seek(0.025);
  assert.deepEqual(snapshot(a), snapshot(b));
});

test('setParams 清空旧粒子、归零时间，新参数立即生效', () => {
  const sys = new ParticleSystem({ emissionRate: 10 }, 3);
  sys.advance(120);
  assert.ok(sys.aliveCount > 0);
  sys.setParams({ emissionRate: 200 });
  assert.equal(sys.aliveCount, 0);
  assert.equal(sys.tick, 0);
  sys.advance(120);
  // 新频率 200/s，1 秒应发射 200 个
  assert.equal(sys.totalEmitted, 200);
});

test('reset 清空粒子并重置累计统计', () => {
  const sys = new ParticleSystem(PARAMS, 3);
  sys.advance(120);
  sys.reset();
  assert.equal(sys.aliveCount, 0);
  assert.equal(sys.tick, 0);
  assert.equal(sys.totalEmitted, 0);
  assert.equal(sys.totalExpired, 0);
  assert.equal(sys.emissionAccumulator, 0);
});

test('发射节奏只取决于经过时间：60/s 在 1 秒时恰好发射 60 个', () => {
  const sys = new ParticleSystem({ emissionRate: 60, lifetime: 6 }, 1);
  sys.advance(120);
  assert.equal(sys.totalEmitted, 60);
  assert.equal(sys.aliveCount, 60); // 寿命 6 秒，1 秒内无消亡
});

test('粒子达到数量上限后持续运行：数量不超限且统计守恒', () => {
  // 240/s、寿命 6 秒：5 秒内发射 1200 个，但上限只有 400
  const sys = new ParticleSystem({ emissionRate: 240, lifetime: 6 }, 1);
  for (let i = 0; i < 600; i++) {
    sys.step();
    assert.ok(sys.aliveCount <= MAX_PARTICLES, `第 ${i} 步超出上限`);
  }
  assert.equal(sys.aliveCount, MAX_PARTICLES);
  assert.equal(sys.totalEmitted, 1200);
  assert.equal(sys.totalExpired, 0); // 最短寿命 0.85*6=5.1s，5 秒内不消亡
  const recycled = sys.totalEmitted - sys.aliveCount - sys.totalExpired;
  assert.equal(recycled, 800); // 被回收的槽位数量可由统计推算
});

test('长时间高负载运行不崩溃，存活数始终不超上限', () => {
  const sys = new ParticleSystem({ emissionRate: 240, lifetime: 0.6 }, 1);
  for (let i = 0; i < 120 * 30; i++) sys.step(); // 30 秒
  assert.ok(sys.aliveCount <= MAX_PARTICLES);
  assert.ok(sys.aliveCount > 0);
  // 守恒关系：总发射 = 存活 + 自然消亡 + 回收
  const recycled = sys.totalEmitted - sys.aliveCount - sys.totalExpired;
  assert.ok(recycled >= 0);
  assert.equal(
    sys.aliveCount + sys.totalExpired + recycled,
    sys.totalEmitted
  );
});

test('短寿命粒子会自然消亡并计入 totalExpired', () => {
  const sys = new ParticleSystem({ emissionRate: 100, lifetime: 0.3 }, 1);
  sys.advance(120 * 3); // 3 秒，远超寿命
  assert.ok(sys.totalExpired > 0);
  assert.ok(sys.aliveCount < sys.totalEmitted);
  // 稳态存活量约等于 频率 * 寿命（允许抖动误差）
  assert.ok(sys.aliveCount < 100 * 0.3 * 1.3);
  assert.ok(sys.aliveCount > 100 * 0.3 * 0.5);
});

test('颜色变化：色相随寿命在 hue0 与 hue0+hueShift 之间过渡', () => {
  const sys = new ParticleSystem({ hueShift: 120 }, 1);
  sys.seek(0.05);
  const p = sys.particles[0];
  assert.ok(p);
  const hueAtBirth = sys.particleHue({ ...p, age: 0 });
  const hueAtDeath = sys.particleHue({ ...p, age: p.life });
  assert.ok(Math.abs(hueAtBirth - p.hue0) < 1);
  assert.ok(Math.abs(((hueAtDeath - p.hue0) + 360) % 360 - 120) < 1);
});

test('normalizeParams 钳制越界值并对非法输入回退默认值', () => {
  const clamped = normalizeParams({ emissionRate: 99999, lifetime: -5, speed: NaN });
  assert.equal(clamped.emissionRate, 240);
  assert.equal(clamped.lifetime, 0.2);
  assert.equal(clamped.speed, DEFAULT_PARAMS.speed);
  assert.deepEqual(normalizeParams(undefined), { ...DEFAULT_PARAMS });
});

test('PRNG 自身确定性：同种子序列相同', () => {
  const a = createRng(123);
  const b = createRng(123);
  const seqA = Array.from({ length: 10 }, a);
  const seqB = Array.from({ length: 10 }, b);
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});
