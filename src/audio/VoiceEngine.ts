/**
 * VoiceEngine —— 全应用唯一的声音过程（single source of truth）。
 *
 * 同一份代码同时用于：
 *   1. OfflineRenderer 离线逐采样渲染（曲线展示、序列回放、WAV 导出）；
 *   2. AudioWorklet 实时声音（手动按键、参数实时过渡）；
 *   3. 单元测试。
 *
 * 因此「听到的」和「曲线画出来的」振幅严格出自同一个逐采样过程，
 * 不存在两套实现之间的漂移。
 *
 * 设计要点：
 * - 状态机 IDLE / ATTACK / DECAY / SUSTAIN / RELEASE 覆盖 ADSR 全程；
 * - noteOn 时若声音仍在响（提前再按下 / 断音重触发），从当前电平重新起音，
 *   这就是真实合成器的 retrigger 行为；
 * - 零时长段在同一个采样内连续推进（允许刻意的垂直跳变，曲线上如实画出）；
 * - 包络参数可「挂起」（下一次 noteOn 生效）或「实时过渡」（以当前电平为
 *   新段起点重建当前段，保证连续、无无缘由瞬时跳变）。
 */
import type { TimbreParams, Waveform } from './types';
import { clampTimbre } from './types';

export type VoicePhase = 'idle' | 'attack' | 'decay' | 'sustain' | 'release';

/** 实时改参数时的生效方式 */
export type ParamUpdateMode = 'pending' | 'live';

/** 实时过渡 sustain 电平时使用的固定滑动时长（秒），避免台阶跳变 */
const SUSTAIN_GLIDE_SECONDS = 0.008;

/**
 * 曲线形状映射：把线性进度 t∈[0,1] 映射成实际进度。
 * shape<0 凹（指数感，起快后慢），0 线性，shape>0 凸（起慢后快）。
 * 端点恒为 0 / 1，所以任意形状下段与段的连接处电平不变。
 */
export function shapedProgress(t: number, shape: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (shape === 0) return t;
  if (shape < 0) {
    // 凹：1 - (1-t)^k，k∈(1, 4]
    const k = 1 + (-shape) * 3;
    return 1 - Math.pow(1 - t, k);
  }
  // 凸：t^k
  const k = 1 + shape * 3;
  return Math.pow(t, k);
}

/** 单音引擎。一个实例只负责一个声部、一种音色。 */
export class VoiceEngine {
  readonly sampleRate: number;
  params: TimbreParams;
  /** 挂起的参数：非 null 时，下一次 noteOn 用它替换 this.params */
  private pending: TimbreParams | null = null;

  phase: VoicePhase = 'idle';
  /** 当前包络电平 [0, 1]（未乘力度） */
  level = 0;
  /** 当前段起点电平，用于段内插值 */
  private segFrom = 0;
  /** 当前段目标电平 */
  private segTo = 0;
  /** 当前段总采样数（0 表示零时长段） */
  private segLength = 0;
  /** 当前段已走采样数 */
  private segElapsed = 0;
  /** 当前段形状 */
  private segShape = 0;

  /** 最近一次 noteOn 的力度 [0,1] */
  private velocity = 1;
  /** 振荡器相位（弧度），retrigger 不复位——模拟自由振荡的振荡器 */
  private oscPhase = 0;

  constructor(params: TimbreParams, sampleRate: number) {
    this.params = clampTimbre(params);
    this.sampleRate = sampleRate;
  }

  get isIdle(): boolean {
    return this.phase === 'idle';
  }

  /** 挂起新参数：只影响下一次 noteOn，当前声音不受影响。 */
  setParamsPending(next: TimbreParams): void {
    this.pending = clampTimbre(next);
  }

  /**
   * 实时改参数：以当前电平为锚点重建当前段，包络保持连续。
   * 正在响的声音会平滑过渡到新包络，不会出现无缘由的瞬时跳变；
   * 唯一允许的跳变来自零时长段本身（用户刻意设置）。
   */
  setParamsLive(next: TimbreParams): void {
    const p = clampTimbre(next);
    this.params = p;
    if (this.phase === 'idle') return;

    const env = p.envelope;
    const here = this.level;
    switch (this.phase) {
      case 'attack':
        // 从当前电平重新起音，目标仍是满幅（乘力度在输出时做）
        this.startSegment('attack', here, 1, env.attack, env.attackShape);
        break;
      case 'decay':
        this.startSegment('decay', here, env.sustain, env.decay, env.decayShape);
        break;
      case 'sustain':
        // 保持电平改变：用一段固定短滑过渡，而不是瞬间跳过去
        if (here !== env.sustain) {
          this.startSegment('sustain', here, env.sustain, SUSTAIN_GLIDE_SECONDS, 0);
        }
        break;
      case 'release':
        // 从当前电平继续释放到 0，只换时长/形状
        this.startSegment('release', here, 0, env.release, env.releaseShape);
        break;
    }
  }

