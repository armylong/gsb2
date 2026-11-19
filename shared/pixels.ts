/** Pure RGBA pixel operations shared by the server verifier and the browser preview. */

import type { Rect, Rotation, Size } from './types';

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number, fill = 0): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function cloneImage(image: RGBAImage): RGBAImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

export function cropImage(image: RGBAImage, rect: Rect): RGBAImage {
  const out = createImage(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const srcStart = ((rect.y + y) * image.width + rect.x) * 4;
    out.data.set(image.data.subarray(srcStart, srcStart + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

export function blitImage(dest: RGBAImage, src: RGBAImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const targetY = dy + y;
    if (targetY < 0 || targetY >= dest.height) continue;
    const srcStart = y * src.width * 4;
    const destStart = (targetY * dest.width + dx) * 4;
    dest.data.set(src.data.subarray(srcStart, srcStart + src.width * 4), destStart);
  }
}

export function rotateImageCW(image: RGBAImage): RGBAImage {
  const out = createImage(image.height, image.width);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const dx = image.height - 1 - y;
      const dy = x;
      const src = (y * image.width + x) * 4;
      const dst = (dy * out.width + dx) * 4;
      out.data[dst] = image.data[src];
      out.data[dst + 1] = image.data[src + 1];
      out.data[dst + 2] = image.data[src + 2];
      out.data[dst + 3] = image.data[src + 3];
    }
  }
  return out;
}

export function rotateImageCCW(image: RGBAImage): RGBAImage {
  const out = createImage(image.height, image.width);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const dx = y;
      const dy = image.width - 1 - x;
      const src = (y * image.width + x) * 4;
      const dst = (dy * out.width + dx) * 4;
      out.data[dst] = image.data[src];
      out.data[dst + 1] = image.data[src + 1];
      out.data[dst + 2] = image.data[src + 2];
      out.data[dst + 3] = image.data[src + 3];
    }
  }
  return out;
}

export function rotateImage180(image: RGBAImage): RGBAImage {
  const out = createImage(image.width, image.height);
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    const src = i * 4;
    const dst = (pixels - 1 - i) * 4;
    out.data[dst] = image.data[src];
    out.data[dst + 1] = image.data[src + 1];
    out.data[dst + 2] = image.data[src + 2];
    out.data[dst + 3] = image.data[src + 3];
  }
  return out;
}

/** Undo a clockwise packing rotation. */
export function unrotateImage(image: RGBAImage, rotation: Rotation): RGBAImage {
  switch (rotation) {
    case 0:
      return cloneImage(image);
    case 90:
      return rotateImageCCW(image);
    case 180:
      return rotateImage180(image);
    case 270:
      return rotateImageCW(image);
  }
}

export function rotatedExtent(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * Edge replication: every content pixel is copied outward so bilinear sampling
 * at the trimmed border cannot blend against transparent black. Uses
 * clamp-to-edge, therefore no new colors are introduced.
 */
export function extrudeImage(image: RGBAImage, amount: number): RGBAImage {
  if (amount <= 0) return cloneImage(image);
  const width = image.width + amount * 2;
  const height = image.height + amount * 2;
  const out = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, y - amount));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, x - amount));
      const src = (sy * image.width + sx) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst] = image.data[src];
      out.data[dst + 1] = image.data[src + 1];
      out.data[dst + 2] = image.data[src + 2];
      out.data[dst + 3] = image.data[src + 3];
    }
  }
  return out;
}

/** Bounds of pixels with any non-zero alpha; null when the image is empty. */
export function findAlphaBounds(image: RGBAImage): Rect | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface PixelComparison {
  match: boolean;
  /** Pixels where alpha matches and RGB is ignored because both sides are alpha 0. */
  ignoredPixels: number;
  /** Pixels where at least one channel differs outside the allowed ignore rule. */
  diffPixels: number;
  firstDiff?: { x: number; y: number; expected: number[]; actual: number[] };
}

/**
 * Compare two same-sized RGBA images.
 *
 * Rule: alpha must match exactly everywhere. RGB must match wherever alpha is
 * non-zero. When both pixels are fully transparent, only their RGB may differ
 * (premultiplied color under alpha 0 is not visible), and the pixel is counted
 * as ignored.
 */
export function compareImages(expected: RGBAImage, actual: RGBAImage): PixelComparison {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { match: false, ignoredPixels: 0, diffPixels: -1 };
  }
  let ignoredPixels = 0;
  let diffPixels = 0;
  let firstDiff: PixelComparison['firstDiff'];
  const pixels = expected.width * expected.height;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const ea = expected.data[o + 3];
    const aa = actual.data[o + 3];
    if (ea === 0 && aa === 0) {
      if (
        expected.data[o] !== actual.data[o] ||
        expected.data[o + 1] !== actual.data[o + 1] ||
        expected.data[o + 2] !== actual.data[o + 2]
      ) {
        ignoredPixels++;
      }
      continue;
    }
    const same =
      ea === aa &&
      expected.data[o] === actual.data[o] &&
      expected.data[o + 1] === actual.data[o + 1] &&
      expected.data[o + 2] === actual.data[o + 2];
    if (!same) {
      diffPixels++;
      if (!firstDiff) {
        firstDiff = {
          x: i % expected.width,
          y: Math.floor(i / expected.width),
          expected: Array.from(expected.data.subarray(o, o + 4)),
          actual: Array.from(actual.data.subarray(o, o + 4)),
        };
      }
    }
  }
  return { match: diffPixels === 0, ignoredPixels, diffPixels, firstDiff };
}
