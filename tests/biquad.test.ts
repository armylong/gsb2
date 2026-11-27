import { describe, it, expect } from 'vitest';
import { bandpassCoeffs, BiquadStage, magnitudeAt } from '../src/dsp/biquad';
import { SAMPLE_RATE } from '../src/types';

describe('RBJ 带通滤波器', () => {
  it('在中心频率处出现响应峰，远离中心处衰减', () => {
    const c = bandpassCoeffs(1000, 100, SAMPLE_RATE);
    const atCenter = magnitudeAt(c, 1000, SAMPLE_RATE);
    const atFar = magnitudeAt(c, 3000, SAMPLE_RATE);
    expect(atCenter).toBeGreaterThan(0.9);
    expect(atFar).toBeLessThan(0.1);
  });

  it('稳定：冲激响应长时间不发散，系数极点在单位圆内', () => {
    const stage = new BiquadStage();
    const c = bandpassCoeffs(200, 20, SAMPLE_RATE);
    let maxAbs = 0;
    let y = 0;
    for (let i = 0; i < SAMPLE_RATE; i++) {
      y = stage.process(i === 0 ? 1 : 0, c);
      maxAbs = Math.max(maxAbs, Math.abs(y));
    }
    expect(maxAbs).toBeLessThan(2);
    expect(Number.isFinite(y)).toBe(true);
  });

  it('窄带宽比宽带宽更具选择性', () => {
    const narrow = bandpassCoeffs(1000, 40, SAMPLE_RATE);
    const wide = bandpassCoeffs(1000, 600, SAMPLE_RATE);
    const narrowAt2k = magnitudeAt(narrow, 2000, SAMPLE_RATE);
    const wideAt2k = magnitudeAt(wide, 2000, SAMPLE_RATE);
    expect(wideAt2k).toBeGreaterThan(narrowAt2k);
  });
});
