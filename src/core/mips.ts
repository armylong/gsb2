import { cloneImage, createImage, type RGBAImage } from './image.ts';

export type ChainMode = 'ordinary' | 'area';

export interface LevelStats {
  level: number;
  width: number;
  height: number;
  texels: number;
  image: RGBAImage;
  histogram: number[];
  passCount: number;
  passRatio: number;
  sourcePassRatio: number;
  expectedCount: number;
  targetCount: number;
  targetRatio: number;
  /** Actual passing texels minus the continuous area-scaled expectation. */
  deltaCount: number;
  deltaRatio: number;
  /** Delta converted back to source-image texel equivalents. */
  equivalentSourceDelta: number;
  /** Nearest feasible integer target minus actual passes; >0 means clipping loss. */
  clippedVsTarget: number;
  /** Integer rounding residual between targetCount and expectedCount. */
  quantizationResidual: number;
}

export interface MipChain {
  mode: ChainMode;
  cutoff: number;
  images: RGBAImage[];
  levels: LevelStats[];
  sourcePassCount: number;
  sourcePassRatio: number;
  firstLossLevel: number | null;
  /** First level retaining at most half of the nearest integer area target. */
  severeLossLevel: number | null;
}

export interface MipComparison {
  cutoff: number;
  rawImages: RGBAImage[];
  ordinary: MipChain;
  area: MipChain;
}

export function clampCutoff(value: number): number {
  if (!Number.isFinite(value)) return 128;
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function countPassing(image: RGBAImage, cutoff: number): number {
  const t = clampCutoff(cutoff);
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] >= t) count++;
  }
  return count;
}

export function alphaHistogram(image: RGBAImage, bins = 16): number[] {
  const result = new Array<number>(bins).fill(0);
  for (let p = 0; p < image.width * image.height; p++) {
    const a = image.data[p * 4 + 3];
    const bin = Math.min(bins - 1, Math.floor((a / 256) * bins));
    result[bin]++;
  }
  return result;
}

function sampleBounds(size: number, outSize: number, outIndex: number): [number, number] {
  if (size === outSize) return [outIndex, outIndex];
  const a = outIndex * 2;
  const b = Math.min(size - 1, a + 1);
  return [a, b];
}

/**
 * Coverage-box reduction with alpha-weighted RGB.
 *
 * Alpha is the ordinary mean coverage. Color is weighted by source alpha, so
 * RGB stored under transparent texels cannot create a dark/magenta fringe.
 */
export function downsampleSafe(source: RGBAImage): RGBAImage {
  const width = Math.max(1, Math.floor(source.width / 2));
  const height = Math.max(1, Math.floor(source.height / 2));
  const output = createImage(width, height);

  for (let y = 0; y < height; y++) {
    const [y0, y1] = sampleBounds(source.height, height, y);
    for (let x = 0; x < width; x++) {
      const [x0, x1] = sampleBounds(source.width, width, x);
      let alphaSum = 0;
      let weightedR = 0;
      let weightedG = 0;
      let weightedB = 0;
      let samples = 0;

      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const i = (sy * source.width + sx) * 4;
          const a = source.data[i + 3];
          alphaSum += a;
          weightedR += source.data[i] * a;
          weightedG += source.data[i + 1] * a;
          weightedB += source.data[i + 2] * a;
          samples++;
        }
      }

      const out = (y * width + x) * 4;
      const alpha = Math.round(alphaSum / samples);
      output.data[out + 3] = alpha;
      if (alphaSum > 0) {
        output.data[out] = Math.round(weightedR / alphaSum);
        output.data[out + 1] = Math.round(weightedG / alphaSum);
        output.data[out + 2] = Math.round(weightedB / alphaSum);
      } else {
        output.data[out] = 0;
        output.data[out + 1] = 0;
        output.data[out + 2] = 0;
      }
    }
  }

  return output;
}

/** Deliberately wrong straight RGBA average; useful only as a bleed/fringe control. */
export function downsampleNaive(source: RGBAImage): RGBAImage {
  const width = Math.max(1, Math.floor(source.width / 2));
  const height = Math.max(1, Math.floor(source.height / 2));
  const output = createImage(width, height);

  for (let y = 0; y < height; y++) {
    const [y0, y1] = sampleBounds(source.height, height, y);
    for (let x = 0; x < width; x++) {
      const [x0, x1] = sampleBounds(source.width, width, x);
      const sums = [0, 0, 0, 0];
      let samples = 0;
      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const i = (sy * source.width + sx) * 4;
          for (let c = 0; c < 4; c++) sums[c] += source.data[i + c];
          samples++;
        }
      }
      const out = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) output.data[out + c] = Math.round(sums[c] / samples);
    }
  }
  return output;
}

