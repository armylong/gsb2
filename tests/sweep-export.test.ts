import { describe, expect, it } from 'vitest';
import { getScenario } from '../src/core/scenarios';
import { computeEnvelope, extractContours, sampleOBBsByPart } from '../src/core/sweep';
import { buildCollisionCSV, buildPlanSVG } from '../src/core/export';
import { scanCollisions } from '../src/core/collision';

describe('扫掠包络', () => {
  const s = getScenario('mid-collision');
  it('区间收紧后包络包围盒随之收紧', () => {
    const wide = sampleOBBsByPart(s.mechanism, [0, 1], 100);
    const tight = sampleOBBsByPart(s.mechanism, [0, 0.3], 100);
    const maxX = (obbs: { center: number[] }[]) => Math.max(...obbs.map((o) => o.center[0] + 500));
    const wideRaster = computeEnvelope(wide.door, 'top', 5, 8);
    const tightRaster = computeEnvelope(tight.door, 'top', 5, 8);
    expect(wideRaster.bounds.maxX).toBeGreaterThan(tightRaster.bounds.maxX);
    expect(maxX(wide.door)).toBeGreaterThan(maxX(tight.door));
  });

  it('marching squares 至少提取出一个闭合轮廓', () => {
    const obbs = sampleOBBsByPart(s.mechanism, [0, 1], 80);
    const raster = computeEnvelope(obbs.door, 'top', 4, 8);
    const polys = extractContours(raster);
    expect(polys.length).toBeGreaterThan(0);
    expect(polys[0].points.length).toBeGreaterThanOrEqual(3);
  });

  it('俯视与侧视都能生成栅格', () => {
    const obbs = sampleOBBsByPart(s.mechanism, [0, 1], 40);
    expect(computeEnvelope(obbs.tray, 'top', 6, 8).cols).toBeGreaterThan(0);
    expect(computeEnvelope(obbs.tray, 'side', 6, 8).rows).toBeGreaterThan(0);
  });

  it('区间收紧后托板包络同样立即收紧', () => {
    const wide = sampleOBBsByPart(s.mechanism, [0, 1], 80);
    const tight = sampleOBBsByPart(s.mechanism, [0, 0.2], 80);
    const rw = computeEnvelope(wide.tray, 'side', 6, 8);
    const rt = computeEnvelope(tight.tray, 'side', 6, 8);
    const spanW = rw.bounds.maxY - rw.bounds.minY;
    const spanT = rt.bounds.maxY - rt.bounds.minY;
    expect(spanT).toBeLessThan(spanW);
  });

  it('采样数变化不改变包络的整体包围方向 (单调可复现)', () => {
    const a = sampleOBBsByPart(s.mechanism, [0, 1], 30);
    const b = sampleOBBsByPart(s.mechanism, [0, 1], 90);
    const ra = computeEnvelope(a.door, 'top', 8, 8);
    const rb = computeEnvelope(b.door, 'top', 8, 8);
    expect(Math.abs(ra.bounds.maxX - rb.bounds.maxX)).toBeLessThan(15);
    expect(Math.abs(ra.bounds.maxY - rb.bounds.maxY)).toBeLessThan(15);
  });
});

describe('SVG / CSV 导出', () => {
  const s = getScenario('mid-collision');
  const scan = scanCollisions(s.mechanism, s.obstacles, { range: [0, 1], steps: 600 });

  it('SVG 是良构 XML 片段且包含尺寸/比例尺/扫掠元素', () => {
    const svg = buildPlanSVG({
      mechanism: s.mechanism,
      obstacles: s.obstacles,
      plane: 'top',
      range: [0, 1],
      title: '测试俯视图',
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('100 mm 比例尺');
    expect(svg).toContain('门板扫掠范围');
    expect(svg).toContain('托板扫掠范围');
    expect(svg).toContain('<polygon');
    // 标签被转义
    expect(svg).not.toContain('&amp;amp;');
  });

  it('侧视 SVG 同样可生成', () => {
    const svg = buildPlanSVG({
      mechanism: s.mechanism,
      obstacles: s.obstacles,
      plane: 'side',
      range: [0.2, 0.8],
      title: '测试侧视图',
    });
    expect(svg).toContain('侧视');
    expect(svg).toContain('0.2000');
  });

  it('CSV 包含表头、元信息和每条碰撞事件', () => {
    const csv = buildCollisionCSV({
      events: scan.events,
      mechanism: s.mechanism,
      range: [0, 1],
    });
    expect(csv).toContain('首次接触t');
    expect(csv).toContain('检查区间');
    const dataRows = csv
      .split('\r\n')
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('﻿') && !l.startsWith('序号'));
    expect(dataRows.length).toBe(scan.events.length);
  });

  it('无碰撞场景导出空清单但保留表头', () => {
    const clear = getScenario('clear');
    const empty = scanCollisions(clear.mechanism, clear.obstacles, { range: [0, 1] });
    const csv = buildCollisionCSV({ events: empty.events, mechanism: clear.mechanism, range: [0, 1] });
    expect(csv).toContain('序号');
    expect(csv).not.toContain('桌板,门板');
  });
});
