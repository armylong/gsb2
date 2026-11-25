/**
 * 边缘融合核心: 权重场、逐像素合成、差值与覆盖模式。
 * 纯 TS(仅依赖 TypedArray 全局对象), 浏览器渲染与 Node 验证共用同一份逻辑。
 */
import {
  applyH,
  clamp,
  convexPolygonIntersection,
  overlapCrossing,
  pointInPolygon,
} from './geometry.ts';
import type { Point, Quad } from './types.ts';

export type RGB = [number, number, number];
export type SourceSampler = (u: number, v: number) => RGB;

export interface ProjectorView {
  quad: Quad;
  brightness: number;
  /** 幕布坐标 -> 输出图归一化坐标 (0..1) 的单应逆矩阵 */
  invH: number[];
  /** 输出图归一化采样器 */
  sample: SourceSampler;
  /** 输出图 uv -> 主测试图的裁剪范围(探针报告主测试图坐标时使用) */
  cropU0: number;
  cropU1: number;
  cropV0: number;
  cropV1: number;
  /**
   * true = 采样源已经烘焙过几何融合权重(导入的输出 PNG),
   * 合成时不再乘几何权重, 但亮度仍由 brightness 重新应用。
   */
  preBaked?: boolean;
}

export type CompositeMode = 'blend' | 'diff' | 'coverage';

export interface CompositeOptions {
  width: number;
  height: number;
  /** 像素坐标 -> 幕布坐标的缩放(低分辨率渲染时 <1) */
  scale: number;
  /** 过渡占重叠宽度的比例 0.05..1 */
  blendRatio: number;
  p1: ProjectorView;
  p2: ProjectorView;
  mode: CompositeMode;
}

export interface CompositeResult {
  /** RGBA, length = width*height*4 */
  rgba: Uint8ClampedArray;
  weight1: Float32Array;
  weight2: Float32Array;
  /** 0=未覆盖, 1=仅投影1, 2=仅投影2, 3=重叠 */
  coverage: Uint8Array;
  /** 每个覆盖像素相对参考图的亮度差(仅 diff 语义使用, 全部计算) */
  delta: Float32Array;
}

