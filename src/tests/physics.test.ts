import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS } from '../rooms.ts';
import { createState, tick, boxSeated, maxPenetration } from '../physics.ts';
import type { GameState, InputState } from '../types.ts';
import { TICK } from '../types.ts';

const noInput: InputState = { left: false, right: false, flipUp: false, flipDown: false };
const hold = (dir: 'left' | 'right'): InputState => ({ ...noInput, [dir]: true });
const flipUp: InputState = { ...noInput, flipUp: true };
const flipDown: InputState = { ...noInput, flipDown: true };

function run(state: GameState, input: InputState, ticks: number): GameState {
  for (let i = 0; i < ticks; i += 1) tick(state, input);
  return state;
}

function assertContained(state: GameState): void {
  const t = state.room.wallThickness;
  for (const b of [state.player, state.box]) {
    assert.ok(b.x >= t - 0.3, `${b.id} 越左界 x=${b.x}`);
    assert.ok(b.y >= t - 0.3, `${b.id} 越上界 y=${b.y}`);
    assert.ok(b.x + b.w <= state.room.width - t + 0.3, `${b.id} 越右界`);
    assert.ok(b.y + b.h <= state.room.height - t + 0.3, `${b.id} 越下界`);
  }
  assert.ok(maxPenetration(state) < 0.6, `残留穿透 ${maxPenetration(state)}px`);
}

test('静止状态：人箱在重力下落地后稳定，不穿墙不重叠', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 180);
  assert.equal(state.status, 'playing');
  assert.equal(state.player.grounded, true);
  assert.equal(state.box.grounded, true);
  assertContained(state);
});

test('翻转规则：必须贴地、不能同向、翻转中连按不重复结算，并给出拒绝原因', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 60);

  // 同向请求被拒
  tick(state, flipDown);
  assert.equal(state.flipPhase, 'idle');
  assert.equal(state.lastReject?.reason, 'same-direction');
  assert.equal(state.gravity, 1);

  // 正常翻转
  tick(state, flipUp);
  assert.equal(state.flipPhase, 'flipping');
  assert.equal(state.gravity, -1);

  // 翻转中的请求一律拒绝，不重置计时
  tick(state, flipDown);
  assert.equal(state.lastReject?.reason, 'flip-in-progress');
  assert.equal(state.gravity, -1);
  tick(state, flipUp);
  assert.equal(state.lastReject?.reason, 'flip-in-progress');

  // 飞到天花板落地后自动结算
  run(state, noInput, 120);
  assert.equal(state.flipPhase, 'idle');
  assert.equal(state.player.grounded, true);
  assertContained(state);
});

test('空中不能触发翻转（not-grounded）：直接构造悬空态验证规则', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 60);
  // 把玩家搬到无障碍物的空中（不与墙、箱、窄台接触），跑一 tick 让 grounded 重算
  state.player.x = 180;
  state.player.y = 200;
  state.player.vx = 0;
  state.player.vy = 0;
  tick(state, noInput);
  assert.equal(state.player.grounded, false);
  tick(state, flipUp);
  assert.equal(state.lastReject?.reason, 'not-grounded');
  assert.equal(state.gravity, 1);
  assert.equal(state.flipPhase, 'idle');
});

test('推箱：箱被墙顶住时人不会穿箱，两者保持体积', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 60);
  run(state, hold('right'), 360);
  assertContained(state);
  // 箱已被推到右墙附近且人在箱左侧
  assert.ok(state.box.x + state.box.w <= state.room.width - state.room.wallThickness + 0.3);
  assert.ok(state.player.x + state.player.w <= state.box.x + 0.6);
});

test('窄角：人把箱推入天花凹槽侧壁时不穿墙、不重叠', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 60);
  tick(state, flipUp);
  run(state, noInput, 150); // 全部贴到天花板
  assert.equal(state.flipPhase, 'idle');
  run(state, hold('right'), 300); // 一路向右推，直到撞凹槽/右墙
  assertContained(state);
});

test('房间 1 可完成：推箱到槽位正下方 → 翻转 → 箱完整入槽并停稳', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 60);

  // 槽 x=640..740，凹槽左壁到 x=660；箱必须完全越过壁面（x>=660）才能垂直升入
  const slot = state.room.slots[0];
  let pushed = 0;
  while (state.box.x + state.box.w <= slot.x + slot.w - 4 && pushed < 300) {
    tick(state, hold('right'));
    pushed += 1;
  }
  assert.ok(pushed < 300, '推箱超时');
  assert.ok(state.box.x >= slot.x + 20, `箱未越过凹槽壁 x=${state.box.x}`);
  assert.ok(state.box.x + state.box.w <= slot.x + slot.w, `箱越过槽口 x=${state.box.x}`);

  // 翻转后人、箱速度清零、同步上飞，箱应完整进入凹槽
  tick(state, flipUp);
  run(state, noInput, 240);

  assertContained(state);
  assert.equal(state.status, 'won', `未完成，状态=${state.status}，箱=${JSON.stringify(state.box)}`);
  assert.ok(boxSeated(state));
});

