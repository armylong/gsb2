/**
 * Atlas texture writer. Places every packed slot on its page, applying the
 * recorded clockwise rotation and edge replication.
 *
 * The verifier never trusts this function: it reads the PNGs back and
 * reconstructs each frame independently (see shared/reconstruct.ts).
 */

import type { AtlasFrame, AtlasPage, PackSettings } from './types';
import type { RGBAImage } from './pixels';
import { blitImage, createImage, extrudeImage, rotateImageCW, rotateImage180 } from './pixels';

/** Anything that exposes a decoded original-size RGBA canvas. */
export interface SourcePixels {
  image: RGBAImage;
}

function rotateForPacking(image: RGBAImage, rotation: number): RGBAImage {
  switch (rotation) {
    case 90:
      return rotateImageCW(image);
    case 180:
      return rotateImage180(image);
    case 270:
      return rotateImageCW(rotateImage180(image));
    default:
      return image;
  }
}

export interface PageRaster {
  page: AtlasPage;
  image: RGBAImage;
}

/**
 * Build one RGBA page per page descriptor.
 *
 * `sources` maps frame id -> decoded original canvas. A packed frame's slot is
 * assembled from its trimmed content: crop trim, rotate clockwise, extrude,
 * then blit at `packedRect`. Fully transparent frames write nothing, leaving
 * their whole slot transparent.
 */
export function renderPages(
  pages: AtlasPage[],
  frames: AtlasFrame[],
  sources: Map<string, SourcePixels>,
  settings: PackSettings,
): PageRaster[] {
  const out: PageRaster[] = [];
  for (const page of pages) {
    out.push({ page, image: createImage(page.width, page.height) });
  }
  const byIndex = new Map(out.map((raster) => [raster.page.index, raster]));

  for (const frame of frames) {
    if (frame.status !== 'packed' || frame.page === null || !frame.packedRect) continue;
    if (frame.extrude !== settings.extrude) {
      throw new Error(`Frame ${frame.id} records extrude ${frame.extrude} but settings say ${settings.extrude}.`);
    }
    const raster = byIndex.get(frame.page);
    if (!raster) continue;
    const source = sources.get(frame.id);
    if (!source) continue;
    if (frame.empty) continue; // transparent slot, intentionally left empty

    const { trim, rotation, extrude, packedRect } = frame;
    let content = cropCanvas(source.image, trim);
    content = rotateForPacking(content, rotation);
    const slot = extrudeImage(content, extrude);
    blitImage(raster.image, slot, packedRect.x, packedRect.y);
  }
  return out;
}

function cropCanvas(image: RGBAImage, rect: { x: number; y: number; width: number; height: number }): RGBAImage {
  const out = createImage(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * image.width + rect.x) * 4;
    out.data.set(image.data.subarray(start, start + rect.width * 4), y * rect.width * 4);
  }
  return out;
}
