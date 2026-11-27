import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE, dbToGain, type RenderOptions } from '../src/types';
import { renderSynth } from '../src/dsp/synth';
import { staticExample, glideExample, breathyExample } from '../src/presets';
import { detectF0 } from '../src/dsp/peaks';

function optsFrom(ex: ReturnType<typeof staticExample>): RenderOptions {
  return {
    sampleRate: SAMPLE_RATE,
    duration: ex.duration,
    f0: ex.f0,
    noiseMix: ex.noiseMix,
    timeline: {
      middleEnabled: ex.middleEnabled,
      middlePos: ex.middlePos,
      keys: ex.keys,
    },
    normalizeTo: dbToGain(-18),
    seed: 42,
  };
}

describe('renderSynth 合成器', () => {
  it('同一参数（含种子）输出完全一致，且时长正确', () => {
    const a = renderSynth(optsFrom(glideExample()));
    const b = renderSynth(optsFrom(glideExample()));
    expect(a.samples.length).toBe(Math.round(glideExample().duration * SAMPLE_RATE));
    expect(a.samples).toEqual(b.samples);
    expect(a.sampleRate).toBe(SAMPLE_RATE);
  });

  it('基频在整段时间线上保持恒定：开头、中段、结尾自相关检测都贴近设定 f0', () => {
    const ex = glideExample(); // 共振位置大滑，f0 不变
    const { samples } = renderSynth(optsFrom(ex));
    const win = Math.floor(0.1 * SAMPLE_RATE);
    const points = [0.12, 0.5, 0.88];
    for (const t of points) {
      const c = Math.floor(t * samples.length);
      const frame = samples.slice(c - win / 2, c + win / 2);
      const f0 = detectF0(frame, SAMPLE_RATE);
      expect(f0).not.toBeNull();
      expect(Math.abs(f0! - ex.f0) / ex.f0).toBeLessThan(0.05);
    }
  });

  it('归一化后 RMS 命中目标响度，且不削波', () => {
    const r = renderSynth(optsFrom(staticExample()));
    const target = dbToGain(-18);
    expect(Math.abs(r.rms - target) / target).toBeLessThan(0.02);
    expect(r.peak).toBeLessThan(1);
  });

  it('纯噪声（noiseMix=1）检测不到稳定基频，并给出提示', () => {
    const ex = breathyExample();
    ex.noiseMix = 1;
    const r = renderSynth(optsFrom(ex));
    const frame = r.samples.slice(0, Math.floor(0.2 * SAMPLE_RATE));
    expect(detectF0(frame, SAMPLE_RATE)).toBeNull();
    expect(r.warnings.some((w) => w.includes('无固定音高'))).toBe(true);
  });

  it('共振区中心越界时产出可读警告，且渲染不抛错', () => {
    const ex = staticExample();
    ex.keys[0].formants[0].center = 20;
    ex.keys[1].formants[0].center = 20;
    ex.keys[2].formants[0].center = 20;
    const r = renderSynth(optsFrom(ex));
    expect(r.warnings.some((w) => w.includes('超出可用频带'))).toBe(true);
    expect(r.samples.length).toBeGreaterThan(0);
  });

  it('静音配置（全部增益为 0）给出静音警告', () => {
    const ex = staticExample();
    ex.keys.forEach((k) => k.formants.forEach((_r) => (_r.gain = 0)));
    const r = renderSynth(optsFrom(ex));
    expect(r.warnings.some((w) => w.includes('几乎静音'))).toBe(true);
  });
});
