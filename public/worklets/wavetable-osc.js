/**
 * 实时波表振荡器（AudioWorklet，纯 JS，由 Vite 原样拷贝）。
 * 数学必须与 src/dsp/wavetable.ts 中的 renderNaive / renderBandlimited 保持一致；
 * src/checks.ts 会用离线渲染对比两条实现，防止漂移。
 *
 * 参数：
 *   f0        基频 Hz（a-rate 自动化，逐采样平滑扫频）
 *   gate      0/1，按键包络（a-rate）
 *   abMix     0 = A 直接循环，1 = B 限带，中间值为线性交叉淡化
 *   levelOn   等响度对齐开关（k-rate）
 */
const TABLE_N = 2048;
const BINS = TABLE_N >> 1;
const TARGET_RMS = 0.12;
const TWO_PI = 2 * Math.PI;

function makeBandState() {
  return {
    mag: new Float64Array(BINS + 1),
    phase: new Float64Array(BINS + 1),
    theta: new Float64Array(BINS + 1),
  };
}

class WavetableProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'f0', defaultValue: 220, automationRate: 'a-rate' },
      { name: 'gate', defaultValue: 0, automationRate: 'a-rate' },
      { name: 'abMix', defaultValue: 1, automationRate: 'a-rate' },
      { name: 'levelOn', defaultValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phaseA = 0;
    this.table = new Float64Array(TABLE_N);
    this.band = makeBandState();
    this.pending = null; // 热替换中的第二套状态
    this.tableFade = 1;
    this.env = 0;
    this.rmsEnv = 0;
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (msg.type === 'setTable') {
      const table = Float64Array.from(msg.table);
      const mag = Float64Array.from(msg.mag);
      const phase = Float64Array.from(msg.phase);
      const theta = new Float64Array(BINS + 1);
      for (let k = 1; k <= BINS; k++) theta[k] = phase[k];
      this.pending = {
        table,
        band: { mag, phase, theta },
      };
      this.tableFade = 0;
    } else if (msg.type === 'resetPhase') {
      this.phaseA = 0;
      for (let k = 1; k <= BINS; k++) this.band.theta[k] = this.band.phase[k];
    }
  }

  interp(table, pos) {
    const n = table.length;
    let p = pos % n;
    if (p < 0) p += n;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % n;
    return table[i0] * (1 - frac) + table[i1] * frac;
  }

  /** A 路：直接循环（两套表共用同一相位位置，交叉淡化时不会拍频）。 */
  naiveAt(table, f0, advance) {
    const v = this.interp(table, this.phaseA);
    if (advance) {
      this.phaseA += (f0 * TABLE_N) / sampleRate;
      if (this.phaseA >= TABLE_N) this.phaseA %= TABLE_N;
    }
    return v;
  }

  /** B 路：限带加法，状态各自独立。增益在奈奎斯特处连续归零。 */
  bandAt(state, f0) {
    const nyquist = sampleRate / 2;
    const fadeStart = nyquist * 0.98;
    let v = state.mag[0];
    for (let k = 1; k <= BINS; k++) {
      const fk = k * f0;
      if (fk > nyquist) break;
      let gain = 1;
      if (fk > fadeStart) {
        const x = (fk - fadeStart) / (nyquist - fadeStart);
        const clamped = Math.min(1, Math.max(0, x / 0.12));
        gain = 0.5 * (1 + Math.cos(Math.PI * clamped));
      }
      v += state.mag[k] * gain * Math.cos(state.theta[k]);
      state.theta[k] += (TWO_PI * fk) / sampleRate;
      if (state.theta[k] > 1e6) state.theta[k] %= TWO_PI;
    }
    return v;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const block = out.length;
    const f0Arr = parameters.f0;
    const gateArr = parameters.gate;
    const abArr = parameters.abMix;
    const levelOn = parameters.levelOn[0] > 0.5;

    const rmsCoeff = 1 - Math.exp(-1 / (sampleRate * 0.12));
    const envCoeff = 1 - Math.exp(-1 / (sampleRate * 0.008));
    const tableFadeStep = 1 / Math.max(1, sampleRate * 0.008);

    for (let i = 0; i < block; i++) {
      const f0 = f0Arr.length > 1 ? f0Arr[i] : f0Arr[0];
      const gate = gateArr.length > 1 ? gateArr[i] : gateArr[0];
      const ab = abArr.length > 1 ? abArr[i] : abArr[0];
      this.env += envCoeff * (gate - this.env);

      let vA;
      let vB;
      if (this.pending && this.tableFade < 1) {
        const f = this.tableFade;
        const oldA = this.naiveAt(this.table, f0, false);
        const newA = this.naiveAt(this.pending.table, f0, true); // 共享 phaseA，只推进一次
        vA = oldA * (1 - f) + newA * f;
        const oldB = this.bandAt(this.band, f0);
        const newB = this.bandAt(this.pending.band, f0);
        vB = oldB * (1 - f) + newB * f;
        this.tableFade = Math.min(1, this.tableFade + tableFadeStep);
        if (this.tableFade >= 1) {
          this.table = this.pending.table;
          this.band = this.pending.band;
          this.pending = null;
        }
      } else {
        vA = this.naiveAt(this.table, f0, true);
        vB = this.bandAt(this.band, f0);
      }

      let v = vA * (1 - ab) + vB * ab;
      v *= this.env;

      if (levelOn) {
        this.rmsEnv += rmsCoeff * (v * v - this.rmsEnv);
        const g = Math.min(8, TARGET_RMS / (Math.sqrt(this.rmsEnv) + 1e-7));
        v *= g;
      }
      out[i] = v;
    }
    return true;
  }
}

registerProcessor('wavetable-osc', WavetableProcessor);
