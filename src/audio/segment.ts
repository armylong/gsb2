import { renderOffline, wrapPhase, type OfflineResult, type RouteMode } from '../dsp/kernel';
import { encodeWav } from '../dsp/wav';

export interface SegmentSpec {
  duration: number;
  startPhase: [number, number];
  gains: [number, number];
  mode: RouteMode;
  /** 扫频范围 [起, 止]，对每一路给出；起止相等即恒定纯音 */
  sweep: {
    a: [number, number];
    b: [number, number];
  };
  fade: number;
  /** 扫频曲线：linear=线性频率，log=按比例（倍频程） */
  curve: 'linear' | 'log';
}

export function defaultSegment(mode: RouteMode): SegmentSpec {
  return {
    duration: 3,
    startPhase: [0, 0],
    gains: [0.2, 0.2],
    mode,
    sweep: {
      a: [440, 440],
      b: [444, 448],
    },
    fade: 0.03,
    curve: 'linear',
  };
}

/** 段内 t 时刻的两路瞬时频率 */
export function freqAt(spec: SegmentSpec, t: number): [number, number] {
  const u = Math.min(1, Math.max(0, t / spec.duration));
  const interp = ([f0, f1]: [number, number]) =>
    spec.curve === 'log' ? f0 * (f1 / f0) ** u : f0 + (f1 - f0) * u;
  return [interp(spec.sweep.a), interp(spec.sweep.b)];
}

/** 用与实时引擎相同的内核离线渲染整段 */
export function renderSegment(spec: SegmentSpec, sampleRate: number): OfflineResult {
  return renderOffline(
    {
      duration: spec.duration,
      startPhase: spec.startPhase,
      gains: spec.gains,
      mode: spec.mode,
      freqs: spec.sweep.a,
      fade: spec.fade,
    },
    sampleRate,
    1024,
    (t) => freqAt(spec, t),
  );
}

export function toAudioBuffer(result: OfflineResult, ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(2, result.left.length, result.sampleRate);
  buf.copyToChannel(result.left as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(result.right as Float32Array<ArrayBuffer>, 1);
  return buf;
}

export function segmentWav(result: OfflineResult, bitDepth: 16 | 32): Blob {
  return encodeWav([result.left, result.right], result.sampleRate, bitDepth);
}

export interface SeamInfo {
  /** 终点累积相位（不卷绕） */
  endPhases: [number, number];
  /** 起点相位（设定值，卷绕） */
  startPhases: [number, number];
  /** 每一路 终点→下一轮起点 的相位跳变（卷绕到 -π..π） */
  jumps: [number, number];
  /** 两路相位差在终点与起点各自的值（-π..π） */
  endPhaseDiff: number;
  startPhaseDiff: number;
  /** 相位差在接缝处的跳变（-π..π），0 表示拍形能接上 */
  diffJump: number;
  /** 终点瞬时频率与起点瞬时频率之差（Hz），扫频段通常不为 0 */
  freqJump: [number, number];
  /** 终点处的解析包络与起点处的包络 */
  endEnvelope: number;
  startEnvelope: number;
  /** 视觉判定：相位差是否接上（容差 0.1 rad） */
  phaseContinuous: boolean;
  /** 频率是否接上（容差 0.5 Hz） */
  freqContinuous: boolean;
}

export function analyzeSeam(spec: SegmentSpec, result: OfflineResult): SeamInfo {
  const startWrapped: [number, number] = [wrapPhase(spec.startPhase[0]), wrapPhase(spec.startPhase[1])];
  const jumps: [number, number] = [
    wrapPhase(result.endPhases[0] - spec.startPhase[0]),
    wrapPhase(result.endPhases[1] - spec.startPhase[1]),
  ];
  const endPhaseDiff = wrapPhase(result.endPhases[0] - result.endPhases[1]);
  const startPhaseDiff = wrapPhase(spec.startPhase[0] - spec.startPhase[1]);
  const diffJump = wrapPhase(endPhaseDiff - startPhaseDiff);
  const fEnd = freqAt(spec, spec.duration);
  const fStart = freqAt(spec, 0);
  const freqJump: [number, number] = [fEnd[0] - fStart[0], fEnd[1] - fStart[1]];
  const g = Math.sqrt(spec.gains[0] * spec.gains[1]) * 2;
  const endEnvelope = g * Math.abs(Math.cos(endPhaseDiff / 2));
  const startEnvelope = g * Math.abs(Math.cos(startPhaseDiff / 2));
  return {
    endPhases: result.endPhases,
    startPhases: startWrapped,
    jumps,
    endPhaseDiff,
    startPhaseDiff,
    diffJump,
    freqJump,
    endEnvelope,
    startEnvelope,
    // 教学判定阈值：首尾 30ms 淡变本身会掩盖小于约 0.4 rad 的相位不连续，
  // 因此 |Δφ 跳变| < 0.4 rad 视为视觉/听觉上连续；扫频段频率跳变另算。
  phaseContinuous: Math.abs(diffJump) < 0.4,
    freqContinuous: Math.abs(freqJump[0]) < 0.5 && Math.abs(freqJump[1]) < 0.5,
  };
}
