import { describe, expect, it } from 'vitest';
import {
  buildSampleChart,
  buildSampleInputs,
  normalizeLog,
  runReplay,
  SAMPLE_CONFIG,
  TRIPLE_CONFIG,
  TRIPLE_TARGET_TEXT,
} from '../src/engine/replay.ts';
import { buildChart, beatToMeasureBeat } from '../src/engine/chart.ts';
import { Engine } from '../src/engine/engine.ts';

describe('可重放样例：五种情形全部出现', () => {
  const chart = buildSampleChart();
  const inputs = buildSampleInputs();

  it('流水里包含 慢拍/擦边/重叠/长按中途释放/乱按', () => {
    const eng = runReplay(chart, inputs, 1 / 60);
    const grades = new Map(eng.log.map((r) => [`${r.targetId ?? 'x'}-${r.kind}`, r.grade]));

    // 重叠：T2 赢得 0.60s 那次输入，候选里有 T3
    const overlapRow = eng.log.find((r) => r.targetId === 'T2')!;
    expect(overlapRow.candidates?.some((c) => c.targetId === 'T3')).toBe(true);
    expect(overlapRow.grade).toBe('good');

    // 擦边：T4 恰好 -50ms → perfect
    expect(grades.get('T4-down')).toBe('perfect');

    // 长按中途释放：T7 尾拍 miss；跨小节 T5 双 perfect
    expect(grades.get('T7-tail')).toBe('miss');
    expect(grades.get('T5-head')).toBe('perfect');
    expect(grades.get('T5-tail')).toBe('perfect');

    // 慢一拍：T8 自动 miss，beat7 的补踩是 ignored
    expect(grades.get('T8-down')).toBe('miss');
    expect(eng.log.filter((r) => r.grade === 'ignored').length).toBeGreaterThanOrEqual(2);

    // T9 晚 100ms good
    expect(grades.get('T9-down')).toBe('good');
  });

  it('60fps / 30fps / 20fps / 10fps 的归一化流水逐行相同', () => {
    const base = normalizeLog(runReplay(chart, inputs, 1 / 60));
    for (const fps of [30, 20, 10, 7]) {
      const got = normalizeLog(runReplay(chart, inputs, 1 / fps));
      expect(got).toEqual(base);
    }
  });

  it('同帧率两次运行结果完全一致（无随机状态）', () => {
    const a = normalizeLog(runReplay(chart, inputs, 1 / 24));
    const b = normalizeLog(runReplay(chart, inputs, 1 / 24));
    expect(a).toEqual(b);
  });

  it('帧长不均（模拟卡顿）也不改变结果', () => {
    const base = normalizeLog(runReplay(chart, inputs, 1 / 60));
    const eng = new Engine(chart);
    for (const i of inputs) eng.queueInput(i);
    // 随机但确定的抖动步长
    const steps = [0.001, 0.05, 0.017, 0.09, 0.004, 0.033, 0.12, 0.008, 0.025];
    let t = 0;
    const end = 6;
    let i = 0;
    while (t < end) {
      t += steps[i++ % steps.length];
      eng.update(Math.min(t, end));
    }
    eng.update(end);
    expect(normalizeLog(eng)).toEqual(base);
  });

  it('汇总成绩稳定：11 条结算中 9 命中', () => {
    const eng = runReplay(chart, inputs, 1 / 60);
    const s = eng.summary();
    expect(s.total).toBe(11); // 7 tap + 2 hold×2
    expect(s.perfect + s.good).toBe(9);
    expect(s.miss).toBe(2); // T8 头、T7 尾
  });
});

describe('小节/拍号显示换算', () => {
  it('4/4 与 3/4 的小节-拍换算', () => {
    expect(beatToMeasureBeat(0, 4)).toEqual({ measure: 0, beatInMeasure: 0 });
    expect(beatToMeasureBeat(3.9, 4)).toEqual({ measure: 0, beatInMeasure: 3.9 });
    expect(beatToMeasureBeat(4, 4)).toEqual({ measure: 1, beatInMeasure: 0 });
    expect(beatToMeasureBeat(5, 3)).toEqual({ measure: 1, beatInMeasure: 2 });
    expect(beatToMeasureBeat(6, 3)).toEqual({ measure: 2, beatInMeasure: 0 });
  });

  it('三拍预设可构建', () => {
    const r = buildChart(TRIPLE_CONFIG, TRIPLE_TARGET_TEXT);
    expect(r.errors).toHaveLength(0);
    expect(r.chart!.targets).toHaveLength(5);
  });

  it('SAMPLE_CONFIG 窗口参数符合样例预期', () => {
    expect(SAMPLE_CONFIG.perfectWindow).toBe(0.05);
    expect(SAMPLE_CONFIG.goodWindow).toBe(0.12);
  });
});
