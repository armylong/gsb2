import { describe, it, expect } from 'vitest';
import { renderSequence, renderOneShot } from './OfflineRenderer';
import { encodeWav, decodeWav, trailingSilence } from './wav';
import { DEFAULT_TIMBRE } from './types';
import type { TimbreParams } from './types';
import type { KeySequence } from './sequence';
import { nextEventId } from './sequence';

const SR = 22050; // 测试用低采样率，更快

const on = (time: number, velocity = 1) => ({
  id: nextEventId(),
  time,
  type: 'noteOn' as const,
  velocity,
});
const off = (time: number) => ({ id: nextEventId(), time, type: 'noteOff' as const });

describe('renderSequence', () => {
  it('逐采样确定：同一序列两次渲染完全一致', () => {
    const seq: KeySequence = {
      name: 't',
      events: [on(0.1, 0.8), off(0.4), on(0.5, 1), off(0.9)],
    };
    const a = renderSequence(seq, DEFAULT_TIMBRE, SR, 1);
    const b = renderSequence(seq, DEFAULT_TIMBRE, SR, 1);
    expect(Array.from(a.pcm)).toEqual(Array.from(b.pcm));
    expect(Array.from(a.amplitude)).toEqual(Array.from(b.amplitude));
  });

  it('事件采样索引与 time*sampleRate 对齐（暂停重播触发点一致的基础）', () => {
    const seq: KeySequence = {
      name: 't',
      events: [on(0.1), off(0.25), on(0.3), off(0.8)],
    };
    const r = renderSequence(seq, DEFAULT_TIMBRE, SR, 1);
    const samples = r.eventSamples.map((e) => e.sample);
    expect(samples).toEqual([
      Math.round(0.1 * SR),
      Math.round(0.25 * SR),
      Math.round(0.3 * SR),
      Math.round(0.8 * SR),
    ]);
  });

  it('同时刻 noteOn+noteOff 的零长度音不报错且可正常继续', () => {
    const seq: KeySequence = {
      name: 'zero',
      events: [on(0.2), off(0.2), on(0.5), off(0.7)],
    };
    const r = renderSequence(seq, DEFAULT_TIMBRE, SR, 1);
    expect(r.pcm.length).toBeGreaterThan(0);
    // 第二个音确实发声了
    const secondStart = Math.round(0.5 * SR);
    let any = false;
    for (let i = secondStart; i < secondStart + 100; i++) any ||= Math.abs(r.pcm[i]) > 0;
    expect(any).toBe(true);
  });

  it('弱长音接强短音：强音触发处振幅上冲超过弱音保持电平', () => {
    const t: TimbreParams = {
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, attack: 0.02, sustain: 0.5, release: 0.2 },
    };
    const seq: KeySequence = {
      name: 'soft-loud',
      events: [on(0.1, 0.3), on(0.6, 1), off(0.75), off(1.0)],
    };
    const r = renderSequence(seq, t, SR, 1);
    const softLevel = r.amplitude[Math.round(0.55 * SR)]; // 弱音保持中
    const loudPeak = Math.max(
      ...Array.from(r.amplitude.slice(Math.round(0.6 * SR), Math.round(0.75 * SR))),
    );
    expect(softLevel).toBeCloseTo(0.3 * 0.5, 1);
    expect(loudPeak).toBeGreaterThan(softLevel);
    expect(loudPeak).toBeGreaterThan(0.8);
  });

  it('渲染结束时包络已完全释放（尾音完整，不留未释放的声音）', () => {
    const t: TimbreParams = {
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, release: 0.3 },
    };
    const r = renderOneShot(t, 0.3, SR);
    expect(r.amplitude[r.amplitude.length - 1]).toBe(0);
    expect(r.tailSilence).toBeGreaterThan(0);
  });

  it('paramChange live 模式在曲线上可见为连续过渡，pending 到下次 noteOn 才变', () => {
    const base: TimbreParams = {
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, sustain: 0.3, attack: 0.01, decay: 0.01 },
    };
    const changed: TimbreParams = {
      ...base,
      envelope: { ...base.envelope, sustain: 0.9 },
    };
    const seqLive: KeySequence = {
      name: 'live',
      events: [
        on(0.1),
        { id: nextEventId(), time: 0.4, type: 'paramChange', params: changed, mode: 'live' },
        off(1.0),
      ],
    };
    const rLive = renderSequence(seqLive, base, SR, 1);
    const atChange = rLive.amplitude[Math.round(0.4 * SR)];
    const afterGlide = rLive.amplitude[Math.round(0.45 * SR)];
    expect(atChange).toBeCloseTo(0.3, 1);
    expect(afterGlide).toBeGreaterThan(0.5); // 已向 0.9 滑动

    const seqPending: KeySequence = {
      name: 'pending',
      events: [
        on(0.1),
        { id: nextEventId(), time: 0.4, type: 'paramChange', params: changed, mode: 'pending' },
        off(0.7),
        on(0.85),
        off(1.3),
      ],
    };
    const rPending = renderSequence(seqPending, base, SR, 1);
    expect(rPending.amplitude[Math.round(0.5 * SR)]).toBeCloseTo(0.3, 1); // 旧值保持
    const secondSustain = rPending.amplitude[Math.round(1.0 * SR)];
    expect(secondSustain).toBeGreaterThan(0.7); // 第二次触发用新值
  });
});

describe('WAV 回读', () => {
  it('编码再解码：采样率、长度与采样值保持一致（16-bit 量化误差内）', () => {
    const t: TimbreParams = {
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, release: 0.2 },
    };
    const r = renderOneShot(t, 0.4, SR);
    const wav = encodeWav(r.pcm, SR);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.channels).toBe(1);
    expect(decoded.bitsPerSample).toBe(16);
    expect(decoded.pcm.length).toBe(r.pcm.length);
    let maxErr = 0;
    for (let i = 0; i < r.pcm.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(decoded.pcm[i] - r.pcm[i]));
    }
    // 对称 16-bit 量化：单采样误差不超过一个量化台阶（再加半个舍入台阶余量）
    expect(maxErr).toBeLessThan(1.5 / 32768);
  });

  it('回读文件的结尾静音长度与渲染结果一致（释放尾音可对照）', () => {
    const t: TimbreParams = {
      ...DEFAULT_TIMBRE,
      envelope: { ...DEFAULT_TIMBRE.envelope, release: 0.15 },
    };
    const r = renderOneShot(t, 0.3, SR, 1);
    const decoded = decodeWav(encodeWav(r.pcm, SR));
    // 16-bit 量化会让噪声门限附近的最后几个可闻采样位置略有移动，
    // 允许一个量化台阶量级的容差（这里远小于一个释放段时长）
    const diff = Math.abs(trailingSilence(decoded.pcm) - trailingSilence(r.pcm));
    expect(diff).toBeLessThanOrEqual(SR * 0.002);
    // 两侧都确认有实质尾静音
    expect(trailingSilence(decoded.pcm)).toBeGreaterThan(SR * 0.5);
  });

  it('零振幅整段静音也能正确往返', () => {
    const silence = new Float32Array(1000);
    const decoded = decodeWav(encodeWav(silence, SR));
    expect(decoded.pcm.length).toBe(1000);
    expect(Array.from(decoded.pcm).every((v) => v === 0)).toBe(true);
    expect(trailingSilence(decoded.pcm)).toBe(1000);
  });
});
