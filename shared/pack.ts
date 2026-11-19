/**
 * Deterministic multi-page atlas packer.
 *
 * Design notes
 * ------------
 * - Frames are sorted by a key derived only from their stable identity and
 *   trimmed size, never by import order. Same set + same settings => same
 *   layout and same ids, byte-for-byte in the manifest.
 * - Each page is exactly `pageWidth x pageHeight`. `margin` is empty on all
 *   four page edges. `spacing` is the minimum empty gap between the slots of
 *   two frames; it is content spacing, never bleed replication.
 * - A slot is the rotated trimmed content plus `extrude` pixels of edge
 *   replication on every side. `extrude` is the anti-bleed border; it is a
 *   separate setting with a separate meaning. `contentRect` is exactly
 *   `packedRect` inset by `extrude`, in page coordinates.
 * - Rotation is limited to 0 or 90 degrees clockwise. The chosen direction is
 *   recorded per frame, so consumers never guess.
 * - A frame that cannot fit an empty page is reported as `FRAME_TOO_LARGE`
 *   and is never scaled or split.
 */

import type {
  AtlasFrame,
  AtlasPage,
  PackIssue,
  PackSettings,
  Rect,
  Rotation,
  Size,
} from './types';

export interface PackFrameInput {
  id: string;
  name: string;
  sourceKey: string;
  contentHash: string;
  sourceSize: Size;
  trim: Rect;
  empty: boolean;
}

interface Item {
  frame: PackFrameInput;
  /** Unrotated trimmed content size. Zero for fully transparent frames. */
  content: Size;
  /** Slot (content + extrusion) for rotation 0 and 90. */
  slot0: Size;
  slot90: Size;
  /** Sorting key; depends only on stable fields, never input order. */
  sortKey: string;
}

interface PageState {
  free: Rect[];
  /** Whole page area after margins; the clamp for spacing reservations. */
  usable: Rect;
  /** Slots already committed on this page, for the hard spacing check. */
  placed: Rect[];
}

interface Placement {
  freeIndex: number;
  x: number;
  y: number;
  rotation: Rotation;
  slot: Size;
  score: [number, number, number, number, number];
}

export function validateSettings(settings: PackSettings): string[] {
  const errors: string[] = [];
  const integer = (name: string, value: number, min: number) => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
      errors.push(`${name} must be an integer >= ${min} (got ${String(value)})`);
    }
  };
  integer('pageWidth', settings.pageWidth, 1);
  integer('pageHeight', settings.pageHeight, 1);
  integer('spacing', settings.spacing, 0);
  integer('margin', settings.margin, 0);
  integer('extrude', settings.extrude, 0);
  if (typeof settings.allowRotation !== 'boolean') {
    errors.push('allowRotation must be a boolean');
  }
  if (errors.length === 0) {
    if (settings.pageWidth - settings.margin * 2 <= 0) {
      errors.push('pageWidth must be greater than 2 * margin');
    }
    if (settings.pageHeight - settings.margin * 2 <= 0) {
      errors.push('pageHeight must be greater than 2 * margin');
    }
    if (settings.spacing > Math.min(settings.pageWidth, settings.pageHeight)) {
      errors.push('spacing must not exceed the page size');
    }
    if (settings.extrude > Math.min(settings.pageWidth, settings.pageHeight)) {
      errors.push('extrude must not exceed the page size');
    }
  }
  return errors;
}

function isEmptyFrame(frame: PackFrameInput): boolean {
  return frame.empty || frame.trim.width === 0 || frame.trim.height === 0;
}

function makeItem(frame: PackFrameInput, settings: PackSettings): Item {
  const empty = isEmptyFrame(frame);
  const content: Size = empty ? { width: 0, height: 0 } : { width: frame.trim.width, height: frame.trim.height };
  // A fully transparent frame keeps a minimal 1x1 slot so it still has a
  // stable, addressable page position. No pixels are written into it.
  const minSlot = empty ? 1 : 0;
  const slot0: Size = {
    width: Math.max(minSlot, content.width + settings.extrude * 2),
    height: Math.max(minSlot, content.height + settings.extrude * 2),
  };
  const slot90: Size = { width: slot0.height, height: slot0.width };
  const maxSide = Math.max(slot0.width, slot0.height);
  const minSide = Math.min(slot0.width, slot0.height);
  const sortKey = `${maxSide}:${minSide}:${frame.id}`;
  return { frame, content, slot0, slot90, sortKey };
}

