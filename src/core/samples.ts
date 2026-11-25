export type Arrangement = 'front' | 'cross';
export type SampleId = 'front-uniform' | 'cross-dwell';

export interface DollySample {
  id: SampleId;
  label: string;
  arrangement: Arrangement;
  durationMs: number;
  description: string;
  keys: ReadonlyArray<readonly [progress: number, lod: number]>;
}

export const LOD_MIN = -1.5;
export const LOD_MAX = 7.2;

export const DOLLY_SAMPLES: DollySample[] = [
  {
    id: 'front-uniform',
    label: '样例 A：正面卡片匀速推远',
    arrangement: 'front',
    durationMs: 36_000,
    description: '同一张正面卡片，LOD 从放大级匀速走到 128px 原图的 1×1 末级。',
    keys: [
      [0, -1.5],
      [1, 7.2],
    ],
  },
  {
    id: 'cross-dwell',
    label: '样例 B：交叉卡片逐级驻留',
    arrangement: 'cross',
    durationMs: 48_000,
    description: '两张 ±45° 交叉卡片；在每个整数采样层短暂驻留，便于暂停和框选。',
    keys: [
      [0.0, -1.2],
      [0.08, 0],
      [0.16, 0],
      [0.24, 1],
      [0.32, 1],
      [0.4, 2],
      [0.48, 2],
      [0.56, 3],
      [0.64, 3],
      [0.72, 4],
      [0.79, 4],
      [0.86, 5],
      [0.91, 5],
      [0.95, 6],
      [0.98, 6],
      [1.0, 7.2],
    ],
  },
];

export function getSample(id: SampleId | string | null | undefined): DollySample {
  return DOLLY_SAMPLES.find((sample) => sample.id === id) ?? DOLLY_SAMPLES[0];
}

export function lodAtProgress(sample: DollySample, progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const keys = sample.keys;
  if (p <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (p >= last[0]) return last[1];

  for (let i = 0; i < keys.length - 1; i++) {
    const [p0, l0] = keys[i];
    const [p1, l1] = keys[i + 1];
    if (p >= p0 && p <= p1) {
      const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
      return l0 + (l1 - l0) * t;
    }
  }
  return last[1];
}

export function progressAtElapsed(sample: DollySample, elapsedMs: number, loop = true): number {
  if (!loop) return Math.min(1, Math.max(0, elapsedMs / sample.durationMs));
  const duration = sample.durationMs;
  if (elapsedMs <= 0) return 0;
  const remainder = elapsedMs % duration;
  // An exact boundary is the repeatable end pose (progress = 1), not phase 0.
  if (remainder === 0) return 1;
  return remainder / duration;
}

export function lodAtElapsed(sample: DollySample, elapsedMs: number, loop = true): number {
  return lodAtProgress(sample, progressAtElapsed(sample, elapsedMs, loop));
}

/** Nearest-mip selection matching NEAREST_MIPMAP_NEAREST's floor(lod + 0.5). */
export function selectMipLevel(geometricLod: number, maxLevel: number): number {
  return Math.max(0, Math.min(maxLevel, Math.floor(geometricLod + 0.5)));
}

export interface OrthoCamera {
  lod: number;
  level: number;
  viewHeight: number;
  pull: number;
  nominalDistance: number;
}

export const VIEWPORT_CSS_OR_BUFFER = 640;
export const CARD_WORLD_HEIGHT = 2;

export function cameraForLod(lod: number, sourceHeight: number, maxLevel: number): OrthoCamera {
  const viewHeight =
    (Math.pow(2, lod) * VIEWPORT_CSS_OR_BUFFER * CARD_WORLD_HEIGHT) / sourceHeight;
  return {
    lod,
    level: selectMipLevel(lod, maxLevel),
    viewHeight,
    pull: Math.pow(2, lod),
    nominalDistance: viewHeight / (2 * Math.tan((35 * Math.PI) / 360 / 2)),
  };
}
