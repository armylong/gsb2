/// <reference path="types.ts" />
namespace Adaptive {

  interface ScheduledBar {
    bar: number;
    sources: AudioScheduledSourceNode[];
  }

  /**
   * 程序合成音频引擎. 不持有任何时间/段落状态, 只负责:
   *  - 按 Transport 给出的绝对时间排一个小节的声音;
   *  - 请求被覆盖时, 停掉尚未发声的预排小节;
   *  - 主音量与挂起/恢复(均不影响拍点).
   * 两套主段与两条过门共用同一条节拍线(同 BPM、同小节长度).
   */
  export class AudioEngine {
    private ctx: AudioContext;
    private master: GainNode;
    private comp: DynamicsCompressorNode;
    private noiseBuffer: AudioBuffer;
    private scheduled: ScheduledBar[] = [];

    constructor() {
      const Ctx: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.comp = this.ctx.createDynamicsCompressor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.comp);
      this.comp.connect(this.ctx.destination);

      const len = this.ctx.sampleRate * 1;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }

    get context(): AudioContext { return this.ctx; }
    get currentTime(): number { return this.ctx.currentTime; }

    suspend(): Promise<void> { return this.ctx.suspend(); }
    resume(): Promise<void> { return this.ctx.resume(); }

    /** 规则 4: 改整体音量只动增益, 不重新起拍. */
    setVolume(v: number): void {
      const g = Math.max(0, Math.min(1, v));
      this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    }

    private midi(m: number): number {
      return 440 * Math.pow(2, (m - 69) / 12);
    }

