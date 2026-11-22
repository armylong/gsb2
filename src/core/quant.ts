/**
 * 轴对齐逐轴量化（Axis-aligned per-axis fixed-point quantization）
 *
 * 编码：c = round(clamp((v - min) / step, 0, levels-1))
 * 还原：v' = min + c * step
 *
 * 全部以 f64 计算；最大支持 24 位（levels = 2^24），整数编码可安全放入 Uint32。
 * 零厚度轴（min === max）：编码恒为 0、step = 0，还原值即 min，不产生误差。
 */
import type { Axis, AxisMeta, BBox, MeshChunk, QuantResult, QuantSettings } from './types';
import { AXES } from './types';

export const MAX_BITS = 24;
export const MIN_BITS = 2;

export function clampBits(bits: number): number {
  if (!Number.isFinite(bits)) return MIN_BITS;
  return Math.max(MIN_BITS, Math.min(MAX_BITS, Math.round(bits)));
}

/** 计算单个轴的量化元数据 */
export function buildAxisMeta(axis: Axis, bits: number, min: number, max: number, usedCodes: Set<number> | null): AxisMeta {
  const flat = min === max;
  if (flat) {
    return {
      axis,
      bits: 0,
      min,
      max,
      step: 0,
      levels: 1,
      usedLevels: 1,
      effectiveBits: 0,
      flat: true,
    };
  }
  const b = clampBits(bits);
  const levels = 2 ** b;
  const step = (max - min) / (levels - 1);
  const usedLevels = usedCodes ? usedCodes.size : levels;
  const effectiveBits = Math.max(1, Math.ceil(Math.log2(usedLevels)));
  return { axis, bits: b, min, max, step, levels, usedLevels, effectiveBits, flat: false };
}

/** 对称四舍五入：与符号无关，保证位级相同的归一化输入永远得到同一编码
 * （Math.round 对负半值向上取整、正半值也向上取整，方向不对称，
 * 会让共享边上数值相同的坐标因计算路径不同而落到相邻整数） */
function symmetricRound(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

/** 单轴编码（f64 -> 整数） */
export function encodeValue(v: number, meta: AxisMeta): number {
  if (meta.flat) return 0;
  let c = symmetricRound((v - meta.min) / meta.step);
  if (c < 0) c = 0;
  else if (c > meta.levels - 1) c = meta.levels - 1;
  return c;
}

/** 单轴解码（整数 -> f64） */
export function decodeValue(c: number, meta: AxisMeta): number {
  if (meta.flat) return meta.min;
  return meta.min + c * meta.step;
}

function bboxForChunk(chunk: MeshChunk, modelBBox: BBox, rangeMode: QuantSettings['rangeMode']): BBox {
  return rangeMode === 'global' ? modelBBox : chunk.bbox;
}

/**
 * 对整件执行量化。
 * @param modelBBox 整件包围盒（global 模式下所有块共用）
 */
export function quantizeModel(chunks: MeshChunk[], modelBBox: BBox, settings: QuantSettings): QuantResult {
  const bitsPerAxis = [settings.bits.x, settings.bits.y, settings.bits.z] as const;
  const result: QuantResult = { settings, chunks: [] };

  for (const chunk of chunks) {
    const box = bboxForChunk(chunk, modelBBox, settings.rangeMode);
    const n = chunk.positions.length / 3;

    // 第一遍：构建轴元数据，并收集实际使用的编码以计算有效位数
    const axes = AXES.map((axis) => {
      const used = new Set<number>();
      const meta0 = buildAxisMeta(axis, bitsPerAxis[axis], box.min[axis], box.max[axis], null);
      if (!meta0.flat) {
        for (let i = 0; i < n; i++) {
          used.add(encodeValue(chunk.positions[i * 3 + axis], meta0));
        }
      }
      return buildAxisMeta(axis, bitsPerAxis[axis], box.min[axis], box.max[axis], meta0.flat ? null : used);
    }) as [AxisMeta, AxisMeta, AxisMeta];

    // 第二遍：编码 + 还原 + 逐顶点误差
    const codes = new Uint32Array(chunk.positions.length);
    const restored = new Float64Array(chunk.positions.length);
    const errors = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      let sumSq = 0;
      for (const axis of AXES) {
        const v = chunk.positions[i * 3 + axis];
        const c = encodeValue(v, axes[axis]);
        const r = decodeValue(c, axes[axis]);
        codes[i * 3 + axis] = c;
        restored[i * 3 + axis] = r;
        const d = r - v;
        sumSq += d * d;
      }
      errors[i] = Math.sqrt(sumSq);
    }

    result.chunks.push({ chunkId: chunk.id, axes, quant: { restored, codes, errors } });
  }
  return result;
}

/** 仅从轴元数据 + 编码还原坐标（导出回读路径使用，保证与导出前同一公式） */
export function decodeChunk(codes: Uint32Array, axes: AxisMeta[]): Float64Array {
  const restored = new Float64Array(codes.length);
  for (let i = 0; i < codes.length / 3; i++) {
    for (const axis of AXES) {
      restored[i * 3 + axis] = decodeValue(codes[i * 3 + axis], axes[axis]);
    }
  }
  return restored;
}

/** 单轴最大理论误差（半个步长），零厚度轴为 0 */
export function axisMaxTheoreticalError(meta: AxisMeta): number {
  return meta.flat ? 0 : meta.step * 0.5;
}

/** 整件最大理论顶点误差（各轴半格平方和开根，取块级最大值） */
export function maxTheoreticalError(result: QuantResult): number {
  let m = 0;
  for (const ch of result.chunks) {
    let sumSq = 0;
    for (const axis of AXES) sumSq += axisMaxTheoreticalError(ch.axes[axis]) ** 2;
    m = Math.max(m, Math.sqrt(sumSq));
  }
  return m;
}
