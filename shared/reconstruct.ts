/**
 * Frame reconstruction shared by the verifier, the browser preview and the
 * standalone animation player. Given a page image and a frame descriptor it
 * produces the frame exactly as it looked on its original canvas.
 */

import type { AtlasFrame } from './types';
import type { RGBAImage } from './pixels';
import { cropImage, createImage, blitImage, unrotateImage, rotatedExtent } from './pixels';

export interface FrameReconstruction {
  /** Original-size transparent canvas with the content put back in place. */
  canvas: RGBAImage;
  /** The trimmed content after undoing packing rotation. */
  content: RGBAImage;
  /** The packed slot cropped from the page (rotation + extrusion included). */
  slot: RGBAImage;
  errors: string[];
}

/** Crop a page-space rectangle, clipped to the page. Missing pixels stay transparent. */
function safeCrop(page: RGBAImage, rect: { x: number; y: number; width: number; height: number }): RGBAImage {
  const out = createImage(Math.max(0, rect.width), Math.max(0, rect.height));
  const startX = Math.max(0, rect.x);
  const startY = Math.max(0, rect.y);
  const endX = Math.min(page.width, rect.x + rect.width);
  const endY = Math.min(page.height, rect.y + rect.height);
  if (endX <= startX || endY <= startY) return out;
  for (let y = startY; y < endY; y++) {
    const dx = startX - rect.x;
    const dy = y - rect.y;
    const srcStart = (y * page.width + startX) * 4;
    const destStart = (dy * out.width + dx) * 4;
    out.data.set(page.data.subarray(srcStart, srcStart + (endX - startX) * 4), destStart);
  }
  return out;
}

/**
 * Rebuild a frame on its original canvas from its page image.
 *
 * The packed slot contains the rotated trimmed content, surrounded by edge
 * replication. We crop `contentRect` (which excludes extrusion), undo the
 * recorded clockwise rotation, and blit at `trim` on a `sourceSize` canvas.
 */
export function reconstructFrame(frame: AtlasFrame, page: RGBAImage | null): FrameReconstruction {
  const canvas = createImage(frame.sourceSize.width, frame.sourceSize.height);
  const errors: string[] = [];

  if (frame.empty) {
    return { canvas, content: createImage(0, 0), slot: createImage(0, 0), errors };
  }

  if (frame.status !== 'packed' || !frame.contentRect || !frame.packedRect || frame.page === null) {
    errors.push(`Frame ${frame.id} is not packed; it cannot be reconstructed from a page.`);
    return { canvas, content: createImage(0, 0), slot: createImage(0, 0), errors };
  }

  if (page) {
    if (page.width < frame.contentRect.x + frame.contentRect.width || page.height < frame.contentRect.y + frame.contentRect.height) {
      errors.push(`Frame ${frame.id} contentRect lies outside page ${frame.page}.`);
    }
  }

  const slot = page ? safeCrop(page, frame.packedRect) : createImage(frame.packedRect.width, frame.packedRect.height);
  const contentCrop = page
    ? safeCrop(page, frame.contentRect)
    : createImage(frame.contentRect.width, frame.contentRect.height);
  const expected = rotatedExtent(
    { width: frame.trim.width, height: frame.trim.height },
    frame.rotation,
  );
  if (contentCrop.width !== expected.width || contentCrop.height !== expected.height) {
    errors.push(
      `Frame ${frame.id} contentRect is ${contentCrop.width}x${contentCrop.height} but trim ${frame.trim.width}x${frame.trim.height} at ${frame.rotation}° needs ${expected.width}x${expected.height}.`,
    );
  }

  const content = unrotateImage(contentCrop, frame.rotation);
  if (content.width !== frame.trim.width || content.height !== frame.trim.height) {
    errors.push(
      `Frame ${frame.id} reconstructed content is ${content.width}x${content.height}, expected ${frame.trim.width}x${frame.trim.height}.`,
    );
    return { canvas, content, slot, errors };
  }
  blitImage(canvas, content, frame.trim.x, frame.trim.y);
  return { canvas, content, slot, errors };
}

/** Blit the trimmed content into an original-size transparent canvas. */
export function placeOnCanvas(
  content: RGBAImage,
  sourceSize: { width: number; height: number },
  trim: { x: number; y: number },
): RGBAImage {
  const canvas = createImage(sourceSize.width, sourceSize.height);
  blitImage(canvas, content, trim.x, trim.y);
  return canvas;
}

/** Crop the unrotated content out of an original-size canvas (for comparisons). */
export function trimCanvas(
  canvas: RGBAImage,
  trim: { x: number; y: number; width: number; height: number },
): RGBAImage {
  return cropImage(canvas, trim);
}
