import { describe, it, expect } from 'vitest';
import { VoiceEngine, shapedProgress } from './VoiceEngine';
import { DEFAULT_TIMBRE } from './types';
import type { TimbreParams } from './types';

const SR = 44100;

function make(params?: Partial<TimbreParams['envelope']>): VoiceEngine {
  const t: TimbreParams = {
    ...DEFAULT_TIMBRE,
    envelope: { ...DEFAULT_TIMBRE.envelope, ...params },
  };
  return new VoiceEngine(t, SR);
}

/** 跑 n 个采样，返回振幅数组。 */
function run(v: VoiceEngine, samples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    v.process();
    out.push(v.amplitude());
  }
  return out;
}

describe('shapedProgress', () => {
  it('端点恒为 0 和 1，线性形状是恒等映射', () => {
    expect(shapedProgress(0, -0.8)).toBe(0);
    expect(shapedProgress(1, 0.8)).toBe(1);
    for (const t of [0.1, 0.37, 0.5, 0.9]) {
      expect(shapedProgress(t, 0)).toBeCloseTo(t, 12);
    }
  });

  it('凹形前段更快、凸形前段更慢', () => {
    expect(shapedProgress(0.3, -0.9)).toBeGreaterThan(0.3);
    expect(shapedProgress(0.3, 0.9)).toBeLessThan(0.3);
  });
});

describe('VoiceEngine 基础 ADSR', () => {
  it('空闲时输出与振幅均为 0', () => {
    const v = make();
    const amps = run(v, 100);
    expect(amps.every((a) => a === 0)).toBe(true);
    expect(v.process()).toBe(0);
  });

  it('attack 段从 0 单调升到 1', () => {
    const v = make({ attack: 0.1, decay: 0.1, sustain: 0.4, release: 0.1 });
    v.noteOn();
    const n = Math.round(0.1 * SR);
    const amps = run(v, n);
    expect(amps[0]).toBeGreaterThan(0);
    for (let i = 1; i < amps.length; i++) expect(amps[i]).toBeGreaterThanOrEqual(amps[i - 1]);
    expect(amps[amps.length - 1]).toBeCloseTo(1, 2);
  });

  it('decay 结束后稳定在 sustain 电平并保持', () => {
    const v = make({ attack: 0.02, decay: 0.05, sustain: 0.4, release: 0.1 });
    v.noteOn();
    run(v, Math.round(0.07 * SR) + 10); // 走完 attack+decay
    const a1 = v.amplitude();
    const a2 = run(v, 2000).at(-1)!;
    expect(a1).toBeCloseTo(0.4, 2);
    expect(a2).toBeCloseTo(0.4, 6);
  });

  it('noteOff 后 release 单调归零并进入 idle', () => {
    const v = make({ attack: 0.01, decay: 0.01, sustain: 0.5, release: 0.1 });
    v.noteOn();
    run(v, Math.round(0.02 * SR) + 5);
    v.noteOff();
    const n = Math.round(0.1 * SR);
    const amps = run(v, n);
    for (let i = 1; i < amps.length; i++) expect(amps[i]).toBeLessThanOrEqual(amps[i - 1]);
    expect(amps[amps.length - 1]).toBeCloseTo(0, 6);
    expect(v.isIdle).toBe(true);
  });

  it('力度缩放振幅但不改变包络形状', () => {
    const v = make({ attack: 0.02, decay: 0.05, sustain: 0.4, release: 0.1 });
    v.noteOn(0.5);
    run(v, Math.round(0.07 * SR) + 10);
    expect(v.amplitude()).toBeCloseTo(0.2, 2); // sustain 0.4 * velocity 0.5
  });
});

