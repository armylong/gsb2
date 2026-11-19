import { describe, expect, it } from 'vitest';
import { Circle, rect } from '../src/core/geometry';
import {
  Scene,
  analyticVisibility,
  pointVisibility,
  rangeFactor,
  sampledVisibility,
} from '../src/core/visibility';
import { buildCases, runVerification } from '../src/core/verifier';
import { makePresets, lightPlacementInvalid, polyPlacementInvalid } from '../src/core/presets';

const light: Circle = { c: { x: 150, y: 300 }, r: 30 };
const base = { light, range: 900, brightness: 1 };
const p = { x: 750, y: 300 };

describe('解析可见度', () => {
  it('无挡板时全亮', () => {
    const scene: Scene = { ...base, polys: [] };
    expect(analyticVisibility(p, scene)).toBeCloseTo(1, 8);
  });

  it('挡板完全罩住光源楔形时全暗', () => {
    const scene: Scene = { ...base, polys: [{ id: 1, verts: rect(420, 180, 90, 240) }] };
    expect(analyticVisibility(p, scene)).toBeCloseTo(0, 6);
  });

  it('挡板偏离视线时保持全亮', () => {
    const scene: Scene = { ...base, polys: [{ id: 1, verts: rect(400, 40, 80, 80) }] };
    expect(analyticVisibility(p, scene)).toBeCloseTo(1, 6);
  });

  it('可见度始终落在 [0,1]', () => {
    const scene: Scene = {
      ...base,
      polys: [
        { id: 1, verts: rect(380, 250, 60, 100) },
        { id: 2, verts: rect(470, 200, 60, 160) },
      ],
    };
    for (let i = 0; i <= 40; i++) {
      const q = { x: 700, y: 120 + i * 12 };
      const v = analyticVisibility(q, scene);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('半径增大 → 同一点半影可见度单调上升（本影变弱）', () => {
    const blocker = { id: 1, verts: rect(400, 230, 70, 140) };
    // 本影边缘点：r=0 时严格被挡（硬值 0），面积光源半径越大越能绕过板沿
    const q = { x: 720, y: 215 };
    const vals = [0, 10, 30, 60, 88].map((r) =>
      analyticVisibility(q, { ...base, light: { c: light.c, r }, polys: [blocker] }),
    );
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - 1e-9);
    }
    // r=0 必须是严格硬值 0
    expect(vals[0]).toBe(0);
    // 大半径时进入半影，严格大于 0
    expect(vals[vals.length - 1]).toBeGreaterThan(0);
  });

  it('点光源 r=0 只产生 0/1，不存在中间灰', () => {
    const blocker = { id: 1, verts: rect(420, 180, 90, 240) };
    const scene: Scene = {
      ...base,
      light: { c: light.c, r: 0 },
      polys: [blocker],
    };
    expect(pointVisibility(p, scene)).toBe(0);
    // 明区点 y=20：视线在板平面 x=420 处高度约 174，高于板上沿 180
    expect(pointVisibility({ x: 750, y: 20 }, scene)).toBe(1);
    // 解析路径在 r=0 时同样退化为 0/1
    const r0 = analyticVisibility(p, scene);
    expect(r0 === 0 || r0 === 1).toBe(true);
  });
});

describe('多挡板合成', () => {
  const a = { id: 1, verts: rect(380, 250, 60, 110) };
  const b = { id: 2, verts: rect(420, 240, 60, 120) };

  it('重叠遮挡取并集：双挡不低于全暗，且不暗于任一单挡', () => {
    const single = analyticVisibility(p, { ...base, polys: [a] });
    const both = analyticVisibility(p, { ...base, polys: [a, b] });
    expect(both).toBeGreaterThanOrEqual(0);
    expect(both).toBeLessThanOrEqual(single + 1e-9);
  });

  it('两块完全重合的挡板与一块结果相同（不重复叠黑）', () => {
    const one = analyticVisibility(p, { ...base, polys: [a] });
    const clone = { id: 2, verts: a.verts.map((q) => ({ ...q })) };
    const two = analyticVisibility(p, { ...base, polys: [a, clone] });
    expect(two).toBeCloseTo(one, 9);
  });
});

describe('分层光线采样核对', () => {
  it('全亮场景光线全部命中', () => {
    const scene: Scene = { ...base, polys: [] };
    const r = sampledVisibility(p, scene, 128);
    expect(r.vis).toBe(1);
    expect(r.hits).toBe(128);
  });

  it('全暗场景光线全部被挡', () => {
    const scene: Scene = { ...base, polys: [{ id: 1, verts: rect(420, 180, 90, 240) }] };
    const r = sampledVisibility(p, scene, 128);
    expect(r.vis).toBe(0);
    expect(r.hits).toBe(0);
  });

  it('采样值在确定性误差界 2/N 内逼近解析值', () => {
    const scene: Scene = { ...base, polys: [{ id: 1, verts: rect(400, 220, 70, 150) }] };
    const exact = analyticVisibility(p, scene);
    for (const n of [64, 128, 256]) {
      const r = sampledVisibility(p, scene, n);
      expect(Math.abs(r.vis - exact)).toBeLessThanOrEqual(2 / n + 1e-12);
      expect(r.deterministicBound).toBeCloseTo(2 / n, 10);
    }
  });

  it('采样误差随光线数下降', () => {
    const scene: Scene = { ...base, polys: [{ id: 1, verts: rect(400, 220, 70, 150) }] };
    const exact = analyticVisibility(p, scene);
    const e64 = Math.abs(sampledVisibility(p, scene, 64).vis - exact);
    const e512 = Math.abs(sampledVisibility(p, scene, 512).vis - exact);
    expect(e512).toBeLessThanOrEqual(e64 + 1e-12);
  });
});

describe('距离衰减', () => {
  it('范围外为 0、过渡单调', () => {
    const scene: Scene = { ...base, range: 400, polys: [] };
    expect(rangeFactor({ x: light.c.x + 100, y: light.c.y }, scene)).toBe(1);
    expect(rangeFactor({ x: light.c.x + 450, y: light.c.y }, scene)).toBe(0);
    const vals: number[] = [];
    for (let d = 300; d <= 400; d += 10) {
      vals.push(rangeFactor({ x: light.c.x + d, y: light.c.y }, scene));
    }
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  });
});

describe('内置核对套件', () => {
  it('全部场景通过且误差界成立', () => {
    const { rows, allPass } = runVerification(256);
    expect(rows).toHaveLength(buildCases().length);
    expect(allPass).toBe(true);
    for (const r of rows) {
      expect(r.analytic).toBeGreaterThanOrEqual(0);
      expect(r.analytic).toBeLessThanOrEqual(1);
      expect(r.actualDiff).toBeLessThanOrEqual(Math.max(r.detBound, r.mc95) + 1e-9);
    }
  });

  it('精确 50% 构造场景解析值在容差内', () => {
    const half = buildCases()[2];
    const v = analyticVisibility(half.point, half.scene);
    expect(Math.abs(v - 0.5)).toBeLessThan(0.02);
  });
});

describe('预设与位置合法性', () => {
  it('三组预设均合法且挡板数 ≤ 8', () => {
    for (const preset of makePresets()) {
      expect(preset.polys.length).toBeGreaterThan(0);
      expect(preset.polys.length).toBeLessThanOrEqual(8);
      expect(lightPlacementInvalid(preset.light, preset.polys)).toBeNull();
    }
  });

  it('检查点标签与实际可见度类别一致，且都在照射范围内', () => {
    for (const preset of makePresets()) {
      const scene: Scene = {
        light: preset.light,
        polys: preset.polys,
        range: preset.range,
        brightness: preset.brightness,
      };
      for (const cp of preset.checkpoints) {
        const vis = analyticVisibility(cp.p, scene);
        const fall = rangeFactor(cp.p, scene);
        expect(fall).toBeGreaterThan(0.5); // 检查点须可被照亮，避免范围外歧义
        if (cp.expect === '全亮') expect(vis).toBeGreaterThan(0.95);
        if (cp.expect === '全暗' || cp.expect === '重叠') expect(vis).toBeLessThan(0.05);
        if (cp.expect === '半影') expect(vis).toBeGreaterThan(0.1);
        if (cp.expect === '半影') expect(vis).toBeLessThan(0.9);
      }
    }
  });

  it('光源进入挡板被拒绝', () => {
    const preset = makePresets()[0];
    const bad: Circle = { c: { x: 435, y: 300 }, r: 10 };
    expect(lightPlacementInvalid(bad, preset.polys)).not.toBeNull();
  });

  it('挡板移动到与光源相交被拒绝，合法移动放行', () => {
    const preset = makePresets()[0];
    const poly = preset.polys[0];
    const moved = poly.verts.map((q) => ({ x: q.x - 200, y: q.y - 100 }));
    expect(polyPlacementInvalid(moved, poly, preset.polys, preset.light)).not.toBeNull();
    const ok = poly.verts.map((q) => ({ x: q.x + 40, y: q.y }));
    expect(polyPlacementInvalid(ok, poly, preset.polys, preset.light)).toBeNull();
  });
});