export function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function luminance(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * 单台投影机在幕布点 p 的几何融合权重; 返回 0 表示未覆盖。
 * - 独占区: 恒为 1(满功率)
 * - 重叠区: 沿「自身边界 -> 对方边界」穿越线段归一化,
 *   自身边界处 0、对方边界处 1, smoothstep 过渡;
 *   两台权重在重叠区内逐点互补, 和恒为 1(无热斑/暗带)。
 *
 * @param blendRatio 0..1, 过渡占局部重叠宽度的比例(1=整条重叠带都在渐变)
 */
export function weightAt(
  p: Point,
  self: Quad,
  other: Quad,
  blendRatio: number,
  overlapPoly: Point[] | null,
): number {
  if (!pointInPolygon(p, self)) return 0;
  if (!pointInPolygon(p, other)) return 1; // 独占区
  if (!overlapPoly || overlapPoly.length < 3) return 0.5;
  const cross = overlapCrossing(p, self, other);
  if (!cross || cross.dSelf + cross.dOther < 1e-9) return 0.5;
  // t=0 在自身边界(本机应熄灭), t=1 在对方边界(本机满功率)
  // 两距离均沿向外射线: 自身边界 dSelf, 对方边界 dOther, 重叠带总长 dOther
  const t = clamp(1 - cross.dSelf / cross.dOther, 0, 1);
  // blendRatio 收窄渐变区: 只在中段 [m, 1-m] 过渡, 两端保持 0/1
  const m = (1 - clamp(blendRatio, 0.05, 1)) / 2;
  const local = clamp((t - m) / (1 - 2 * m), 0, 1);
  return smoothstep01(local);
}

/** 计算两台四边形的重叠多边形(每帧/每次查询前算一次即可) */
export function computeOverlap(q1: Quad, q2: Quad): Point[] | null {
  const poly = convexPolygonIntersection([...q1], [...q2]);
  return poly.length >= 3 ? poly : null;
}

/** 生成图案的实时采样器(归一化 uv -> RGB) */
export function patternSampler(sampleBilinear: (x: number, y: number) => RGB, patternW: number, patternH: number): SourceSampler {
  return (u, v) => sampleBilinear(u * (patternW - 1), v * (patternH - 1));
}

/** 位图采样器(导入的 PNG 反演时使用) */
export function bitmapSampler(data: Uint8ClampedArray, w: number, h: number): SourceSampler {
  const at = (x: number, y: number): RGB => {
    const xi = clamp(Math.round(x), 0, w - 1);
    const yi = clamp(Math.round(y), 0, h - 1);
    const i = (yi * w + xi) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return (u, v) => {
    const x = clamp(u, 0, 1) * (w - 1);
    const y = clamp(v, 0, 1) * (h - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const c00 = at(x0, y0);
    const c10 = at(x0 + 1, y0);
    const c01 = at(x0, y0 + 1);
    const c11 = at(x0 + 1, y0 + 1);
    const out: RGB = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const top = c00[k] * (1 - tx) + c10[k] * tx;
      const bot = c01[k] * (1 - tx) + c11[k] * tx;
      out[k] = top * (1 - ty) + bot * ty;
    }
    return out;
  };
}

/**
 * 逐像素合成幕布画面。
 */
export function renderComposite(opts: CompositeOptions): CompositeResult {
  const { width, height, scale, blendRatio, p1, p2, mode } = opts;
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  const weight1 = new Float32Array(n);
  const weight2 = new Float32Array(n);
  const coverage = new Uint8Array(n);
  const delta = new Float32Array(n);
  const overlap = computeOverlap(p1.quad, p2.quad);

  for (let py = 0; py < height; py++) {
    const sy = (py + 0.5) / scale;
    for (let px = 0; px < width; px++) {
      const sx = (px + 0.5) / scale;
      const p = { x: sx, y: sy };
      const idx = py * width + px;

      const in1 = pointInPolygon(p, p1.quad);
      const in2 = pointInPolygon(p, p2.quad);
      if (!in1 && !in2) continue;

      // 已烘焙的导入图不再乘权重; 实时视图走几何权重
      let w1 = 0;
      let w2 = 0;
      if (in1) w1 = p1.preBaked ? 1 : weightAt(p, p1.quad, p2.quad, blendRatio, overlap);
      if (in2) w2 = p2.preBaked ? 1 : weightAt(p, p2.quad, p1.quad, blendRatio, overlap);
      weight1[idx] = w1;
      weight2[idx] = w2;

      let cover = 0;
      if (in1 && in2) cover = 3;
      else if (in1) cover = 1;
      else cover = 2;
      coverage[idx] = cover;

      // 各投影机在该点取色(透视逆映射)
      let c1: RGB | null = null;
      let c2: RGB | null = null;
      if (in1) {
        const uv1 = applyH(p1.invH, sx, sy);
        if (uv1.x >= -1e-6 && uv1.x <= 1 + 1e-6 && uv1.y >= -1e-6 && uv1.y <= 1 + 1e-6) {
          c1 = p1.sample(clamp(uv1.x, 0, 1), clamp(uv1.y, 0, 1));
        }
      }
      if (in2) {
        const uv2 = applyH(p2.invH, sx, sy);
        if (uv2.x >= -1e-6 && uv2.x <= 1 + 1e-6 && uv2.y >= -1e-6 && uv2.y <= 1 + 1e-6) {
          c2 = p2.sample(clamp(uv2.x, 0, 1), clamp(uv2.y, 0, 1));
        }
      }

      // 已烘焙源: 位图颜色 = 图案×几何权重, 合成时乘定位设置中的亮度;
      // 实时源: 颜色 × 几何权重 × 亮度
      const gain1 = p1.preBaked ? p1.brightness : w1 * p1.brightness;
      const gain2 = p2.preBaked ? p2.brightness : w2 * p2.brightness;
      const acc: RGB = [0, 0, 0];
      if (c1) for (let k = 0; k < 3; k++) acc[k] += c1[k] * gain1;
      if (c2) for (let k = 0; k < 3; k++) acc[k] += c2[k] * gain2;

      // 参考图: 以投影1的映射取原始图案(重叠对齐时两者一致)
      const refView = c1 ? p1 : p2;
      const uvRef = applyH(refView.invH, sx, sy);
      const ref = refView.sample(clamp(uvRef.x, 0, 1), clamp(uvRef.y, 0, 1));
      delta[idx] = luminance(acc) - luminance(ref);

      const o = idx * 4;
      if (mode === 'blend') {
        rgba[o] = clamp(acc[0], 0, 255);
        rgba[o + 1] = clamp(acc[1], 0, 255);
        rgba[o + 2] = clamp(acc[2], 0, 255);
        rgba[o + 3] = 255;
      } else if (mode === 'diff') {
        const d = clamp(delta[idx], -255, 255);
        // 红=偏亮, 蓝=偏暗, 中性灰=与参考一致
        rgba[o] = clamp(128 + d, 0, 255);
        rgba[o + 1] = clamp(128 - Math.abs(d) * 0.5, 0, 255);
        rgba[o + 2] = clamp(128 - d, 0, 255);
        rgba[o + 3] = 210;
      } else {
        // coverage
        if (cover === 1) {
          rgba[o] = 224; rgba[o + 1] = 86; rgba[o + 2] = 86;
        } else if (cover === 2) {
          rgba[o] = 86; rgba[o + 1] = 124; rgba[o + 2] = 224;
        } else {
          rgba[o] = 196; rgba[o + 1] = 86; rgba[o + 2] = 214;
        }
        rgba[o + 3] = 200;
      }
    }
  }
  return { rgba, weight1, weight2, coverage, delta };
}

export interface PointSample {
  point: Point;
  in1: boolean;
  in2: boolean;
  w1: number;
  w2: number;
  /** 投影1 映射回测试图的像素坐标(未覆盖为 null) */
  patternPoint: Point | null;
  composite: RGB | null;
  reference: RGB | null;
  delta: number | null;
}

/** 任意幕布点采样(探针与 Node 验证使用), 逻辑与 renderComposite 保持一致 */
export function sampleAt(
  p: Point,
  p1: ProjectorView,
  p2: ProjectorView,
  blendRatio: number,
  patternW: number,
  patternH: number,
): PointSample {
  const in1 = pointInPolygon(p, p1.quad);
  const in2 = pointInPolygon(p, p2.quad);
  const overlap = computeOverlap(p1.quad, p2.quad);
  const w1 = in1 ? (p1.preBaked ? 1 : weightAt(p, p1.quad, p2.quad, blendRatio, overlap)) : 0;
  const w2 = in2 ? (p2.preBaked ? 1 : weightAt(p, p2.quad, p1.quad, blendRatio, overlap)) : 0;

  let patternPoint: Point | null = null;
  let composite: RGB | null = null;
  let reference: RGB | null = null;
  let delta: number | null = null;

  if (in1 || in2) {
    const acc: RGB = [0, 0, 0];
    if (in1) {
      const uv = applyH(p1.invH, p.x, p.y);
      patternPoint = {
        x: (p1.cropU0 + clamp(uv.x, 0, 1) * (p1.cropU1 - p1.cropU0)) * (patternW - 1),
        y: (p1.cropV0 + clamp(uv.y, 0, 1) * (p1.cropV1 - p1.cropV0)) * (patternH - 1),
      };
      const c = p1.sample(clamp(uv.x, 0, 1), clamp(uv.y, 0, 1));
      const gain = p1.preBaked ? p1.brightness : w1 * p1.brightness;
      for (let k = 0; k < 3; k++) acc[k] += c[k] * gain;
    }
    if (in2) {
      const uv = applyH(p2.invH, p.x, p.y);
      if (!patternPoint) {
        patternPoint = {
          x: (p2.cropU0 + clamp(uv.x, 0, 1) * (p2.cropU1 - p2.cropU0)) * (patternW - 1),
          y: (p2.cropV0 + clamp(uv.y, 0, 1) * (p2.cropV1 - p2.cropV0)) * (patternH - 1),
        };
      }
      const c = p2.sample(clamp(uv.x, 0, 1), clamp(uv.y, 0, 1));
      const gain = p2.preBaked ? p2.brightness : w2 * p2.brightness;
      for (let k = 0; k < 3; k++) acc[k] += c[k] * gain;
    }
    composite = [clamp(acc[0], 0, 255), clamp(acc[1], 0, 255), clamp(acc[2], 0, 255)];

    const refView = in1 ? p1 : p2;
    const uvRef = applyH(refView.invH, p.x, p.y);
    reference = refView.sample(clamp(uvRef.x, 0, 1), clamp(uvRef.y, 0, 1));
    delta = luminance(composite) - luminance(reference);
  }

  return { point: p, in1, in2, w1, w2, patternPoint, composite, reference, delta };
}

/**
 * 烘焙单台投影机的输出 PNG 像素: 输出图 = 测试图 × 亮度 × 该点融合权重。
 * 重新导入后按四边形叠加即可还原幕布合成结果。
 * 每个输出像素做 2×2 超采样, 抑制网格线在二次透视采样时的混叠。
 */
export function bakeOutput(
  view: ProjectorView,
  forwardH: number[],
  other: Quad,
  outW: number,
  outH: number,
  blendRatio: number,
  overlap: Point[] | null,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(outW * outH * 4);
  const SS = 3;
  const n = SS * SS;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / outW;
          const v = (y + (sy + 0.5) / SS) / outH;
          const screen = applyH(forwardH, u, v);
          const w = weightAt(screen, view.quad, other, blendRatio, overlap);
          const c = view.sample(u, v);
          // 只烘焙几何权重, 不烘焙亮度(亮度作为定位设置在重导入时重新应用)
          r += c[0] * w;
          g += c[1] * w;
          b += c[2] * w;
        }
      }
      const i = (y * outW + x) * 4;
      data[i] = clamp(r / n, 0, 255);
      data[i + 1] = clamp(g / n, 0, 255);
      data[i + 2] = clamp(b / n, 0, 255);
      data[i + 3] = 255;
    }
  }
  return data;
}
