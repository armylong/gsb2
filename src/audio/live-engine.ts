import {
  ActiveVoice,
  carrierFreqFor,
  createFmBellVoice,
  rescheduleDepthFromNow,
  stopVoice,
  voiceEndTime,
} from './engine';
import { clonePatch, FmPatch } from './types';

/**
 * 实时引擎: 一个 AudioContext 上管理多个按住的声音。
 * 同一音符按住期间修改参数 -> 只做平滑追赶, 绝不重新 strike。
 */
export class FmEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private voices = new Map<number, ActiveVoice>();
  private cleanupTimer: number | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.15;

    this.master.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** 按下音符; 已按住同一音符时忽略(不重触发) */
  noteOn(midi: number, patch: FmPatch): boolean {
    if (this.voices.has(midi)) return false;
    const start = this.ctx.currentTime + 0.01;
    const voice = createFmBellVoice(this.ctx, this.master, midi, clonePatch(patch), start);
    this.voices.set(midi, voice);
    this.scheduleCleanup();
    return true;
  }

  noteOff(midi: number): void {
    const voice = this.voices.get(midi);
    if (!voice) return;
    // 电铃自然衰减: 松手不截断, 只在包络走完后回收节点
    const end = voiceEndTime(voice.patch, voice.startTime);
    stopVoice(voice, end);
    this.voices.delete(midi);
  }

  isHeld(midi: number): boolean {
    return this.voices.has(midi);
  }

  heldNotes(): number[] {
    return [...this.voices.keys()];
  }

  /** 按住中改调制深度/曲线: 从当前时刻平滑重排, 无新起音 */
  updateDepth(patch: FmPatch): void {
    const now = this.ctx.currentTime;
    for (const voice of this.voices.values()) {
      voice.patch.modDepth = patch.modDepth;
      voice.patch.depthCurve = patch.depthCurve.map((p) => ({ ...p }));
      voice.patch.modelTime = patch.modelTime;
      voice.modelTime = patch.modelTime;
      rescheduleDepthFromNow(voice, now);
    }
  }

  /** 按住中改模型时间: 同步曲线时间轴并平滑重排 */
  updateModelTime(patch: FmPatch): void {
    this.updateDepth(patch);
  }

  /** 按住中改调制比: 平滑追赶调制器频率 */
  updateModRatio(patch: FmPatch): void {
    const now = this.ctx.currentTime;
    const t = now + 0.03;
    for (const voice of this.voices.values()) {
      voice.patch.modRatio = patch.modRatio;
      const target = voice.baseCarrierHz * patch.modRatio;
      voice.modulator.frequency.cancelScheduledValues(now);
      voice.modulator.frequency.setValueAtTime(voice.modulator.frequency.value, now);
      voice.modulator.frequency.exponentialRampToValueAtTime(Math.max(1, target), t);
    }
  }

  /**
   * 按住中切换 固定/跟随 模式或改固定频率: 载波频率平滑滑到新目标,
   * 不产生新的起音瞬态, 仍在同一个音符上。
   */
  updateCarrier(patch: FmPatch): void {
    const now = this.ctx.currentTime;
    const t = now + 0.03;
    for (const [midi, voice] of this.voices) {
      voice.patch.carrierMode = patch.carrierMode;
      voice.patch.fixedCarrierHz = patch.fixedCarrierHz;
      const target = carrierFreqFor(patch, midi);
      voice.carrier.frequency.cancelScheduledValues(now);
      voice.carrier.frequency.setValueAtTime(voice.carrier.frequency.value, now);
      voice.carrier.frequency.exponentialRampToValueAtTime(Math.max(1, target), t);
      // 调制器跟随新载波
      voice.modulator.frequency.cancelScheduledValues(t);
      voice.modulator.frequency.exponentialRampToValueAtTime(
        Math.max(1, target * voice.patch.modRatio),
        t + 0.03,
      );
      voice.baseCarrierHz = target;
    }
  }

  /** 输出增益实时调节 */
  updateOutputGain(gain: number): void {
    for (const voice of this.voices.values()) {
      voice.patch.outputGain = gain;
      const now = this.ctx.currentTime;
      voice.voiceGain.gain.cancelScheduledValues(now);
      voice.voiceGain.gain.setTargetAtTime(gain, now, 0.02);
    }
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer !== null) return;
    this.cleanupTimer = window.setInterval(() => {
      const now = this.ctx.currentTime;
      let any = false;
      for (const voice of this.voices.values()) {
        any = true;
        if (voiceEndTime(voice.patch, voice.startTime) < now) {
          this.voices.delete(voice.midi);
        }
      }
      if (!any && this.voices.size === 0 && this.cleanupTimer !== null) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, 500);
  }

  /** 以当前分析器数据给出某频率附近的实测电平(dB), 供频谱标注核对 */
  measuredLevelAt(hz: number): number {
    const bins = this.analyser.frequencyBinCount;
    const data = new Float32Array(bins);
    this.analyser.getFloatFrequencyData(data);
    const bin = Math.round(hz / (this.ctx.sampleRate / 2 / (bins - 1)));
    if (bin < 0 || bin >= bins) return -Infinity;
    return data[bin];
  }

  /** 测试/调试用: 直接返回某 midi 当前载波应处频率 */
  expectedCarrierHz(patch: FmPatch, midi: number): number {
    return carrierFreqFor(patch, midi);
  }
}
