/**
 * 实时播放引擎：AudioContext + AudioWorklet 节点封装。
 * 单声部（同时只响一个音），支持逐采样平滑扫频、A/B 交叉淡化、波形热替换。
 */
import { analyzeTable, type RenderMode } from '../dsp/wavetable';
export interface EngineState {
  sampleRate: number;
  baseFreq: number;
  currentFreq: number;
  noteOn: boolean;
  mode: RenderMode;
  abMix: number;
  levelOn: boolean;
  ready: boolean;
}

export class OscEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private baseFreq = 220;
  private semitoneOffset = 0;
  private mode: RenderMode = 'bandlimited';
  private abMix = 1;
  private noteOn = false;
  private sweepTimer: number | null = null;
  onStateChange: ((s: EngineState) => void) | null = null;

  get ready(): boolean {
    return this.node !== null && this.ctx !== null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get currentFreq(): number {
    return this.baseFreq * Math.pow(2, this.semitoneOffset / 12);
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const workletUrl = new URL(
      `${import.meta.env.BASE_URL}worklets/wavetable-osc.js`,
      window.location.href,
    ).href;
    await this.ctx.audioWorklet.addModule(workletUrl);

    this.node = new AudioWorkletNode(this.ctx, 'wavetable-osc', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.25;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;

    this.node.connect(this.analyser);
    this.analyser.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.emit();
  }

  setTable(table: Float64Array): void {
    const coeffs = analyzeTable(table);
    if (this.node && this.ctx) {
      // 热替换：worklet 内部做 8ms 交叉淡化，音符保持时也不爆音
      this.node.port.postMessage({
        type: 'setTable',
        table,
        mag: coeffs.mag,
        phase: coeffs.phase,
      });
    }
  }

  setMasterGain(v: number): void {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }
  }

  setMode(mode: RenderMode): void {
    this.mode = mode;
    this.setAbMix(mode === 'naive' ? 0 : 1);
  }

  /** A/B 交叉淡化（0=A，1=B），直接驱动 worklet 参数，切换是连续的。 */
  setAbMix(mix: number): void {
    this.abMix = Math.max(0, Math.min(1, mix));
    if (this.node && this.ctx) {
      this.node.parameters.get('abMix')!.setTargetAtTime(this.abMix, this.ctx.currentTime, 0.02);
    }
    this.emit();
  }

  setLevelOn(on: boolean): void {
    if (this.node) this.node.parameters.get('levelOn')!.value = on ? 1 : 0;
    this.emit();
  }

  /** 设定基准音高（按键），保留当前扫频偏移。 */
  setBaseFreq(freq: number): void {
    this.baseFreq = freq;
    this.applyFreq();
  }

  setSemitoneOffset(semis: number): void {
    this.semitoneOffset = semis;
    this.applyFreq();
  }

  private applyFreq(): void {
    if (this.node && this.ctx) {
      // setTargetAtTime 提供指数级平滑，手动拖推子也不会有拉链噪声
      this.node.parameters
        .get('f0')!
        .setTargetAtTime(this.currentFreq, this.ctx.currentTime, 0.015);
    }
    this.emit();
  }

  noteDown(freq?: number): void {
    if (freq !== undefined) this.baseFreq = freq;
    this.noteOn = true;
    this.stopSweep();
    if (this.node && this.ctx) {
      const p = this.node.parameters.get('gate')!;
      p.cancelScheduledValues(this.ctx.currentTime);
      p.setTargetAtTime(1, this.ctx.currentTime, 0.005);
      this.applyFreq();
    }
    this.emit();
  }

  noteUp(): void {
    this.noteOn = false;
    this.stopSweep();
    if (this.node && this.ctx) {
      const p = this.node.parameters.get('gate')!;
      p.cancelScheduledValues(this.ctx.currentTime);
      p.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    }
    this.emit();
  }

  get isNoteOn(): boolean {
    return this.noteOn;
  }

  /**
   * 自动往返扫频：用 value curve 预排程，整条曲线在音频线程平滑执行，
   * 不依赖 JS 定时器精度，也不会在某个音高突然换声。
   */
  startAutoSweep(semitoneRange: number, oneWaySeconds: number): void {
    if (!this.node || !this.ctx || !this.noteOn) return;
    this.stopSweep();
    const ctx = this.ctx;
    const f0Param = this.node.parameters.get('f0')!;
    const chunk = 0.1; // 每 100ms 一段 curve
    const period = 2 * oneWaySeconds;
    const chunksPerPeriod = Math.round(period / chunk);
    const start = ctx.currentTime + 0.05;
    let t = start;
    for (let rep = 0; rep < 40; rep++) {
      // 预排 40 个周期（最长 ~320s），足够一次试听
      const curve = new Float32Array(chunksPerPeriod);
      for (let i = 0; i < chunksPerPeriod; i++) {
        const phase = i / chunksPerPeriod; // 0..1 三角
        const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
        const semis = (tri - 0.5) * 2 * semitoneRange;
        curve[i] = this.baseFreq * Math.pow(2, semis / 12);
      }
      f0Param.setValueCurveAtTime(curve, t, period);
      t += period;
    }
  }

  stopSweep(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.node && this.ctx) {
      const f0Param = this.node.parameters.get('f0')!;
      f0Param.cancelScheduledValues(this.ctx.currentTime);
      f0Param.setTargetAtTime(this.currentFreq, this.ctx.currentTime, 0.02);
    }
  }

  /** 暂停/恢复（浏览器自动挂起时用）。 */
  async resume(): Promise<void> {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  private emit(): void {
    this.onStateChange?.({
      sampleRate: this.sampleRate,
      baseFreq: this.baseFreq,
      currentFreq: this.currentFreq,
      noteOn: this.noteOn,
      mode: this.mode,
      abMix: this.abMix,
      levelOn: this.node ? (this.node.parameters.get('levelOn')!.value > 0.5) : true,
      ready: this.ready,
    });
  }
}
