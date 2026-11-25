import { PLATE_MAP } from '../game/plates';
import type { ConditionKey, PlateDef, PlateId } from '../game/types';
import { keyToKind } from '../game/evidence';

interface ActiveVoice {
  bus: GainNode;
  sources: OscillatorNode[];
  noise?: AudioBufferSourceNode;
}

/**
 * 纯程序合成的风铃音频引擎：
 * 每个铃片 = 基频 + 若干非谐和分音（各自指数衰减）+ 短噪声敲槌声；
 * 压制 = 在极短时间内把该声部总线压到无声；
 * 三个位置用 StereoPanner 做左右中定位。
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private reverb: ConvolverNode | null = null;
  private active = new Set<ActiveVoice>();

  /** 必须在用户手势中调用。 */
  ensure(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;

      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 24;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.82;

      this.master.connect(comp);
      comp.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      // 极轻的空间混响，增加“风铃”融合感；干声仍是辨识依据主体
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(1.5, 2.2);
      const wet = this.ctx.createGain();
      wet.gain.value = 0.1;
      const reverbGain = this.ctx.createGain();
      reverbGain.gain.value = 0.5;
      this.reverb.connect(reverbGain);
      reverbGain.connect(wet);
      wet.connect(comp);
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.35;
      this.reverbSend.connect(this.reverb);

      this.noiseBuffer = this.makeNoiseBuffer(1);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private reverbSend: GainNode | null = null;

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  private makeNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const impulse = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return impulse;
  }

  /** 立即止住所有正在响的声音。 */
  stopAll(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const voice of this.active) {
      try {
        voice.bus.gain.cancelScheduledValues(t);
        voice.bus.gain.setValueAtTime(Math.max(voice.bus.gain.value, 0.0001), t);
        voice.bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
        for (const src of voice.sources) {
          try {
            src.stop(t + 0.1);
          } catch {
            /* already stopped */
          }
        }
        try {
          voice.noise?.stop(t + 0.1);
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }

  /**
   * 敲响一片铃片。
   * @param damp  true = 敲响后立刻“压住”，余音被截断
   * @param pan   -1 左 ~ 1 右
   */
  playPlate(
    plate: PlateDef,
    opts: { damp?: boolean; pan?: number; delay?: number; velocity?: number } = {},
  ): void {
    const ctx = this.ensure();
    const t = ctx.currentTime + (opts.delay ?? 0);
    const velocity = opts.velocity ?? 1;

    const voice: ActiveVoice = { bus: ctx.createGain(), sources: [] };
    voice.bus.gain.value = 1;

    const panner = ctx.createStereoPanner();
    panner.pan.value = opts.pan ?? 0;

    voice.bus.connect(panner);
    panner.connect(this.master!);
    if (this.reverbSend) panner.connect(this.reverbSend);

    // —— 分音 ——
    for (const partial of plate.partials) {
      const osc = ctx.createOscillator();
      osc.type = partial.type ?? 'sine';
      osc.frequency.value = plate.freq * partial.ratio;
      if (partial.detune) osc.detune.value = partial.detune;

      const g = ctx.createGain();
      const peak = Math.max(0.0002, partial.gain * 0.5 * velocity);
      const attack = 0.006;
      const dur = Math.max(0.12, plate.decay * partial.decayFactor);

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(g);
      g.connect(voice.bus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      voice.sources.push(osc);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    }

    // —— 敲槌噪声瞬态 ——
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = plate.mallet.freq;
    bp.Q.value = plate.mallet.q;
    const ng = ctx.createGain();
    const md = plate.mallet.dur;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(plate.mallet.gain * velocity, t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + md);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(voice.bus);
    noise.start(t);
    noise.stop(t + md + 0.05);
    voice.noise = noise;
    noise.onended = () => {
      try {
        noise.disconnect();
        bp.disconnect();
        ng.disconnect();
      } catch {
        /* ignore */
      }
    };

    // —— 压制：快速截断整个声部总线 ——
    if (opts.damp) {
      const at = t + 0.055;
      voice.bus.gain.setValueAtTime(1, t);
      voice.bus.gain.setValueAtTime(1, at);
      voice.bus.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    }

    this.active.add(voice);
    const cleanupAt = (plate.decay + 0.4) * 1000;
    window.setTimeout(() => {
      this.active.delete(voice);
      try {
        voice.bus.disconnect();
        panner.disconnect();
      } catch {
        /* ignore */
      }
    }, cleanupAt);
  }

  /** 按真实摆放演奏某个敲击条件（题面声音 / 回放共用，保证条件一致）。 */
  playCondition(truth: PlateId[], key: ConditionKey): void {
    const kind = keyToKind(key);
    const pans = [-0.55, 0, 0.55];
    truth.forEach((id, pos) => {
      const damp = kind.type === 'mute' && kind.pos === pos;
      this.playPlate(PLATE_MAP[id], { pan: pans[pos], damp, velocity: 0.95 });
    });
  }

  /** 顺序对比演示：先 A 后 B（结束核对里的鉴别讲解用）。 */
  playSequence(
    items: { plate: PlateId; damp?: boolean; pan?: number; hold?: number }[],
  ): void {
    let delay = 0;
    for (const item of items) {
      this.playPlate(PLATE_MAP[item.plate], { ...item, delay });
      delay += item.hold ?? 1.1;
    }
  }
}

export const audio = new AudioEngine();
