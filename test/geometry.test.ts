import { describe, expect, it } from 'vitest';
import {
  Circle,
  Poly,
  TAU,
  Vec2,
  circleIntersectsConvex,
  convexIntersect,
  cutToCircle,
  lightWedge,
  mergeIntervals,
  pointInConvex,
  rect,
  regularPolygon,
  segmentHitsConvex,
  tangentWedge,
} from '../src/core/geometry';

const square = (x: number, y: number, w: number, h: number): Poly => ({ id: 1, verts: rect(x, y, w, h) });

describe('角度区间工具', () => {
  it('cutToCircle 在不跨 0 时返回单段', () => {
    const segs = cutToCircle(1.0, 0.2);
    expect(segs).toHaveLength(1);
    expect(segs[0].e - segs[0].s).toBeCloseTo(0.4, 6);
  });

  it('cutToCircle 跨 0 时拆成两段且总长度不变', () => {
    const segs = cutToCircle(0.1, 0.3);
    expect(segs).toHaveLength(2);
    const total = segs.reduce((a, s) => a + (s.e - s.s), 0);
    expect(total).toBeCloseTo(0.6, 6);
  });

  it('mergeIntervals 合并重叠段', () => {
    const merged = mergeIntervals([
      { s: 0.2, e: 0.5 },
      { s: 0.4, e: 0.9 },
      { s: 1.2, e: 1.5 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ s: 0.2, e: 0.9 });
  });
});

describe('凸多边形判定', () => {
  const box = square(100, 100, 80, 80);
  it('内部/外部点', () => {
    expect(pointInConvex({ x: 140, y: 140 }, box)).toBe(true);
    expect(pointInConvex({ x: 10, y: 10 }, box)).toBe(false);
  });

  it('规则多边形按 CCW 生成', () => {
    const pent = regularPolygon({ x: 0, y: 0 }, 50, 5);
    let area2 = 0;
    for (let i = 0; i < pent.length; i++) {
      const a = pent[i];
      const b = pent[(i + 1) % pent.length];
      area2 += a.x * b.y - a.y * b.x;
    }
    expect(area2).toBeGreaterThan(0);
  });

  it('SAT 相交与分离', () => {
    expect(convexIntersect(square(0, 0, 50, 50), square(40, 40, 50, 50))).toBe(true);
    expect(convexIntersect(square(0, 0, 50, 50), square(200, 200, 50, 50))).toBe(false);
  });

  it('线段求交：穿过为 true，错过为 false', () => {
    const box = square(100, 100, 60, 60);
    expect(segmentHitsConvex({ x: 0, y: 130 }, { x: 300, y: 130 }, box)).toBe(true);
    expect(segmentHitsConvex({ x: 0, y: 40 }, { x: 300, y: 40 }, box)).toBe(false);
  });
});

describe('圆盘与多边形碰撞', () => {
  const box = square(200, 200, 100, 100);
  it('圆心在内部即相交', () => {
    const c: Circle = { c: { x: 250, y: 250 }, r: 5 };
    expect(circleIntersectsConvex(c, box)).toBe(true);
  });
  it('相切距离判定', () => {
    const c: Circle = { c: { x: 250, y: 180 }, r: 20 }; // 距上边 0
    expect(circleIntersectsConvex(c, box)).toBe(true);
    const far: Circle = { c: { x: 250, y: 150 }, r: 20 }; // 距上边 30
    expect(circleIntersectsConvex(far, box)).toBe(false);
  });
});

describe('楔形几何', () => {
  const light: Circle = { c: { x: 100, y: 300 }, r: 30 };
  const p: Vec2 = { x: 700, y: 300 };

  it('光源楔形半角满足 asin(r/d)', () => {
    const w = lightWedge(p, light)!;
    const d = 600;
    expect(w.half).toBeCloseTo(Math.asin(30 / d), 8);
    expect(w.half).toBeLessThan(Math.PI / 2);
  });

  it('点在光源内时 lightWedge 返回 null', () => {
    expect(lightWedge({ x: 105, y: 300 }, light)).toBeNull();
  });

  it('挡板楔形宽度不超过 π', () => {
    const box = square(350, 200, 60, 200);
    const w = tangentWedge(p, box);
    expect(w.half * 2).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(w.half).toBeGreaterThan(0);
  });

  it('楔形在跨 ±π 方向仍稳定（角度周期 TAU）', () => {
    const light2: Circle = { c: { x: 0, y: 0 }, r: 10 };
    const p2: Vec2 = { x: -100, y: 0 };
    const w = lightWedge(p2, light2)!;
    expect(Number.isFinite(w.mean)).toBe(true);
    expect(w.half).toBeGreaterThan(0);
    expect(w.half).toBeLessThan(TAU / 4);
  });
});