    private tone(
      entry: ScheduledBar, freq: number, t: number, dur: number,
      peak: number, type: OscillatorType, attack = 0.005, release = 0.08,
      filterFreq?: number,
    ): void {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
      let head: AudioNode = osc;
      if (filterFreq) {
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = filterFreq;
        osc.connect(f);
        head = f;
      }
      head.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + release + 0.02);
      entry.sources.push(osc);
    }

    private noise(
      entry: ScheduledBar, t: number, dur: number, peak: number,
      filterType: BiquadFilterType, filterFreq: number, q = 1,
    ): void {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = filterFreq;
      f.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);
      src.stop(t + dur + 0.02);
      entry.sources.push(src);
    }

    private kick(entry: ScheduledBar, t: number, accent: boolean): void {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      const peak = accent ? 0.9 : 0.65;
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.25);
      entry.sources.push(osc);
    }

    private pad(entry: ScheduledBar, midis: number[], t: number, dur: number, peak: number): void {
      for (const m of midis) {
        for (const detune of [-6, 6]) {
          const osc = this.ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = this.midi(m);
          osc.detune.value = detune;
          const f = this.ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = 900;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(peak, t + 0.4);
          g.gain.setValueAtTime(peak, t + dur - 0.3);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(f);
          f.connect(g);
          g.connect(this.master);
          osc.start(t);
          osc.stop(t + dur + 0.05);
          entry.sources.push(osc);
        }
      }
    }

    private riser(entry: ScheduledBar, t: number, dur: number): void {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.5;
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(6000, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + dur * 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);
      src.stop(t + dur + 0.02);
      entry.sources.push(src);
    }

    /** 排一个完整小节, time0 为该小节第一拍的 AudioContext 绝对时间. */
    scheduleBar(bar: number, time0: number, kind: BarKind): void {
      const entry: ScheduledBar = { bar, sources: [] };
      const stepDur = SECONDS_PER_BAR / 16;
      const at = (step: number) => time0 + step * stepDur;

      switch (kind) {
        case 'main-calm': this.calmBar(entry, at); break;
        case 'main-lively': this.livelyBar(entry, at); break;
        case 'fill-c2l': this.fillC2L(entry, at); break;
        case 'fill-l2c': this.fillL2C(entry, at); break;
      }
      this.scheduled.push(entry);
    }

    /** 静区主段: 稀疏琶音 + 长音垫 + 极轻底鼓, 无军鼓. */
    private calmBar(e: ScheduledBar, at: (s: number) => number): void {
      this.pad(e, [57, 60, 64], at(0), SECONDS_PER_BAR, 0.028);           // Am 长垫
      const arp: [number, number][] = [[0, 69], [4, 76], [6, 72], [8, 69], [12, 67], [14, 64]];
      for (const [s, m] of arp) this.tone(e, this.midi(m), at(s), 0.35, 0.12, 'triangle', 0.01, 0.15);
      this.tone(e, this.midi(45), at(0), 1.4, 0.16, 'sine');              // A2 根音
      this.tone(e, this.midi(40), at(8), 1.2, 0.12, 'sine');              // E2
      this.kick(e, at(0), false);
      this.noise(e, at(4), 0.06, 0.03, 'highpass', 7000);
      this.noise(e, at(12), 0.06, 0.03, 'highpass', 7000);
    }

    /** 热闹区主段: 四四拍底鼓 + 军鼓反拍 + 驱动贝斯 + 离拍断奏和弦. */
    private livelyBar(e: ScheduledBar, at: (s: number) => number): void {
      this.pad(e, [57, 60, 64], at(0), SECONDS_PER_BAR, 0.018);
      for (const s of [0, 4, 8, 12]) this.kick(e, at(s), s === 0);
      this.noise(e, at(4), 0.18, 0.22, 'bandpass', 1800, 0.8);            // 军鼓 2/4 拍
      this.noise(e, at(12), 0.18, 0.22, 'bandpass', 1800, 0.8);
      for (const s of [2, 6, 10]) this.noise(e, at(s), 0.05, 0.07, 'highpass', 8000);
      this.noise(e, at(14), 0.2, 0.09, 'highpass', 8000);                 // 开镲
      const bassLine: [number, number][] = [[0, 45], [2, 45], [4, 48], [6, 45], [8, 45], [10, 43], [12, 45], [14, 47]];
      for (const [s, m] of bassLine) this.tone(e, this.midi(m), at(s), 0.22, 0.2, 'sawtooth', 0.005, 0.05, 500);
      for (const s of [2, 6, 10, 14]) {                                    // 离拍和弦断奏
        for (const m of [69, 72, 76]) this.tone(e, this.midi(m), at(s), 0.16, 0.05, 'square', 0.004, 0.04, 2200);
      }
    }

    /** 静→闹专用过门: 上行噪声拉升 + 渐密军鼓滚奏 + 末尾吊镲, 整小节. */
    private fillC2L(e: ScheduledBar, at: (s: number) => number): void {
      this.riser(e, at(0), SECONDS_PER_BAR);
      this.kick(e, at(0), true);
      const rolls = [8, 10, 12, 13, 14, 15];
      rolls.forEach((s, i) => this.noise(e, at(s), 0.12, 0.1 + i * 0.03, 'bandpass', 1800, 0.8));
      this.noise(e, at(15), 0.9, 0.25, 'highpass', 5000);                 // 吊镲延续到下一小节
      this.tone(e, this.midi(45), at(0), SECONDS_PER_BAR, 0.14, 'sawtooth', 0.01, 0.05, 600);
    }

    /** 闹→静专用过门: 下行五声音阶 16 分音流 + 收束软钟, 整小节. */
    private fillL2C(e: ScheduledBar, at: (s: number) => number): void {
      const run = [76, 74, 72, 69, 67, 64, 62, 59, 57, 55, 52, 50, 48, 47, 45, 45];
      run.forEach((m, s) => {
        const fade = 0.14 - (s / 16) * 0.08;
        this.tone(e, this.midi(m), at(s), 0.18, fade, 'triangle', 0.004, 0.08);
      });
      this.kick(e, at(0), false);
      for (const s of [4, 8, 12]) this.noise(e, at(s), 0.05, 0.06 - s * 0.003, 'highpass', 8000);
      this.pad(e, [57, 60, 64], at(8), SECONDS_PER_BAR / 2, 0.03);        // 垫音提前半小节铺垫静区
      this.tone(e, this.midi(69), at(15), 1.2, 0.1, 'sine', 0.01, 0.4);   // 收束软钟 A4
    }

    /**
     * 停掉 bar >= fromBar 的所有预排声音.
     * 仅用于「过门还没发声就被新请求覆盖」的情况, 保证被取消的过门绝不播放.
     */
    cancelFromBar(fromBar: number): void {
      const keep: ScheduledBar[] = [];
      for (const entry of this.scheduled) {
        if (entry.bar >= fromBar) {
          for (const src of entry.sources) {
            try { src.stop(); } catch { /* 已结束的节点 stop 会抛错, 忽略 */ }
          }
        } else {
          keep.push(entry);
        }
      }
      this.scheduled = keep;
    }

    /** 从头开始: 停掉全部预排声音. */
    cancelAll(): void {
      for (const entry of this.scheduled) {
        for (const src of entry.sources) {
          try { src.stop(); } catch { /* ignore */ }
        }
      }
      this.scheduled = [];
    }
  }
}
