import { describe, it, expect } from 'vitest';
import { computeSpectrum, fft } from '../src/dsp/fft';
import { SAMPLE_RATE } from '../src/types';

describe('FFT', () => {
  it('对单频正弦在正确 bin 上出现主峰', () => {
    const f0 = 440;
    const n = 4096;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * f0 * i) / SAMPLE_RATE);
    const spec = computeSpectrum(samples, SAMPLE_RATE, 4096);
    const targetBin = Math.round((f0 * 4096) / SAMPLE_RATE);
    let maxBin = 0;
    for (let k = 1; k < spec.magDb.length; k++) {
      if (spec.magDb[k] > spec.magDb[maxBin]) maxBin = k;
    }
    expect(maxBin).toBe(targetBin);
  });

  it('非 2 的幂长度抛错，2 的幂长度通过', () => {
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    expect(() => fft(re, im)).not.toThrow();
    const bad = new Float64Array(7);
    expect(() => fft(bad, new Float64Array(7))).toThrow();
  });
});
