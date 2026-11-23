import { describe, expect, it } from 'vitest';
import { getModel, PRESETS } from '../src/core/generators';
import { buildThickenedSolid } from '../src/core/thickening';
import { inspectRegion } from '../src/core/inspection';
import { exportSolidToObj, inspectObjReadback, parseObj } from '../src/core/obj';
import { runZeroThicknessRegression } from '../src/core/regression';
import { hashMesh } from '../src/core/vec';
import { triangleTriangleIntersection } from '../src/core/geometry';
import type { Vec3 } from '../src/core/types';

const EPS = 1e-9;

describe('边界闭合', () => {
  it('碗形片有外缘和中心孔两条边界', () => {
    const model = getModel('bowl');
    expect(model.boundaries).toHaveLength(2);
    const outer = model.boundaries.find((loop) => loop.kind === 'outer')!;
    const holes = model.boundaries.filter((loop) => loop.kind === 'hole');
    expect(outer).toBeDefined();
    expect(holes).toHaveLength(1);
    // 外缘开口半径约 1.05, 中心孔半径约 0.17
    expect(outer.perimeter).toBeGreaterThan(2 * Math.PI * 1.0);
    expect(holes[0].perimeter).toBeLessThan(2 * Math.PI * 0.2);
  });

  it('薄碗加厚后闭合、流形、欧拉示性数为 0 (双环面)', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    expect(solid.validation.valid).toBe(true);
    expect(solid.validation.topology.closed).toBe(true);
    expect(solid.validation.topology.manifold).toBe(true);
    expect(solid.validation.topology.eulerCharacteristic).toBe(0);
    expect(solid.validation.intersectionTotal).toBe(0);
    expect(solid.volume).toBeGreaterThan(0);
  });

  it('两条边界都生成了侧壁, 且每条侧壁可追溯到源边和源三角形', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    expect(solid.sideWalls).toHaveLength(model.boundaryEdges.length);
    const outerWalls = solid.sideWalls.filter((wall) => wall.loopKind === 'outer');
    const holeWalls = solid.sideWalls.filter((wall) => wall.loopKind === 'hole');
    expect(outerWalls.length).toBeGreaterThan(0);
    expect(holeWalls.length).toBeGreaterThan(0);

    for (let i = 0; i < solid.sideFaces.length; i++) {
      const meta = solid.sideFaces[i];
      const edge = model.boundaryEdges[meta.edgeId];
      expect(edge).toBeDefined();
      expect([edge.a, edge.b]).toEqual([meta.a, meta.b]);
      const tri = model.indices.subarray(meta.sourceTriangle * 3, meta.sourceTriangle * 3 + 3);
      expect(tri).toContain(edge.a);
      expect(tri).toContain(edge.b);
    }
    // 每个边界四边形拆成两个三角形, 每个三角形映射到同一条边
    expect(solid.sideFaces).toHaveLength(model.boundaryEdges.length * 2);
    for (const edge of model.boundaryEdges) {
      const faces = solid.sideFaces.filter((meta) => meta.edgeId === edge.id);
      expect(faces).toHaveLength(2);
    }
  });

  it('中心孔没有被填掉: 孔边界的侧壁仍然存在, 且孔面积 > 0', () => {
    const model = getModel('bowl');
    const hole = model.boundaries.find((loop) => loop.kind === 'hole')!;
    expect(Math.abs(hole.signedArea)).toBeGreaterThan(0.001);
    const solid = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    const holeEdges = model.boundaryEdges.filter((edge) => edge.loopId === hole.id);
    expect(holeEdges.length).toBe(hole.vertices.length);
    for (const edge of holeEdges) {
      expect(solid.sideWalls.some((wall) => wall.edgeId === edge.id)).toBe(true);
    }
  });
});

describe('加厚参数', () => {
  it('两侧加厚都保持闭合且绕序朝外', () => {
    const model = getModel('bowl');
    for (const side of [1, -1] as const) {
      const solid = buildThickenedSolid(model, { thickness: 0.055, side });
      expect(solid.validation.topology.closed).toBe(true);
      expect(solid.validation.topology.orientationPositive).toBe(true);
      expect(solid.volume).toBeGreaterThan(0);
      expect(solid.validation.topology.eulerCharacteristic).toBe(0);
    }
  });

  it('体积随厚度单调增加', () => {
    const model = getModel('bowl');
    const volumes = [0.02, 0.05, 0.1, 0.15].map(
      (thickness) => buildThickenedSolid(model, { thickness, side: 1 }).volume,
    );
    for (let i = 1; i < volumes.length; i++) expect(volumes[i]).toBeGreaterThan(volumes[i - 1]);
    // 薄壳体积应接近 曲面面积 * 厚度
    const thin = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    let area = 0;
    for (let t = 0; t < model.indices.length; t += 3) {
      const ia = model.indices[t];
      const ib = model.indices[t + 1];
      const ic = model.indices[t + 2];
      const a: Vec3 = [model.positions[ia * 3], model.positions[ia * 3 + 1], model.positions[ia * 3 + 2]];
      const b: Vec3 = [model.positions[ib * 3], model.positions[ib * 3 + 1], model.positions[ib * 3 + 2]];
      const c: Vec3 = [model.positions[ic * 3], model.positions[ic * 3 + 1], model.positions[ic * 3 + 2]];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = ab[1] * ac[2] - ab[2] * ac[1];
      const ny = ab[2] * ac[0] - ab[0] * ac[2];
      const nz = ab[0] * ac[1] - ab[1] * ac[0];
      area += Math.hypot(nx, ny, nz) / 2;
    }
    expect(Math.abs(thin.volume - area * 0.055) / thin.volume).toBeLessThan(0.15);
  });
});

