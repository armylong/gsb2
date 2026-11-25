export interface BufferDiff {
  width: number;
  height: number;
  /** RGBA 字节数。 */
  totalBytes: number;
  /** 至少一个通道不同的像素数。 */
  diffPixels: number;
  /** 单通道最大差值 0..255。 */
  maxDelta: number;
  /** 所有通道差值的平均值。 */
  meanDelta: number;
  refHash: string;
  batchHash: string;
}

export function compareRgba(
  ref: Uint8Array,
  batch: Uint8Array,
  width: number,
  height: number,
  hash: (bytes: ArrayLike<number>) => string,
): BufferDiff {
  if (ref.length !== batch.length) {
    throw new Error(`缓冲区长度不一致: ${ref.length} vs ${batch.length}`);
  }
  let diffPixels = 0;
  let maxDelta = 0;
  let sum = 0;
  for (let i = 0; i < ref.length; i += 4) {
    const dr = Math.abs(ref[i]! - batch[i]!);
    const dg = Math.abs(ref[i + 1]! - batch[i + 1]!);
    const db = Math.abs(ref[i + 2]! - batch[i + 2]!);
    const da = Math.abs(ref[i + 3]! - batch[i + 3]!);
    const pixelMax = Math.max(dr, dg, db, da);
    if (pixelMax > 0) diffPixels++;
    if (pixelMax > maxDelta) maxDelta = pixelMax;
    sum += dr + dg + db + da;
  }
  return {
    width,
    height,
    totalBytes: ref.length,
    diffPixels,
    maxDelta,
    meanDelta: ref.length > 0 ? sum / ref.length : 0,
    refHash: hash(ref),
    batchHash: hash(batch),
  };
}

export interface PixelSample {
  ref: readonly [number, number, number, number];
  batch: readonly [number, number, number, number];
  maxDelta: number;
}

export function pixelSample(
  ref: Uint8Array,
  batch: Uint8Array,
  index: number,
): PixelSample {
  const i = index * 4;
  const r: [number, number, number, number] = [ref[i]!, ref[i + 1]!, ref[i + 2]!, ref[i + 3]!];
  const b: [number, number, number, number] = [batch[i]!, batch[i + 1]!, batch[i + 2]!, batch[i + 3]!];
  return {
    ref: r,
    batch: b,
    maxDelta: Math.max(
      Math.abs(r[0] - b[0]),
      Math.abs(r[1] - b[1]),
      Math.abs(r[2] - b[2]),
      Math.abs(r[3] - b[3]),
    ),
  };
}