  /**
   * 按下琴键。
   * - idle：从 0 起音；
   * - 正在响（含 release 中）：从当前电平重新 attack（断音 / 再触发）；
   * 振荡器相位不复位，听感是同一个音色被重新打点。
   */
  noteOn(velocity = 1): void {
    if (this.pending) {
      this.params = this.pending;
      this.pending = null;
    }
    this.velocity = Math.min(1, Math.max(0, velocity));
    const env = this.params.envelope;
    this.startSegment('attack', this.level, 1, env.attack, env.attackShape);
  }

  /** 松开琴键：从当前电平进入 release。空闲时调用为空操作。 */
  noteOff(): void {
    if (this.phase === 'idle') return;
    const env = this.params.envelope;
    this.startSegment('release', this.level, 0, env.release, env.releaseShape);
  }

  /** 立刻静音并回到空闲（序列渲染开头用）。 */
  reset(): void {
    this.phase = 'idle';
    this.level = 0;
    this.oscPhase = 0;
    this.pending = null;
  }

  private startSegment(
    phase: VoicePhase,
    from: number,
    to: number,
    durationSeconds: number,
    shape: number,
  ): void {
    this.phase = phase;
    this.segFrom = from;
    this.segTo = to;
    this.segLength = Math.max(0, Math.round(durationSeconds * this.sampleRate));
    this.segElapsed = 0;
    this.segShape = shape;
    if (this.segLength === 0) {
      // 零时长段：本采样内立即落到目标值并推进到下一段
      this.level = to;
      this.advanceFromZeroLength();
    }
  }

  /**
   * 零时长段的连锁推进。可能多段同时为零
   * （如 attack=0 且 decay=0），在同一个采样内全部走完。
   */
  private advanceFromZeroLength(): void {
    const env = this.params.envelope;
    // 用简单循环防护，正常 ADSR 最多 4 段
    let guard = 0;
    while (this.segLength === 0 && this.phase !== 'idle' && guard++ < 8) {
      switch (this.phase) {
        case 'attack':
          this.startSegment('decay', this.level, env.sustain, env.decay, env.decayShape);
          break;
        case 'decay':
          this.phase = 'sustain';
          this.segLength = Infinity;
          this.segElapsed = 0;
          this.segFrom = this.segTo = env.sustain;
          break;
        case 'sustain':
          // sustain 的零时长只可能是实时滑动段结束
          this.phase = 'sustain';
          this.segLength = Infinity;
          this.segElapsed = 0;
          this.segFrom = this.segTo = env.sustain;
          break;
        case 'release':
          this.phase = 'idle';
          this.level = 0;
          this.segLength = 0;
          break;
      }
    }
  }

  /** 推进一个采样，返回该采样的输出采样值。 */
  process(): number {
    if (this.phase !== 'idle') {
      if (Number.isFinite(this.segLength)) {
        this.segElapsed++;
        if (this.segElapsed >= this.segLength) {
          this.level = this.segTo;
          this.onSegmentEnd();
        } else {
          const t = this.segElapsed / this.segLength;
          const p = shapedProgress(t, this.segShape);
          this.level = this.segFrom + (this.segTo - this.segFrom) * p;
        }
      }
      this.oscPhase += (2 * Math.PI * this.params.frequency) / this.sampleRate;
      if (this.oscPhase > 2 * Math.PI) this.oscPhase -= 2 * Math.PI;
    }

    const osc = oscillatorSample(this.params.waveform, this.oscPhase);
    return osc * this.level * this.velocity * this.params.masterGain;
  }

  /**
   * 当前采样的纯振幅（包络 × 力度，不含振荡器与主增益）。
   * 曲线展示画的就是这个值——与 process() 内参与发声的是同一个 level。
   */
  amplitude(): number {
    return this.level * this.velocity;
  }

  private onSegmentEnd(): void {
    const env = this.params.envelope;
    switch (this.phase) {
      case 'attack':
        this.startSegment('decay', this.level, env.sustain, env.decay, env.decayShape);
        break;
      case 'decay':
        this.phase = 'sustain';
        this.segFrom = this.segTo = env.sustain;
        this.segLength = Infinity;
        this.segElapsed = 0;
        break;
      case 'sustain':
        // 实时滑动段结束，进入正常保持
        this.phase = 'sustain';
        this.segFrom = this.segTo = env.sustain;
        this.segLength = Infinity;
        this.segElapsed = 0;
        break;
      case 'release':
        this.phase = 'idle';
        this.level = 0;
        break;
    }
  }
}

/** 无查表的基础波形，相位 φ∈[0,2π)。 */
export function oscillatorSample(wave: Waveform, phi: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phi);
    case 'triangle': {
      const x = phi / (2 * Math.PI); // 0..1
      return 4 * Math.abs(x - 0.5) - 1;
    }
    case 'sawtooth': {
      const x = phi / (2 * Math.PI);
      return 2 * x - 1;
    }
    case 'square':
      return phi < Math.PI ? 1 : -1;
  }
}
