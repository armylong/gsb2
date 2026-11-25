/**
 * 离线渲染：用与 AudioWorklet 完全相同的数学（renderNaive/renderBandlimited）
 * 在 TypeScript 里逐采样渲染，用于确定性测量与 WAV 导出。
 */
import { levelOffline } from './level';
import {
  analyzeTable,
  constantF0,
  renderBandlimited,
  renderNaive,
  sweepF0Curve,
  type HarmonicCoeffs,
  type RenderMode,
} from './wavetable';
import type { TestSequence } from './rng';

export interface RenderToneOptions {
  sampleRate: number;
  f0: number;
  duration: number;
  mode: RenderMode;
  table: Float64Array;
  coeffs?: HarmonicCoeffs;
  levelMatch?: boolean;
  /** 可选扫频（按住时平滑扫过一段音高） */
  sweep?: { semitoneRange: number; oneWaySeconds: number };
  /** 起音/释音毫秒，防止开关爆音 */
  attackMs?: number;
  releaseMs?: number;
}

export function renderTone(opts: RenderToneOptions): Float64Array {
  const {
    sampleRate,
    f0,
    duration,
    mode,
    table,
    levelMatch = true,
    sweep,
    attackMs = 8,
    releaseMs = 60,
  } = opts;
  const length = Math.round(duration * sampleRate);
  const f0Curve = sweep
    ? sweepF0Curve(length, sampleRate, f0, sweep.semitoneRange, sweep.oneWaySeconds)
    : constantF0(length, f0);

  const raw =
    mode === 'naive'
      ? renderNaive(table, { sampleRate, f0Curve })
      : renderBandlimited(opts.coeffs ?? analyzeTable(table), { sampleRate, f0Curve });

  applyEnvelope(raw, sampleRate, attackMs, releaseMs);
  return levelMatch ? levelOffline(raw, sampleRate) : raw;
}

/** 测试序列：逐音渲染后拼接（音间留空），两种模式各出一条声道。 */
export function renderSequence(
  seq: TestSequence,
  table: Float64Array,
  coeffs: HarmonicCoeffs,
  mode: RenderMode,
  levelMatch = true,
): Float64Array {
  const { sampleRate } = seq;
  const total = Math.round(seq.totalDuration * sampleRate);
  const mix = new Float64Array(total);
  for (const note of seq.notes) {
    const tone = renderTone({
      sampleRate,
      f0: note.freq,
      duration: note.duration,
      mode,
      table,
      coeffs,
      levelMatch,
    });
    const offset = Math.round(note.start * sampleRate);
    for (let i = 0; i < tone.length && offset + i < total; i++) {
      mix[offset + i] += tone[i];
    }
  }
  return mix;
}

function applyEnvelope(
  signal: Float64Array,
  sampleRate: number,
  attackMs: number,
  releaseMs: number,
): void {
  const atk = Math.max(1, Math.round((attackMs / 1000) * sampleRate));
  const rel = Math.max(1, Math.round((releaseMs / 1000) * sampleRate));
  for (let i = 0; i < atk && i < signal.length; i++) {
    signal[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / atk);
  }
  for (let i = 0; i < rel && i < signal.length; i++) {
    const idx = signal.length - 1 - i;
    signal[idx] *= 0.5 * (1 + Math.cos((Math.PI * i) / rel));
  }
}
