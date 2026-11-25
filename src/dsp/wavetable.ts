/**
 * 波表数据模型与两种渲染方式：
 * - naive：直接对一周期表做相位递增循环（线性插值），高次谐波越过奈奎斯特后自然折叠；
 * - bandlimited：同一组谐波系数，按每个采样点的瞬时基频只叠加放得下的分量。
 * 纯函数、无浏览器依赖，AudioWorklet 与离线渲染共用同一套数学。
 */
import { realDftOneSided, reconstructTable } from './fft';

export const TABLE_SIZE = 2048;

export type RenderMode = 'naive' | 'bandlimited';

export interface HarmonicCoeffs {
  /** 表的周期长度（采样点） */
  n: number;
  /** mag[k]/phase[k]：第 k 次谐波的单边幅度与相位，k=0 为直流 */
  mag: Float64Array;
  phase: Float64Array;
}

export interface RenderOptions {
  sampleRate: number;
  /** 每个输出采样点对应的基频 Hz；长度即渲染长度，支持逐采样平滑扫频 */
  f0Curve: Float64Array;
  /** 起始相位（弧度，2π 对应一整张表） */
  startPhase?: number;
  /** 限带保护带：谐波频率 >= (nyquist * (1 - guard)) 即开始淡出 */
  bandGuard?: number;
  /** 限带淡出宽度（倍频程内的线性余弦过渡） */
  fadeWidth?: number;
}

/** 去掉直流偏移（返回新数组）。 */
export function removeDc(table: Float64Array): Float64Array {
  let sum = 0;
  for (const v of table) sum += v;
  const mean = sum / table.length;
  return table.map((v) => v - mean);
}

export function meanDc(table: Float64Array): number {
  let sum = 0;
  for (const v of table) sum += v;
  return sum / table.length;
}

export function peakAmplitude(table: Float64Array): number {
  let p = 0;
  for (const v of table) p = Math.max(p, Math.abs(v));
  return p;
}

export function rms(signal: Float64Array): number {
  let s = 0;
  for (const v of signal) s += v * v;
  return Math.sqrt(s / signal.length);
}

/** 峰值归一化到 ±1（静音表保持不变）。 */
export function normalizePeak(table: Float64Array): Float64Array {
  const p = peakAmplitude(table);
  if (p < 1e-9) return table.slice();
  return table.map((v) => v / p);
}

/** 从一周期波形提取谐波系数。 */
export function analyzeTable(table: Float64Array): HarmonicCoeffs {
  const { magnitude, phase } = realDftOneSided(table);
  return { n: table.length, mag: magnitude, phase };
}

/** 由谐波系数重建周期表（用于验证与显示）。 */
export function synthesizeTable(coeffs: HarmonicCoeffs): Float64Array {
  return reconstructTable(coeffs.n, coeffs.mag, coeffs.phase);
}

// ---------- 预设波形 ----------

function sineTable(n: number): Float64Array {
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.sin((2 * Math.PI * i) / n);
  return t;
}

/** 尖锯齿：相位提前的窄下降沿锯齿，谐波丰富且高频衰减慢，最容易听到折叠。 */
function sharpSawTable(n: number): Float64Array {
  const t = new Float64Array(n);
  // 下降沿占周期 4%，其余时间近似线性缓升（-1 -> +1）
  const edge = Math.max(2, Math.round(n * 0.04));
  for (let i = 0; i < n; i++) {
    if (i < edge) {
      t[i] = 1 - (2 * (i + 1)) / edge; // +1 快速降到 -1
    } else {
      t[i] = -1 + (2 * (i - edge)) / (n - edge);
    }
  }
  return t;
}

/**
 * 带窄凹口的波形：正弦主体 + 周期 8% 宽度的深窄凹口。
 * 窄凹口制造一簇高次谐波，适合观察“凹口谐波在高音处折回”。
 */
function notchedTable(n: number): Float64Array {
  const t = new Float64Array(n);
  const notchCenter = Math.round(n * 0.62);
  const notchHalf = Math.max(1, Math.round(n * 0.04));
  for (let i = 0; i < n; i++) {
    let v = 0.8 * Math.sin((2 * Math.PI * i) / n);
    const d = Math.abs(i - notchCenter);
    if (d < notchHalf) {
      // 余弦形深凹，最深到 -1.35
      const w = 0.5 * (1 + Math.cos((Math.PI * d) / notchHalf));
      v -= 1.35 * w;
    }
    t[i] = v;
  }
  return normalizePeak(t);
}

export type PresetId = 'sine' | 'sharp-saw' | 'notched';

export const PRESETS: { id: PresetId; label: string; build: (n: number) => Float64Array }[] = [
  { id: 'sine', label: '正弦', build: sineTable },
  { id: 'sharp-saw', label: '尖锯齿', build: sharpSawTable },
  { id: 'notched', label: '窄凹口', build: notchedTable },
];

export function buildPreset(id: PresetId, n = TABLE_SIZE): Float64Array {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`未知预设：${id}`);
  return preset.build(n);
}

// ---------- 折叠（混叠）数学 ----------