function compareItems(a: Item, b: Item): number {
  const maxDiff = Math.max(b.slot0.width, b.slot0.height) - Math.max(a.slot0.width, a.slot0.height);
  if (maxDiff !== 0) return maxDiff;
  const minDiff = Math.min(b.slot0.width, b.slot0.height) - Math.min(a.slot0.width, a.slot0.height);
  if (minDiff !== 0) return minDiff;
  return a.frame.id < b.frame.id ? -1 : a.frame.id > b.frame.id ? 1 : 0;
}

function compareScore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function fits(rect: Rect, size: Size): boolean {
  return size.width <= rect.width && size.height <= rect.height;
}

/**
 * Slots for an item, in preference order. Rotation is 90 degrees clockwise.
 * A slot is only placed where slot + spacing fits: the spacing band is part of
 * the reservation, so a gap can never spill over the free rectangle's edge.
 */
function orientations(item: Item, allowRotation: boolean): { rotation: Rotation; size: Size }[] {
  const list: { rotation: Rotation; size: Size }[] = [{ rotation: 0, size: item.slot0 }];
  const square = item.slot0.width === item.slot0.height;
  const empty = item.content.width === 0 || item.content.height === 0;
  if (allowRotation && !empty && !square) {
    list.push({ rotation: 90, size: item.slot90 });
  }
  return list;
}

function canFitEmptyPage(item: Item, usable: Rect, allowRotation: boolean): boolean {
  return orientations(item, allowRotation).some((o) => fits(usable, o.size));
}

function findPlacement(page: PageState, item: Item, settings: PackSettings): Placement | null {
  let best: Placement | null = null;
  for (let fi = 0; fi < page.free.length; fi++) {
    const freeRect = page.free[fi];
    for (const { rotation, size } of orientations(item, settings.allowRotation)) {
      if (!fits(freeRect, size)) continue;
      const candidate: Rect = { x: freeRect.x, y: freeRect.y, width: size.width, height: size.height };
      // Hard spacing guarantee, independent of how the free list was split.
      if (page.placed.some((placed) => rectGap(placed, candidate) < settings.spacing)) continue;
      const leftW = freeRect.width - size.width;
      const leftH = freeRect.height - size.height;
      const score: Placement['score'] = [
        Math.min(leftW, leftH),
        Math.max(leftW, leftH),
        freeRect.y,
        freeRect.x,
        rotation === 0 ? 0 : 1,
      ];
      if (!best || compareScore(score, best.score) < 0) {
        best = { freeIndex: fi, x: freeRect.x, y: freeRect.y, rotation, slot: size, score };
      }
    }
  }
  return best;
}

