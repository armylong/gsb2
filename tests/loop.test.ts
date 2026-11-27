import { describe, it, expect } from 'vitest';
import { crossfadeLoop, medianStep, renderSynth } from '../src/dsp/synth';
import { staticExample } from '../src/presets';
import { SAMPLE_RATE, dbToGain, type RenderOptions } from '../src/types';

function renderStatic(): Float32Array {
  const ex = staticExample();
  const opts: RenderOptions = {
    sampleRate: SAMPLE_RATE,
    duration: 0.8,
    f0: ex.f0,
    noiseMix: ex.noiseMix,
    timeline: { middleEnabled: false, middlePos: 0.5, keys: ex.keys },
    normalizeTo: dbToGain(-18),
    seed: 11,
  };
  return renderSynth(opts).samples;
}

describe('crossfadeLoop 无缝循环', () => {
  /** 接缝前后各 5 个样本里的最大相邻跳变 */
  function worstSeamStep(x: Float32Array): number {
    let worst = 0;
    for (let j = 1; j <= 5; j++) {
      worst = Math.max(
        worst,
        Math.abs(x[j] - x[j - 1]),
        Math.abs(x[x.length - j] - x[x.length - 1 - j]),
      );
    }
    return worst;
  }

  it('烘焙后接缝邻域的跳变不超过典型样本跳变的 3 倍（无脉冲）', () => {
    const raw = renderStatic();
    const looped = crossfadeLoop(raw, SAMPLE_RATE);
    expect(worstSeamStep(looped)).toBeLessThan(3 * medianStep(looped));
  });

  it('对带首尾突变的信号显著压低环绕接缝跳变', () => {
    const n = SAMPLE_RATE;
    const raw = new Float32Array(n);
    // 前 2/3 为 0，末 1/3 抬到 1：朴素循环在环绕处产生 1.0 的硬跳变（脉冲）
    for (let i = (n * 2) / 3; i < n; i++) raw[i] = 1;
    const rawSeam = Math.abs(raw[raw.length - 1] - raw[0]);
    const looped = crossfadeLoop(raw, SAMPLE_RATE);
    const loopedSeam = Math.abs(looped[looped.length - 1] - looped[0]);
    expect(rawSeam).toBeCloseTo(1, 5);
    expect(loopedSeam).toBeLessThan(0.05);
  });

  it('长度缩短一个 fade 段，且能量量级与原信号接近', () => {
    const raw = renderStatic();
    const looped = crossfadeLoop(raw, SAMPLE_RATE);
    const fade = Math.floor(0.08 * SAMPLE_RATE);
    expect(looped.length).toBe(raw.length - fade);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(Math.abs(rms(looped) - rms(raw)) / rms(raw)).toBeLessThan(0.25);
  });
});
