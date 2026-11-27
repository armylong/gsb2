import type { AppState } from './state';
import { SAMPLE_RATE, dbToGain } from './types';
import { crossfadeLoop, renderSynth } from './dsp/synth';
import { frameAt } from './dsp/interp';

/**
 * 浏览器播放引擎。
 * - 整段试听：离线渲染同一个 renderSynth，BufferSource 从光标处播放，保证与导出 WAV 同源。
 * - 定住音色：渲染光标处的静态短缓冲，首尾等功率交叉淡化烘焙成无缝循环，
 *   单源 loop=true 持续发声，循环接缝处能量恒定，不会出现一声脉冲。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private meterInput: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private fullSource: AudioBufferSourceNode | null = null;
  private freezeSource: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private startOffset = 0;
  private freezeBufferDuration = 0;
  mode: 'idle' | 'playing' | 'frozen' = 'idle';
  onEnded: (() => void) | null = null;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.master = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.meterInput = this.ctx.createGain();
      this.meterInput.connect(this.master);
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  setMasterDb(db: number): void {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
    }
  }

  private buildBuffer(samples: Float32Array): AudioBuffer {
    const ctx = this.ensureContext();
    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    return buf;
  }

  /** 按当前状态离线渲染整段（归一化在渲染内部完成） */
  renderFull(state: AppState, targetRms: number | null): Float32Array {
    const result = renderSynth({
      sampleRate: SAMPLE_RATE,
      duration: state.duration,
      f0: state.f0,
      noiseMix: state.noiseMix,
      timeline: state.timeline,
      normalizeTo: targetRms,
      seed: state.seed,
    });
    return result.samples;
  }

  /** 渲染某一时刻的静态音色（时间线冻结，仅保留起振/收尾短淡变） */
  renderStaticAt(state: AppState, t: number, targetRms: number | null, seconds = 0.8): Float32Array {
    const frozenRegions = frameAt(state.timeline, t);
    const flatTimeline = {
      middleEnabled: false,
      middlePos: 0.5,
      keys: [
        { pos: 0, label: '冻结', formants: frozenRegions },
        { pos: 1, label: '冻结', formants: frozenRegions },
      ],
    };
    const result = renderSynth({
      sampleRate: SAMPLE_RATE,
      duration: seconds,
      f0: state.f0,
      noiseMix: state.noiseMix,
      timeline: flatTimeline,
      normalizeTo: targetRms,
      seed: state.seed + 7,
    });
    return result.samples;
  }

  /** 整段试听，从 offset（秒）开始；offset 超出长度则回到开头 */
  playFull(state: AppState, targetRms: number | null, offsetSeconds: number): void {
    const ctx = this.ensureContext();
    void ctx.resume();
    this.stopAll();
    const samples = this.renderFull(state, targetRms);
    const buffer = this.buildBuffer(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.meterInput!);
    const offset = Math.min(offsetSeconds, Math.max(0, buffer.duration - 0.02));
    src.start(0, offset);
    src.onended = () => {
      if (this.fullSource === src) {
        this.fullSource = null;
        this.mode = 'idle';
        this.onEnded?.();
      }
    };
    this.fullSource = src;
    this.startedAt = ctx.currentTime;
    this.startOffset = offset;
    this.mode = 'playing';
    this.setMasterDb(state.masterDb);
  }

  /** 定住 t（0..1）处的音色并持续循环 */
  freezeAt(state: AppState, t: number, targetRms: number | null): void {
    const ctx = this.ensureContext();
    void ctx.resume();
    this.stopAll();
    const raw = this.renderStaticAt(state, t, targetRms);
    const looped = crossfadeLoop(raw, SAMPLE_RATE);
    const buffer = this.buildBuffer(looped);
    this.freezeBufferDuration = buffer.duration;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.meterInput!);
    src.start();
    this.freezeSource = src;
    this.mode = 'frozen';
    this.setMasterDb(state.masterDb);
  }

  /** 当前播放位置（秒）；冻结模式返回静态缓冲内的循环位置 */
  getPosition(state: AppState): number {
    if (!this.ctx) return state.cursor * state.duration;
    if (this.mode === 'playing') {
      return Math.min(state.duration, this.startOffset + (this.ctx.currentTime - this.startedAt));
    }
    if (this.mode === 'frozen') {
      return (this.ctx.currentTime % this.freezeBufferDuration);
    }
    return state.cursor * state.duration;
  }

  /** 读取电平表 RMS（dB） */
  readLevel(): number {
    if (!this.analyser) return -Infinity;
    const arr = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(arr);
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    const rms = Math.sqrt(s / arr.length);
    return 20 * Math.log10(Math.max(1e-7, rms));
  }

  stopAll(): void {
    if (this.fullSource) {
      this.fullSource.onended = null;
      try {
        this.fullSource.stop();
      } catch {
        /* 已停止 */
      }
      this.fullSource = null;
    }
    if (this.freezeSource) {
      try {
        this.freezeSource.stop();
      } catch {
        /* 已停止 */
      }
      this.freezeSource.disconnect();
      this.freezeSource = null;
    }
    this.mode = 'idle';
  }
}