test('人自己掉在槽上不算完成（槽只认箱子）', () => {
  const state = createState(ROOMS[0]);
  run(state, noInput, 60);
  // 人直接跑到右侧槽的正下方再翻转
  run(state, hold('right'), 200);
  tick(state, flipUp);
  run(state, noInput, 240);
  assert.notEqual(state.status, 'won');
  assert.equal(boxSeated(state), false);
});

test('房间 2：开局即箱-人-天花同时接触，保持无穿透', () => {
  const state = createState(ROOMS[1]);
  run(state, noInput, 120);
  assertContained(state);
  assert.equal(state.box.grounded, true);
  assert.equal(state.player.grounded, true);
});

test('房间 2 核心场景：接触态下翻转，箱与人同时换方向坠落不卡死', () => {
  const state = createState(ROOMS[1]);
  run(state, noInput, 30);

  // 初始重力向上，人贴天花即 grounded，可触发向下翻转
  assert.equal(state.player.grounded, true);
  tick(state, flipDown);
  assert.equal(state.gravity, 1);

  // 坠落过程 + 落地后继续模拟，检查全程无穿透、不出界
  for (let i = 0; i < 300; i += 1) {
    tick(state, i % 40 < 20 ? hold('right') : noInput);
    assertContained(state);
  }
  assert.equal(state.status, 'playing');
  assert.equal(state.flipPhase, 'idle');
});

test('房间 2：反复横跳 + 推箱，任何时刻都不允许穿透或出界', () => {
  const state = createState(ROOMS[1]);
  run(state, noInput, 30);
  let dir = false;
  for (let i = 0; i < 900; i += 1) {
    const cycle = i % 120;
    let input: InputState = cycle % 2 === 0 ? hold(dir ? 'right' : 'left') : noInput;
    if (cycle === 0 && state.flipPhase === 'idle') {
      input = state.gravity === -1 ? flipDown : flipUp;
      dir = !dir;
    }
    tick(state, input);
    assertContained(state);
  }
  assert.equal(state.status, 'playing');
});

test('房间 2：从接触堆叠态可恢复——翻转向下后推箱入地板槽完成', () => {
  const state = createState(ROOMS[1]);
  run(state, noInput, 30);
  tick(state, flipDown);
  run(state, noInput, 150); // 人箱落回地板
  assert.equal(state.flipPhase, 'idle');
  assertContained(state);

  // 玩家落在箱右侧，向左长推，左墙兜底保证完整入槽
  let pushed = 0;
  while (state.status === 'playing' && pushed < 400) {
    tick(state, hold('left'));
    pushed += 1;
    assertContained(state);
  }
  assert.equal(state.status, 'won', `房间2未能完成 status=${state.status}`);
  assert.ok(boxSeated(state));
});

test('fuzz：随机输入长序列下两个房间都保持体积与边界不变量', () => {
  let seed = 15437;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const room of ROOMS) {
    const state = createState(room);
    for (let i = 0; i < 3000; i += 1) {
      const r = rand();
      let input: InputState = noInput;
      if (r < 0.35) input = hold(rand() < 0.5 ? 'left' : 'right');
      else if (r < 0.4 && state.player.grounded && state.flipPhase === 'idle') {
        input = state.gravity === 1 ? flipUp : flipDown;
      }
      tick(state, input);
      assertContained(state);
      if (state.status === 'failed') throw new Error(`${room.id} 在 t${state.tick} 失败`);
    }
  }
});

test('时间步：物理是确定性的，同样输入序列两次结果一致', () => {
  const a = createState(ROOMS[1]);
  const b = createState(ROOMS[1]);
  const seq: InputState[] = [];
  let s = 7;
  for (let i = 0; i < 300; i += 1) {
    s = (s * 48271) % 2147483647;
    const k = s % 4;
    seq.push(k === 0 ? hold('left') : k === 1 ? hold('right') : k === 2 ? flipDown : noInput);
  }
  for (const input of seq) {
    tick(a, input);
    tick(b, input);
  }
  assert.deepEqual(
    { x: a.player.x, y: a.player.y, vx: a.player.vx, vy: a.player.vy },
    { x: b.player.x, y: b.player.y, vx: b.player.vx, vy: b.player.vy },
  );
  assert.ok(TICK > 0);
});
