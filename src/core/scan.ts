import {
  type RatioSample,
  detectOnset,
  geometricSchedule,
  predictedOnset,
  worldGap,
} from './depthMath';
import type { DepthSession, SessionParams } from './depthSession';
import { GAP_RATIOS } from './labScene';

/** 扫描配置：完全可序列化，保证同样的输入得到同样的采样点。 */
export interface ScanConfig {
  near: number;
  far: number;
  fovDeg: number;
  startDistance: number;
  endDistance: number;
  steps: number;
  /** 与前文“保持参考物比例”一致：间距 = gapRatio × 当前距离 */
  gapScale: number;
  overlapThreshold: number;
  /** 连续多少个采样点达到阈值才判定为“开始不稳定” */
  sustain: number;
}

export interface ScanStep {
  step: number;
  distance: number;
  /** 每个组的争抢比例 */
  ratios: number[];
  contestedPx: number[];
  coveragePx: number[];
}

export interface TileOnset {
  index: number;
  gapRatio: number;
  measured: number | null;
  predicted: number | null;
  /** 触发阈值所需的连续样本数 */
  sustain: number;
}

export interface ScanResult {
  config: ScanConfig;
  steps: ScanStep[];
  onsets: TileOnset[];
  /** 结果指纹：同样的配置 + 硬件，重复运行应一致 */
  digest: string;
  elapsedMs: number;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  near: 0.1,
  far: 100000,
  fovDeg: 45,
  startDistance: 10,
  endDistance: 90000,
  steps: 90,
  gapScale: 1,
  overlapThreshold: 0.002,
  sustain: 3,
};

function fnv1aHex(values: number[]): string {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const text = value.toPrecision(8);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

export function configToParams(config: ScanConfig, distance: number): SessionParams {
  return {
    distance,
    near: config.near,
    far: config.far,
    fovDeg: config.fovDeg,
    keepScreenScale: true,
    gapScale: config.gapScale,
  };
}

/**
 * 在给定会话上执行一次固定相机扫描。
 *
 * 单个相机位置上的争抢像素数会被“深度码点栅格”的相位强烈调制：
 * 同一距离移动 0.1% 就可能从 0% 跳到 80%。这是真实存在的数值行为，
 * 但直接画出来是一条锯齿，无法读出趋势。
 *
 * 因此每个采样距离取 5 个等距子样本平均：子样本间距固定为步长的 1/5，
 * 完全由 distance 与 step 决定，不含随机数 —— 重跑同样输入得到同样结果。
 */
export const SUB_SAMPLES = 9;

export function scanDistances(config: ScanConfig): number[] {
  return geometricSchedule(config.startDistance, config.endDistance, config.steps);
}

/** 第 step 个采样点附近第 k 个子样本的距离（几何等距，确定性）。 */
export function subSampleDistance(
  config: ScanConfig,
  stepDistances: readonly number[],
  step: number,
  k: number,
): number {
  const count = stepDistances.length;
  const lo = stepDistances[Math.max(0, step - 1)];
  const hi = stepDistances[Math.min(count - 1, step + 1)];
  const neighbourSpan = Math.log(hi) - Math.log(lo) || Math.log(stepDistances[step]) * 1e-3;
  const offset = ((k + 0.5) / SUB_SAMPLES - 0.5) * neighbourSpan * 1.0;
  void config;
  return Math.exp(Math.log(stepDistances[step]) + offset);
}

export function runScan(
  session: DepthSession,
  config: ScanConfig,
  onStep?: (step: ScanStep, total: number) => void,
): ScanResult {
  const started = performance.now();
  const distances = scanDistances(config);
  const steps: ScanStep[] = [];
  const digestValues: number[] = [];

  for (let i = 0; i < distances.length; i++) {
    const distance = distances[i];
    const contestedSum = new Array<number>(GAP_RATIOS.length).fill(0);
    const coverageSum = new Array<number>(GAP_RATIOS.length).fill(0);

    for (let k = 0; k < SUB_SAMPLES; k++) {
      const subDistance = subSampleDistance(config, distances, i, k);
      const samples = session.sampleContention(configToParams(config, subDistance));
      for (let tile = 0; tile < samples.length; tile++) {
        contestedSum[tile] += samples[tile].contestedPx;
        coverageSum[tile] += samples[tile].coveragePx;
      }
    }

    const contestedAvg = contestedSum.map((v) => v / SUB_SAMPLES);
    const coverageAvg = coverageSum.map((v) => v / SUB_SAMPLES);
    const step: ScanStep = {
      step: i,
      distance,
      ratios: contestedAvg.map((v, tile) => (coverageAvg[tile] ? v / coverageAvg[tile] : 0)),
      contestedPx: contestedAvg.map((v) => Math.round(v)),
      coveragePx: coverageAvg.map((v) => Math.round(v)),
    };
    steps.push(step);
    for (const ratio of step.ratios) digestValues.push(Math.round(ratio * 1e6) / 1e6);
    onStep?.(step, distances.length);
  }

  const sessionsMode = session.effectiveMode;
  const sessionsStorage = session.storageModel();
  const onsets: TileOnset[] = GAP_RATIOS.map((gapRatio, index) => {
    const series: RatioSample[] = steps.map((step) => ({
      z: step.distance,
      ratio: step.ratios[index],
    }));
    return {
      index,
      gapRatio,
      measured: detectOnset(series, config.overlapThreshold, config.sustain),
      predicted: predictedOnset(
        gapRatio * config.gapScale,
        config.near,
        config.far,
        sessionsMode,
        sessionsStorage,
      ),
      sustain: config.sustain,
    };
  });

  return {
    config,
    steps,
    onsets,
    digest: fnv1aHex(digestValues),
    elapsedMs: performance.now() - started,
  };
}

/** 世界间距辅助导出，便于结果面板展示。 */
export function stepGapWorld(config: ScanConfig, distance: number): number[] {
  return GAP_RATIOS.map((ratio) => worldGap(ratio * config.gapScale, distance));
}

/** 把扫描结果转成便于复制/存档的纯文本摘要。 */
export function formatScanSummary(result: ScanResult, modeLabel: string): string {
  const lines: string[] = [];
  lines.push(`# 深度扫描结果 (${modeLabel})`);
  lines.push(
    `# near=${result.config.near} far=${result.config.far} fov=${result.config.fovDeg} ` +
      `start=${result.config.startDistance} end=${result.config.endDistance} steps=${result.config.steps} ` +
      `threshold=${result.config.overlapThreshold} sustain=${result.config.sustain}`,
  );
  lines.push(`# digest=${result.digest} elapsed=${result.elapsedMs.toFixed(1)}ms`);
  lines.push('tile\tgapRatio\tonsetDistance\tpredictedLowerBound');
  for (const onset of result.onsets) {
    lines.push(
      [
        onset.index,
        onset.gapRatio,
        onset.measured === null ? 'null' : onset.measured.toPrecision(8),
        onset.predicted === null ? 'null' : onset.predicted.toPrecision(8),
      ].join('\t'),
    );
  }
  return lines.join('\n');
}
