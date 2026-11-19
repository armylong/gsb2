import sharp from 'sharp';
import type { RGBAImage } from '../shared/pixels';

/** Build a raw RGBA image from a per-pixel callback. */
export function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number] | null,
): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = paint(x, y);
      if (!value) continue;
      const o = (y * width + x) * 4;
      data[o] = value[0];
      data[o + 1] = value[1];
      data[o + 2] = value[2];
      data[o + 3] = value[3];
    }
  }
  return { width, height, data };
}

export async function toPng(image: RGBAImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png({ compressionLevel: 6, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

/** A rectangle with a solid fill and a translucent border, off-center. */
export function rectangle(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number],
  alpha = 255,
): RGBAImage {
  return makeImage(width, height, (x, y) => {
    const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    if (!inside) return null;
    const onEdge =
      x === rect.x || y === rect.y || x === rect.x + rect.width - 1 || y === rect.y + rect.height - 1;
    return [color[0], color[1], color[2], onEdge ? Math.round(alpha / 2) : alpha];
  });
}

/** Irregular diagonal band with varying alpha. */
export function slash(width: number, height: number): RGBAImage {
  return makeImage(width, height, (x, y) => {
    const dist = Math.abs(y - (height / 2 + Math.sin(x / 5) * 8));
    if (dist > 6) return null;
    return [255, 200, 90, Math.round(255 * (1 - dist / 6))];
  });
}
