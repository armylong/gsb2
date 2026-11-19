/**
 * Runs the whole flow headlessly and asserts the guarantees that matter:
 *
 *   1. Import analysis keeps the original canvas, trim bounds and empty frames.
 *   2. Packing is deterministic under input shuffling and multi-page.
 *   3. Every frame exported in the PNGs reconstructs to its original canvas
 *      pixel-for-pixel (alpha exact; RGB ignored only under alpha 0).
 *   4. The exported bundle alone reproduces the animation frame by frame,
 *      including frames on different pages with different transparent bounds.
 *   5. Rotation, extrusion and spacing are recorded and consistent.
 *
 * This is the command `npm run headless-check`; it exits non-zero on failure.
 * It complements `npm test` by walking the same path the UI uses via the
 * service (import -> pack -> export -> reload) with printed diagnostics.
 */

import { AtlasService } from '../server/service';
import { decodeBundlePages, parseBundle, verifyBundle } from '../server/bundle';
import { composeAnimation } from '../shared/animation';
import { compareImages } from '../shared/pixels';
import { reconstructFrame } from '../shared/reconstruct';
import { DEFAULT_SETTINGS, type AnimationSpec, type PackSettings } from '../shared/types';
import { ANIMATION_FORMAT } from '../shared/types';
import { decodePng } from '../server/png';

const failures: string[] = [];

function check(condition: boolean, label: string, detail = ''): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const settings: PackSettings = {
  ...DEFAULT_SETTINGS,
  pageWidth: 96,
  pageHeight: 96,
  spacing: 3,
  margin: 2,
  extrude: 1,
  allowRotation: true,
};