describe('凹角过厚', () => {
  it('薄折片有效, 厚折片在凹转角处报出反折和穿插', () => {
    const model = getModel('flap');
    const thin = buildThickenedSolid(model, { thickness: 0.045, side: 1 });
    expect(thin.validation.valid).toBe(true);
    expect(thin.validation.foldedOffsetTriangles).toHaveLength(0);

    const thick = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    expect(thick.validation.valid).toBe(false);
    expect(thick.validation.foldedOffsetTriangles.length).toBeGreaterThan(0);
    expect(thick.validation.intersectionTotal).toBeGreaterThan(0);
    expect(thick.validation.intersectionCounts.offsetOffset).toBeGreaterThan(0);
    expect(thick.validation.problemSourceTriangles.size).toBeGreaterThan(0);
    expect(thick.validation.problemSideEdges.size).toBeGreaterThan(0);
  });

  it('出问题位置集中在折角附近 (y 接近 0 的圆角段)', () => {
    const model = getModel('flap');
    const thick = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    const folded = thick.validation.foldedOffsetTriangles;
    const nearCrease = folded.filter((issue) => issue.centroid[2] > 0.02).length;
    expect(nearCrease / folded.length).toBeGreaterThan(0.5);
  });

  it('问题侧壁与正常侧壁是分开标记的', () => {
    const model = getModel('flap');
    const thick = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    const problem = thick.sideWalls.filter((wall) => wall.problem);
    const ok = thick.sideWalls.filter((wall) => !wall.problem);
    expect(problem.length).toBeGreaterThan(0);
    expect(ok.length).toBeGreaterThan(0);
    expect(thick.validation.problemSideEdges.size).toBe(problem.filter((w) => w.flipped || w.intersects).length
      + thick.sideWalls.filter((w) => w.problem && !w.flipped && !w.intersects && w.degenerate).length);
  });
});

describe('厚度归零回归', () => {
  it('厚度 0 -> 原厚度 不改变源网格', () => {
    for (const id of ['bowl', 'flap'] as const) {
      const model = getModel(id);
      const before = hashMesh(model.positions, model.indices);
      const report = runZeroThicknessRegression(model, { thickness: model.defaultThickness, side: 1 });
      expect(report.pass).toBe(true);
      expect(hashMesh(model.positions, model.indices)).toBe(before);
      expect(hashMesh(model.positions, model.indices)).toBe(model.sourceHash);
      expect(report.sourceLayerVertexMaxDelta).toBeLessThan(EPS);
      expect(report.restoredTriangleCount).toBe(report.referenceTriangleCount);
    }
  });

  it('厚度为 0 时实体退化但原始层仍与源网格一致', () => {
    const model = getModel('flap');
    const solid = buildThickenedSolid(model, { thickness: 0, side: 1 });
    expect(solid.degenerate).toBe(true);
    expect(solid.validation.valid).toBe(false);
    const base = solid.positions.subarray(0, model.positions.length);
    expect(base).toEqual(model.positions);
    expect(solid.validation.messages.some((m) => m.includes('厚度为 0'))).toBe(true);
  });
});

describe('局部区域检查', () => {
  it('薄壳区域实测厚度接近名义厚度', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    const region = Array.from({ length: 20 }, (_, i) => 400 + i);
    const result = inspectRegion(model, solid, { triangles: region, side: 1 });
    expect(result.triangleCount).toBe(20);
    expect(result.pairedDistanceMin).toBeCloseTo(0.055, 4);
    expect(result.pairedDistanceMax).toBeCloseTo(0.055, 4);
    expect(result.measuredMean).toBeGreaterThan(0.04);
    expect(result.measuredMean).toBeLessThan(0.07);
    expect(result.meanNormalDeviationDeg).toBeLessThan(15);
    expect(result.sampleGaps.length).toBeGreaterThan(0);
  });

  it('凹角过厚区域的法线偏差和折叠三角形被报出', () => {
    const model = getModel('flap');
    const thick = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    const folded = thick.validation.foldedOffsetTriangles.slice(0, 10).map((i) => i.sourceTriangle);
    const result = inspectRegion(model, thick, { triangles: folded, side: 1 });
    expect(result.flippedTriangleCount).toBe(10);
    expect(result.maxNormalDeviationDeg).toBeGreaterThan(90);
    expect(result.problemTriangleCount).toBeGreaterThan(0);
  });

  it('区域检查不改动实体或源网格', () => {
    const model = getModel('flap');
    const solid = buildThickenedSolid(model, { thickness: 0.1, side: 1 });
    const before = hashMesh(solid.positions, solid.originalIndices);
    const sourceBefore = hashMesh(model.positions, model.indices);
    inspectRegion(model, solid, { triangles: [0, 1, 2, 3], side: 1 });
    expect(hashMesh(solid.positions, solid.originalIndices)).toBe(before);
    expect(hashMesh(model.positions, model.indices)).toBe(sourceBefore);
  });
});