export function buildMipImages(source: RGBAImage, downsample: (image: RGBAImage) => RGBAImage): RGBAImage[] {
  const levels = [source];
  let current = source;
  while (current.width !== 1 || current.height !== 1) {
    current = downsample(current);
    levels.push(current);
  }
  return levels;
}

export function buildSafeMipChain(source: RGBAImage): RGBAImage[] {
  return buildMipImages(source, downsampleSafe);
}

export function buildNaiveMipChain(source: RGBAImage): RGBAImage[] {
  return buildMipImages(source, downsampleNaive);
}

export function evaluateImages(
  mode: ChainMode,
  images: RGBAImage[],
  cutoffInput: number,
  sourcePassCountOverride?: number,
): MipChain {
  const cutoff = clampCutoff(cutoffInput);
  const source = images[0];
  const sourceTexels = source.width * source.height;
  const sourcePassCount = sourcePassCountOverride ?? countPassing(source, cutoff);
  const sourcePassRatio = sourcePassCount / sourceTexels;

  const levels: LevelStats[] = images.map((image, level) => {
    const texels = image.width * image.height;
    const passCount = countPassing(image, cutoff);
    const expectedCount = (sourcePassCount * texels) / sourceTexels;
    const targetCount = Math.max(0, Math.min(texels, Math.round(expectedCount)));
    const passRatio = passCount / texels;
    const targetRatio = targetCount / texels;
    const areaScale = sourceTexels / texels;

    return {
      level,
      width: image.width,
      height: image.height,
      texels,
      image,
      histogram: alphaHistogram(image),
      passCount,
      passRatio,
      sourcePassRatio,
      expectedCount,
      targetCount,
      targetRatio,
      deltaCount: passCount - expectedCount,
      deltaRatio: passRatio - sourcePassRatio,
      equivalentSourceDelta: (passCount - expectedCount) * areaScale,
      clippedVsTarget: targetCount - passCount,
      quantizationResidual: targetCount - expectedCount,
    };
  });

  let firstLossLevel: number | null = null;
  let severeLossLevel: number | null = null;
  for (const stat of levels) {
    if (stat.level > 0 && stat.passCount < stat.targetCount) {
      if (firstLossLevel === null) firstLossLevel = stat.level;
      if (
        severeLossLevel === null &&
        stat.targetCount > 0 &&
        stat.passCount * 2 <= stat.targetCount
      ) {
        severeLossLevel = stat.level;
      }
    }
  }

  return { mode, cutoff, images, levels, sourcePassCount, sourcePassRatio, firstLossLevel, severeLossLevel };
}

/**
 * Rank/quantile regeneration.
 *
 * The nearest integer to sourcePassCount * levelTexels/sourceTexels texels are
 * forced to the passing side of the cutoff. Other texels are forced below it.
 * Colors remain alpha-weighted colors from the ordinary coverage box.
 */
export function regenerateAreaImages(
  rawImages: RGBAImage[],
  cutoffInput: number,
  sourcePassCount: number,
): RGBAImage[] {
  const cutoff = clampCutoff(cutoffInput);
  const source = rawImages[0];
  const sourceTexels = source.width * source.height;
  const result: RGBAImage[] = [rawImages[0]];

  for (let level = 1; level < rawImages.length; level++) {
    const base = rawImages[level];
    const image = cloneImage(base);
    const texels = base.width * base.height;
    const expected = (sourcePassCount * texels) / sourceTexels;
    const target = Math.max(0, Math.min(texels, Math.round(expected)));

    const order = Array.from({ length: texels }, (_, p) => p).sort((p, q) => {
      const da = base.data[p * 4 + 3];
      const db = base.data[q * 4 + 3];
      if (db !== da) return db - da;
      return p - q;
    });

    for (let rank = 0; rank < texels; rank++) {
      const alphaIndex = order[rank] * 4 + 3;
      const rawAlpha = base.data[alphaIndex];
      if (rank < target) {
        image.data[alphaIndex] = Math.max(rawAlpha, cutoff);
      } else {
        image.data[alphaIndex] = Math.min(rawAlpha, Math.max(0, cutoff - 1));
      }
    }

    result.push(image);
  }

  return result;
}

export function buildComparison(source: RGBAImage, cutoff: number): MipComparison {
  const rawImages = buildSafeMipChain(source);
  const ordinary = evaluateImages('ordinary', rawImages, cutoff);
  const areaImages = regenerateAreaImages(rawImages, cutoff, ordinary.sourcePassCount);
  const area = evaluateImages('area', areaImages, cutoff, ordinary.sourcePassCount);
  return { cutoff: ordinary.cutoff, rawImages, ordinary, area };
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatSignedPercent(value: number, digits = 1): string {
  const formatted = formatPercent(Math.abs(value), digits);
  return `${value > 0.0000001 ? '+' : value < -0.0000001 ? '−' : '±'}${formatted}`;
}
