// controller.test.js
// 播放控制器测试：暂停/恢复、单步、时间跳转、参数重置、
// A/B 锁步、不同帧率下的无漂移行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackController } from '../src/controller.js';
import { SIM_DT, MAX_PARTICLES } from '../src/engine.js';

function snapshot(sys) {
  return {
    tick: sys.tick,
    particles: sys.particles.map((p) => ({ ...p })),
    totalEmitted: sys.totalEmitted,
  };
}

const PA = { emissionRate: 60, lifetime: 2, speed: 0.4, hue: 200 };
const PB = { emissionRate: 150, lifetime: 1, speed: 0.7, hue: 30 };

test('初始为暂停状态，update 不推进仿真', () => {
  const c = new PlaybackController(PA, PB);
  assert.equal(c.playing, false);
  const steps = c.update(1 / 60);
  assert.equal(steps, 0);
  assert.equal(c.tick, 0);
});

test('播放后按真实帧间隔推进固定步，暂停立即冻结', () => {
  const c = new PlaybackController(PA, PB);
  c.play();
  // 1/30 秒的帧 = 4 个 1/120 仿真步
  const steps = c.update(1 / 30);
  assert.equal(steps, 4);
  assert.equal(c.tick, 4);
  c.pause();
  assert.equal(c.update(1 / 30), 0);
  assert.equal(c.tick, 4);
});

test('暂停-恢复与连续播放轨迹一致（无半帧残留）', () => {
  const one = new PlaybackController(PA, PB, 77);
  const split = new PlaybackController(PA, PB, 77);

  one.play();
  for (let i = 0; i < 60; i++) one.update(1 / 60);

  split.play();
  for (let i = 0; i < 20; i++) split.update(1 / 60);
  split.pause();
  const frozenTick = split.tick;
  // 暂停期间任意调用 update 都不会推进
  split.update(1 / 60);
  split.update(0.5);
  assert.equal(split.tick, frozenTick);
  split.play();
  for (let i = 0; i < 40; i++) split.update(1 / 60);

  assert.equal(split.tick, one.tick);
  assert.deepEqual(snapshot(split.systemA), snapshot(one.systemA));
  assert.deepEqual(snapshot(split.systemB), snapshot(one.systemB));
});

test('单步前进固定 1/60 秒（2 个仿真步），暂停状态也可用', () => {
  const c = new PlaybackController(PA, PB);
  assert.equal(c.playing, false);
  c.stepOnce();
  assert.equal(c.tick, 2);
  assert.equal(c.time, 1 / 60);
  c.stepOnce();
  assert.equal(c.tick, 4);
  // 连续单步 30 次 = 0.5 秒，与直接 seek 到 0.5 秒的画面一致
  for (let i = 0; i < 28; i++) c.stepOnce();
  const stepped = snapshot(c.systemA);
  const ref = new PlaybackController(PA, PB, c.seed);
  ref.seek(0.5);
  assert.deepEqual(stepped, snapshot(ref.systemA));
});

test('回到开始：时间与粒子全部清零，参数保留', () => {
  const c = new PlaybackController(PA, PB);
  c.play();
  c.update(0.5);
  assert.ok(c.systemA.aliveCount > 0);
  const rateBefore = c.systemA.params.emissionRate;
  c.goToStart();
  assert.equal(c.tick, 0);
  assert.equal(c.systemA.aliveCount, 0);
  assert.equal(c.systemB.aliveCount, 0);
  assert.equal(c.systemA.totalEmitted, 0);
  assert.equal(c.systemA.params.emissionRate, rateBefore);
});

test('seek 跳到指定时间并可精确复现', () => {
  const c = new PlaybackController(PA, PB);
  c.play();
  c.update(1.2);
  c.seek(0.8);
  assert.equal(c.tick, Math.round(0.8 / SIM_DT));

  const ref = new PlaybackController(PA, PB, c.seed);
  ref.seek(0.8);
  assert.deepEqual(snapshot(c.systemA), snapshot(ref.systemA));
  assert.deepEqual(snapshot(c.systemB), snapshot(ref.systemB));

  // seek 后继续播放，轨迹与直接播放到该时间再继续完全一致
  c.seek(0);
  c.play();
  for (let i = 0; i < 96; i++) c.update(1 / 60); // 1.6 秒
  const ref2 = new PlaybackController(PA, PB, c.seed);
  ref2.seek(1.6);
  assert.deepEqual(snapshot(c.systemA), snapshot(ref2.systemA));
});

test('A/B 始终锁步：任意播放路径下 tick 相同', () => {
  const c = new PlaybackController(PA, PB, 9);
  c.play();
  for (let i = 0; i < 37; i++) c.update(1 / 60);
  c.pause();
  c.stepOnce();
  c.seek(0.33);
  c.stepOnce();
  assert.equal(c.systemA.tick, c.systemB.tick);
  assert.equal(c.systemA.time, c.systemB.time);
});

