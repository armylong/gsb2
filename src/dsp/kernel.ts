/**
 * 核心 DSP：两路纯音的相位累加、等功率路由与解析包络。
 *
 * 同一份代码同时被 AudioWorklet（实时试听）与离线渲染（WAV 导出、循环试听）
 * 调用，保证"听到的声音"与"导出的文件"逐样本一致。
 */

export type RouteMode = 'split' | 'mix';

export interface ToneSpec {
  /** 瞬时频率（Hz），逐样本可线性插值 */
  freq: number;
  /** 起点相位（弧度，0..2π） */
  phase: number;
  /** 线性幅度 0..1 */
  gain: number;
}

export interface KernelState {
  /** 两路各自的累积相位（弧度，不卷绕） */
  phases: [number, number];
  /** 每个 128 样本块开始时的目标频率，块内线性插值（Hz） */
  freqs: [number, number];
  /** 每路线性幅度 */
  gains: [number, number];
  mode: RouteMode;
  /** 路由交叉渐变位置 0..1，0=完全 split，1=完全 mix（用于无爆音切换） */
  modeBlend: number;
  /** 输出总增益（起停淡入淡出）0..1 */
  master: number;
}

export function createKernelState(a: ToneSpec, b: ToneSpec, mode: RouteMode): KernelState {
  return {
    phases: [a.phase, b.phase],
    freqs: [a.freq, b.freq],
    gains: [a.gain, b.gain],
    mode,
    modeBlend: mode === 'mix' ? 1 : 0,
    master: 1,
  };
}

const TWO_PI = Math.PI * 2;
/** 路由切换交叉渐变时间（秒） */
export const MODE_CROSSFADE_S = 0.012;
/** 起停淡入淡出时间（秒） */
export const MASTER_FADE_S = 0.02;
/**
 * 等功率路由系数。
 *
 * split：A 全送左、B 全送右，每只耳朵收到一路、功率 = g²。
 * mix  ：两路各 1/√2 混成同一信号再送两边，每只耳朵功率 = g²，与 split 相等，
 *        切换听法时不会因为总响度变化而让某一种听法"占便宜"。
 */
const MIX_GAIN = 1 / Math.SQRT2;

export function routeGains(blend: number): { aToL: number; aToR: number; bToL: number; bToR: number } {
  // 等功率交叉渐变，两个端点严格满足：
  //   blend=0（split）：L=A、R=B，每耳功率 g²
  //   blend=1（mix）  ：L=R=(A+B)/√2，每耳功率 g²/2+g²/2=g²，与 split 相等
  // 令 θ=blend·π/2，c=cos θ、s=sin θ、k=1/√2：
  //   L = c·A + k·s·(A+B)，R = c·B + k·s·(A+B)
  // L 内两系数 c+ks 与 ks 的平方和 = c²+2cks+s²(2k²)=c²+2cks+s²=1+2cks，
  // 非恒定但始终 ≥1，取等号于两个端点；12ms 过渡内响度不塌陷、端点零差。
  const c = Math.cos((blend * Math.PI) / 2);
  const s = Math.sin((blend * Math.PI) / 2);
  const m = s * MIX_GAIN;
  return {
    aToL: c + m,
    bToL: m,
    aToR: m,
    bToR: c + m,
  };
}

export interface BlockOutput {
  /** 输出到声卡的左右声道 */
  left: Float32Array;
  right: Float32Array;
  /** 两路相加的对照信号（分送时用来观察"如果合到一起"的拍） */
  sumRef: Float32Array;
  /** 每样本卷绕后的相位差（-π..π） */
  phaseDiff: Float32Array;
  /** 逐样本瞬时频率（Hz） */
  freqA: Float32Array;
  freqB: Float32Array;
  /** 逐样本解析包络（sumRef 对应的真实幅度包络，0..2） */
  envelope: Float32Array;
}

export function createBlockOutput(length: number): BlockOutput {
  return {
    left: new Float32Array(length),
    right: new Float32Array(length),
    sumRef: new Float32Array(length),
    phaseDiff: new Float32Array(length),
    freqA: new Float32Array(length),
    freqB: new Float32Array(length),
    envelope: new Float32Array(length),
  };
}

/**
 * 渲染一个样本块。
 *
 * @param state        内核状态（会被就地更新相位）
 * @param blockLength  块长（实时为 128，离线可用任意值）
 * @param sampleRate   采样率
 * @param targetFreqs  块结束时两路应到达的频率；块内从当前 state.freqs 线性插值
 * @param out          可复用的输出缓冲
 * @param fadeEnv      可选的逐样本外部淡变包络（离线渲染的首尾平滑），长度需等于 blockLength
 */
