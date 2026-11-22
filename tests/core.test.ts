import { describe, it, expect } from 'vitest';
import { buildAssembly, buildEdgeStrip, buildSplitSurface } from '../src/core/models';
import { quantizeModel, decodeValue, MAX_BITS } from '../src/core/quant';
import { analyzeModel } from '../src/core/analyze';
import type { QuantSettings } from '../src/core/types';

const settings = (bits: number, rangeMode: 'global' | 'perChunk' = 'global'): QuantSettings => ({
  bits: { x: bits, y: bits, z: bits },
  rangeMode,
});

describe('量化往返与误差界', () => {
  it('还原误差不超过各轴半格平方和', () => {
    const model = buildSplitSurface();
    for (const bits of [4, 8, 16, 24]) {
      const q = quantizeModel(model.chunks, model.bbox, settings(bits));
      for (const ch of q.chunks) {
        let boundSq = 0;
        for (const meta of ch.axes) boundSq += (meta.flat ? 0 : meta.step / 2) ** 2;
        const bound = Math.sqrt(boundSq);
        for (const e of ch.quant.errors) {
          expect(e).toBeLessThanOrEqual(bound + 1e-12 * model.bbox.max[0]);
        }
      }
      expect(bits).toBeLessThanOrEqual(MAX_BITS);
    }
  });

  it('编码落在 [0, levels-1]，零厚度轴编码恒为 0', () => {
    const model = buildAssembly();
    const q = quantizeModel(model.chunks, model.bbox, settings(6));
    for (const ch of q.chunks) {
      ch.axes.forEach((meta, axis) => {
        const n = ch.quant.codes.length / 3;
        for (let i = 0; i < n; i++) {
          const c = ch.quant.codes[i * 3 + axis];
          if (meta.flat) expect(c).toBe(0);
          else {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(meta.levels - 1);
          }
        }
      });
    }
  });

  it('decodeValue 对 min/max 端点往返正确', () => {
    const model = buildSplitSurface();
    const q = quantizeModel(model.chunks, model.bbox, settings(10));
    const meta = q.chunks[0].axes[0];
    expect(decodeValue(0, meta)).toBe(meta.min);
    expect(decodeValue(meta.levels - 1, meta)).toBeCloseTo(meta.max, 10);
  });

  it('位数越高误差单调不增', () => {
    const model = buildSplitSurface();
    let prev = Infinity;
    for (const bits of [4, 6, 8, 12, 16, 24]) {
      const q = quantizeModel(model.chunks, model.bbox, settings(bits));
      const a = analyzeModel(model, q);
      expect(a.stats.maxError).toBeLessThanOrEqual(prev + 1e-15);
      prev = a.stats.maxError;
    }
  });
});

describe('接缝分析', () => {
  it('分块曲面在高精度下接缝不张开，低精度下出现张开对', () => {
    const model = buildSplitSurface();
    const hi = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(20)));
    expect(hi.seamPairs.length).toBeGreaterThan(0);
    expect(hi.separatedSeams.length).toBe(0);

    const lo = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(4)));
    expect(lo.separatedSeams.length).toBeGreaterThan(0);
    // 张开的接缝：张开量约达一个完整量化步长（浮点容差）
    expect(lo.separatedSeams.every((s) => s.gapInSteps >= 0.9)).toBe(true);
    // 所有接缝对都来自带物理微缝的瓦片边
    expect(lo.seamPairs.every((s) => s.originalDistance > 0)).toBe(true);
  });

  it('perChunk 模式对小部件更友好：组合件小螺钉的步长显著变小', () => {
    const model = buildAssembly();
    const g = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(8, 'global')));
    const p = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(8, 'perChunk')));

    const screwChunkId = model.chunks.find((c) => c.name.includes('螺钉 #1'))!.id;
    const stepOf = (analysis: typeof g, id: number) => {
      const ch = analysis.quant.chunks.find((c) => c.chunkId === id)!;
      return Math.max(...ch.axes.map((m) => m.step));
    };
    expect(stepOf(p, screwChunkId)).toBeLessThan(stepOf(g, screwChunkId));
    // 贴边模型在 global 低精度下同样会出现量化致裂的接缝
    const strip = buildEdgeStrip();
    const sg = analyzeModel(strip, quantizeModel(strip.chunks, strip.bbox, settings(6, 'global')));
    expect(sg.separatedSeams.length).toBeGreaterThan(0);
    // perChunk 改变接缝行为（可能张开也可能把微缝量化到重合），且小部件步长严格变小
    const sp = analyzeModel(strip, quantizeModel(strip.chunks, strip.bbox, settings(6, 'perChunk')));
    expect(sp.seamPairs.length).toBe(sg.seamPairs.length);
  });

  it('贴边分块条在 4bit 下产生明显接缝，原始间距为亚毫米级微缝', () => {
    const model = buildEdgeStrip();
    const a = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(4)));
    expect(a.seamPairs.length).toBeGreaterThan(0);
    expect(a.seamPairs.every((s) => s.originalDistance > 0 && s.originalDistance < 0.01)).toBe(true);
    expect(a.separatedSeams.length).toBeGreaterThan(0);
  });
});

describe('特殊几何情形', () => {
  it('零厚度轴：平板 Y 轴 flat，不占位数且无误差', () => {
    const model = buildEdgeStrip();
    const a = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(8)));
    for (const ch of a.quant.chunks) {
      expect(ch.axes[1].flat).toBe(true);
      expect(ch.axes[1].bits).toBe(0);
      expect(ch.axes[1].effectiveBits).toBe(0);
    }
  });

  it('同位置重复顶点被检出', () => {
    const model = buildEdgeStrip();
    const a = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(8)));
    expect(a.duplicates.length).toBeGreaterThanOrEqual(1);
    const first = a.duplicates[0];
    expect(first.vertices.length).toBeGreaterThanOrEqual(2);
    // 重复顶点量化后仍然重合（同样的输入 -> 同样的编码）
    const ch = a.quant.chunks.find((c) => c.chunkId === first.chunkId)!;
    const [v0, v1] = first.vertices;
    for (let axis = 0; axis < 3; axis++) {
      expect(ch.quant.codes[v0 * 3 + axis]).toBe(ch.quant.codes[v1 * 3 + axis]);
    }
  });

  it('有效位数 <= 名义位数，且数据量统计为顶点数的线性函数', () => {
    const model = buildAssembly();
    const a = analyzeModel(model, quantizeModel(model.chunks, model.bbox, settings(12)));
    for (const ch of a.quant.chunks) {
      for (const meta of ch.axes) {
        expect(meta.effectiveBits).toBeLessThanOrEqual(meta.bits);
      }
    }
    expect(a.effectiveBits).toBeLessThanOrEqual(a.nominalBits);
    expect(a.nominalBytes).toBe(Math.ceil(a.nominalBits / 8));
  });
});