test('setParams 清理对应系统旧粒子并按新参数重建，保持同时间锁步', () => {
  const c = new PlaybackController(PA, PB);
  c.play();
  c.update(1);
  const targetTime = c.time;
  const oldParticleCount = c.systemA.aliveCount;
  assert.ok(oldParticleCount > 0);
  c.pause();

  c.setParams('A', { ...PA, emissionRate: 200 });
  // setParams 内部先 reset（旧粒子确实被清空）再 seek 到原时间重建：
  // 重建结果必须与"用新参数直接 seek 到同一时间"的参考系统逐字段一致
  const ref = new PlaybackController({ ...PA, emissionRate: 200 }, PB, c.seed);
  ref.seek(targetTime);
  assert.deepEqual(snapshot(c.systemA), snapshot(ref.systemA));
  assert.equal(c.systemA.tick, c.systemB.tick);
  assert.equal(c.systemA.time, targetTime);
  assert.equal(c.systemB.time, targetTime);
  // 新参数体现在重建结果上
  assert.equal(c.systemA.params.emissionRate, 200);
  assert.equal(c.systemB.params.emissionRate, 150);
  // 继续播放仍锁步
  c.play();
  c.update(0.5);
  assert.equal(c.systemA.tick, c.systemB.tick);
});

test('不同帧率无漂移：30/60/144fps 播放 1 秒后状态一致', () => {
  const SECONDS = 1;
  const runs = [30, 60, 144].map((fps) => {
    const c = new PlaybackController(PA, PB, 123);
    c.play();
    const frames = Math.round(SECONDS * fps);
    const frame = SECONDS / frames; // 保证 frames*frame 严格等于 1 秒
    for (let i = 0; i < frames; i++) c.update(frame);
    return c;
  });
  for (let i = 1; i < runs.length; i++) {
    assert.equal(runs[i].tick, runs[0].tick);
    assert.equal(runs[i].time, runs[0].time);
    assert.deepEqual(snapshot(runs[i].systemA), snapshot(runs[0].systemA));
    assert.deepEqual(snapshot(runs[i].systemB), snapshot(runs[0].systemB));
  }
  assert.equal(runs[0].tick, Math.round(SECONDS / SIM_DT));
});

test('不规则帧间隔（含抖动）按累计时间得到确定结果', () => {
  const even = new PlaybackController(PA, PB, 55);
  const jittery = new PlaybackController(PA, PB, 55);
  even.play();
  jittery.play();
  for (let i = 0; i < 60; i++) even.update(1 / 60);
  // 同样 1 秒，但帧间隔抖动（总和仍为 1 秒）
  const jitter = [0.01, 0.022, 0.013, 0.019, 0.0027, 0.0333];
  let elapsed = 0;
  let guard = 0;
  while (elapsed < 1 - 1e-9 && guard < 500) {
    const dt = Math.min(jitter[guard % jitter.length], 1 - elapsed);
    jittery.update(dt);
    elapsed += dt;
    guard++;
  }
  assert.equal(jittery.tick, even.tick);
  assert.deepEqual(snapshot(jittery.systemA), snapshot(even.systemA));
});

test('帧间隔被钳制：后台标签页切回不会灌入巨量步长', () => {
  const c = new PlaybackController(PA, PB);
  c.play();
  const steps = c.update(10); // 假装卡顿 10 秒
  assert.ok(steps <= Math.ceil(0.1 / SIM_DT)); // 钳制在 0.1 秒以内
  assert.ok(c.time <= 0.1 + SIM_DT);
});

test('两个系统达到上限后统计均准确且保持锁步', () => {
  const heavy = { emissionRate: 240, lifetime: 8 };
  const c = new PlaybackController(heavy, heavy, 3);
  c.play();
  // 按 60fps 逐帧喂给控制器（单帧 1/60 秒，不触发钳制），共 5 秒
  for (let i = 0; i < 300; i++) c.update(1 / 60); // 发射 1200，存活封顶 400
  assert.equal(c.systemA.aliveCount, MAX_PARTICLES);
  assert.equal(c.systemB.aliveCount, MAX_PARTICLES);
  assert.equal(c.systemA.totalEmitted, 1200);
  assert.equal(c.systemB.totalEmitted, 1200);
  assert.equal(c.systemA.tick, c.systemB.tick);
  for (let i = 0; i < 300; i++) c.update(1 / 60); // 再跑 5 秒仍稳定
  assert.ok(c.systemA.aliveCount <= MAX_PARTICLES);
  assert.ok(c.systemB.aliveCount <= MAX_PARTICLES);
});
