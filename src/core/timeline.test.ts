import { describe, expect, it } from 'vitest';
import { createExampleProject } from './project';
import { Timeline, barQuarters, computeBars, computeSegmentSpans } from './timeline';

const project = createExampleProject();
const tl = new Timeline(project);

describe('结构展开: 弱起 / 拍号切换', () => {
  it('满小节长度按拍号分母换算 (6/8 = 3 个四分音符)', () => {
    expect(barQuarters({ numerator: 6, denominator: 8 })).toBeCloseTo(3, 10);
    expect(barQuarters({ numerator: 5, denominator: 4 })).toBe(5);
  });

  it('弱起段第一小节不完整, 显示小节号为 0, 后续小节号连续', () => {
    expect(tl.bars.length).toBe(3 + 2 + 3);
    const [pickup, a1, a2, b1] = tl.bars;
    expect(pickup.isPickup).toBe(true);
    expect(pickup.quarters).toBe(1);
    expect(pickup.barNumber).toBe(0);
    expect(a1.barNumber).toBe(1);
    expect(a2.barNumber).toBe(2);
    expect(b1.barNumber).toBe(3);
    expect(b1.quarters).toBe(5);
  });

  it('段区间首尾相接, 总 q = 1+3+3 + 10 + 12 = 29', () => {
    const spans = computeSegmentSpans(project.segments);
    expect(spans.map((s) => [s.qStart, s.qEnd])).toEqual([
      [0, 7],
      [7, 17],
      [17, 29],
    ]);
    expect(tl.totalQ).toBe(29);
  });

  it('弱起拍数超过小节容量时抛错', () => {
    const bad = createExampleProject();
    bad.segments[0].pickupBeats = 99;
    expect(() => new Timeline(bad)).toThrow(/弱起/);
  });
});

describe('q -> 秒: 恒速 / 突变 / 渐变', () => {
  it('90 BPM 下每四分音符 = 2/3 秒', () => {
    expect(tl.qToTime(1)).toBeCloseTo(2 / 3, 9);
    expect(tl.qToTime(3)).toBeCloseTo(2, 9);
  });

  it('突然变速: 边界处时间连续, 边界后按 132 BPM 走', () => {
    const tBoundary = (7 * 60) / 90; // 14/3
    expect(tl.qToTime(7)).toBeCloseTo(tBoundary, 9);
    expect(tl.qToTime(8)).toBeCloseTo(tBoundary + 60 / 132, 9);
    expect(tl.qToTime(17)).toBeCloseTo(tBoundary + (10 * 60) / 132, 9);
  });

  it('线性渐快: 解析式 t(q) = t0 + 60L/(b1-b0) ln(b(q)/b0)', () => {
    const t17 = (7 * 60) / 90 + (10 * 60) / 132;
    const L = 12;
    const b0 = 100;
    const b1 = 150;
    const expectT = (q: number) =>
      t17 + ((60 * L) / (b1 - b0)) * Math.log((b0 + ((b1 - b0) * (q - 17)) / L) / b0);
    expect(tl.qToTime(17)).toBeCloseTo(t17, 9);
    expect(tl.qToTime(23)).toBeCloseTo(expectT(23), 9);
    expect(tl.qToTime(29)).toBeCloseTo(expectT(29), 9);
    // 渐快后同等 q 距离耗时更短: 后 6 拍比前 6 拍快
    const first6 = tl.qToTime(23) - tl.qToTime(17);
    const last6 = tl.qToTime(29) - tl.qToTime(23);
    expect(last6).toBeLessThan(first6);
  });

  it('timeToQ 是 qToTime 的逆 (含渐变段内部)', () => {
    for (const q of [0, 1, 6.5, 7, 12.333, 17, 20.25, 25.75, 29]) {
      expect(tl.timeToQ(tl.qToTime(q))).toBeCloseTo(Math.min(q, 29), 7);
    }
  });

  it('改速度后 q 网格不动, 秒数随之变', () => {
    const edited = createExampleProject();
    edited.segments[0].bpmStart = 180;
    const tl2 = new Timeline(edited);
    const bars1 = computeBars(project.segments).map((b) => [b.qStart, b.qEnd]);
    const bars2 = computeBars(edited.segments).map((b) => [b.qStart, b.qEnd]);
    expect(bars2).toEqual(bars1);
    expect(tl2.qToTime(1)).toBeCloseTo(1 / 3, 9);
    expect(tl.qToTime(1)).toBeCloseTo(2 / 3, 9);
  });
});

describe('拍点事件与边界拍', () => {
  const events = tl.buildEvents();

  it('每个 q 只有一个事件 (小节/段边界不重复发声)', () => {
    const qs = events.map((e) => e.q);
    expect(new Set(qs).size).toBe(qs.length);
  });

  it('弱起首拍是 downbeat, 段首拍带 segmentStart 标记', () => {
    const first = events[0];
    expect(first.q).toBe(0);
    expect(first.kind).toBe('downbeat');
    expect(first.isPickup).toBe(true);
    // 段首拍: 第一段首拍在 0; 后续段首拍同时是前段的右端点, 仍由后段小节正常产出
    const segStarts = events.filter((e) => e.isSegmentStart).map((e) => e.q);
    expect(segStarts).toEqual([0, 7, 17]);
    expect(events.find((e) => e.q === 7)!.kind).toBe('downbeat');
    expect(events.find((e) => e.q === 17)!.kind).toBe('downbeat');
    // 整条时间线的结束点不发声 (左闭右开, 不多发边界拍)
    expect(events.some((e) => e.q === tl.totalQ)).toBe(false);
  });

  it('分拍只出现在整拍之间, 且挂在 parentBeatQ 下', () => {
    const subs = events.filter((e) => e.kind === 'sub');
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.q).not.toBe(s.parentBeatQ);
      expect(s.q).toBeGreaterThan(s.parentBeatQ);
      expect(s.q).toBeLessThan(s.parentBeatQ + 1);
    }
  });

  it('五拍段 sub=3 (三连音): 整拍各带 2 个三连音, 段尾边界拍不产生 B 段分拍', () => {
    const inB = events.filter((e) => e.segmentId === project.segments[1].id);
    const beats = inB.filter((e) => e.kind !== 'sub');
    const subs = inB.filter((e) => e.kind === 'sub');
    // 左闭右开: 10 个整拍; 两个小节各自产出三连音, 共 10*2 个 (q=17 边界拍本身不产 B 段分拍)
    expect(beats.length).toBe(10);
    expect(subs.length).toBe(20);
    // q=17 这个边界拍由 C 段首小节产出, 是 downbeat, 不会重复
    const boundary = events.filter((e) => e.q === 17);
    expect(boundary.length).toBe(1);
    expect(boundary[0].segmentId).toBe(project.segments[2].id);
  });

  it('区间构建时右端点边界拍被排除 (不会多发)', () => {
    const partial = tl.buildEvents(0, 7);
    expect(partial.some((e) => e.q === 7)).toBe(false);
    expect(partial[partial.length - 1].q).toBeLessThan(7);
    const partial2 = tl.buildEvents(3, 5);
    expect(partial2[0].q).toBe(3);
    expect(partial2.some((e) => e.q >= 5)).toBe(false);
  });

  it('从渐变中段取事件, 时间戳与全量构建完全一致', () => {
    const full = tl.buildEvents();
    const mid = tl.buildEvents(20, 26);
    for (const m of mid) {
      const f = full.find((e) => e.q === m.q);
      expect(f).toBeDefined();
      expect(f!.t).toBeCloseTo(m.t, 12);
      expect(f!.kind).toBe(m.kind);
    }
  });
});
