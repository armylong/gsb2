import { describe, expect, it } from 'vitest';
import {
  analyticEnvelope,
  createBlockOutput,
  createKernelState,
  renderBlock,
  renderOffline,
  routeGains,
  wrapPhase,
  type ToneSpec,
} from '../src/dsp/kernel';
import { encodeWav, parseWav } from '../src/dsp/wav';
import { estimateTone, expectedBeat } from '../src/dsp/analyze';
import { analyzeSeam } from '../src/audio/segment';
import { defaultSegment, freqAt } from '../src/audio/segment';

const SR = 48000;
const tone = (f: number, p = 0, g = 0.2): ToneSpec => ({ freq: f, phase: p, gain: g });

describe('等功率路由', () => {
  it('split 系数每耳只收一路、mix 系数平方和与 split 相等', () => {
    const split = routeGains(0);
    const mix = routeGains(1);
    // split 端点：L 只收 A、R 只收 B
    expect(split.aToL).toBeCloseTo(1, 6);
    expect(split.bToR).toBeCloseTo(1, 6);
    expect(split.aToR).toBeCloseTo(0, 6);
    expect(split.bToL).toBeCloseTo(0, 6);
    // mix 端点：两耳完全对称，每路分量都是 1/√2
    expect(mix.aToL).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(mix.bToL).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(mix.aToR).toBeCloseTo(mix.bToL, 6);
    expect(mix.aToL).toBeCloseTo(mix.bToR, 6);
    // 过渡过程功率不低于端点（无响度塌陷），端点严格相等
    for (const b of [0, 0.25, 0.5, 0.75, 1]) {
      const g = routeGains(b);
      expect(g.aToL ** 2 + g.bToL ** 2).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(g.aToR ** 2 + g.bToR ** 2).toBeGreaterThanOrEqual(1 - 1e-9);
    }
    const e0 = routeGains(0);
    const e1 = routeGains(1);
    expect(e0.aToL ** 2 + e0.bToL ** 2).toBeCloseTo(1, 6);
    expect(e1.aToL ** 2 + e1.bToL ** 2).toBeCloseTo(1, 6);
  });
});

