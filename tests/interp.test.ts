import { describe, it, expect } from 'vitest';
import { frameAt, activeKeys } from '../src/dsp/interp';
import { defaultTimeline } from '../src/presets';

describe('时间线插值', () => {
  it('t=0 与 t=1 精确等于首尾节点', () => {
    const tl = defaultTimeline();
    const at0 = frameAt(tl, 0);
    const at1 = frameAt(tl, 1);
    expect(at0[0].center).toBe(tl.keys[0].formants[0].center);
    expect(at1[1].center).toBe(tl.keys[2].formants[1].center);
  });

  it('中心频率按对数插值：几何中点落在两值的几何平均上', () => {
    const tl = defaultTimeline();
    const keys = activeKeys(tl);
    const a = keys[0].formants[0].center;
    const b = keys[2].formants[0].center;
    const mid = frameAt(tl, 0.5)[0].center;
    // 拐点在 0.5，t=0.25 是首段中点
    const quarter = frameAt(tl, 0.25)[0].center;
    expect(quarter).toBeCloseTo(Math.sqrt(a * mid), 3);
    expect(mid).toBeGreaterThan(0);
    void b;
  });

  it('关闭拐点后只在首尾之间插值，且返回两个节点', () => {
    const tl = defaultTimeline();
    tl.middleEnabled = false;
    const keys = activeKeys(tl);
    expect(keys).toHaveLength(2);
    const mid = frameAt(tl, 0.5);
    const geo = Math.sqrt(tl.keys[0].formants[0].center * tl.keys[2].formants[0].center);
    expect(mid[0].center).toBeCloseTo(geo, 3);
  });
});
