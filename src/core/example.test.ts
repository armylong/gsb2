import { describe, expect, it } from 'vitest';
import { createExampleProject } from './project';
import { Timeline } from './timeline';
import { planExport, renderExport } from './render';

/**
 * 针对内置练习 (弱起 / 三拍转五拍 / 渐快) 的端到端核对:
 * 已知拍点的采样位置可手算复核, 且任何导出都不会多发边界拍。
 */
describe('内置练习核对', () => {
  const SR = 48000;
  const project = createExampleProject();
  const tl = new Timeline(project);

  it('结构: 1 拍弱起 -> 3/4 -> 5/4 -> 4/4 渐快, 共 8 个小节', () => {
    expect(tl.bars.length).toBe(8);
    expect(tl.bars[0].isPickup).toBe(true);
    expect(tl.bars[0].quarters).toBe(1);
    expect(tl.bars[3].meter).toEqual({ numerator: 5, denominator: 4 });
    expect(project.segments[2].mode).toBe('ramp');
  });

  it('整曲导出: 每个拍点采样位置 = round(qToTime * SR), 且无 q=29 结束边界拍', () => {
    const { plan, pcm } = renderExport(tl, project, {
      sampleRate: SR,
      barFrom: 0,
      barTo: 7,
      countIn: false,
    });
    for (const h of plan.hits) {
      const expectedSample = Math.round(tl.qToTime(h.q) * SR);
      expect(h.sample).toBe(expectedSample);
      // 该采样点确实有声音 (正弦 i=0 过零, 检查 +1)
      expect(pcm[h.sample + 1]).not.toBe(0);
    }
    expect(plan.hits.every((h) => h.q < tl.totalQ)).toBe(true);
    expect(plan.hits.some((h) => h.q === tl.totalQ)).toBe(false);
  });

  it('手算复核已知点: 弱起首拍 sample=0; 段 B 首拍在 14/3 秒', () => {
    const plan = planExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: false });
    expect(plan.hits[0].q).toBe(0);
    expect(plan.hits[0].sample).toBe(0);
    const bStart = plan.hits.find((h) => h.q === 7)!;
    expect(bStart.kind).toBe('downbeat');
    expect(bStart.sample).toBe(Math.round(((7 * 60) / 90) * SR));
    expect(bStart.sample).toBe(224000); // (14/3)s * 48000
  });

  it('预备拍: 进入点 sample 与无预备拍时同一点相差正好预备小节采样数', () => {
    const noCount = planExport(tl, project, { sampleRate: SR, barFrom: 3, barTo: 5, countIn: false });
    const withCount = planExport(tl, project, { sampleRate: SR, barFrom: 3, barTo: 5, countIn: true });
    const countSamples = Math.round(((5 * 60) / 132) * SR);
    const a = noCount.hits[0].sample;
    const b = withCount.hits.find((h) => !h.inCountIn)!.sample;
    expect(b - a).toBe(countSamples);
    // 预备拍最后一拍与进入点间距正好一拍
    const lastCount = withCount.hits.filter((h) => h.inCountIn).pop()!;
    expect(b - lastCount.sample).toBe(Math.round((60 / 132) * SR));
  });

  it('渐快段内部起点开始: 采样位置与全量时间表一致 (渐变中途不漂移)', () => {
    const mid = planExport(tl, project, { sampleRate: SR, barFrom: 6, barTo: 7, countIn: false });
    const full = planExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: false });
    for (const h of mid.hits) {
      const ref = full.hits.find((x) => x.q === h.q)!;
      expect(h.tInFile - mid.hits[0].tInFile).toBeCloseTo(ref.tInFile - full.hits.find((x) => x.q === mid.qFrom)!.tInFile, 10);
    }
  });

  it('相邻两个导出区域拼接处不重拍: 左区末拍 != 右区首拍, 且 q 连续', () => {
    const left = planExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 2, countIn: false });
    const right = planExport(tl, project, { sampleRate: SR, barFrom: 3, barTo: 4, countIn: false });
    const leftQs = new Set(left.hits.map((h) => h.q));
    for (const h of right.hits) {
      expect(leftQs.has(h.q)).toBe(false);
    }
    const boundaryQ = tl.bars[3].qStart;
    expect(right.hits[0].q).toBe(boundaryQ);
  });
});
