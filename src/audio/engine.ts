import type { RouteMode } from '../dsp/kernel';
import { MASTER_FADE_S } from '../dsp/kernel';
import type { MultiRing } from '../ui/ringbuf';

export interface EngineBlock {
  left: Float32Array;
  right: Float32Array;
  sumRef: Float32Array;
  phaseDiff: Float32Array;
  freqA: Float32Array;
  freqB: Float32Array;
  envelope: Float32Array;
  phases: [number, number];
}

/**
 * 实时引擎：AudioWorklet 发声，AnalyserNode 做左右独立电平表，
 * 工作节点上报的块写入绘图环形缓冲。起停用 GainNode 采样精确淡变。
 */
export class ToneEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private meterL: Float32Array = new Float32Array(2048);
  private meterR: Float32Array = new Float32Array(2048);
  private ring: MultiRing | null = null;
  private ready: Promise<void> | null = null;
  private running = false;

  freqs: [number, number] = [440, 444];
  gains: [number, number] = [0.2, 0.2];
  mode: RouteMode = 'split';
  startPhases: [number, number] = [0, 0];

  setRing(ring: MultiRing) {
    this.ring = ring;
  }

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const Ctx: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      // ?worklet 由 vite-plugin-worklet 处理：dev 返回源码 URL，build 输出独立 ES chunk
      const workletModule = await import('./tone-worklet.ts?worklet');
      const workletUrl = workletModule.default;
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(this.ctx, 'tone-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const splitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserR = this.ctx.createAnalyser();
      this.analyserL.fftSize = 2048;
      this.analyserR.fftSize = 2048;
      const merger = this.ctx.createChannelMerger(2);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;

      this.node.connect(splitter);
      // 电平表在淡变前取样，显示的是原始生成电平
      splitter.connect(this.analyserL, 0);
      splitter.connect(this.analyserR, 1);
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
      merger.connect(this.master).connect(this.ctx.destination);

      this.node.port.onmessage = (e: MessageEvent<EngineBlock>) => {
        const b = e.data;
        this.ring?.push([b.left, b.right, b.sumRef, b.phaseDiff, b.freqA, b.freqB, b.envelope]);
      };
      this.syncAll();
    })();
    return this.ready;
  }

  private send(m: Record<string, unknown>) {
    this.node?.port.postMessage(m);
  }

  syncAll() {
    this.send({ type: 'freqs', freqs: this.freqs });
    this.send({ type: 'gains', gains: this.gains });
    this.send({ type: 'mode', mode: this.mode });
    this.send({ type: 'resetPhase', phases: this.startPhases });
  }

  setFreqs(f: [number, number]) {
    this.freqs = f;
    this.send({ type: 'freqs', freqs: f });
  }
  setGains(g: [number, number]) {
    this.gains = g;
    this.send({ type: 'gains', gains: g });
  }
  setMode(mode: RouteMode) {
    this.mode = mode;
    this.send({ type: 'mode', mode });
  }
  resetPhase(phases: [number, number]) {
    this.startPhases = phases;
    this.send({ type: 'resetPhase', phases });
  }

  async start() {
    await this.ensure();
    await this.ctx!.resume();
    const t = this.ctx!.currentTime;
    this.master!.gain.cancelScheduledValues(t);
    this.master!.gain.setValueAtTime(this.master!.gain.value, t);
    this.master!.gain.linearRampToValueAtTime(1, t + MASTER_FADE_S);
    this.running = true;
  }

  async stop() {
    if (!this.ctx || !this.master || !this.running) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0, t + MASTER_FADE_S);
    await new Promise((r) => setTimeout(r, MASTER_FADE_S * 1000 + 40));
    await this.ctx.suspend();
    this.running = false;
  }

  /** 左右独立 RMS 电平（0..1 线性） */
  readMeters(): [number, number] {
    if (!this.analyserL || !this.analyserR) return [0, 0];
    this.analyserL.getFloatTimeDomainData(this.meterL as Float32Array<ArrayBuffer>);
    this.analyserR.getFloatTimeDomainData(this.meterR as Float32Array<ArrayBuffer>);
    let sl = 0;
    let sr = 0;
    for (let i = 0; i < this.meterL.length; i++) {
      sl += this.meterL[i] * this.meterL[i];
      sr += this.meterR[i] * this.meterR[i];
    }
    return [Math.sqrt(sl / this.meterL.length), Math.sqrt(sr / this.meterR.length)];
  }

  get isRunning(): boolean {
    return this.running;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** 循环试听一个离线渲染好的缓冲（走独立通路，不影响实时双音） */
  async playBuffer(buffer: AudioBuffer, loop: boolean, offset = 0): Promise<AudioBufferSourceNode> {
    await this.ensure();
    await this.ctx!.resume();
    const src = this.ctx!.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const gain = this.ctx!.createGain();
    gain.gain.value = 1;
    src.connect(gain).connect(this.ctx!.destination);
    src.start(0, offset);
    return src;
  }
}
