/**
 * 关键验证：切片与网格对照。
 * 同一坐标上，网格∩切片 的交线 与 场值等值线（marching squares）应一致，
 * 偏差尺度不超过一个网格间距 h。
 */
import { describe, it, expect } from 'vitest';
import { getSample, sampleGrid, sampleTrilinear } from '../src/field';
import { extractIsosurface } from '../src/marchingTets';
import { intersectMeshPlane } from '../src/sliceIntersect';
import { marchingSquares, type Segment2 } from '../src/marchingSquares';

const N = 48;
const grid = sampleGrid(getSample('single'), N);
const mesh = extractIsosurface(grid, 0);
const h = grid.h;

function pointToSegDist(px: number, py: number, s: Segment2): number {
  const dx = s.bu - s.au;
  const dy = s.bv - s.av;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - s.au) * dx + (py - s.av) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.au + t * dx), py - (s.av + t * dy));
}

describe('网格 ∩ 切片（z=0 平面）', () => {
  const segs = intersectMeshPlane(mesh, 'z', 0);

  it('产生交线段', () => {
    expect(segs.length).toBeGreaterThan(20);
  });

  it('所有交点位于切片平面上', () => {
    for (const s of segs) {
      expect(Math.abs(s.az)).toBeLessThan(1e-5);
      expect(Math.abs(s.bz)).toBeLessThan(1e-5);
    }
  });

  it('交线半径 ≈ 球半径 5（误差 < h）', () => {
    for (let i = 0; i < segs.length; i += 3) {
      const s = segs[i];
      expect(Math.abs(Math.hypot(s.ax, s.ay) - 5)).toBeLessThan(h);
      expect(Math.abs(Math.hypot(s.bx, s.by) - 5)).toBeLessThan(h);
    }
  });

  it('交线总长 ≈ 圆周 2πr（10% 以内）', () => {
    let total = 0;
    for (const s of segs) total += Math.hypot(s.bx - s.ax, s.by - s.ay, s.bz - s.az);
    const exact = 2 * Math.PI * 5;
    expect(Math.abs(total - exact) / exact).toBeLessThan(0.1);
  });
});

describe('网格交线 vs 场值等值线（同一切片对照）', () => {
  // 在 z=0 切片上用三线性插值采样场，marching squares 提取 iso=0 等值线
  const S = 128;
  const vals = new Float32Array(S * S);
  for (let r = 0; r < S; r++) {
    const y = 10 - ((r + 0.5) / S) * 20;
    for (let c = 0; c < S; c++) {
      const x = -10 + ((c + 0.5) / S) * 20;
      vals[c + S * r] = sampleTrilinear(grid, x, y, 0);
    }
  }
  const contour = marchingSquares(vals, S, S, -10, 10, -10, 10, 0);
  const meshSegs = intersectMeshPlane(mesh, 'z', 0);

  it('场值等值线存在且半径 ≈ 5', () => {
    expect(contour.length).toBeGreaterThan(20);
    for (let i = 0; i < contour.length; i += 5) {
      const s = contour[i];
      expect(Math.abs(Math.hypot(s.au, s.av) - 5)).toBeLessThan(h);
    }
  });

  it('网格交线上的点到场值等值线的距离 < h（误差尺度依据）', () => {
    let maxDist = 0;
    for (const s of meshSegs) {
      const mx = (s.ax + s.bx) / 2;
      const my = (s.ay + s.by) / 2;
      let minD = Infinity;
      for (const c of contour) minD = Math.min(minD, pointToSegDist(mx, my, c));
      maxDist = Math.max(maxDist, minD);
    }
    expect(maxDist).toBeLessThan(h);
  });
});

describe('marching squares 自校验', () => {
  it('解析场 x²+y²−25 的 iso=0 等值线半径 ≈ 5', () => {
    const S = 64;
    const vals = new Float32Array(S * S);
    for (let r = 0; r < S; r++) {
      const y = -10 + (r / (S - 1)) * 20;
      for (let c = 0; c < S; c++) {
        const x = -10 + (c / (S - 1)) * 20;
        vals[c + S * r] = x * x + y * y - 25;
      }
    }
    const segs = marchingSquares(vals, S, S, -10, 10, -10, 10, 0);
    expect(segs.length).toBeGreaterThan(10);
    const hh = 20 / (S - 1);
    for (const s of segs) {
      expect(Math.abs(Math.hypot(s.au, s.av) - 5)).toBeLessThan(hh);
      expect(Math.abs(Math.hypot(s.bu, s.bv) - 5)).toBeLessThan(hh);
    }
  });
});
