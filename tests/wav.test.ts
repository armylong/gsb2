import { describe, it, expect } from 'vitest';
import { encodeWav, decodeWav } from '../src/dsp/wav';
import { SAMPLE_RATE } from '../src/types';

describe('WAV 编码/回读', () => {
  it('round-trip：回读采样率、长度一致，16-bit 量化误差在 1 LSB 左右', () => {
    const n = SAMPLE_RATE; // 1 秒
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
    const buf = encodeWav(samples, SAMPLE_RATE);
    const decoded = decodeWav(buf);
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.samples.length).toBe(n);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(decoded.samples[i] - samples[i]));
    // 16-bit 非对称量化（负值 0x8000、正值 0x7fff）理论最大误差略大于 1 LSB，上界约 1.5 LSB
    expect(maxErr).toBeLessThan(2 / 32768 + 1e-6);
  });

  it('非法字节抛出可读错误', () => {
    expect(() => decodeWav(new ArrayBuffer(16))).toThrow();
  });
});