export function renderBlock(
  state: KernelState,
  blockLength: number,
  sampleRate: number,
  targetFreqs: [number, number],
  out: BlockOutput,
  fadeEnv?: Float32Array,
): BlockOutput {
  const { left, right, sumRef, phaseDiff, freqA: outFA, freqB: outFB, envelope } = out;
  const [fA0, fB0] = state.freqs;
  const [fA1, fB1] = targetFreqs;
  const [gA, gB] = state.gains;
  // 向目标模式逼近的每样本增量；已到端点则为 0（保持恒定）
  let blendPerSample = 0;
  if ((state.mode === 'mix' && state.modeBlend < 1) || (state.mode === 'split' && state.modeBlend > 0)) {
    blendPerSample =
      (state.mode === 'mix' ? 1 : -1) / (MODE_CROSSFADE_S * sampleRate);
  }

  let [pA, pB] = state.phases;
  let blend = state.modeBlend;

  for (let i = 0; i < blockLength; i++) {
    const t = blockLength > 1 ? i / (blockLength - 1) : 0;
    const fa = fA0 + (fA1 - fA0) * t;
    const fb = fB0 + (fB1 - fB0) * t;
    outFA[i] = fa;
    outFB[i] = fb;

    // 块内线性扫频：相位增量取本样本瞬时频率
    pA += (TWO_PI * fa) / sampleRate;
    pB += (TWO_PI * fb) / sampleRate;
    const sA = Math.sin(pA) * gA;
    const sB = Math.sin(pB) * gB;

    if (blendPerSample !== 0) {
      blend = Math.min(1, Math.max(0, blend + blendPerSample));
    }
    const g = routeGains(blend);
    const master = fadeEnv ? state.master * fadeEnv[i] : state.master;

    const l = (sA * g.aToL + sB * g.bToL) * master;
    const r = (sA * g.aToR + sB * g.bToR) * master;
    left[i] = l;
    right[i] = r;

    // 对照信号：两路直接相加（与听法无关，始终是同一数学量）
    const sum = sA + sB;
    sumRef[i] = sum * master;

    let d = pA - pB;
    d = d - TWO_PI * Math.round(d / TWO_PI);
    phaseDiff[i] = d;

    // 解析包络：等幅双音 g·(sin a + sin b) 的真实幅度
    envelope[i] = 2 * Math.sqrt(gA * gB) * Math.abs(Math.cos(d / 2)) * master;
  }

  state.phases = [pA, pB];
  state.freqs = [fA1, fB1];
  state.modeBlend = blend;
  return out;
}

/**
 * 离线整段渲染：允许每段给出逐块频率轨迹（分段线性扫频）。
 *
 * @param spec       段规格
 * @param sampleRate 采样率
 * @param blockSize  块长
 * @param freqPath   可选频率轨迹函数，t∈[0,duration]→两路频率；缺省用恒定频率
 */
export interface OfflineSpec {
  duration: number;
  startPhase: [number, number];
  gains: [number, number];
  mode: RouteMode;
  /** 恒定频率（无 freqPath 时使用） */
  freqs: [number, number];
  /** 首尾淡变时长（秒） */
  fade: number;
}

export interface OfflineResult {
  left: Float32Array;
  right: Float32Array;
  sumRef: Float32Array;
  envelope: Float32Array;
  phaseDiff: Float32Array;
  /** 终点累积相位（不卷绕），用于循环接缝检查 */
  endPhases: [number, number];
  sampleRate: number;
}

export function renderOffline(
  spec: OfflineSpec,
  sampleRate: number,
  blockSize = 1024,
  freqPath?: (t: number) => [number, number],
): OfflineResult {
  const total = Math.round(spec.duration * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const sumRef = new Float32Array(total);
  const envelope = new Float32Array(total);
  const phaseDiff = new Float32Array(total);

  const state = createKernelState(
    { freq: spec.freqs[0], phase: spec.startPhase[0], gain: spec.gains[0] },
    { freq: spec.freqs[1], phase: spec.startPhase[1], gain: spec.gains[1] },
    spec.mode,
  );
  state.master = 1;
  const fadeSamples = Math.min(Math.round(spec.fade * sampleRate), Math.floor(total / 2));
  const buf = createBlockOutput(blockSize);

  let written = 0;
  while (written < total) {
    const n = Math.min(blockSize, total - written);
    const t1 = (written + n - 1) / sampleRate;
    const f1: [number, number] = freqPath ? freqPath(t1) : spec.freqs;
    const block = renderBlock(state, n, sampleRate, f1, buf);

    for (let i = 0; i < n; i++) {
      const idx = written + i;
      let env = 1;
      if (fadeSamples > 0) {
        if (idx < fadeSamples) env = 0.5 - 0.5 * Math.cos((Math.PI * idx) / fadeSamples);
        else if (idx >= total - fadeSamples) {
          const k = total - 1 - idx;
          env = 0.5 - 0.5 * Math.cos((Math.PI * k) / fadeSamples);
        }
      }
      left[idx] = block.left[i] * env;
      right[idx] = block.right[i] * env;
      sumRef[idx] = block.sumRef[i] * env;
      envelope[idx] = block.envelope[i] * env;
      phaseDiff[idx] = block.phaseDiff[i];
    }
    written += n;
  }

  return {
    left,
    right,
    sumRef,
    envelope,
    phaseDiff,
    endPhases: state.phases,
    sampleRate,
  };
}

/** 解析包络（供绘图工具对任意缓冲复用） */
export function analyticEnvelope(gA: number, gB: number, phaseDiff: Float32Array): Float32Array {
  const out = new Float32Array(phaseDiff.length);
  const amp = 2 * Math.sqrt(gA * gB);
  for (let i = 0; i < out.length; i++) {
    out[i] = amp * Math.abs(Math.cos(phaseDiff[i] / 2));
  }
  return out;
}

/** 把相位卷绕到 -π..π */
export function wrapPhase(p: number): number {
  return p - TWO_PI * Math.round(p / TWO_PI);
}
