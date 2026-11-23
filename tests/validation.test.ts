import { describe, expect, it } from 'vitest';
import { getModel, PRESETS } from '../src/core/generators';
import { buildThickenedSolid } from '../src/core/thickening';
import { inspectRegion } from '../src/core/inspection';
import { exportSolidToObj, inspectObjReadback } from '../src/core/obj';
import { runZeroThicknessRegression } from '../src/core/regression';
import { boundaryEdgeTrace, wallReport } from '../src/core/diagnostics';

describe('诊断与侧壁检索', () => {
  it('按侧壁三角形检索到对应的源边与源三角形', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    for (let i = 0; i < solid.sideFaces.length; i += 7) {
      const trace = boundaryEdgeTrace(solid, i);
      expect(trace).not.toBeNull();
      expect(trace!.edge.id).toBe(solid.sideFaces[i].edgeId);
      expect(trace!.edgeLength).toBeCloseTo(model.boundaryEdges[solid.sideFaces[i].edgeId].length, 6);
      expect(trace!.sourceTriangleVertices).toHaveLength(3);
      expect(trace!.sourceTriangleIndices).toContain(trace!.edge.a);
      expect(trace!.sourceTriangleIndices).toContain(trace!.edge.b);
      expect(trace!.endpoints[0].length).toBe(3);
      expect(trace!.offsetEndpoints[0].length).toBe(3);
    }
    expect(boundaryEdgeTrace(solid, -1)).toBeNull();
    expect(boundaryEdgeTrace(solid, solid.sideFaces.length)).toBeNull();
  });

  it('能按问题/正常侧壁分组取回统计', () => {
    const model = getModel('flap');
    const thick = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    const report = wallReport(thick);
    expect(report.problem.length).toBeGreaterThan(0);
    expect(report.normal.length).toBeGreaterThan(0);
    expect(report.problemEdgeIds.size).toBe(report.problem.length);
    expect(report.problemOuter + report.problemHole).toBe(report.problem.length);
    expect(report.normalOuter + report.normalHole).toBe(report.normal.length);
    expect(report.outerEdgeCount + report.holeEdgeCount).toBe(thick.sideWalls.length);
    expect(report.byReason.flipped + report.byReason.intersects + report.byReason.degenerate)
      .toBeGreaterThanOrEqual(report.problem.length);
  });

  it('问题位置可按厚度区间定位: 厚度跨过圆角半径后才开始出错', () => {
    const model = getModel('flap');
    const below = buildThickenedSolid(model, { thickness: 0.14, side: 1 });
    const above = buildThickenedSolid(model, { thickness: 0.2, side: 1 });
    expect(below.validation.valid).toBe(true);
    expect(above.validation.valid).toBe(false);
    // 问题应当从折角圆角附近开始
    const yValues = above.validation.foldedOffsetTriangles.map((issue) => issue.centroid[1]);
    expect(Math.min(...yValues)).toBeLessThan(0.1);
  });

  it('预设覆盖薄/厚两态, 并对无效几何给出明确提示', () => {
    for (const preset of PRESETS) {
      const model = getModel(preset.modelId);
      const solid = buildThickenedSolid(model, { thickness: preset.thickness, side: preset.side });
      expect(solid.validation.valid).toBe(preset.expectValid);
      if (!preset.expectValid) {
        expect(solid.validation.messages.join(' ')).toMatch(/穿插|反折|坍缩/);
      }
    }
  });
});

describe('导出读回复核一致', () => {
  it('有效实体的读回报告与内存报告一致', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.08, side: 1 });
    const { report } = inspectObjReadback(exportSolidToObj(solid, 'bowl'));
    expect(report.topology.eulerCharacteristic).toBe(solid.validation.topology.eulerCharacteristic);
    expect(report.topology.boundaryEdgeCount).toBe(0);
    expect(report.triangleCount).toBe(solid.triangleCount);
    expect(report.bbox!.center.map((v) => Math.round(v * 1000) / 1000))
      .toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it('零厚度导出会被读回标记为未通过', () => {
    const model = getModel('flap');
    const solid = buildThickenedSolid(model, { thickness: 0, side: 1 });
    const { report } = inspectObjReadback(exportSolidToObj(solid, 'flap_zero'));
    expect(report.valid).toBe(false);
    expect(report.messages.length).toBeGreaterThan(0);
  });

  it('回归检查覆盖两侧加厚方向', () => {
    for (const side of [1, -1] as const) {
      const model = getModel('bowl');
      const report = runZeroThicknessRegression(model, { thickness: 0.07, side });
      expect(report.pass).toBe(true);
    }
  });

  it('局部区域检查可以跨两侧加厚', () => {
    const model = getModel('bowl');
    for (const side of [1, -1] as const) {
      const solid = buildThickenedSolid(model, { thickness: 0.05, side });
      const result = inspectRegion(model, solid, { triangles: [100, 101, 102], side });
      expect(result.pairedDistanceMin).toBeCloseTo(0.05, 4);
      expect(result.flippedTriangleCount).toBe(0);
    }
  });
});

describe('加厚侧对称性', () => {
  it('凹侧先于凸侧失效: 折角半径 0.16 决定凹侧阈值', () => {
    const model = getModel('flap');
    const concaveAt016 = buildThickenedSolid(model, { thickness: 0.16, side: 1 });
    const convexAt016 = buildThickenedSolid(model, { thickness: 0.16, side: -1 });
    expect(concaveAt016.validation.valid).toBe(false);
    expect(convexAt016.validation.valid).toBe(true);
    const convexAt06 = buildThickenedSolid(model, { thickness: 0.6, side: -1 });
    expect(convexAt06.validation.valid).toBe(false);
  });
});