function subtractAlloc(free: Rect, alloc: Rect): Rect[] {
  const allocRight = Math.min(free.x + free.width, alloc.x + alloc.width);
  const allocBottom = Math.min(free.y + free.height, alloc.y + alloc.height);
  const out: Rect[] = [];
  if (alloc.x > free.x) {
    out.push({ x: free.x, y: free.y, width: alloc.x - free.x, height: free.height });
  }
  if (allocRight < free.x + free.width) {
    out.push({ x: allocRight, y: free.y, width: free.x + free.width - allocRight, height: free.height });
  }
  if (alloc.y > free.y) {
    out.push({ x: free.x, y: free.y, width: free.width, height: alloc.y - free.y });
  }
  if (allocBottom < free.y + free.height) {
    out.push({ x: free.x, y: allocBottom, width: free.width, height: free.y + free.height - allocBottom });
  }
  return out;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Remove empty and fully-contained rectangles. Deterministic ordering. */
function pruneFree(rects: Rect[]): Rect[] {
  const positive = rects.filter((r) => r.width > 0 && r.height > 0);
  const kept: Rect[] = [];
  for (let i = 0; i < positive.length; i++) {
    const a = positive[i];
    let redundant = false;
    for (let j = 0; j < positive.length; j++) {
      if (i === j) continue;
      const b = positive[j];
      if (!contains(b, a)) continue;
      const identical = a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
      if (identical && j < i) continue; // duplicate kept by its first copy
      redundant = true;
      break;
    }
    if (!redundant) kept.push(a);
  }
  kept.sort((p, q) => p.y - q.y || p.x - q.x || p.width - q.width || p.height - q.height);
  return kept;
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Reserve `alloc` (slot plus spacing) in the free list. Every free rectangle
 * that intersects the reservation is split, not just the one the slot was
 * chosen from: free rectangles produced by earlier splits can overlap each
 * other, and ignoring that would let a later frame reuse reserved pixels.
 */
/**
 * Space a placement must reserve: the slot plus a trailing spacing band on the
 * right and bottom, reduced when the free rectangle has no room for it (the
 * page edge or an already-reserved band is there). The hard spacing check in
 * `findPlacement` guarantees the gap even when this reservation is trimmed.
 */
function reservationFor(size: Size, freeRect: Rect, spacing: number): Size {
  return {
    width: Math.min(size.width + spacing, freeRect.width),
    height: Math.min(size.height + spacing, freeRect.height),
  };
}

function commitPlacement(page: PageState, placement: Placement, spacing: number): void {
  page.placed.push({
    x: placement.x,
    y: placement.y,
    width: placement.slot.width,
    height: placement.slot.height,
  });
  const reserved = reservationFor(placement.slot, page.free[placement.freeIndex], spacing);
  const alloc: Rect = {
    x: placement.x,
    y: placement.y,
    width: reserved.width,
    height: reserved.height,
  };
  const next: Rect[] = [];
  for (const rect of page.free) {
    if (!intersects(rect, alloc)) {
      next.push(rect);
      continue;
    }
    next.push(...subtractAlloc(rect, alloc));
  }
  page.free = pruneFree(next);
}

function buildFrame(item: Item, placement: Placement, pageIndex: number, extrude: number): AtlasFrame {
  const packedRect: Rect = {
    x: placement.x,
    y: placement.y,
    width: placement.slot.width,
    height: placement.slot.height,
  };
  const empty = item.content.width === 0 || item.content.height === 0;
  const contentRect: Rect = empty
    ? {
        x: packedRect.x + Math.floor(packedRect.width / 2),
        y: packedRect.y + Math.floor(packedRect.height / 2),
        width: 0,
        height: 0,
      }
    : {
        x: packedRect.x + extrude,
        y: packedRect.y + extrude,
        width: packedRect.width - extrude * 2,
        height: packedRect.height - extrude * 2,
      };
  return {
    id: item.frame.id,
    name: item.frame.name,
    sourceKey: item.frame.sourceKey,
    contentHash: item.frame.contentHash,
    sourceSize: { ...item.frame.sourceSize },
    trim: { ...item.frame.trim },
    empty,
    rotation: placement.rotation,
    extrude,
    page: pageIndex,
    packedRect,
    contentRect,
    status: 'packed',
  };
}

function unplacedFrame(frame: PackFrameInput, reason: string): AtlasFrame {
  return {
    id: frame.id,
    name: frame.name,
    sourceKey: frame.sourceKey,
    contentHash: frame.contentHash,
    sourceSize: { ...frame.sourceSize },
    trim: { ...frame.trim },
    empty: isEmptyFrame(frame),
    rotation: 0,
    extrude: 0,
    page: null,
    packedRect: null,
    contentRect: null,
    status: 'unplaced',
    issue: reason,
  };
}

function sanitizeFrame(frame: PackFrameInput): string | null {
  const integer = (value: number) => Number.isInteger(value);
  if (!integer(frame.trim.x) || !integer(frame.trim.y) || !integer(frame.trim.width) || !integer(frame.trim.height)) {
    return 'trim rectangle must use integer pixels';
  }
  if (frame.trim.width < 0 || frame.trim.height < 0) return 'trim rectangle must not be negative';
  if (!integer(frame.sourceSize.width) || !integer(frame.sourceSize.height)) {
    return 'source size must use integer pixels';
  }
  if (frame.sourceSize.width <= 0 || frame.sourceSize.height <= 0) return 'source size must be positive';
  if (!isEmptyFrame(frame)) {
    if (frame.trim.x < 0 || frame.trim.y < 0) return 'trim origin must not be negative';
    if (frame.trim.x + frame.trim.width > frame.sourceSize.width) return 'trim exceeds source width';
    if (frame.trim.y + frame.trim.height > frame.sourceSize.height) return 'trim exceeds source height';
  }
  return null;
}

function tooLargeIssue(item: Item, settings: PackSettings, usable: Rect): PackIssue {
  const rot = orientations(item, settings.allowRotation)
    .map((o) => `${o.size.width}x${o.size.height}px at ${o.rotation}°`)
    .join(' or ');
  return {
    code: 'FRAME_TOO_LARGE',
    frameId: item.frame.id,
    message:
      `Frame ${item.frame.name} (${item.frame.id}) cannot fit a ${settings.pageWidth}x${settings.pageHeight} page: ` +
      `trimmed content is ${item.content.width}x${item.content.height}px, ` +
      `slot including ${settings.extrude}px edge extrusion per side is ${rot}, ` +
      `usable area after ${settings.margin}px margins is ${usable.width}x${usable.height}px. ` +
      'Images are never scaled or split.',
    detail: {
      id: item.frame.id,
      name: item.frame.name,
      content: item.content,
      slot: item.slot0,
      slotRotated: item.slot90,
      page: { width: settings.pageWidth, height: settings.pageHeight },
      usable: { width: usable.width, height: usable.height },
    },
  };
}

export interface PackOutcome {
  frames: AtlasFrame[];
  pages: AtlasPage[];
  issues: PackIssue[];
}

/**
 * Pack frames into one or more pages. The result depends only on the set of
 * frames and the settings; shuffling the input produces the same result.
 */
export function packFrames(inputs: PackFrameInput[], settings: PackSettings): PackOutcome {
  const issues: PackIssue[] = [];
  const settingsErrors = validateSettings(settings);
  if (settingsErrors.length > 0) {
    for (const message of settingsErrors) {
      issues.push({ code: 'INVALID_SETTINGS', message });
    }
    const frames = inputs
      .map((frame) => unplacedFrame(frame, 'Invalid pack settings'))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { frames, pages: [], issues };
  }

  const seen = new Set<string>();
  const unique: PackFrameInput[] = [];
  for (const frame of inputs) {
    if (seen.has(frame.id)) {
      issues.push({
        code: 'DUPLICATE_ID',
        frameId: frame.id,
        message: `Duplicate frame id ${frame.id} (${frame.sourceKey}) ignored; the first entry is kept.`,
        detail: { id: frame.id, sourceKey: frame.sourceKey },
      });
      continue;
    }
    const problem = sanitizeFrame(frame);
    if (problem) {
      issues.push({
        code: 'INVALID_SOURCE',
        frameId: frame.id,
        message: `Frame ${frame.id} (${frame.name}) is invalid: ${problem}.`,
        detail: { id: frame.id, name: frame.name },
      });
      continue;
    }
    seen.add(frame.id);
    unique.push(frame);
  }

  const items = unique.map((frame) => makeItem(frame, settings)).sort(compareItems);
  const placed = new Map<string, AtlasFrame>();
  const pages: AtlasPage[] = [];
  const usable: Rect = {
    x: settings.margin,
    y: settings.margin,
    width: settings.pageWidth - settings.margin * 2,
    height: settings.pageHeight - settings.margin * 2,
  };

  let remaining = items;
  while (remaining.length > 0) {
    // Frames that cannot fit an empty page can never be placed. Report them
    // once and remove them from the queue.
    const placeable: Item[] = [];
    for (const item of remaining) {
      if (canFitEmptyPage(item, usable, settings.allowRotation)) {
        placeable.push(item);
      } else {
        issues.push(tooLargeIssue(item, settings, usable));
      }
    }
    if (placeable.length === 0) break;

    const pageIndex = pages.length;
    const page: PageState = { free: [{ ...usable }], usable, placed: [] };
    const deferred: Item[] = [];
    let placedOnPage = 0;

    for (const item of placeable) {
      const placement = findPlacement(page, item, settings);
      if (!placement) {
        deferred.push(item);
        continue;
      }
      commitPlacement(page, placement, settings.spacing);
      placed.set(item.frame.id, buildFrame(item, placement, pageIndex, settings.extrude));
      placedOnPage++;
    }

    if (placedOnPage === 0) {
      // A frame passes canFitEmptyPage but the packer could not place it on
      // an empty page: report it and continue with the rest.
      issues.push(tooLargeIssue(placeable[0], settings, usable));
      remaining = placeable.slice(1).concat(deferred);
      continue;
    }

    pages.push({
      index: pageIndex,
      file: `atlas_${String(pageIndex).padStart(3, '0')}.png`,
      width: settings.pageWidth,
      height: settings.pageHeight,
    });
    remaining = deferred;
  }

  const issueById = new Map(issues.filter((issue) => issue.frameId).map((issue) => [issue.frameId!, issue]));
  const frames = unique
    .map((frame) => {
      const placedFrame = placed.get(frame.id);
      if (placedFrame) return placedFrame;
      const issue = issueById.get(frame.id);
      return unplacedFrame(frame, issue ? issue.message : 'Frame does not fit any page');
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { frames, pages, issues };
}

/** Minimum axis-aligned gap between two rectangles (0 when they overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.max(dx, dy);
}
