import { describe, it, expect } from 'vitest';
import { BUILTIN_MODELS } from '../src/core/models';
import { quantizeModel } from '../src/core/quant';
import { analyzeModel } from '../src/core/analyze';
import { buildExport, readImport, verifyImport } from '../src/core/export';
import { parseOBJ } from '../src/core/objParser';

describe('端到端冒烟：三种内置模型 × 两种范围模式 × 多档精度', () => {
  for (const built of BUILTIN_MODELS) {
    for (const rangeMode of ['global', 'perChunk'] as const) {
      for (const bits of [3, 8, 16, 24]) {
        it(`${built.label} / ${rangeMode} / ${bits}bit 全链路`, () => {
          const model = built.build();
          const analysis = analyzeModel(
            model,
            quantizeModel(model.chunks, model.bbox, { bits: { x: bits, y: bits, z: bits }, rangeMode }),
          );
          // 面板数据完整性
          expect(analysis.stats.maxError).toBeGreaterThanOrEqual(0);
          expect(analysis.nominalBits).toBeGreaterThan(0);
          expect(analysis.effectiveBits).toBeLessThanOrEqual(analysis.nominalBits);
          for (const ch of analysis.quant.chunks) {
            for (const meta of ch.axes) {
              expect(meta.effectiveBits).toBeLessThanOrEqual(meta.bits);
              if (!meta.flat) expect(meta.step).toBeGreaterThan(0);
            }
          }
          // 导出 -> 回读 -> 校验
          const file = buildExport(model, analysis);
          const imp = readImport(JSON.stringify(file));
          const v = verifyImport(imp, model);
          expect(v.allExact).toBe(true);
          expect(v.fullComparison!.maxErrorMatch).toBe(true);
          expect(v.fullComparison!.rmsMatch).toBe(true);
          expect(v.fullComparison!.seamGapMatch).toBe(true);
        });
      }
    }
  }
});

describe('OBJ 全链路', () => {
  it('多块 OBJ 量化并回读一致', () => {
    const obj = ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'o a', 'f 1 2 3', 'v 0 0 1', 'v 1 0 1', 'v 1 1 1', 'o b', 'f 4 5 6'].join('\n');
    const model = parseOBJ(obj, 'smoke.obj');
    expect(model.chunks.length).toBe(2);
    const analysis = analyzeModel(model, quantizeModel(model.chunks, model.bbox, { bits: { x: 10, y: 10, z: 10 }, rangeMode: 'perChunk' }));
    const imp = readImport(JSON.stringify(buildExport(model, analysis)));
    const v = verifyImport(imp, model);
    expect(v.allExact).toBe(true);
  });
});
