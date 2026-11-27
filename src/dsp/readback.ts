import type { FormantRegion, Timeline } from '../types';
import { activeKeys } from './interp';
import { computeSpectrum } from './fft';
import { detectF0, findPeaks, isPeakClear, noiseFloor, type SpectralPeak } from './peaks';

export interface RegionReport {
  index: number;
  expectedCenter: number;
  expectedBandwidth: number;
  matchedPeak: SpectralPeak | null;
  deltaHz: number | null;
  status: 'ok' | 'weak' | 'missing' | 'merged';
  message: string;
}

export interface NodeReport {
  label: string;
  pos: number;
  f0: number | null;
  regions: RegionReport[];
  notes: string[];
}

export interface ReadbackReport {
  nodes: NodeReport[];
  /** 相邻节点之间共振中心的移动量（Hz），用于确认“口形变化”确实被记录进 WAV */
  movements: { label: string; from: number; to: number; deltaHz: number }[];
  globalNotes: string[];
}

function extractFrame(samples: Float32Array, sampleRate: number, t: number, halfWindowS = 0.06): Float32Array {
  const center = Math.floor(t * samples.length);
  const half = Math.floor(halfWindowS * sampleRate);
  const start = Math.max(0, center - half);
  const end = Math.min(samples.length, center + half);
  return samples.slice(start, end);
}

/** 判断两个共振区是否挨到一起（带宽重叠到无法分辨独立峰） */
function regionsOverlap(a: FormantRegion, b: FormantRegion): boolean {
  return Math.abs(a.center - b.center) < (a.bandwidth + b.bandwidth) / 2;
}

function matchRegion(
  region: FormantRegion,
  index: number,
  peaks: SpectralPeak[],
  floor: number,
  usedBins: Set<number>,
  merged: boolean,
): RegionReport {
  // 在期望中心 ±max(带宽, 15%) 的窗口内找最显著的未占用峰
  const window = Math.max(region.bandwidth, region.center * 0.15);
  const candidates = peaks.filter(
    (p) => !usedBins.has(p.bin) && Math.abs(p.freq - region.center) <= window,
  );
  const peak = candidates[0];
  if (merged) {
    return {
      index,
      expectedCenter: region.center,
      expectedBandwidth: region.bandwidth,
      matchedPeak: peak ?? null,
      deltaHz: peak ? peak.freq - region.center : null,
      status: 'merged',
      message: `共振区 ${index + 1} 与邻区重叠，回读只看到合并峰（${
        peak ? peak.freq.toFixed(0) + ' Hz' : '无'
      }），属预期现象。`,
    };
  }
  if (!peak || !isPeakClear(peak, floor)) {
    return {
      index,
      expectedCenter: region.center,
      expectedBandwidth: region.bandwidth,
      matchedPeak: null,
      deltaHz: null,
      status: peak ? 'weak' : 'missing',
      message:
        peak
          ? `共振区 ${index + 1} 处峰不清晰（prominence ${peak.prominence.toFixed(1)} dB），可能被气音或邻区掩盖。`
          : `共振区 ${index + 1}（${region.center.toFixed(0)} Hz）附近找不到清楚的峰。`,
    };
  }
  usedBins.add(peak.bin);
  return {
    index,
    expectedCenter: region.center,
    expectedBandwidth: region.bandwidth,
    matchedPeak: peak,
    deltaHz: peak.freq - region.center,
    status: 'ok',
    message: `共振区 ${index + 1}：期望 ${region.center.toFixed(0)} Hz，实测峰 ${peak.freq.toFixed(
      0,
    )} Hz，偏差 ${(peak.freq - region.center).toFixed(0)} Hz。`,
  };
}

/**
 * 对一段已导出的 PCM（即从 WAV 回读出的字节）做时间线节点附近的频率检查。
 */
export function readbackCheck(
  samples: Float32Array,
  sampleRate: number,
  timeline: Timeline,
  f0: number,
): ReadbackReport {
  const keys = activeKeys(timeline);
  const nodes: NodeReport[] = [];
  const globalNotes: string[] = [];

  const fftSize = samples.length >= 4096 ? 4096 : 2048;

  for (const key of keys) {
    const frame = extractFrame(samples, sampleRate, key.pos);
    const spec = computeSpectrum(frame, sampleRate, fftSize);
    const floor = noiseFloor(spec);
    const peaks = findPeaks(spec);
    const usedBins = new Set<number>();
    const notes: string[] = [];

    const mergedFlags = key.formants.map((r, i) => {
      if (i === 0) return regionsOverlap(r, key.formants[1]);
      if (i === 2) return regionsOverlap(r, key.formants[1]);
      return regionsOverlap(r, key.formants[0]) || regionsOverlap(r, key.formants[2]);
    });
    if (mergedFlags.some(Boolean)) notes.push('该节点存在相邻共振区重叠，重叠区按合并峰解释。');

    const regions = key.formants.map((r, i) => matchRegion(r, i, peaks, floor, usedBins, mergedFlags[i]));

    const measuredF0 = detectF0(frame, sampleRate);
    if (measuredF0 === null) {
      notes.push('该节点附近检测不到稳定基频（气音过重或信号过弱）。');
    } else if (Math.abs(measuredF0 - f0) / f0 > 0.08) {
      notes.push(`基频漂移：设定 ${f0.toFixed(1)} Hz，实测 ${measuredF0.toFixed(1)} Hz。`);
    }

    nodes.push({ label: key.label, pos: key.pos, f0: measuredF0, regions, notes });
  }

  // 节点间共振中心移动量
  const movements: ReadbackReport['movements'] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const from = nodes[i].regions[k].expectedCenter;
      const to = nodes[i + 1].regions[k].expectedCenter;
      movements.push({
        label: `F${k + 1}：${nodes[i].label} → ${nodes[i + 1].label}`,
        from,
        to,
        deltaHz: to - from,
      });
    }
  }

  const allMissing = nodes.every((nd) => nd.regions.every((r) => r.status === 'missing' || r.status === 'weak'));
  if (allMissing) globalNotes.push('所有节点均未找到清楚的峰：请降低气音比例或增大共振区增益后重新导出。');

  return { nodes, movements, globalNotes };
}