describe('OBJ 导出与读回', () => {
  it('有效实体导出后读回仍闭合、流形、无自相交, 分组齐全', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.055, side: 1 });
    const text = exportSolidToObj(solid, 'bowl_solid');
    expect(text).toContain('g original_layer');
    expect(text).toContain('g offset_layer');
    expect(text).toContain('g side_wall_outer');
    expect(text).toContain('g side_wall_hole_1');
    const { report } = inspectObjReadback(text);
    expect(report.vertexCount).toBe(solid.vertexCount);
    expect(report.triangleCount).toBe(solid.triangleCount);
    expect(report.topology.closed).toBe(true);
    expect(report.topology.manifold).toBe(true);
    expect(report.topology.eulerCharacteristic).toBe(0);
    expect(report.intersectionPairs).toBe(0);
    expect(report.valid).toBe(true);
    expect(report.groups).toContain('original_layer');
    expect(report.groups).toContain('side_wall_hole_1');
  });

  it('无效几何导出后读回复现问题, 且带问题分组', () => {
    const model = getModel('flap');
    const solid = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    expect(solid.validation.valid).toBe(false);
    const text = exportSolidToObj(solid, 'flap_solid');
    expect(text).toContain('g side_wall_problem');
    const { report } = inspectObjReadback(text);
    expect(report.valid).toBe(false);
    expect(report.intersectionPairs).toBeGreaterThan(0);
    expect(report.messages.some((m) => m.includes('自相交'))).toBe(true);
  });

  it('解析器支持负索引和 v/vt/vn 形式', () => {
    const text = [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'f 1/1/1 2/1/1 3/1/1',
      'f -3 -2 -1',
    ].join('\n');
    const scene = parseObj(text);
    expect(scene.indices.length).toBe(6);
    expect(Array.from(scene.indices)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('非法 OBJ 抛出明确错误', () => {
    expect(() => parseObj('v 0 0 0\nf 1 2 3')).toThrow(/越界/);
    expect(() => parseObj('v 0 0 0')).toThrow(/没有面/);
    expect(() => parseObj('v a b c\nf 1 2 3')).toThrow(/不是有效数字/);
  });
});

describe('三角形相交判定', () => {
  const t = (points: Vec3[]): [Vec3, Vec3, Vec3] => [points[0], points[1], points[2]];

  it('分离三角形不相交', () => {
    const A = t([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const B = t([[0, 0, 1], [1, 0, 1], [0, 1, 1]]);
    expect(triangleTriangleIntersection(A, B)).toBeNull();
  });

  it('穿插三角形相交', () => {
    const A = t([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const B = t([[0.2, 0.2, -1], [0.2, 0.2, 1], [0.6, 0.2, -1]]);
    expect(triangleTriangleIntersection(A, B)).not.toBeNull();
  });

  it('仅共享顶点不算穿插', () => {
    const A = t([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const B = t([[0, 0, 0], [-1, 0, 1], [0, -1, 1]]);
    expect(triangleTriangleIntersection(A, B)).toBeNull();
  });

  it('共面重叠被识别为穿插, 仅共边不算', () => {
    const A = t([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const overlap = t([[0.1, 0.1, 0], [0.5, 0.1, 0], [0.1, 0.5, 0]]);
    expect(triangleTriangleIntersection(A, overlap)).not.toBeNull();
    const sharedEdge = t([[1, 0, 0], [0, 1, 0], [1, 1, 0]]);
    expect(triangleTriangleIntersection(A, sharedEdge)).toBeNull();
  });
});

describe('预设', () => {
  it('内置一组边界闭合和一组凹角过厚的验证参数, 结果与预期一致', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(2);
    expect(PRESETS.filter((preset) => preset.expectValid).length).toBeGreaterThanOrEqual(1);
    expect(PRESETS.filter((preset) => !preset.expectValid).length).toBeGreaterThanOrEqual(1);
    for (const preset of PRESETS) {
      const model = getModel(preset.modelId);
      const solid = buildThickenedSolid(model, { thickness: preset.thickness, side: preset.side });
      expect(solid.validation.valid).toBe(preset.expectValid);
    }
  });
});

describe('预设自检', () => {
  it('全部预设与预期一致', async () => {
    const { runPresetCheck } = await import('../src/core/presets');
    const report = runPresetCheck();
    expect(report.pass).toBe(true);
    for (const result of report.results) {
      if (result.preset.expectValid) {
        expect(result.closed).toBe(true);
        expect(result.manifold).toBe(true);
        expect(result.foldedTriangles).toBe(0);
        expect(result.intersectionTotal).toBe(0);
      } else {
        expect(result.foldedTriangles + result.intersectionTotal).toBeGreaterThan(0);
        expect(result.summary).toBeTruthy();
      }
    }
  });
});
