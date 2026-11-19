/**
 * Structural atlas checks. These need only the manifest, so the same code
 * runs on the build server and in the browser when re-loading an exported
 * bundle. Pixel checks live in the server verifier because they need sources.
 */

import type { AtlasManifest, AtlasFrame, Rect, VerificationCheck } from './types';
import { ATLAS_FORMAT } from './types';
import { rectGap } from './pack';
import { rectContains, rectsOverlap } from './geometry';

function rectInPage(rect: Rect, width: number, height: number): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= 0 &&
    rect.height >= 0 &&
    rect.x + rect.width <= width &&
    rect.y + rect.height <= height
  );
}

export function verifyStructure(manifest: AtlasManifest): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const settings = manifest.settings;

  checks.push({
    id: 'format',
    label: 'Manifest format identifier',
    ok: manifest.format === ATLAS_FORMAT,
    detail: String(manifest.format),
  });

  const packed = manifest.frames.filter((frame) => frame.status === 'packed');
  const idSet = new Set<string>();
  let duplicateIds = 0;
  let malformedIds = 0;
  for (const frame of manifest.frames) {
    if (idSet.has(frame.id)) duplicateIds++;
    idSet.add(frame.id);
    if (!/^f_[0-9a-f]{16}$/.test(frame.id)) malformedIds++;
  }
  checks.push({
    id: 'ids-unique',
    label: 'Stable frame ids are unique and well-formed',
    ok: duplicateIds === 0 && malformedIds === 0,
    detail: `${manifest.frames.length} frames, ${duplicateIds} duplicate, ${malformedIds} malformed`,
  });

  checks.push({
    id: 'pages-index',
    label: 'Page indices are contiguous and start at 0',
    ok: manifest.pages.every((page, index) => page.index === index),
    detail: `${manifest.pages.length} page(s)`,
  });

  let boundsFailures = 0;
  let marginFailures = 0;
  let contentInsideSlot = 0;
  for (const frame of packed) {
    const page = frame.page === null ? undefined : manifest.pages[frame.page];
    if (!page || !frame.packedRect || !frame.contentRect) {
      boundsFailures++;
      continue;
    }
    if (!rectInPage(frame.packedRect, page.width, page.height)) boundsFailures++;
    if (!rectInPage(frame.contentRect, page.width, page.height)) boundsFailures++;
    if (!rectContains(frame.packedRect, frame.contentRect)) contentInsideSlot++;
    if (
      frame.packedRect.x < settings.margin ||
      frame.packedRect.y < settings.margin ||
      frame.packedRect.x + frame.packedRect.width > page.width - settings.margin ||
      frame.packedRect.y + frame.packedRect.height > page.height - settings.margin
    ) {
      marginFailures++;
    }
  }
  checks.push({
    id: 'bounds',
    label: 'Every packed frame lies inside its page',
    ok: boundsFailures === 0,
    detail: boundsFailures === 0 ? `${packed.length} frame(s) in bounds` : `${boundsFailures} out-of-page frame(s)`,
  });
  checks.push({
    id: 'margin',
    label: `Page margin of ${settings.margin}px is respected`,
    ok: marginFailures === 0,
    detail:
      marginFailures === 0
        ? 'all slots clear the page edge'
        : `${marginFailures} slot(s) intrude on the margin`,
  });

  let overlapFailures = 0;
  let spacingFailures = 0;
  const byPage = new Map<number, AtlasFrame[]>();
  for (const frame of packed) {
    if (frame.page === null) continue;
    const list = byPage.get(frame.page) ?? [];
    list.push(frame);
    byPage.set(frame.page, list);
  }
  for (const list of byPage.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].packedRect;
        const b = list[j].packedRect;
        if (!a || !b) continue;
        if (rectsOverlap(a, b)) overlapFailures++;
        if (rectGap(a, b) < settings.spacing) spacingFailures++;
      }
    }
  }
  checks.push({
    id: 'overlap',
    label: 'No two frames overlap',
    ok: overlapFailures === 0,
    detail: overlapFailures === 0 ? 'no overlaps' : `${overlapFailures} overlapping pair(s)`,
  });
  checks.push({
    id: 'spacing',
    label: `Content spacing of ${settings.spacing}px is respected`,
    ok: spacingFailures === 0,
    detail: spacingFailures === 0 ? 'all slots separated' : `${spacingFailures} pair(s) closer than spacing`,
  });

  let extrusionFailures = 0;
  for (const frame of packed) {
    if (!frame.packedRect || !frame.contentRect) {
      extrusionFailures++;
      continue;
    }
    if (frame.extrude !== settings.extrude) {
      extrusionFailures++;
      continue;
    }
    if (frame.empty) continue;
    const expected: Rect = {
      x: frame.packedRect.x + frame.extrude,
      y: frame.packedRect.y + frame.extrude,
      width: frame.packedRect.width - frame.extrude * 2,
      height: frame.packedRect.height - frame.extrude * 2,
    };
    if (
      frame.contentRect.x !== expected.x ||
      frame.contentRect.y !== expected.y ||
      frame.contentRect.width !== expected.width ||
      frame.contentRect.height !== expected.height
    ) {
      extrusionFailures++;
      continue;
    }
    const rotated = frame.rotation === 90 || frame.rotation === 270;
    const expectedWidth = rotated ? frame.trim.height : frame.trim.width;
    const expectedHeight = rotated ? frame.trim.width : frame.trim.height;
    if (frame.contentRect.width !== expectedWidth || frame.contentRect.height !== expectedHeight) {
      extrusionFailures++;
    }
  }
  checks.push({
    id: 'extrusion',
    label: 'contentRect equals packedRect minus the extrusion on each side',
    ok: extrusionFailures === 0 && contentInsideSlot === 0,
    detail:
      extrusionFailures === 0 && contentInsideSlot === 0
        ? 'geometry consistent'
        : `${extrusionFailures} inconsistent frame(s), ${contentInsideSlot} content rect(s) outside their slot`,
  });

  let rotationFailures = 0;
  for (const frame of packed) {
    if (frame.rotation !== 0 && frame.rotation !== 90) rotationFailures++;
    if (frame.empty && frame.rotation !== 0) rotationFailures++;
  }
  checks.push({
    id: 'rotation',
    label: 'Rotation is recorded and limited to clockwise 0° / 90°',
    ok: rotationFailures === 0,
    detail: rotationFailures === 0 ? 'rotation explicit for all frames' : `${rotationFailures} invalid rotation(s)`,
  });

  const emptyFrames = manifest.frames.filter((frame) => frame.empty);
  const emptyUnplaced = emptyFrames.filter((frame) => frame.status !== 'packed');
  checks.push({
    id: 'empty-frames',
    label: 'Fully transparent frames are kept and packed',
    ok: emptyUnplaced.length === 0,
    detail:
      emptyFrames.length === 0
        ? 'no fully transparent frames in this import'
        : `${emptyFrames.length} empty frame(s), ${emptyUnplaced.length} unplaced`,
  });

  const unplaced = manifest.frames.filter((frame) => frame.status === 'unplaced');
  checks.push({
    id: 'summary',
    label: 'Manifest summary agrees with the frame list',
    ok:
      manifest.summary.total === manifest.frames.length &&
      manifest.summary.packed === packed.length &&
      manifest.summary.unplaced === unplaced.length &&
      manifest.summary.empty === emptyFrames.length,
    detail: JSON.stringify(manifest.summary),
  });

  return checks;
}
