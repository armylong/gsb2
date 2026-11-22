import { describe, it, expect } from 'vitest';
import { buildAssembly, buildEdgeStrip, buildSplitSurface } from '../src/core/models';
import { quantizeModel } from '../src/core/quant';
import { analyzeModel } from '../src/core/analyze';
import { buildExport, readImport, verifyImport } from '../src/core/export';
import { parseOBJ } from '../src/core/objParser';
import type { QuantSettings } from '../src/core/types';

const settings = (bits: number, rangeMode: 'global' | 'perChunk' = 'global'): QuantSettings => ({
  bits: { x: bits, y: bits, z: bits },
  rangeMode,
});

describe('导出 / 回读一致性', () => {
  for (const [name, build] of [
    ['分块曲面', buildSplitSurface],
    ['组合件', buildAssembly],
    ['贴边条', buildEdgeStrip],
  ] as const) {
    it(`${name}: 回读探针与全量误差、接缝张开逐位一致`, () => {
      const model = build();
      const analysis = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(7, 'perChunk')));
      const file = buildExport(model, analysis);
      const text = JSON.stringify(file);
      const imp = readImport(text);
      const v = verifyImport(imp, model);

      expect(v.allExact).toBe(true);
      expect(v.probes.length).toBeGreaterThan(0);
      expect(v.probes.every((p) => p.decodeExact && p.errorExact)).toBe(true);
      expect(v.fullComparison).not.toBeNull();
      expect(v.fullComparison!.maxErrorMatch).toBe(true);
      expect(v.fullComparison!.rmsMatch).toBe(true);
      expect(v.fullComparison!.meanMatch).toBe(true);
      expect(v.fullComparison!.seamGapMatch).toBe(true);
      // restoredMaxDiff 是逐轴分量的最大差，必不大于欧氏最大误差且不小于 0
      expect(v.fullComparison!.restoredMaxDiff).toBeGreaterThanOrEqual(0);
      expect(v.fullComparison!.restoredMaxDiff).toBeLessThanOrEqual(analysis.stats.maxError);
      expect(v.checksumEcho.maxError).toBe(analysis.stats.maxError);
    });
  }

  it('global 范围 + 24bit 同样一致', () => {
    const model = buildSplitSurface();
    const analysis = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(24, 'global')));
    const imp = readImport(JSON.stringify(buildExport(model, analysis)));
    const v = verifyImport(imp, model);
    expect(v.allExact).toBe(true);
    expect(v.fullComparison!.maxErrorMatch).toBe(true);
  });

  it('回读模型的顶点数/三角形数与源一致', () => {
    const model = buildAssembly();
    const analysis = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(10)));
    const imp = readImport(JSON.stringify(buildExport(model, analysis)));
    expect(imp.restoredModel.vertexCount).toBe(model.vertexCount);
    expect(imp.restoredModel.triangleCount).toBe(model.triangleCount);
    expect(imp.restoredModel.chunks.length).toBe(model.chunks.length);
  });

  it('非法格式文件被拒绝', () => {
    expect(() => readImport(JSON.stringify({ format: 'nope', version: 1 }))).toThrow();
  });
});

describe('OBJ 解析', () => {
  it('解析分组、负索引、多边形与 v/vt/vn 写法', () => {
    const obj = `# test
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
g lower
f 1/1/1 2/2/1 3/3/1 4/4/1
g upper
f 1 -2 -1
`;
    const model = parseOBJ(obj, 'test.obj');
    expect(model.chunks.length).toBe(2);
    // 解析器按块保留实际引用顶点：lower 用 4 个，upper 用 3 个（v1/v4/v5）
    expect(model.vertexCount).toBe(7);
    // 四边形扇形三角化 = 2 个三角形；三角形面 = 1 个
    expect(model.triangleCount).toBe(3);
    // 负索引: f 1 -2 -1 -> 全局 v1/v4/v5，在 upper 块内重映射为局部 0/1/2
    const upper = model.chunks[1];
    expect([...upper.indices]).toEqual([0, 1, 2]);
    expect([...upper.positions]).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('无分组时整体成块，空文件报错', () => {
    const model = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n');
    expect(model.chunks.length).toBe(1);
    expect(model.triangleCount).toBe(1);
    expect(() => parseOBJ('# nothing\n')).toThrow();
  });
});
