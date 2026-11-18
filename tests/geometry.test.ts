import { describe, it, expect } from 'vitest';
import {
  distancePointRect,
  distanceSegmentRect,
  segmentsIntersect,
  inflateRect,
  distancePointSegment,
} from '../src/core/geometry';

describe('geometry 基础几何', () => {
  it('点到矩形距离: 内部为 0, 外部为最近边距离', () => {
    const r = { x: 10, y: 10, w: 4, h: 4 };
    expect(distancePointRect({ x: 12, y: 12 }, r)).toBe(0);
    expect(distancePointRect({ x: 5, y: 12 }, r)).toBeCloseTo(5, 6);
    expect(distancePointRect({ x: 12, y: 20 }, r)).toBeCloseTo(6, 6);
    // 点 (16,16) 到矩形 [10,14]×[10,14] 的最近点是角 (14,14), 距离 2√2
    expect(distancePointRect({ x: 16, y: 16 }, r)).toBeCloseTo(2 * Math.SQRT2, 6);
  });

  it('点到线段距离', () => {
    expect(distancePointSegment({ x: 0, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 6);
    expect(distancePointSegment({ x: -2, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(2, 6);
    expect(distancePointSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 6);
  });

  it('线段相交判定(含接触)', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 10, y: 10 }),
    ).toBe(false);
    // 端点接触
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 0 }),
    ).toBe(true);
  });

  it('线段到矩形: 穿矩形时为 0', () => {
    const r = { x: 10, y: 8, w: 2, h: 14 };
    expect(distanceSegmentRect({ x: 0, y: 15 }, { x: 20, y: 15 }, r)).toBe(0);
    // 平行擦边: 距离 1
    expect(distanceSegmentRect({ x: 0, y: 7 }, { x: 20, y: 7 }, r)).toBeCloseTo(1, 6);
  });

  it('膨胀矩形并夹取到房间', () => {
    const inflated = inflateRect({ x: 5, y: 5, w: 2, h: 2 }, 0.5, 40, 30);
    expect(inflated).toEqual({ x: 4.5, y: 4.5, w: 3, h: 3 });
    // 贴墙障碍膨胀后被夹到 0
    const corner = inflateRect({ x: 0, y: 0, w: 2, h: 2 }, 0.8, 40, 30);
    expect(corner).toEqual({ x: 0, y: 0, w: 2.8, h: 2.8 });
  });
});
