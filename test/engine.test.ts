import { describe, expect, it } from 'vitest';
import { runAllChecks } from '../src/engine/selfcheck';
import { runDemo, DEMOS } from '../src/engine/demos';
import { createSim, stepSim } from '../src/engine/simulation';
import { TEST_PRESETS, WORLD } from '../src/engine/world';
import { DEFAULT_PARAMS, FIXED_DT, type InputState } from '../src/engine/types';

describe('自检套件（与页面按钮同源）', () => {
  const results = runAllChecks();
  for (const r of results) {
    it(r.name, () => {
      expect(r.pass, r.detail).toBe(true);
    });
  }
});

describe('确定性与显示节奏', () => {
  it('同一演示独立运行两次，最终位置与事件逐位相同', () => {
    const a = runDemo(DEMOS[0]);
    const b = runDemo(DEMOS[0]);
    expect(a.finalX).toBe(b.finalX);
    expect(a.finalY).toBe(b.finalY);
    expect(a.events.map((e) => `${e.step}:${e.type}`)).toEqual(b.events.map((e) => `${e.step}:${e.type}`));
  });

  it('固定步长恒为 1/60s，time 是步长整数倍', () => {
    const state = createSim(WORLD, DEFAULT_PARAMS);
    for (let i = 0; i < 137; i++) stepSim(state, WORLD, { move: 0, jumpPressed: false });
    expect(state.time).toBeCloseTo(137 * FIXED_DT, 10);
    expect(state.step).toBe(137);
  });
});

describe('场地碰撞约束', () => {
  it('角色不会穿出地面与左右墙', () => {
    const state = createSim(WORLD, DEFAULT_PARAMS);
    for (let step = 1; step <= 600; step++) {
      stepSim(state, WORLD, { move: 1, jumpPressed: step === 30 || step === 200 });
      expect(state.player.x + state.player.w).toBeLessThanOrEqual(984 + 1e-6);
      expect(state.player.x).toBeGreaterThanOrEqual(16 - 1e-6);
      expect(state.player.y + state.player.h).toBeLessThanOrEqual(564 + 1e-6);
    }
  });

  it('低顶下方起跳产生 head-bump 且撞顶当帧向上速度归零', () => {
    const preset = TEST_PRESETS.ceiling;
    const state = createSim(preset, DEFAULT_PARAMS);
    const bumpSteps: number[] = [];
    for (let step = 1; step <= 200; step++) {
      stepSim(state, preset, { move: 0, jumpPressed: step === 20 || step === 110 });
      if (state.events.some((e) => e.step === step && e.type === 'head-bump')) {
        bumpSteps.push(step);
        // 撞顶当帧向上运动必须已被截断
        expect(state.player.vy).toBeGreaterThanOrEqual(0);
        expect(state.player.contacts.up).toBe(true);
      }
    }
    expect(bumpSteps.length).toBeGreaterThanOrEqual(2);
  });
});

describe('移动平台随动', () => {
  it('站立在水平平台上时与平台无相对位移（换向不甩开）', () => {
    const preset = TEST_PRESETS.platformRide;
    const state = createSim(preset, DEFAULT_PARAMS);
    // 先落到平台
    for (let step = 1; step <= 30; step++) stepSim(state, preset, { move: 0, jumpPressed: false });
    expect(state.player.grounded).toBe(true);
    expect(state.player.groundId).toBe('plat-h');
    const plat0 = state.solids.find((s) => s.id === 'plat-h')!;
    const rel0 = state.player.x - plat0.x;
    // 覆盖至少一次完整换向（半周期 1.8s = 108 步），全程站立不动
    for (let step = 31; step <= 240; step++) stepSim(state, preset, { move: 0, jumpPressed: false });
    const plat1 = state.solids.find((s) => s.id === 'plat-h')!;
    const rel1 = state.player.x - plat1.x;
    expect(state.player.groundId).toBe('plat-h');
    expect(Math.abs(rel1 - rel0)).toBeLessThan(1e-9);
  });

  it('走离平台边缘后解除支撑关系并产生 leave 事件', () => {
    const preset = TEST_PRESETS.platformRide;
    const state = createSim(preset, DEFAULT_PARAMS);
    for (let step = 1; step <= 30; step++) stepSim(state, preset, { move: 0, jumpPressed: false });
    expect(state.player.groundId).toBe('plat-h');
    for (let step = 31; step <= 160; step++) {
      stepSim(state, preset, { move: 1, jumpPressed: false });
    }
    expect(state.events.some((e) => e.type === 'leave')).toBe(true);
    expect(state.player.groundId).not.toBe('plat-h');
  });
});

describe('输入时序', () => {
  it('一次跳跃按下在缓冲过期前最多产生一次起跳', () => {
    const state = createSim(TEST_PRESETS.flat, DEFAULT_PARAMS);
    const input = (step: number): InputState => ({ move: 0, jumpPressed: step === 10 });
    for (let step = 1; step <= 200; step++) stepSim(state, TEST_PRESETS.flat, input(step));
    const jumps = state.events.filter((e) => e.type === 'jump' || e.type === 'buffered-jump' || e.type === 'coyote-jump');
    expect(jumps.length).toBe(1);
  });
});
