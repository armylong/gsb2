import { describe, expect, it } from 'vitest';
import { createExampleProject } from './project';
import { Timeline } from './timeline';
import { renderExport } from './render';
import { encodeWav, parseWavHeader } from './wav';

/** 字节级核对: 渲染 -> 编码 WAV -> 按 16bit PCM 解码回采样, 逐发声点验证 */
describe('WAV 字节级端到端核对 (内置练习)', () => {
  const SR = 48000;
  const project = createExampleProject();
  const tl = new Timeline(project);

  it('带预备拍整曲导出: 每个计划发声点在 WAV 解码后有能量, 零点是 downbeat, 边界拍不发', () => {
    const { pcm, plan } = renderExport(tl, project, {
      sampleRate: SR,
      barFrom: 0,
      barTo: 7,
      countIn: true,
    });
    const wav = encodeWav(pcm, SR);
    const bytes = new Uint8Array(wav);
    const info = parseWavHeader(bytes);
    expect(info.totalSamples).toBe(pcm.length);

    const view = new DataView(wav);
    const decodeAt = (sample: number): number => view.getInt16(44 + sample * 2, true) / 0x8000;

    for (const h of plan.hits) {
      // 正弦 i=0 过零, 检查 +1 采样; 16bit 量化后仍应明显非零
      expect(Math.abs(decodeAt(h.sample + 1))).toBeGreaterThan(1e-4);
    }

    const zero = plan.markers.find((m) => m.kind === 'zero')!;
    const zeroSample = Math.round(zero.t * SR);
    const zeroHit = plan.hits.find((h) => h.sample === zeroSample);
    expect(zeroHit?.kind).toBe('downbeat');
    expect(Math.abs(decodeAt(zeroSample + 1))).toBeGreaterThan(0.1);

    // 整条时间线结束边界 q=29 绝不出现在导出里
    expect(plan.hits.some((h) => h.q === tl.totalQ)).toBe(false);

    // 预备拍区域: 文件最前面的发声点在 sample 0
    expect(plan.hits[0].inCountIn).toBe(true);
    expect(plan.hits[0].sample).toBe(0);
  });

  it('16bit 量化误差在合理范围 (峰值不削波)', () => {
    const { pcm } = renderExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: false });
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(1);
    const wav = encodeWav(pcm, SR);
    const view = new DataView(wav);
    let wavPeak = 0;
    for (let i = 0; i < pcm.length; i++) {
      wavPeak = Math.max(wavPeak, Math.abs(view.getInt16(44 + i * 2, true)) / 0x8000);
    }
    expect(wavPeak).toBeLessThan(1);
    expect(Math.abs(wavPeak - peak)).toBeLessThan(2 / 0x8000);
  });
});
