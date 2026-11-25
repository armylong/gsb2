/**
 * 确定性单元测试（node --test，无浏览器依赖）。
 * 覆盖：折叠数学、FFT 往返、PRNG 可复现、限带抑制、正弦无假谐波、WAV、去直流。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeTable,
  buildPreset,
  foldFrequency,
  renderBandlimited,
  renderNaive,
  TABLE_SIZE,
  constantF0,
  removeDc,
  meanDc,
} from '../src/dsp/wavetable.ts';
import { classifyMeasurement } from '../src/dsp/spectrum.ts';
import { reconstructTable, realDftOneSided } from '../src/dsp/fft.ts';
import { mulberry32, buildTestSequence } from '../src/dsp/rng.ts';
import { encodeWavPcm16 } from '../src/dsp/wav.ts';

const SR = 48000;

test('折叠公式：越过奈奎斯特的分量镜像折回基带', () => {
  assert.equal(foldFrequency(30000, SR), 18000);
  assert.equal(foldFrequency(26000, SR), 22000);
  assert.equal(foldFrequency(50000, SR), 2000);
  // 基带内频率不受影响
  assert.equal(foldFrequency(1000, SR), 1000);
  // 奈奎斯特边界
  assert.equal(foldFrequency(SR / 2, SR), SR / 2);
});

test('DFT -> 重建往返：正弦表恢复误差 < 1e-10', () => {
  const table = buildPreset('sine', TABLE_SIZE);
  const { magnitude, phase } = realDftOneSided(table);
  const rebuilt = reconstructTable(TABLE_SIZE, magnitude, phase);
  let err = 0;
  for (let i = 0; i < TABLE_SIZE; i++) err = Math.max(err, Math.abs(rebuilt[i] - table[i]));
  assert.ok(err < 1e-10, `往返误差 ${err}`);
});

test('mulberry32 同种子序列完全一致，不同种子不同', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const c = mulberry32(12346);
  const seqA = Array.from({ length: 50 }, a);
  const seqB = Array.from({ length: 50 }, b);
  const seqC = Array.from({ length: 50 }, c);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('测试序列确定性：同种子同音高与时间', () => {
  const s1 = buildTestSequence(777, SR);
  const s2 = buildTestSequence(777, SR);
  assert.equal(s1.notes.length, 8);
  assert.deepEqual(s1.notes.map((n) => n.freq), s2.notes.map((n) => n.freq));
  assert.deepEqual(s1.notes.map((n) => n.start), s2.notes.map((n) => n.start));
  // 所有音都落在声明的范围内：C3-24 半音（C1）到 C3+36 半音（C6）
  const fMin = 440 * Math.pow(2, (48 - 24 - 69) / 12);
  const fMax = 440 * Math.pow(2, (48 + 36 - 69) / 12);
  for (const n of s1.notes) {
    assert.ok(n.freq >= fMin - 1e-9);
    assert.ok(n.freq <= fMax + 1e-9);
  }
});

test('A 模式高音符产生折叠分量，B 模式消除（尖锯齿）', () => {
  const table = buildPreset('sharp-saw', TABLE_SIZE);
  const coeffs = analyzeTable(table);
  const f0 = 1568;
  const length = SR * 1.2;
  const curve = constantF0(length, f0);
  const naive = renderNaive(table, { sampleRate: SR, f0Curve: curve });
  const band = renderBandlimited(coeffs, { sampleRate: SR, f0Curve: curve });

  const mNaive = classifyMeasurement(naive, SR, f0, 'naive', coeffs);
  const mBand = classifyMeasurement(band, SR, f0, 'bandlimited', coeffs);

  const aliasesNaive = mNaive.classified.filter((p) => p.kind === 'alias');
  const aliasesBand = mBand.classified.filter((p) => p.kind === 'alias');
  assert.ok(aliasesNaive.length > 0, '直接循环必须出现折叠峰');
  assert.equal(aliasesBand.length, 0, '限带模式不应有折叠峰');

  // 折叠峰频率必须与折叠公式对上（容差 1.5 个 FFT bin）
  const tol = (SR / 16384) * 1.5;
  for (const p of aliasesNaive) {
    const want = foldFrequency(p.harmonicK! * f0, SR);
    assert.ok(Math.abs(want - p.freq) <= tol);
  }
});

test('正弦例：任何模式都没有“多出的真峰”，额外频率不被当成真实谐波', () => {
  const table = buildPreset('sine', TABLE_SIZE);
  const coeffs = analyzeTable(table);
  for (const f0 of [130.81, 440, 2093]) {
    const length = SR * 1.2;
    const naive = renderNaive(table, { sampleRate: SR, f0Curve: constantF0(length, f0) });
    const m = classifyMeasurement(naive, SR, f0, 'naive', coeffs);
    const extras = m.classified.filter((p) => p.kind === 'extra');
    assert.equal(extras.length, 0, `f0=${f0} 出现 ${extras.length} 个假峰`);
    const harmonics = m.classified.filter((p) => p.kind === 'harmonic');
    assert.equal(harmonics.length, 1, '正弦只能有基频一个真实峰');
  }
});

test('去直流：均值归零且交流分量保持', () => {
  const table = buildPreset('notched', TABLE_SIZE).map((v, i) => v + 0.3 + 0.001 * i);
  const cleaned = removeDc(table);
  assert.ok(Math.abs(meanDc(cleaned)) < 1e-12);
  // 差值近似常数（原始偏移量）
  const diffs = table.map((v, i) => v - cleaned[i]);
  const spread = Math.max(...diffs) - Math.min(...diffs);
  assert.ok(spread < 0.01);
});

test('WAV 编码：头部字段与数据长度正确', () => {
  const ch = new Float64Array(100).fill(0.5);
  const blob = encodeWavPcm16([ch], SR);
  assert.equal(blob.size, 44 + 100 * 2);
  assert.equal(blob.type, 'audio/wav');
  const stereo = encodeWavPcm16([ch, ch], SR);
  assert.equal(stereo.size, 44 + 100 * 4);
});

test('窄凹口预设比正弦具有丰富高次谐波', () => {
  const sine = analyzeTable(buildPreset('sine', TABLE_SIZE));
  const notch = analyzeTable(buildPreset('notched', TABLE_SIZE));
  const countAbove = (c: ReturnType<typeof analyzeTable>, db: number) => {
    let n = 0;
    for (let k = 1; k < c.mag.length; k++) {
      const d = 20 * Math.log10(c.mag[k] + 1e-12);
      if (d > db) n++;
    }
    return n;
  };
  assert.ok(countAbove(notch, -60) > countAbove(sine, -60) * 3);
});
