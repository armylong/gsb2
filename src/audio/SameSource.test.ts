/**
 * 同源保证测试：
 * 曲线展示用的 amplitude、试听/导出用的 pcm 必须来自同一次 renderSequence 调用，
 * 且 WAV 往返后包络形状与原振幅一致。
 */
import { describe, it, expect } from 'vitest';
import { renderSequence } from './OfflineRenderer';
import { encodeWav, decodeWav } from './wav';
import { DEFAULT_TIMBRE } from './types';
import type { KeySequence } from './sequence';
import { nextEventId } from './sequence';

const SR = 22050;

describe('单一声音过程：曲线 / 试听 / WAV 同源', () => {
  const seq: KeySequence = {
    name: 'mixed',
    events: [
      { id: nextEventId(), time: 0.1, type: 'noteOn', velocity: 0.35 },
      { id: nextEventId(), time: 0.45, type: 'noteOff' },
      { id: nextEventId(), time: 0.5, type: 'noteOn', velocity: 1 },
      { id: nextEventId(), time: 0.8, type: 'noteOff' },
    ],
  };

  it('一次渲染产出等长的 pcm 与 amplitude，且 amplitude 等于 |pcm| 的逐采样上界', () => {
    const r = renderSequence(seq, DEFAULT_TIMBRE, SR, 1);
    expect(r.pcm.length).toBe(r.amplitude.length);
    // pcm = osc * level * velocity * masterGain，故 |pcm| <= amplitude * masterGain
    for (let i = 0; i < r.pcm.length; i++) {
      expect(Math.abs(r.pcm[i])).toBeLessThanOrEqual(r.amplitude[i] * DEFAULT_TIMBRE.masterGain + 1e-9);
    }
  });

  it('WAV 往返后的块包络与渲染 amplitude 的块包络高度一致', () => {
    const r = renderSequence(seq, DEFAULT_TIMBRE, SR, 1);
    const decoded = decodeWav(encodeWav(r.pcm, SR));
    const blocks = 128;
    const block = (data: Float32Array, useAbs: boolean) => {
      const out = new Float32Array(blocks);
      const size = Math.floor(data.length / blocks);
      for (let b = 0; b < blocks; b++) {
        let peak = 0;
        for (let i = b * size; i < (b + 1) * size; i++) {
          peak = Math.max(peak, useAbs ? Math.abs(data[i]) : data[i]);
        }
        out[b] = peak;
      }
      return out;
    };
    const a = block(decoded.pcm, true);
    const b = block(r.amplitude, false).map((v) => v * DEFAULT_TIMBRE.masterGain);
    let maxDiff = 0;
    for (let i = 0; i < blocks; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    // 16-bit 量化 + 块边界误差，远小于一个可闻层级
    expect(maxDiff).toBeLessThan(0.02);
  });

  it('尾音长度：最后事件时刻 + 完整 release 之后才归零，且总尾音可精确统计', () => {
    const t = {
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, release: 0.25 },
    };
    const r = renderSequence(seq, t, SR, 1);
    const lastEventSample = Math.round(0.8 * SR);
    // 最后事件后至少还有一个完整 release 长度的有声/衰减过程
    const releaseSamples = Math.round(0.25 * SR);
    let audibleAfterRelease = false;
    for (let i = lastEventSample; i < lastEventSample + releaseSamples; i++) {
      if (r.amplitude[i] > 0) audibleAfterRelease = true;
    }
    expect(audibleAfterRelease).toBe(true);
    // release 结束之后严格为 0
    for (let i = lastEventSample + releaseSamples + 2; i < r.amplitude.length; i++) {
      expect(r.amplitude[i]).toBe(0);
    }
  });
});
