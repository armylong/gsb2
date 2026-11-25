import { describe, expect, it } from 'vitest';
import { besselJ } from '../src/audio/bessel';
import { foldFrequency, analyzeSidebands } from '../src/audio/sidebands';
import { sampleCurve, normalizeCurve } from '../src/audio/curve';
import { midiToFreq, midiToName, nameToMidi } from '../src/audio/notes';
import { encodeWav } from '../src/audio/wav';
import { defaultPatch } from '../src/audio/patch-utils';

describe('bessel J_n', () => {
  it('J0(0)=1, Jn(0)=0 for n>0', () => {
    expect(besselJ(0, 0)).toBe(1);
    expect(besselJ(3, 0)).toBe(0);
  });

  it('matches known values to 4 decimals', () => {
    // 标准表: J0(1)=0.7652, J1(1)=0.4401, J0(5)=-0.1776, J2(3)=0.4861
    expect(besselJ(0, 1)).toBeCloseTo(0.7652, 4);
    expect(besselJ(1, 1)).toBeCloseTo(0.4401, 4);
    expect(besselJ(0, 5)).toBeCloseTo(-0.1776, 4);
    expect(besselJ(2, 3)).toBeCloseTo(0.4861, 4);
  });

  it('handles large order and argument used by the bell preset', () => {
    const v = besselJ(10, 4);
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThan(1);
  });

  it('negative argument flips sign with parity', () => {
    expect(besselJ(1, -2)).toBeCloseTo(-besselJ(1, 2), 10);
    expect(besselJ(2, -2)).toBeCloseTo(besselJ(2, 2), 10);
  });
});

describe('frequency folding', () => {
  it('passes through in-band frequencies', () => {
    expect(foldFrequency(1000, 24000)).toBe(1000);
  });
  it('folds negative frequencies by absolute value', () => {
    expect(foldFrequency(-500, 24000)).toBe(500);
  });
  it('triangular-folds above Nyquist (e.g. 30k @ sr48k)', () => {
    // nyquist 24000: 30000 -> 48000-30000 = 18000
    expect(foldFrequency(30000, 24000)).toBe(18000);
  });
  it('folds beyond one full period', () => {
    // 55000 % 48000 = 7000
    expect(foldFrequency(55000, 24000)).toBe(7000);
  });
});

describe('sideband analysis', () => {
  it('at zero depth only the carrier (J0≈1) survives above threshold', () => {
    const patch = { ...defaultPatch(), modDepth: 0, modRatio: 2 };
    const a = analyzeSidebands(patch, 440, 48000);
    const audible = a.sidebands.filter((s) => s.levelDb > -40);
    expect(audible.length).toBe(1);
    expect(audible[0].order).toBe(0);
    expect(audible[0].levelDb).toBeCloseTo(0, 1);
  });

  it('places sidebands at fc + n*fm and flags above-Nyquist ones', () => {
    const patch = { ...defaultPatch(), modDepth: 3, modRatio: 2 };
    const a = analyzeSidebands(patch, 1000, 8000); // nyquist 4000, fm=2000
    const n1 = a.sidebands.find((s) => s.order === 1)!;
    expect(n1.nominalHz).toBe(3000);
    const n2 = a.sidebands.find((s) => s.order === 2)!;
    expect(n2.nominalHz).toBe(5000);
    expect(n2.aliased).toBe(true);
    // 5000 folded with nyquist 4000 -> 8000-5000=3000
    expect(n2.audibleHz).toBe(3000);
    expect(a.hasAboveNyquist).toBe(true);
  });

  it('deep bell preset yields several strong inharmonic bands', () => {
    const patch = { ...defaultPatch(), modDepth: 4, modRatio: 2.76 };
    const a = analyzeSidebands(patch, 440, 48000);
    const strong = a.sidebands.filter((s) => s.levelDb > -20);
    expect(strong.length).toBeGreaterThanOrEqual(4);
  });
});

describe('curve sampling', () => {
  const pts = normalizeCurve([
    { t: 0, v: 1 },
    { t: 0.5, v: 0.5 },
    { t: 1, v: 0 },
  ]);
  it('interpolates piecewise linearly', () => {
    expect(sampleCurve(pts, 0.25)).toBeCloseTo(0.75, 6);
    expect(sampleCurve(pts, 0.75)).toBeCloseTo(0.25, 6);
  });
  it('clamps outside [0,1]', () => {
    expect(sampleCurve(pts, -1)).toBe(1);
    expect(sampleCurve(pts, 2)).toBe(0);
  });
  it('normalizeCurve guarantees endpoints', () => {
    const c = normalizeCurve([{ t: 0.3, v: 0.2 }]);
    expect(c[0].t).toBe(0);
    expect(c[c.length - 1].t).toBe(1);
  });
});

describe('notes', () => {
  it('A4 = 440Hz and round-trips names', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(midiToName(69)).toBe('A4');
    expect(nameToMidi('A4')).toBe(69);
    expect(nameToMidi('C4')).toBe(60);
  });
});

describe('wav encoder', () => {
  it('emits a valid RIFF/WAVE header and correct sizes', () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.1) * 0.5);
    const blob = encodeWav(samples, 44100);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 2000);
  });
});