async function main() {
  console.log('== import ==');
  const service = new AtlasService();
  const first = await service.loadSamples();
  const second = await service.loadSamples();
  check(first.frames.length > 0, 'sample frames imported', `${first.frames.length}`);
  check(second.duplicates.length === first.frames.length, 're-import reports duplicates, no overwrite');
  check(service.listFrames().length === first.frames.length, 'frame count stable after re-import');

  const empty = first.frames.find((frame) => frame.empty);
  check(Boolean(empty), 'fully transparent frame kept');
  check(empty?.trim.width === 0 && empty?.trim.height === 0, 'empty frame has 0x0 trim');
  const sameNames = first.frames.filter((frame) => frame.name === 'hero_idle.png');
  check(sameNames.length === 2, 'same basename from two directories kept separate', `${sameNames.length}`);
  check(
    sameNames.length === 2 && sameNames[0].id !== sameNames[1].id,
    'same basename yields distinct stable ids',
  );

  console.log('\n== pack ==');
  const ids = service.listFrames().map((frame) => frame.id);
  const shuffled = [...ids].reverse();
  const a = await service.pack(settings, ids);
  const b = await service.pack(settings, shuffled);
  check(a.buildId === b.buildId, 'same layout for shuffled import order', a.buildId);
  check(
    JSON.stringify(a.manifest) === JSON.stringify(b.manifest),
    'manifest identical (ids, pages, rects) regardless of order',
  );
  check(a.manifest.pages.length > 1, 'multiple pages generated', `${a.manifest.pages.length}`);

  const huge = a.issues.filter((issue) => issue.code === 'FRAME_TOO_LARGE');
  check(huge.length > 0, 'oversized frames are reported explicitly', huge[0]?.message ?? '');
  const unplaced = a.manifest.frames.filter((frame) => frame.status === 'unplaced');
  check(
    unplaced.every((frame) => frame.page === null && frame.packedRect === null),
    'unplaced frames have no page and no packed rect',
  );
  check(
    unplaced.every((frame) => huge.some((issue) => issue.frameId === frame.id)),
    'every unplaced frame maps to a FRAME_TOO_LARGE issue',
  );

  const rotated = a.manifest.frames.filter((frame) => frame.rotation !== 0);
  check(
    rotated.every((frame) => frame.rotation === 90),
    'rotation recorded as clockwise 90 only',
    `${rotated.length} rotated`,
  );

  for (const frame of a.manifest.frames) {
    if (frame.status !== 'packed' || !frame.packedRect || !frame.contentRect) continue;
    const insetOk =
      frame.contentRect.x === frame.packedRect.x + frame.extrude &&
      frame.contentRect.y === frame.packedRect.y + frame.extrude &&
      frame.contentRect.width === frame.packedRect.width - frame.extrude * 2 &&
      frame.contentRect.height === frame.packedRect.height - frame.extrude * 2;
    if (!insetOk) {
      check(false, `content rect inset for ${frame.id}`);
    }
  }
  check(true, 'contentRect equals packedRect minus extrusion for all packed frames');

  console.log('\n== verify (server, read-back PNGs) ==');
  for (const entry of a.verification.checks) {
    check(entry.ok, `build:${entry.id}`, entry.detail);
  }
  check(a.verification.ignoredTransparentPixels >= 0, 'transparent RGB ignored count reported', `${a.verification.ignoredTransparentPixels}`);

  console.log('\n== export + reload ==');
  const animation: AnimationSpec = {
    format: ANIMATION_FORMAT,
    name: 'headless',
    loop: true,
    anchor: { x: 0.5, y: 1 },
    frames: a.manifest.frames
      .filter((frame) => frame.status === 'packed' && !frame.empty)
      .map((frame) => ({ id: frame.id, durationMs: 80 })),
  };
  const exported = await service.export(a.buildId, animation);
  check(exported.verification.ok, 'export verification ok');
  const files = service.getExport(exported.exportId)!.artifacts.files;
  check(Boolean(files['atlas.json']), 'atlas.json present');
  check(Boolean(files['animation.json']), 'animation.json present');
  check(Boolean(files['README.txt']), 'README.txt present');
  check(
    Object.keys(files).filter((name) => name.startsWith('pages/')).length === a.manifest.pages.length,
    'one PNG per page in the bundle',
  );

  const bundle = await verifyBundle(files);
  for (const entry of bundle.report.checks) {
    check(entry.ok, `bundle:${entry.id}`, entry.detail);
  }

  const parsed = parseBundle(files);
  const pages = await decodeBundlePages(parsed.manifest, files);
  const composed = composeAnimation(parsed.manifest, parsed.animation, pages);
  check(composed.errors.length === 0, 'animation composes from bundle files only', composed.errors.join('; '));
  check(
    composed.frames.length === animation.frames.length,
    'all animation frames present after reload',
    `${composed.frames.length}/${animation.frames.length}`,
  );

  // Frame-by-frame comparison against the original canvases.
  let compared = 0;
  let mismatched = 0;
  let ignored = 0;
  for (const frame of a.manifest.frames) {
    if (frame.status !== 'packed') continue;
    const stored = service.store.get(frame.id);
    if (!stored) continue;
    const page = frame.page === null ? null : pages.get(frame.page) ?? null;
    const reconstructed = reconstructFrame(frame, page);
    const comparison = compareImages(stored.image, reconstructed.canvas);
    compared++;
    ignored += comparison.ignoredPixels;
    if (!comparison.match) {
      mismatched++;
      console.log(`    mismatch ${frame.id}: ${comparison.diffPixels} px`);
    }
  }
  check(mismatched === 0, 'reloaded frames match original canvases', `${compared} frames, ${ignored} ignored RGB px`);

  console.log('\n== multipage animation stability ==');
  const onDifferentPages = new Set(composed.frames.map((frame) => a.manifest.frames.find((entry) => entry.id === frame.id)?.page));
  check(onDifferentPages.size > 1, 'animation spans more than one page', `${onDifferentPages.size} pages`);
  // Offsets depend only on original canvas + anchor.
  const offsetsOk = composed.frames.every((frame) => {
    const atlasFrame = a.manifest.frames.find((entry) => entry.id === frame.id)!;
    return (
      frame.offset.x === Math.round(0.5 * composed.stage.width - 0.5 * atlasFrame.sourceSize.width) &&
      frame.offset.y === Math.round(1 * composed.stage.height - 1 * atlasFrame.sourceSize.height)
    );
  });
  check(offsetsOk, 'frame offsets follow original canvas + anchor, not page positions');

  // Repack and confirm the composition is byte-identical.
  const repacked = await service.pack({ ...settings, pageWidth: 150, pageHeight: 120, spacing: 1, extrude: 2 });
  const repackedPages = new Map<number, Awaited<ReturnType<typeof decodePng>>['image']>();
  for (const page of repacked.pages) {
    repackedPages.set(page.index, (await decodePng(service.getPagePng(repacked.buildId, page.file)!)).image);
  }
  const recomposed = composeAnimation(repacked.manifest, animation, repackedPages);
  const sameStage = JSON.stringify(recomposed.stage) === JSON.stringify(composed.stage);
  const sameOffsets = JSON.stringify(recomposed.frames.map((frame) => frame.offset)) === JSON.stringify(composed.frames.map((frame) => frame.offset));
  const samePixels = recomposed.frames.every((frame, index) => compareImages(frame.image, composed.frames[index].image).match);
  const idsStable = animation.frames.every((ref) => repacked.manifest.frames.some((frame) => frame.id === ref.id));
  check(sameStage && sameOffsets && samePixels, 'repacking with new settings yields identical playback');
  check(idsStable, 'animation frame ids survive repacking');

  console.log('');
  if (failures.length > 0) {
    console.log(`RESULT: FAILED (${failures.length} check(s))`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('RESULT: OK — all headless checks passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
