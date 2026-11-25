/**
 * 引擎规则单元测试（node:test）。覆盖：
 *  - 绳长不变量在自由运动、撞击限位、全程换配重下都严格守恒
 *  - 约束解与解析解一致（张力/加速度）
 *  - 限位只停住真正受限的体，不影响绳长
 *  - 卡榫的速度阈值与状态机（locked / too-fast / released）
 *  - 换配重不改变当前速度与位置（惯性连续）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BODY_IDS } from '../src/model.js';
import { GRAVITY, H_MAX, H_MIN, ROPE_SUM, ropeLength } from '../src/geometry.js';

const STEP = 1 / 60;
const run = (e: Engine, frames: number) => {
  for (let i = 0; i < frames; i++) e.step(STEP);
};

test('等质量配置精确平衡：长期静止', () => {
  const e = new Engine({ carriage1: 1, lantern: 1, carriage2: 1 });
  run(e, 60 * 5);
  for (const id of BODY_IDS) {
    assert.ok(Math.abs(e.v[id]) < 1e-9, `${id} 应静止`);
    assert.ok(Math.abs(e.h[id] - 220) < 1e-9, `${id} 不应移动`);
  }
});

test('约束解与解析张力/加速度一致', () => {
  const w = { carriage1: 0.72, lantern: 1.2, carriage2: 0.7 };
  const e = new Engine(w);
  // 解析：2T = (Σ g) / (Σ 1/m)；a_i = g − 2T/m_i
  const inv = BODY_IDS.reduce((s, id) => s + 1 / w[id], 0);
  const T = (BODY_IDS.length * GRAVITY) / (2 * inv);
  // 跑一步让引擎产生解算结果
  e.step(STEP);
  assert.ok(Math.abs(e.lastTension - T) < 1e-9, `张力 ${e.lastTension} ≠ ${T}`);
});

test('自由运动全程绳长和恒为 660', () => {
  const e = new Engine({ carriage1: 1.1, lantern: 1.0, carriage2: 1.1 });
  const L0 = ropeLength(e.h.carriage1, e.h.lantern, e.h.carriage2);
  for (let f = 0; f < 60 * 6; f++) {
    e.step(STEP);
    const sum = BODY_IDS.reduce((s, id) => s + e.h[id], 0);
    assert.ok(Math.abs(sum - ROPE_SUM) < 1e-6, `第${f}帧绳长和漂移 ${sum}`);
    const L = ropeLength(e.h.carriage1, e.h.lantern, e.h.carriage2);
    assert.ok(Math.abs(L - L0) < 1e-6, `第${f}帧完整绳长漂移 ${L}`);
  }
});

test('速度层约束：任意时刻 v1+vL+v2 = 0（自由体）', () => {
  const e = new Engine({ carriage1: 2.2, lantern: 0.9, carriage2: 0.45 });
  for (let f = 0; f < 60 * 3; f++) {
    e.step(STEP);
    const free = BODY_IDS.filter((id) => e.contacts[id] === null);
    if (free.length >= 2) {
      const vsum = free.reduce((s, id) => s + e.v[id], 0);
      assert.ok(Math.abs(vsum) < 1e-6, `自由体速度和 ${vsum}`);
    }
  }
});

test('撞限位：只锁真正受限的体，其它体仍可动且绳长守恒', () => {
  const e = new Engine({ carriage1: 2.2, lantern: 0.9, carriage2: 0.45 });
  // 托架2先撞顶（无头校准约在 t=2.0s）
  run(e, 60 * 2.5);
  assert.equal(e.contacts.carriage2, -1);
  assert.equal(e.contacts.carriage1, null); // 托架1此时仍自由下坠
  assert.ok(Math.abs(e.v.carriage1) > 1, '托架1应仍在运动');
  const sum1 = BODY_IDS.reduce((s, id) => s + e.h[id], 0);
  assert.ok(Math.abs(sum1 - ROPE_SUM) < 1e-6);

  // 续跑到托架1也撞底
  run(e, 60 * 10);
  assert.equal(e.contacts.carriage1, 1);
  assert.equal(e.h.carriage1, H_MAX);
  assert.equal(e.h.carriage2, H_MIN);
  for (const id of BODY_IDS) assert.equal(e.v[id], 0);
  const sum2 = BODY_IDS.reduce((s, id) => s + e.h[id], 0);
  assert.ok(Math.abs(sum2 - ROPE_SUM) < 1e-6);
});

test('换配重保持当前速度与位置，动画连续', () => {
  const e = new Engine({ carriage1: 1.1, lantern: 1.0, carriage2: 1.1 });
  run(e, 60);
  const v0 = { ...e.v };
  const h0 = { ...e.h };
  e.setWeight('lantern', 1.4);
  assert.deepEqual(e.v, v0);
  assert.deepEqual(e.h, h0);
  e.step(STEP);
  const dh = Math.abs(e.h.lantern - h0.lantern);
  assert.ok(dh < 5, `换配重后位移应只在一帧量级，实际 ${dh}`);
});

test('卡榫：慢速进入窗格能 locked，硬锁且不自动释放', () => {
  const e = new Engine({ carriage1: 1.1, lantern: 1.0, carriage2: 1.1 });
  e.toggleLatch('upper');
  run(e, 60 * 10);
  assert.equal(e.engagedLatch, 'upper');
  assert.equal(e.v.lantern, 0);
  const locked = e.checks.filter((c) => c.result === 'locked');
  assert.ok(locked.length >= 1);
  // 再跑一会儿，仍锁住
  run(e, 60 * 3);
  assert.equal(e.engagedLatch, 'upper');
});

test('卡榫：过快经过留 too-fast，不锁', () => {
  const e = new Engine({ carriage1: 0.9, lantern: 1.05, carriage2: 0.9 });
  e.toggleLatch('lower');
  run(e, 60 * 8);
  assert.equal(e.engagedLatch, null);
  const fast = e.checks.filter((c) => c.result === 'too-fast');
  assert.ok(fast.length >= 1);
  assert.ok(fast[0].speed > fast[0].vMax);
});

test('卡榫：手动松开产生 released 记录并恢复运动', () => {
  const e = new Engine({ carriage1: 1.1, lantern: 1.0, carriage2: 1.1 });
  e.toggleLatch('upper');
  run(e, 60 * 10);
  assert.equal(e.engagedLatch, 'upper');
  const hLocked = e.h.lantern;
  e.toggleLatch('upper');
  assert.equal(e.engagedLatch, null);
  assert.ok(e.checks.some((c) => c.result === 'released'));
  run(e, 30);
  assert.notEqual(e.h.lantern, hLocked);
});

test('未武装卡榫：穿过窗格不产生任何记录', () => {
  const e = new Engine({ carriage1: 0.9, lantern: 1.05, carriage2: 0.9 });
  run(e, 60 * 12);
  assert.equal(e.checks.length, 0);
});

test('过头后调重回升，二次慢速经过可补卡', () => {
  const e = new Engine({ carriage1: 0.9, lantern: 1.05, carriage2: 0.9 });
  e.toggleLatch('lower');
  let swapped = false;
  for (let f = 0; f < 60 * 16; f++) {
    e.step(STEP);
    if (!swapped && e.h.lantern > 360) {
      e.setWeight('lantern', 0.75);
      swapped = true;
    }
    if (e.engagedLatch) break;
  }
  const results = e.checks.map((c) => c.result);
  assert.ok(results.includes('too-fast'));
  assert.equal(e.engagedLatch, 'lower');
  assert.ok(results.at(-1) === 'locked');
});