describe('断音与再触发', () => {
  it('attack 途中松开：release 从当前电平起步，不跳回 0', () => {
    const v = make({ attack: 0.3, decay: 0.1, sustain: 0.5, release: 0.2 });
    v.noteOn();
    run(v, Math.round(0.1 * SR)); // attack 走到约 1/3
    const before = v.amplitude();
    expect(before).toBeGreaterThan(0.05);
    v.noteOff();
    const after = v.amplitude(); // 同采样电平不应突变
    expect(after).toBeCloseTo(before, 6);
    const next = run(v, 10);
    for (const a of next) expect(a).toBeLessThanOrEqual(before + 1e-9);
  });

  it('release 途中再 noteOn：从当前电平重新 attack，无跳变', () => {
    const v = make({ attack: 0.05, decay: 0.05, sustain: 0.4, release: 0.3 });
    v.noteOn();
    run(v, Math.round(0.1 * SR) + 5); // 到 sustain
    v.noteOff();
    run(v, Math.round(0.1 * SR)); // release 走到一半
    const mid = v.amplitude();
    expect(mid).toBeGreaterThan(0);
    v.noteOn();
    expect(v.amplitude()).toBeCloseTo(mid, 6); // 起点连续
    const rising = run(v, 5);
    for (let i = 1; i < rising.length; i++) expect(rising[i]).toBeGreaterThan(rising[i - 1]);
  });

  it('零时长 attack+release：同采样内完成垂直跳变且不卡死', () => {
    const v = make({ attack: 0, decay: 0.05, sustain: 0.6, release: 0 });
    v.noteOn();
    expect(v.phase).toBe('decay'); // attack=0 已在 noteOn 采样内走完
    run(v, Math.round(0.05 * SR) + 2);
    expect(v.amplitude()).toBeCloseTo(0.6, 2);
    v.noteOff(); // release=0 → 立刻 idle
    expect(v.isIdle).toBe(true);
    expect(v.amplitude()).toBe(0);
    // 仍能再次触发
    v.noteOn();
    expect(v.phase).not.toBe('idle');
  });

  it('attack=0 且 decay=0：连锁零时长段直达 sustain', () => {
    const v = make({ attack: 0, decay: 0, sustain: 0.7, release: 0.1 });
    v.noteOn();
    expect(v.phase).toBe('sustain');
    expect(v.amplitude()).toBeCloseTo(0.7, 6);
  });
});

describe('参数变更：pending 与 live', () => {
  it('pending 模式不影响当前声音，下一次 noteOn 才采用', () => {
    const v = make({ attack: 0.02, decay: 0.05, sustain: 0.4, release: 0.1 });
    v.noteOn();
    run(v, Math.round(0.07 * SR) + 5);
    const before = v.amplitude();
    v.setParamsPending({
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, sustain: 0.9 },
    });
    const during = run(v, 500);
    expect(during.at(-1)).toBeCloseTo(before, 6); // 仍是旧 sustain
    v.noteOff();
    run(v, Math.round(0.1 * SR) + 2);
    expect(v.isIdle).toBe(true);
    v.noteOn();
    // 新参数是默认包络：attack 0.08 + decay 0.18，走完才到 sustain
    run(v, Math.round((0.08 + 0.18) * SR) + 5);
    expect(v.amplitude()).toBeCloseTo(0.9, 2); // 新参数生效
  });

  it('live 模式改 sustain：用电平滑动过渡，不出现瞬时跳变', () => {
    const v = make({ attack: 0.01, decay: 0.01, sustain: 0.4, release: 0.1 });
    v.noteOn();
    run(v, Math.round(0.02 * SR) + 5);
    expect(v.amplitude()).toBeCloseTo(0.4, 2);
    v.setParamsLive({
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, sustain: 0.8 },
    });
    const first = v.amplitude();
    expect(first).toBeCloseTo(0.4, 6); // 改动瞬间电平不变
    const trace: number[] = [];
    for (let i = 0; i < SR; i++) {
      v.process();
      trace.push(v.amplitude());
    }
    // 相邻采样无跳变（限制在量化误差内）
    for (let i = 1; i < trace.length; i++) {
      expect(Math.abs(trace[i] - trace[i - 1])).toBeLessThan(0.01);
    }
    expect(trace.at(-1)).toBeCloseTo(0.8, 2);
  });

  it('live 模式改 release：从当前电平继续释放到 0', () => {
    const v = make({ attack: 0.01, decay: 0.01, sustain: 0.5, release: 0.5 });
    v.noteOn();
    run(v, Math.round(0.02 * SR) + 5);
    v.noteOff();
    run(v, Math.round(0.1 * SR));
    const mid = v.amplitude();
    v.setParamsLive({
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, sustain: 0.5, release: 0.05 },
    });
    expect(v.amplitude()).toBeCloseTo(mid, 6);
    run(v, Math.round(0.05 * SR) + 2);
    expect(v.isIdle).toBe(true);
  });
});
