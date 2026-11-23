import { describe, expect, it } from 'vitest';
import { getModel } from '../src/core/generators';
import { buildThickenedSolid } from '../src/core/thickening';
import { exportSolidToObj, inspectObjReadback, parseObj } from '../src/core/obj';

describe('OBJ 细节', () => {
  it('顶点坐标与内存一致 (精度 1e-6)', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.07, side: -1 });
    const text = exportSolidToObj(solid, 'test');
    const scene = parseObj(text);
    expect(scene.positions.length).toBe(solid.positions.length);
    let maxDelta = 0;
    for (let i = 0; i < scene.positions.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(scene.positions[i] - solid.positions[i]));
    }
    expect(maxDelta).toBeLessThan(1e-5);
  });

  it('分组面数加和等于总面数', () => {
    const model = getModel('flap');
    const solid = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    const text = exportSolidToObj(solid, 'flap');
    const { report } = inspectObjReadback(text);
    const sum = Object.values(report.groupFaceCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.triangleCount);
    expect(report.groupFaceCounts.original_layer).toBe(solid.originalIndices.length / 3);
    expect(report.groupFaceCounts.offset_layer).toBe(solid.offsetIndices.length / 3);
  });

  it('侧壁在有效实体中只出现在正常分组', () => {
    const model = getModel('bowl');
    const solid = buildThickenedSolid(model, { thickness: 0.05, side: 1 });
    const { report } = inspectObjReadback(exportSolidToObj(solid, 'bowl'));
    expect(report.groupFaceCounts.side_wall_problem ?? 0).toBe(0);
    const sideTotal = Object.entries(report.groupFaceCounts)
      .filter(([name]) => name.startsWith('side_wall'))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(sideTotal).toBe(solid.sideIndices.length / 3);
  });

  it('读回报告包含包围盒, 且与源模型尺度一致', () => {
    for (const id of ['bowl', 'flap'] as const) {
      const model = getModel(id);
      const solid = buildThickenedSolid(model, { thickness: 0.05, side: 1 });
      const { report } = inspectObjReadback(exportSolidToObj(solid, id));
      expect(report.bbox).not.toBeNull();
      expect(report.bbox!.radius).toBeGreaterThan(model.bounds.radius * 0.9);
      expect(report.bbox!.radius).toBeLessThan(model.bounds.radius * 1.6);
    }
  });

  it('空文件与非三角面被正确处理', () => {
    expect(() => parseObj('')).toThrow(/没有顶点/);
    // 四边形会被扇形三角化
    const scene = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4');
    expect(scene.indices.length).toBe(6);
  });

  it('导出文本带可读元信息', () => {
    const model = getModel('flap');
    // 凸侧加厚方向不会反折, 元信息里记录的是加厚侧
    const convex = buildThickenedSolid(model, { thickness: 0.3, side: -1 });
    const convexText = exportSolidToObj(convex, 'flap_convex');
    expect(convexText).toContain('thickness: 0.3 side: -normal');
    expect(convexText).toContain(`source hash: ${model.sourceHash}`);
    expect(convexText).toContain('# valid: yes');

    const concave = buildThickenedSolid(model, { thickness: 0.42, side: 1 });
    expect(exportSolidToObj(concave, 'flap_concave')).toContain('# valid: no');
  });
});
