/**
 * 极简 WebAudio mock, 只实现引擎用到的 API, 在 Node 中离线"渲染" FM 信号。
 * 目的: 验证 createFmBellVoice 的接线与包络调度在数学上产生正确的 FM 频谱,
 * 不依赖浏览器。采样逐点积分, 调制通过 carrier.phase += 2π*(fc+mod(t)*sin(...))。
 */

type Scheduled = { time: number; value: number; type: 'set' | 'linear' | 'exp' };

class MockParam {
  value = 0;
  scheduled: Scheduled[] = [];

  setValueAtTime(v: number, t: number): void {
    this.scheduled.push({ time: t, value: v, type: 'set' });
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.scheduled.push({ time: t, value: v, type: 'linear' });
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    this.scheduled.push({ time: t, value: Math.max(1e-6, v), type: 'exp' });
  }
  cancelScheduledValues(t: number): void {
    this.scheduled = this.scheduled.filter((s) => s.time < t);
  }

  /** 在时间 t 处取值, 段间按调度类型插值 */
  at(t: number): number {
    const evs = this.scheduled;
    if (evs.length === 0) return this.value;
    if (t <= evs[0].time) return evs[0].value;
    for (let i = 1; i < evs.length; i++) {
      if (t <= evs[i].time) {
        const a = evs[i - 1];
        const b = evs[i];
        const k = (t - a.time) / (b.time - a.time || 1);
        if (b.type === 'exp') {
          // 钳制底数, 避免接近零的值在 0^k 处塌缩为 0
          const base = Math.max(1e-12, b.value / Math.max(1e-12, a.value));
          return Math.max(1e-12, a.value) * Math.pow(base, k);
        }
        return a.value + (b.value - a.value) * k;
      }
    }
    return evs[evs.length - 1].value;
  }
}

class MockOscillator {
  type = 'sine';
  frequency = new MockParam();
  phase = 0;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor(public ctx: MockContext) {}
  start(t: number): void {
    this.startedAt = t;
  }
  stop(t: number): void {
    this.stoppedAt = t;
  }
  connect(node: MockNode | MockParam): void {
    this.ctx.connections.push({ from: this, to: node });
  }
  disconnect(): void {}
  get onended(): null {
    return null;
  }
  set onended(_fn: (() => void) | null) {}
}

class MockGain {
  gain = new MockParam();
  connect(node: MockNode): void {
    this.ctx.connections.push({ from: this, to: node });
  }
  disconnect(): void {}
  constructor(public ctx: MockContext) {}
}

type MockNode = MockGain | MockDestination | MockOscillator;

class MockDestination {
  channels = 1;
  connect(): void {}
  disconnect(): void {}
}

interface Conn {
  from: MockNode;
  to: MockNode | MockParam;
}

export class MockContext {
  sampleRate: number;
  readonly destination = new MockDestination();
  connections: Conn[] = [];
  oscillators: MockOscillator[] = [];
  gains: MockGain[] = [];
  private length: number;

  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createOscillator(): MockOscillator {
    const o = new MockOscillator(this);
    this.oscillators.push(o);
    return o;
  }
  createGain(): MockGain {
    const g = new MockGain(this);
    this.gains.push(g);
    return g;
  }

  /** 逐采样渲染。
   * Web Audio 中 modGain 接到 carrier.frequency: 振荡器相位是频率的积分,
   * 即 phase(t) = 2π∫(fc + I(t)·sin(2π fm t))dt, 等价于标准 FM 相位形式
   * sin(2π fc t + β(t)·sin(2π fm t)), 其中 β 为 I(t) 的积分。
   * 对恒定 I 有 β=I; 对时变 I(t) 逐点累加 I·dt 得到瞬时 β。 */
  render(): Float32Array {
    const out = new Float32Array(this.length);
    const carrier = this.oscillators[0];
    const modulator = this.oscillators[1];
    const modGain = this.gains.find((g) =>
      this.connections.some((c) => c.from === modulator && c.to === g),
    )!;
    const voiceGain = this.gains.find((g) =>
      this.connections.some((c) => c.from === carrier && c.to === g),
    )!;

    const dt = 1 / this.sampleRate;
    for (let i = 0; i < this.length; i++) {
      const t = i * dt;
      const fc = carrier.frequency.at(t);
      const fm = modulator.frequency.at(t);
      // modGain 输出的是峰值频率偏移 Δf(t) (Hz); 调制指数 I = Δf / fm。
      const deltaF = modGain.gain.at(t);
      const I = fm > 0 ? deltaF / fm : 0;
      // 标准 FM 相位形式(用绝对时间, 避免离散相位累加漂移):
      // sin(2π fc t + I(t)·sin(2π fm t))
      const amp = voiceGain.gain.at(t);
      out[i] = amp * Math.sin(2 * Math.PI * fc * t + I * Math.sin(2 * Math.PI * fm * t));
    }
    return out;
  }
}

/** Goertzel 单频幅度估计, 对非 DFT 格点频率也稳定 */
export function amplitudeAt(samples: Float32Array, freq: number, sampleRate: number): number {
  const k = (2 * Math.PI * freq) / sampleRate;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + 2 * Math.cos(k) * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 / samples.length) * Math.hypot(s1 - Math.cos(k) * s2, Math.sin(k) * s2);
}