/**
 * 采样率 fs 下，任意频率 f 折叠到基带 [0, fs/2] 后的实际落点。
 * 这就是“跑到听不到的频带又折回来”的确定性公式。
 */
export function foldFrequency(f: number, sampleRate: number): number {
  const fs = sampleRate;
  return Math.abs(((f + fs / 2) % fs) - fs / 2);
}

/** 第 k 次谐波在基频 f0 下的理论频率。 */
export function harmonicFrequency(k: number, f0: number): number {
  return k * f0;
}

// ---------- 渲染 ----------

function interpLinear(table: Float64Array, pos: number): number {
  const n = table.length;
  // pos 可能为负，先折回 [0, n)
  let p = pos % n;
  if (p < 0) p += n;
  const i0 = Math.floor(p);
  const frac = p - i0;
  const i1 = (i0 + 1) % n;
  return table[i0] * (1 - frac) + table[i1] * frac;
}

/**
 * A 模式：直接循环波表。
 * 相位逐采样累加 f0/fs，查表用线性插值；任何超奈奎斯特分量都由采样过程自动折叠。
 */
export function renderNaive(table: Float64Array, opts: RenderOptions): Float64Array {
  const { sampleRate, f0Curve, startPhase = 0 } = opts;
  const total = f0Curve.length;
  const out = new Float64Array(total);
  let phase = startPhase; // 单位：表采样点（0..n）
  const n = table.length;
  for (let i = 0; i < total; i++) {
    out[i] = interpLinear(table, phase);
    phase += (f0Curve[i] * n) / sampleRate;
    // 相位缠绕，避免长音浮点漂移
    if (phase >= n) phase %= n;
  }
  return out;
}

/**
 * B 模式：限带加法合成。
 * 与 A 共用同一组 mag/phase（同一音色族），每次谐波按瞬时频率决定保留/淡出，
 * 扫频时谐波在奈奎斯特边界平滑滑入滑出（增益连续归零，无硬切断、无整段换声）。
 */
export function renderBandlimited(coeffs: HarmonicCoeffs, opts: RenderOptions): Float64Array {
  const { sampleRate, f0Curve, startPhase = 0, bandGuard = 0.02, fadeWidth = 0.12 } = opts;
  const total = f0Curve.length;
  const out = new Float64Array(total);
  const nyquist = sampleRate / 2;
  const bins = coeffs.n >> 1;

  // 各谐波独立相位累加器，初相与表保持一致：θₖ = k·startPhase·2π/n + φₖ
  const theta = new Float64Array(bins + 1);
  const twoPiOverN = (2 * Math.PI) / coeffs.n;
  for (let k = 1; k <= bins; k++) theta[k] = k * startPhase * twoPiOverN + coeffs.phase[k];

  const dphi = new Float64Array(bins + 1);
  const fadeStart = nyquist * (1 - bandGuard);

  // 谐波增益：保护带以下为 1，过渡带余弦平方淡出，到奈奎斯特恰好为 0（连续）
  const harmonicGain = (fk: number): number => {
    if (fk <= fadeStart) return 1;
    if (fk >= nyquist) return 0;
    const x = (fk - fadeStart) / (nyquist - fadeStart);
    const clamped = Math.min(1, Math.max(0, x / fadeWidth));
    return 0.5 * (1 + Math.cos(Math.PI * clamped));
  };

  for (let i = 0; i < total; i++) {
    const f0 = f0Curve[i];
    let v = coeffs.mag[0]; // 直流分量（UI 去直流后通常为 0）
    for (let k = 1; k <= bins; k++) {
      const fk = k * f0;
      if (fk > nyquist) break; // 增益已为 0 且后续频率更高，可安全停止
      const gain = harmonicGain(fk);
      dphi[k] = (2 * Math.PI * fk) / sampleRate;
      v += coeffs.mag[k] * gain * Math.cos(theta[k]);
      theta[k] += dphi[k];
      // 相位缠绕控制幅度
      if (theta[k] > 1e6) theta[k] %= 2 * Math.PI;
    }
    out[i] = v;
  }
  return out;
}

/** 恒定基频的便捷封装。 */
export function constantF0(length: number, f0: number): Float64Array {
  const curve = new Float64Array(length);
  curve.fill(f0);
  return curve;
}

/**
 * 对数扫频曲线（半音域）。
 * @param lengthSamples 采样点数
 * @param f0Start 起点频率
 * @param semitoneRange 单向幅度（半音），三角波往返
 * @param oneWaySeconds 单趟耗时
 */
export function sweepF0Curve(
  lengthSamples: number,
  sampleRate: number,
  f0Start: number,
  semitoneRange: number,
  oneWaySeconds: number,
): Float64Array {
  const curve = new Float64Array(lengthSamples);
  const period = 2 * oneWaySeconds;
  for (let i = 0; i < lengthSamples; i++) {
    const t = i / sampleRate;
    const phase = (t % period) / period; // 0..1 三角
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0..1..0
    const semis = (tri - 0.5) * 2 * semitoneRange; // -range..+range
    curve[i] = f0Start * Math.pow(2, semis / 12);
  }
  return curve;
}
