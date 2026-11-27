import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE, dbToGain, type RenderOptions } from '../src/types';
import { renderSynth } from '../src/dsp/synth';
import { encodeWav, decodeWav } from '../src/dsp/wav';
import { readbackCheck } from '../src/dsp/readback';
import { glideExample, breathyExample } from '../src/presets';

function render(ex: ReturnType<typeof glideExample>) {
  const opts: RenderOptions = {
    sampleRate: SAMPLE_RATE,
    duration: ex.duration,
    f0: ex.f0,
    noiseMix: ex.noiseMix,
    timeline: { middleEnabled: ex.middleEnabled, middlePos: ex.middlePos, keys: ex.keys },
    normalizeTo: dbToGain(-18),
    seed: 7,
  };
  return { opts, result: renderSynth(opts) };
}

describe('WAV 回读检查', () => {
  it('口形渐变例子：节点附近能找回三个共振峰，且 F1/F2 移动方向与时间线一致', () => {
    const ex = glideExample();
    const { result, opts } = render(ex);
    const decoded = decodeWav(encodeWav(result.samples, SAMPLE_RATE));
    const report = readbackCheck(decoded.samples, decoded.sampleRate, opts.timeline, ex.f0);

    expect(report.nodes).toHaveLength(3);
    for (const node of report.nodes) {
      const okCount = node.regions.filter((r) => r.status === 'ok').length;
      expect(okCount).toBeGreaterThanOrEqual(2);
      expect(node.f0).not.toBeNull();
      expect(Math.abs(node.f0! - ex.f0) / ex.f0).toBeLessThan(0.08);
    }
    // /i/ → /a/：F1 从 270 升到 730，F2 从 2290 降到 1090（取首尾节点的净变化）
    const first = report.nodes[0];
    const last = report.nodes[report.nodes.length - 1];
    const f1Delta = last.regions[0].expectedCenter - first.regions[0].expectedCenter;
    const f2Delta = last.regions[1].expectedCenter - first.regions[1].expectedCenter;
    expect(f1Delta).toBeGreaterThan(300);
    expect(f2Delta).toBeLessThan(-800);
    // 移动量数组也应记录到这些变化
    expect(report.movements.some((m) => m.label.startsWith('F1') && m.deltaHz > 0)).toBe(true);
    expect(report.movements.some((m) => m.label.startsWith('F2') && m.deltaHz < 0)).toBe(true);
  });

  it('高气音比例：至少一个节点出现峰弱/缺失提示或无基频提示', () => {
    const ex = breathyExample();
    ex.noiseMix = 0.95;
    const { result, opts } = render(ex);
    const decoded = decodeWav(encodeWav(result.samples, SAMPLE_RATE));
    const report = readbackCheck(decoded.samples, decoded.sampleRate, opts.timeline, ex.f0);
    const hasWeakness = report.nodes.some(
      (n) => n.regions.some((r) => r.status === 'weak' || r.status === 'missing') || n.f0 === null,
    );
    expect(hasWeakness).toBe(true);
  });

  it('相邻共振区重叠时给出 merged 状态而不是误报缺失', () => {
    const ex = glideExample();
    // 把起点 F1、F2 挤到一起
    ex.keys[0].formants[0].center = 900;
    ex.keys[0].formants[0].bandwidth = 300;
    ex.keys[0].formants[1].center = 1000;
    ex.keys[0].formants[1].bandwidth = 300;
    const { result, opts } = render(ex);
    const report = readbackCheck(result.samples, SAMPLE_RATE, opts.timeline, ex.f0);
    expect(report.nodes[0].regions.some((r) => r.status === 'merged')).toBe(true);
  });
});
