import { describe, expect, it } from 'vitest';
import {
  type OBB,
  makeOBB,
  obbDistance,
  rotAxis,
  satOBB,
  segmentSegment,
  sub,
  length,
} from '../src/core/math3d';

describe('SAT / OBB 基础', () => {
  it('轴对齐盒子: 分离时给出正净距', () => {
    const a = makeOBB([0, 0, 0], [10, 10, 10]);
    const b = makeOBB([20, 0, 0], [10, 10, 10]);
    const r = satOBB(a, b);
    expect(r.contact).toBe(false);
    expect(r.depth).toBeCloseTo(-10, 6);
    expect(obbDistance(a, b)).toBeCloseTo(10, 6);
  });

  it('轴对齐盒子: 重叠时 depth 为侵入量', () => {
    const a = makeOBB([0, 0, 0], [10, 10, 10]);
    const b = makeOBB([8, 0, 0], [10, 10, 10]);
    const r = satOBB(a, b);
    expect(r.contact).toBe(true);
    expect(r.depth).toBeCloseTo(2, 6);
  });

  it('接触容差内判为贴边接触', () => {
    const a = makeOBB([0, 0, 0], [10, 10, 10]);
    const b = makeOBB([10.4, 0, 0], [10, 10, 10]); // 净距 0.4
    expect(satOBB(a, b, 1).contact).toBe(true);
    expect(satOBB(a, b, 0.1).contact).toBe(false);
  });

  it('旋转 45° 的盒子与静止盒子正确碰撞', () => {
    const a = makeOBB([0, 0, 0], [10, 10, 10]);
    const rot = rotAxis([0, 1, 0], Math.PI / 4);
    const b: OBB = {
      center: [12, 0, 0],
      half: [5, 5, 5],
      axes: [
        [rot[0], rot[3], rot[6]],
        [rot[1], rot[4], rot[7]],
        [rot[2], rot[5], rot[8]],
      ],
    };
    // b 中心距 12, 旋转后沿世界 x 的半宽 = 5*(cos45+sin45) ≈ 7.07, 必然重叠
    const r = satOBB(a, b);
    expect(r.contact).toBe(true);
    expect(r.depth).toBeGreaterThan(0);
  });

  it('法线方向由 A 指向 B', () => {
    const a = makeOBB([0, 0, 0], [10, 10, 10]);
    const b = makeOBB([8, 0, 0], [10, 10, 10]);
    const r = satOBB(a, b);
    expect(r.normal[0]).toBeGreaterThan(0);
  });

  it('线段最近距离', () => {
    // 两线在 (5,0,0) 与 (5,5,0) 处取得最近点, 间距 5
    const r = segmentSegment(
      { a: [0, 0, 0], b: [10, 0, 0], dirAxis: 0 },
      { a: [5, 5, 0], b: [5, 10, 0], dirAxis: 1 },
    );
    expect(r.dist).toBeCloseTo(5, 6);
    expect(length(sub(r.pb, r.pa))).toBeCloseTo(5, 6);
    // 相交线段距离为 0
    const hit = segmentSegment(
      { a: [0, 0, 0], b: [10, 0, 0], dirAxis: 0 },
      { a: [5, 0, 0], b: [5, 10, 0], dirAxis: 1 },
    );
    expect(hit.dist).toBeCloseTo(0, 6);
  });
});
