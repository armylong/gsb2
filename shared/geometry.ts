/** Shared geometry helpers. Pure functions, no Node or DOM dependencies. */

import type { Rect, Rotation, Size } from './types';

export function rectsOverlap(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Original-canvas outline of a packed frame, in page coordinates.
 *
 * The trimmed content sits at `contentRect`, rotated clockwise by `rotation`.
 * Mapping the whole source canvas through the same rotation shows how much
 * canvas extends around the content, which is what the preview overlays.
 * Returns null for fully transparent frames, which have no content anchor.
 */
export function sourceCanvasOutline(
  contentRect: Rect | null,
  rotation: Rotation,
  sourceSize: Size,
  trim: Rect,
): Rect | null {
  if (!contentRect || contentRect.width === 0 || contentRect.height === 0) return null;
  if (rotation === 0) {
    return {
      x: contentRect.x - trim.x,
      y: contentRect.y - trim.y,
      width: sourceSize.width,
      height: sourceSize.height,
    };
  }
  // 90 CW: local (x, y) -> (trim.height - y, x). The source canvas spans
  // local x in [-trim.x, width - trim.x] and y in [-trim.y, height - trim.y],
  // so its outline is source.height wide and source.width tall.
  return {
    x: contentRect.x + trim.y + trim.height - sourceSize.height,
    y: contentRect.y - trim.x,
    width: sourceSize.height,
    height: sourceSize.width,
  };
}
