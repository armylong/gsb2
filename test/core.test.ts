import { describe, it, expect } from 'vitest';
import { runAllChecks } from '../src/core/verify';
import { PolyPath } from '../src/core/path';
import { planDashes } from '../src/core/dash';
import { buildStrokeMesh } from '../src/core/mesh';
import { DEFAULT_STROKE } from '../src/core/types';
import { Vec2 } from '../src/core/math2d';

describe('可重复验证套件（与页面验证面板同源）', () => {
  it('全部检查通过', () => {
    const results = runAllChecks();
    for (const r of results) {
      expect(r.pass, `${r.name}\n预期: ${r.expected}\n实测: ${r.measured}`).toBe(true);
    }
  });
});

describe('虚线节奏', () => {
  const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }];

  it('按累计弧长连续排列，跨顶点不重置', () => {
    const path = new PolyPath(pts, false);
    const iv = planDashes(path, { dashed: true, dashLength: 2, gapLength: 1, offset: 0 });
    expect(iv.map((d) => [d.u0, d.u1])).toEqual([[0, 2], [3, 5], [6, 7]]);
  });

  it('offset 平移整条节奏', () => {
    const path = new PolyPath(pts, false);
    const iv = planDashes(path, { dashed: true, dashLength: 2, gapLength: 1, offset: 0.5 });
    expect(iv[0]).toMatchObject({ u0: 0, u1: 1.5 });
    expect(iv[1]).toMatchObject({ u0: 2.5, u1: 4.5 });
  });

  it('闭合路径首段可跨接缝且回绕采样一致', () => {
    const rect: Vec2[] = [{ x: -3, y: -2 }, { x: 3, y: -2 }, { x: 3, y: 2 }, { x: -3, y: 2 }];
    const path = new PolyPath(rect, true);
    expect(path.totalLength).toBeCloseTo(20, 9);
    const iv = planDashes(path, { dashed: true, dashLength: 2, gapLength: 1, offset: 0.5 });
    expect(iv[0].u0).toBeCloseTo(-0.5, 9);
    expect(iv[0].u1).toBeCloseTo(1.5, 9);
    const a = path.sampleAt(iv[0].u0).point;
    const b = path.sampleAt(path.totalLength + iv[0].u0).point;
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.y).toBeCloseTo(b.y, 9);
  });
});

describe('尖角限制', () => {
  // 尖角 V 形：偏转 136.4°，外角 θ=43.6°，标准 ratio=1/sin(θ/2)≈2.693
  const pts: Vec2[] = [{ x: -4, y: 2 }, { x: 1, y: 0 }, { x: -4, y: -2 }];
  const ratioExpected = 1 / Math.sin((Math.PI - Math.acos(-21 / 29)) / 2);

  it('小夹角在低限制下降级为 bevel，高限制保持 miter', () => {
    const bevel = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1, join: 'miter', miterLimit: 1.5 },
      { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    const miter = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1, join: 'miter', miterLimit: 4 },
      { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    expect(bevel.mesh?.joins[0].effective).toBe('bevel');
    expect(miter.mesh?.joins[0].effective).toBe('miter');
    expect(miter.mesh?.joins[0].miterRatio).toBeCloseTo(ratioExpected, 6);
  });

  it('标准直角的 miter 比值为 √2', () => {
    const right: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];
    const r = buildStrokeMesh(right, false, { ...DEFAULT_STROKE, width: 1, join: 'miter', miterLimit: 10 },
      { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    expect(r.mesh?.joins[0].miterRatio).toBeCloseTo(Math.SQRT2, 6);
  });

  it('连续扫过限制边界时网格始终有限', () => {
    for (let lim = 0.5; lim <= 4; lim += 0.1) {
      const r = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1, join: 'miter', miterLimit: lim },
        { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
      expect(r.mesh).not.toBeNull();
      for (const x of r.mesh!.positions) expect(Number.isFinite(x)).toBe(true);
    }
  });

  it('极尖锐角（近乎折返）在默认限制下被削平且不产生长刺', () => {
    // 近乎 180° 折返：外角 θ≈0，标准 miter 趋于无穷
    const spike: Vec2[] = [{ x: -2, y: 0 }, { x: 0, y: 0.01 }, { x: -2, y: 0.2 }];
    const r = buildStrokeMesh(spike, false, { ...DEFAULT_STROKE, width: 1, join: 'miter', miterLimit: 4 },
      { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    expect(r.mesh?.joins[0].effective).toBe('bevel');
    for (const x of r.mesh!.positions) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Math.abs(x)).toBeLessThan(50);
    }
  });
});

describe('端帽范围', () => {
  const pts: Vec2[] = [{ x: -4, y: 0 }, { x: 4, y: 0 }];
  const bbox = (positions: Float32Array) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
      minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    }
    return { minX, maxX, minY, maxY };
  };

  it('平头不延伸，方头/圆头延伸半个宽度', () => {
    for (const [cap, xMin, xMax] of [['butt', -4, 4], ['square', -4.5, 4.5], ['round', -4.5, 4.5]] as const) {
      const r = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1, cap },
        { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
      const b = bbox(r.mesh!.positions);
      expect(b.minX).toBeCloseTo(xMin, 6);
      expect(b.maxX).toBeCloseTo(xMax, 6);
      expect(b.minY).toBeCloseTo(-0.5, 6);
      expect(b.maxY).toBeCloseTo(0.5, 6);
    }
  });
});

describe('闭合与重复点', () => {
  it('闭合实线只有整圈区间，转角数等于顶点数，无端帽点', () => {
    const rect: Vec2[] = [{ x: -3, y: -2 }, { x: 3, y: -2 }, { x: 3, y: 2 }, { x: -3, y: 2 }];
    const r = buildStrokeMesh(rect, true, DEFAULT_STROKE, { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    expect(r.mesh?.intervalCount).toBe(1);
    expect(r.mesh?.joins.length).toBe(4);
    expect(r.mesh?.polygons[0].length).toBe(8);
  });

  it('连续重复点被去重且网格有效', () => {
    const pts: Vec2[] = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 },
      { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 },
    ];
    const path = new PolyPath(pts, false);
    expect(path.points.length).toBe(3);
    const r = buildStrokeMesh(pts, false, DEFAULT_STROKE, { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    expect(r.mesh).not.toBeNull();
    expect(r.mesh!.triangleCount).toBeGreaterThan(0);
  });

  it('少于两个点时不生成网格但不抛错', () => {
    const r = buildStrokeMesh([{ x: 0, y: 0 }], false, DEFAULT_STROKE,
      { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    expect(r.mesh).toBeNull();
  });
});
