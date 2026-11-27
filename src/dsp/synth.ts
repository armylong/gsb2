import type { RenderOptions, RenderResult, FormantRegion } from '../types';
import { MAX_FREQ, MIN_FREQ, clamp, dbToGain } from '../types';
import { frameAt } from './interp';
import { BiquadStage, bandpassCoeffs, lerpCoeffs } from './biquad';
import { generateNoise, generateVoiced } from './source';

const BLOCK = 32; // 每 32 个样本更新一次滤波系数，块内逐样本插值

function rmsOf(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** 起止淡入淡出 + 整段缓动包络，杜绝边界脉冲 */
function applyEnvelope(x: Float32Array, sampleRate: number): void {
  const n = x.length;
  const attack = Math.min(n >> 2, Math.floor(0.012 * sampleRate));
  const release = Math.min(n >> 2, Math.floor(0.03 * sampleRate));
  for (let i = 0; i < attack; i++) {
    x[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / attack));
  }
  for (let i = 0; i < release; i++) {
    const idx = n - 1 - i;
    x[idx] *= 0.5 * (1 - Math.cos((Math.PI * i) / release));
  }
}

/** 参数级校验：中心频率/带宽超出可用频带时给出可读提示 */
export function validateRegions(regions: FormantRegion[], sampleRate: number): string[] {
  const warnings: string[] = [];
  const nyq = sampleRate / 2;
  regions.forEach((r, i) => {
    const name = `共振区 ${i + 1}`;
    if (r.center < MIN_FREQ || r.center > Math.min(MAX_FREQ, nyq)) {
      warnings.push(
        `${name}中心频率 ${r.center.toFixed(0)} Hz 超出可用频带 ${MIN_FREQ}–${Math.min(
          MAX_FREQ,
          nyq,
        ).toFixed(0)} Hz，已按边界裁剪。`,
      );
    }
    if (r.bandwidth < 8) warnings.push(`${name}带宽 ${r.bandwidth.toFixed(0)} Hz 过窄，已按 8 Hz 下限处理。`);
    if (r.bandwidth > nyq / 2) warnings.push(`${name}带宽过宽（超过奈奎斯特频率的一半），已收窄。`);
    if (r.gain <= 0) warnings.push(`${name}增益为 0 或负值，该区域将听不到声音。`);
  });
  return warnings;
}

/**
 * 完整离线渲染：
 * 浊音（恒定 f0）与噪声按比例混合 → 三路时变带通并联（共振区）→ 包络 → RMS 归一化。
 * 同一 options（含 seed）输出完全一致，试听与 WAV 导出共用这条路径。
 */
export function renderSynth(options: RenderOptions): RenderResult {
  const { sampleRate, duration, f0, noiseMix, timeline, normalizeTo, seed } = options;
  const n = Math.max(1, Math.round(duration * sampleRate));
  const warnings: string[] = [];

  // 先扫一遍时间线，收集越界参数提示
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const regions = frameAt(timeline, t);
    warnings.push(...validateRegions(regions, sampleRate));
  }
  const dedupWarnings = [...new Set(warnings)];

  const voiced = generateVoiced(n, f0, sampleRate);
  const noise = generateNoise(n, seed);
  const ng = clamp(noiseMix, 0, 1);
  const vg = 1 - ng;

  const stages = [new BiquadStage(), new BiquadStage(), new BiquadStage()];
  const out = new Float32Array(n);

  let prevRegions = frameAt(timeline, 0);
  let prevCoeffs = prevRegions.map((r) =>
    bandpassCoeffs(r.center, r.bandwidth, sampleRate),
  );

  for (let blockStart = 0; blockStart < n; blockStart += BLOCK) {
    const blockEnd = Math.min(n, blockStart + BLOCK);
    const tMid = (blockStart + blockEnd) / 2 / n;
    const regions = frameAt(timeline, tMid);
    const coeffs = regions.map((r) => bandpassCoeffs(r.center, r.bandwidth, sampleRate));

    for (let i = blockStart; i < blockEnd; i++) {
      const u = (i - blockStart) / BLOCK;
      const src = vg * voiced[i] + ng * noise[i];
      let y = 0;
      for (let k = 0; k < 3; k++) {
        const c = lerpCoeffs(prevCoeffs[k], coeffs[k], u);
        const gain = prevRegions[k].gain + (regions[k].gain - prevRegions[k].gain) * u;
        y += stages[k].process(src, c) * gain;
      }
      out[i] = y;
    }
    prevRegions = regions;
    prevCoeffs = coeffs;
  }

  applyEnvelope(out, sampleRate);

  const rmsBefore = rmsOf(out);
  if (normalizeTo !== null && rmsBefore > 1e-9) {
    const scale = normalizeTo / rmsBefore;
    for (let i = 0; i < n; i++) out[i] *= scale;
  }

  let peak = 0;
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
    rms += out[i] * out[i];
  }
  rms = Math.sqrt(rms / n);

  const finalWarnings = [...dedupWarnings];
  if (peak >= 0.999) {
    finalWarnings.push('输出已接近满幅（发生削波风险），请降低共振区增益或目标响度。');
  }
  if (rms < 1e-5) {
    finalWarnings.push('合成结果几乎静音：检查气音比例、共振区增益与 f0 设置。');
  }
  if (noiseMix >= 0.95) {
    finalWarnings.push('气音比例接近 100%：源声已无固定音高，回读可能找不到清楚的共振峰。');
  }

  return { samples: out, sampleRate, rms, peak, warnings: finalWarnings };
}

/** 取时间线上某一时刻（0..1）的静态共振区快照，用于“定住听音色”与频谱解析曲线 */
export function snapshotAt(options: RenderOptions, t: number) {
  const regions = frameAt(options.timeline, clamp(t, 0, 1));
  return regions.map((r) => ({
    region: r,
    coeffs: bandpassCoeffs(
      clamp(r.center, MIN_FREQ, Math.min(MAX_FREQ, options.sampleRate / 2 - 8)),
      Math.max(8, r.bandwidth),
      options.sampleRate,
    ),
  }));
}

/**
 * 把一段静态渲染烘焙成可无缝循环的缓冲（DAW 式首尾等功率交叉淡化）。
 * 新缓冲长度 = 原长 - fade。新缓冲开头 fade 段：
 *   out[i] = sin(θ)·raw[i]（头段，权重 0→1）+ cos(θ)·raw[n-F+i]（尾段，权重 1→0）
 * 接缝处 out[0]=raw[n-F]，与上一圈末尾 raw[n-F-1] 相邻，能量连续；
 * 单源 loop=true 即可无脉冲持续发声。sin²+cos²=1 保证等功率。
 */
export function crossfadeLoop(samples: Float32Array, sampleRate: number, fadeSeconds = 0.08): Float32Array {
  const fade = Math.min(Math.floor(fadeSeconds * sampleRate), Math.floor(samples.length / 3));
  const out = new Float32Array(samples.length - fade);
  out.set(samples.subarray(fade), 0); // 中段原样
  for (let i = 0; i < fade; i++) {
    const theta = (Math.PI / 2) * (i / fade);
    const headW = Math.sin(theta); // 头段：0 → 1
    const tailW = Math.cos(theta); // 尾段：1 → 0
    out[i] = headW * samples[i] + tailW * samples[samples.length - fade + i];
  }
  return out;
}

/** 相邻样本差的中位数（衡量信号本身的典型跳变量） */
export function medianStep(samples: Float32Array): number {
  const diffs: number[] = [];
  for (let i = 1; i < samples.length; i++) diffs.push(Math.abs(samples[i] - samples[i - 1]));
  diffs.sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)];
}

export { dbToGain };