describe('相位累加与拍', () => {
  it('恒定频率渲染后相位推进与解析包络正确', () => {
    const state = createKernelState(tone(440), tone(442), 'split');
    const out = createBlockOutput(1024);
    renderBlock(state, 1024, SR, [440, 442], out);
    // 1024 样本后 A 的累积相位 ≈ 2π·440·1024/48000
    const expectPA = (2 * Math.PI * 440 * 1024) / SR;
    expect(wrapPhase(state.phases[0] - expectPA)).toBeCloseTo(0, 4);
    // 包络范围 0..2g
    expect(Math.min(...out.envelope)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out.envelope)).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it('同频同相时包络恒定为 2g（拍动停止）', () => {
    const r = renderOffline(
      {
        duration: 0.5,
        startPhase: [0, 0],
        gains: [0.2, 0.2],
        mode: 'mix',
        freqs: [440, 440],
        fade: 0,
      },
      SR,
    );
    const mid = r.envelope.subarray(SR * 0.1, SR * 0.4);
    const mean = mid.reduce((a, b) => a + b, 0) / mid.length;
    expect(mean).toBeCloseTo(0.4, 3);
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThan(1e-4);
  });

  it('频差 2 Hz 时每秒恰有 2 个包络峰', () => {
    const r = renderOffline(
      {
        duration: 2,
        startPhase: [0, 0],
        gains: [0.2, 0.2],
        mode: 'mix',
        freqs: [440, 442],
        fade: 0,
      },
      SR,
    );
    // 包络 = 2g|cos(π·Δf·t)|，周期 1/Δf = 0.5s，2 秒应有 4 个峰
    const peaks = countPeaks(r.envelope, SR);
    expect(peaks).toBeGreaterThanOrEqual(3);
    expect(peaks).toBeLessThanOrEqual(5);
  });

  it('analyticEnvelope 与内核输出一致', () => {
    const state = createKernelState(tone(440), tone(443), 'mix');
    const out = createBlockOutput(2048);
    renderBlock(state, 2048, SR, [440, 443], out);
    const env = analyticEnvelope(0.2, 0.2, out.phaseDiff);
    for (let i = 0; i < env.length; i += 37) expect(env[i]).toBeCloseTo(out.envelope[i], 5);
  });
});

describe('扫频连续性', () => {
  it('块内线性插值，相邻块频率无跳变、相位连续', () => {
    const state = createKernelState(tone(440), tone(440), 'split');
    const out = createBlockOutput(128);
    let prevEnd = 440;
    let prevPhase = state.phases[0];
    for (let k = 1; k <= 20; k++) {
      const target = 440 + k * 2;
      renderBlock(state, 128, SR, [target, 440], out);
      expect(out.freqA[0]).toBeCloseTo(prevEnd, 6);
      // 相位单调连续，无回卷
      expect(state.phases[0]).toBeGreaterThan(prevPhase);
      prevEnd = target;
      prevPhase = state.phases[0];
    }
  });

  it('离线扫频轨迹在穿越点拍频为零', () => {
    const spec = defaultSegment('split');
    spec.duration = 2;
    spec.sweep = { a: [440, 440], b: [432, 448] };
    const mid = freqAt(spec, 1);
    expect(mid[1]).toBeCloseTo(440, 6);
    expect(expectedBeat(mid[0], mid[1])).toBeCloseTo(0, 6);
  });
});

describe('WAV 往返', () => {
  it('16-bit 立体声编码后解析，频率与幅度保持', () => {
    const r = renderOffline(
      {
        duration: 1,
        startPhase: [0, 0],
        gains: [0.2, 0.2],
        mode: 'split',
        freqs: [440, 444],
        fade: 0,
      },
      SR,
    );
    const blob = encodeWav([r.left, r.right], SR, 16);
    return blob.arrayBuffer().then((ab) => {
      const parsed = parseWav(ab);
      expect(parsed.numChannels).toBe(2);
      expect(parsed.sampleRate).toBe(SR);
      expect(parsed.bitDepth).toBe(16);
      const eL = estimateTone(parsed.channels[0], SR);
      const eR = estimateTone(parsed.channels[1], SR);
      // 32768 点 FFT 的 bin 宽约 1.46 Hz，抛物线插值后亚 bin 精度放宽到 0.3 Hz
      expect(eL.freq).toBeCloseTo(440, 0);
      expect(Math.abs(eL.freq - 440)).toBeLessThan(0.3);
      expect(eR.freq).toBeCloseTo(444, 0);
      expect(Math.abs(eR.freq - 444)).toBeLessThan(0.3);
      // 加窗 FFT 峰值在分数 bin 有泄漏，幅度用时域 RMS 精确核验（纯音 A = RMS·√2）
      let sumSq = 0;
      const seg = parsed.channels[0].subarray(SR * 0.1, SR * 0.9);
      for (const v of seg) sumSq += v * v;
      const rmsAmp = Math.sqrt(sumSq / seg.length) * Math.SQRT2;
      expect(Math.abs(rmsAmp - 0.2)).toBeLessThan(0.002);
      // 量化噪声很小
      let err = 0;
      for (let i = 0; i < r.left.length; i++) err += (parsed.channels[0][i] - r.left[i]) ** 2;
      expect(Math.sqrt(err / r.left.length)).toBeLessThan(1e-4);
    });
  });

  it('32-bit 浮点往返误差接近机器精度', () => {
    const r = renderOffline(
      {
        duration: 0.5,
        startPhase: [0.2, 0.4],
        gains: [0.15, 0.25],
        mode: 'mix',
        freqs: [300, 305],
        fade: 0.02,
      },
      SR,
    );
    const blob = encodeWav([r.left, r.right], SR, 32);
    return blob.arrayBuffer().then((ab) => {
      const parsed = parseWav(ab);
      let err = 0;
      for (let i = 0; i < r.left.length; i++) err += (parsed.channels[0][i] - r.left[i]) ** 2;
      expect(Math.sqrt(err / r.left.length)).toBeLessThan(1e-6);
    });
  });
});

describe('循环接缝', () => {
  it('恒定频、整周期时长 → 相位与频率都连续', () => {
    const spec = defaultSegment('split');
    spec.duration = 1; // 440 与 444 都是整数 Hz，1 秒后相位都是 2π 整数倍
    spec.sweep = { a: [440, 440], b: [444, 444] };
    spec.fade = 0;
    const r = renderOffline(
      {
        duration: spec.duration,
        startPhase: spec.startPhase,
        gains: spec.gains,
        mode: spec.mode,
        freqs: [440, 444],
        fade: 0,
      },
      SR,
    );
    const seam = analyzeSeam(spec, r);
    expect(seam.phaseContinuous).toBe(true);
    expect(seam.freqContinuous).toBe(true);
    expect(Math.abs(seam.diffJump)).toBeLessThan(0.4);
  });

  it('非整周期时长 → 接缝相位跳变可被检出', () => {
    const spec = defaultSegment('split');
    spec.duration = 0.333;
    spec.sweep = { a: [440, 440], b: [444, 444] };
    spec.fade = 0;
    const r = renderOffline(
      {
        duration: spec.duration,
        startPhase: spec.startPhase,
        gains: spec.gains,
        mode: spec.mode,
        freqs: [440, 444],
        fade: 0,
      },
      SR,
    );
    const seam = analyzeSeam(spec, r);
    expect(seam.phaseContinuous).toBe(false);
    expect(Math.abs(seam.diffJump)).toBeGreaterThan(0.1);
  });

  it('扫频段接缝频率不连续', () => {
    const spec = defaultSegment('split');
    spec.duration = 2;
    spec.sweep = { a: [440, 440], b: [432, 448] };
    spec.fade = 0;
    const r = renderOffline(
      {
        duration: spec.duration,
        startPhase: spec.startPhase,
        gains: spec.gains,
        mode: spec.mode,
        freqs: [440, 432],
        fade: 0,
      },
      SR,
      1024,
      (t) => freqAt(spec, t),
    );
    const seam = analyzeSeam(spec, r);
    expect(seam.freqContinuous).toBe(false);
    expect(Math.abs(seam.freqJump[1])).toBeCloseTo(16, 5);
  });
});

function countPeaks(env: Float32Array, sr: number): number {
  // 简单峰值计数：局部最大且高于均值
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  let peaks = 0;
  const gap = Math.floor(sr * 0.05);
  let last = -gap;
  for (let i = 2; i < env.length - 2; i++) {
    if (
      env[i] > mean &&
      env[i] >= env[i - 1] &&
      env[i] >= env[i + 1] &&
      env[i] > env[i - 2] &&
      env[i] > env[i + 2] &&
      i - last > gap
    ) {
      peaks++;
      last = i;
    }
  }
  return peaks;
}
