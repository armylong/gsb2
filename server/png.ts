/** PNG decode/encode to/from RGBA8 using sharp. 8-bit only by design. */

import sharp from 'sharp';
import type { RGBAImage } from '../shared/pixels';

export interface DecodedPng {
  image: RGBAImage;
  png: Buffer;
}

export async function decodePng(buffer: Buffer): Promise<DecodedPng> {
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== 'png') {
    throw new Error(`Unsupported format "${metadata.format ?? 'unknown'}"; only PNG files are accepted.`);
  }
  if (metadata.depth === 'ushort') {
    throw new Error('16-bit PNG is not supported; export an 8-bit RGBA PNG so pixel verification is exact.');
  }
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`Expected 4 RGBA channels after decode, got ${info.channels}.`);
  }
  const image: RGBAImage = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength).slice(),
  };
  return { image, png: buffer };
}

/** Encode an RGBA image as a deterministic 8-bit PNG. */
export async function encodePng(image: RGBAImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}
