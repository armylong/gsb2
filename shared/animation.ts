/**
 * Animation alignment. Every frame is first reconstructed onto its ORIGINAL
 * canvas (see reconstruct.ts), then all original canvases are aligned on one
 * normalized anchor. Trimming, extrusion and the packed page position are
 * irrelevant to this step, so frames with different transparent bounds or on
 * different pages keep their true relative positions.
 */

import type { AnimationSpec, AtlasManifest, AtlasFrame, Point, Size } from './types';
import type { RGBAImage } from './pixels';
import { createImage, blitImage } from './pixels';
import { reconstructFrame } from './reconstruct';

export function unionCanvasSize(frames: AtlasFrame[]): Size {
  return frames.reduce(
    (acc, frame) => ({
      width: Math.max(acc.width, frame.sourceSize.width),
      height: Math.max(acc.height, frame.sourceSize.height),
    }),
    { width: 1, height: 1 },
  );
}

export function anchorPoint(canvas: Size, anchor: Point): Point {
  return { x: anchor.x * canvas.width, y: anchor.y * canvas.height };
}

/** Integer offset that aligns a frame canvas onto the union canvas. */
export function alignedOffset(frameCanvas: Size, union: Size, anchor: Point): Point {
  const unionAnchor = anchorPoint(union, anchor);
  const frameAnchor = anchorPoint(frameCanvas, anchor);
  return { x: Math.round(unionAnchor.x - frameAnchor.x), y: Math.round(unionAnchor.y - frameAnchor.y) };
}

export interface AlignedFrame {
  id: string;
  offset: Point;
  image: RGBAImage;
}

/**
 * Reconstruct one animation frame from page pixels and place it on a shared
 * stage of `union` size. The returned image is the full stage, so callers can
 * compare frames directly or draw them at (0, 0).
 */
export function composeAlignedFrame(
  frame: AtlasFrame,
  page: RGBAImage | null,
  union: Size,
  anchor: Point,
): AlignedFrame {
  const reconstructed = reconstructFrame(frame, page);
  const stage = createImage(union.width, union.height);
  const offset = alignedOffset(frame.sourceSize, union, anchor);
  blitImage(stage, reconstructed.canvas, offset.x, offset.y);
  return { id: frame.id, offset, image: stage };
}

export interface ComposedAnimation {
  stage: Size;
  frames: { id: string; durationMs: number; offset: Point; image: RGBAImage }[];
  errors: string[];
}

/**
 * Full offline composition of an animation. `pages` must be keyed by page
 * index; callers loading an export can build it from pages/*.png only.
 */
export function composeAnimation(
  manifest: AtlasManifest,
  spec: AnimationSpec,
  pages: Map<number, RGBAImage>,
): ComposedAnimation {
  const byId = new Map(manifest.frames.map((frame) => [frame.id, frame]));
  const frames = spec.frames
    .map((ref) => byId.get(ref.id))
    .filter((frame): frame is AtlasFrame => Boolean(frame));
  const stage = unionCanvasSize(frames);
  const errors: string[] = [];
  const out = spec.frames.map((ref) => {
    const frame = byId.get(ref.id);
    if (!frame) {
      errors.push(`Animation references unknown frame id ${ref.id}`);
      return {
        id: ref.id,
        durationMs: ref.durationMs,
        offset: { x: 0, y: 0 },
        image: createImage(stage.width, stage.height),
      };
    }
    const page = frame.page === null ? null : pages.get(frame.page) ?? null;
    if (frame.page !== null && !page) errors.push(`Page ${frame.page} is missing for frame ${frame.id}`);
    const composed = composeAlignedFrame(frame, page, stage, spec.anchor);
    errors.push(...reconstructFrame(frame, page).errors);
    return { id: ref.id, durationMs: ref.durationMs, offset: composed.offset, image: composed.image };
  });
  return { stage, frames: out, errors };
}

/** Total clip duration in milliseconds. */
export function animationDuration(spec: AnimationSpec): number {
  return spec.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
}
