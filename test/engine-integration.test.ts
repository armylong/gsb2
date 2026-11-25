import { describe, expect, it } from 'vitest';
import { amplitudeAt, MockContext } from './mock-audio';
import { createFmBellVoice, stopVoice, voiceEndTime } from '../src/audio/engine';
import { defaultPatch } from '../src/audio/patch-utils';
import { besselJ } from '../src/audio/bessel';

const SR = 48000;

function render(patchOverrides: Partial<ReturnType<typeof defaultPatch>> = {}): Float32Array {
  const patch = { ...defaultPatch(), ...patchOverrides };
  patch.decayTime = patchOverrides.decayTime ?? 0.6;
  patch.modelTime = patchOverrides.modelTime ?? 0.4;
  const duration = voiceEndTime(patch, 0);
  const ctx = new MockContext(Math.ceil(duration * SR), SR);
  const voice = createFmBellVoice(
    ctx as unknown as BaseAudioContext,
    ctx.destination as unknown as AudioNode,
    69,
    patch,
    0,
  );
  stopVoice(voice, duration);
  return ctx.render();
}

describe('FM render integration (mocked WebAudio graph)', () => {
  it('I=0 renders essentially a pure carrier tone', () => {
    // 恒定深度(=0) + 长衰减, 让分析窗近似稳态
    const samples = render({
      modDepth: 0,
      modRatio: 2,
      decayTime: 20,
      depthCurve: [
        { t: 0, v: 1 },
        { t: 1, v: 1 },
      ],
    });
    const seg = samples.slice(SR, SR + Math.floor(0.5 * SR));
    const fc = 440;
    const carrierAmp = amplitudeAt(seg, fc, SR);
    const sideAmp = amplitudeAt(seg, fc + 2 * fc, SR); // n=1 位置
    // 窗内增益在 0.38~0.29 间缓降, 载波幅度应落在该量级
    expect(carrierAmp).toBeGreaterThan(0.2);
    // 侧带相对载波低于 -40dB
    expect(20 * Math.log10(sideAmp / carrierAmp)).toBeLessThan(-40);
  });

  it('constant I produces sidebands at fc + n*fm matching J_n(I) magnitudes', () => {
    const I = 4;
    const ratio = 2.76; // 与强侧带电铃预设一致的非谐波比
    const samples = render({
      modDepth: I,
      modRatio: ratio,
      decayTime: 20, // 近似恒定幅度, 消除包络展宽
      depthCurve: [
        { t: 0, v: 1 },
        { t: 1, v: 1 },
      ],
    });
    const seg = samples.slice(SR, SR + Math.floor(0.5 * SR));
    const fc = 440;
    const fm = fc * ratio;
    const carrierAmp = amplitudeAt(seg, fc, SR);
    // 窗内平均增益约 0.33, |J0(4)|=0.40 => 载波幅度约 0.13
    expect(carrierAmp).toBeGreaterThan(0.08);

    for (const n of [1, 2, 3]) {
      const target = fc + n * fm;
      const amp = amplitudeAt(seg, target, SR);
      const expectedRatio = Math.abs(besselJ(n, I)) / Math.abs(besselJ(0, I));
      const measuredRatio = amp / carrierAmp;
      // Goertzel + 近似稳态窗, 容差 0.7x..1.3x
      expect(measuredRatio).toBeGreaterThan(expectedRatio * 0.7);
      expect(measuredRatio).toBeLessThan(expectedRatio * 1.3 + 0.02);
    }
  });

  it('amplitude envelope decays to near silence by the tail end', () => {
    const samples = render();
    const tail = samples.slice(-2048);
    const peak = Math.max(...tail.map((v) => Math.abs(v)));
    expect(peak).toBeLessThan(0.01);
  });

  it('depth curve ramping to zero makes tail sidebands weaker than head sidebands', () => {
    const samples = render({
      modDepth: 4,
      modRatio: 2,
      modelTime: 0.4,
      decayTime: 20,
      depthCurve: [
        { t: 0, v: 1 },
        { t: 0.5, v: 0.2 },
        { t: 1, v: 0 },
      ],
    });
    const fc = 440;
    const fm = fc * 2;
    // 头段: 深度接近峰值 I=4, 侧带强
    const head = samples.slice(Math.floor(0.02 * SR), Math.floor(0.27 * SR));
    // 尾段: 曲线已归零, 调制频率偏移消失, 但调制相位项 β 冻结在某常数,
    // 故仍有与该冻结 β 对应的固定侧带, 只是远弱于峰值深度时
    const tail = samples.slice(Math.floor(0.5 * SR), Math.floor(0.75 * SR));
    const headSide = amplitudeAt(head, fc + fm, SR);
    const tailSide = amplitudeAt(tail, fc + fm, SR);
    const headCarrier = amplitudeAt(head, fc, SR);
    const tailCarrier = amplitudeAt(tail, fc, SR);

    // 头段侧带相对载波较强 (I=4 时 J1/J0 约 0.17, 但非稳态会更高)
    expect(20 * Math.log10(headSide / headCarrier)).toBeGreaterThan(-20);
    // 尾段侧带相对载波明显变小
    expect(20 * Math.log10(tailSide / tailCarrier)).toBeLessThan(
      20 * Math.log10(headSide / headCarrier) - 8,
    );
    // 绝对幅度: 尾段侧带不到头段的一半
    expect(tailSide).toBeLessThan(headSide * 0.5);
  });
});
