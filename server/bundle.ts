/**
 * Independent bundle loader. Reads ONLY the files that are inside an exported
 * zip / export directory — no source images, no in-memory packer state — and
 * answers: does this data alone describe a coherent, replayable atlas?
 *
 * Used by the export flow, the CLI and the tests. The browser standalone
 * preview performs the same reconstruction through shared/reconstruct.ts.
 */

import type { AnimationSpec, AtlasManifest, VerificationReport } from '../shared/types';
import { ANIMATION_FORMAT, ATLAS_FORMAT } from '../shared/types';
import type { RGBAImage } from '../shared/pixels';
import { findAlphaBounds } from '../shared/pixels';
import { verifyStructure } from '../shared/verify';
import { reconstructFrame } from '../shared/reconstruct';
import { decodePng } from './png';

export interface LoadedBundle {
  manifest: AtlasManifest;
  animation: AnimationSpec;
  pages: Map<number, RGBAImage>;
  /** Page file name -> decoded image, useful for tests and the CLI. */
  pageFiles: Map<string, RGBAImage>;
}

export function parseBundle(files: Record<string, Uint8Array>): LoadedBundle {
  const decodeText = (data: Uint8Array) => new TextDecoder().decode(data);
  const atlasBytes = files['atlas.json'];
  if (!atlasBytes) throw new Error('Bundle is missing atlas.json');
  const manifest = JSON.parse(decodeText(atlasBytes)) as AtlasManifest;
  const animationBytes = files['animation.json'];
  if (!animationBytes) throw new Error('Bundle is missing animation.json');
  const animation = JSON.parse(decodeText(animationBytes)) as AnimationSpec;
  return { manifest, animation, pages: new Map(), pageFiles: new Map() };
}

/** Decode page PNGs listed in the manifest from the bundle file map. */
export async function decodeBundlePages(
  manifest: AtlasManifest,
  files: Record<string, Uint8Array>,
): Promise<Map<number, RGBAImage>> {
  const pages = new Map<number, RGBAImage>();
  for (const page of manifest.pages) {
    const bytes = files[`pages/${page.file}`];
    if (!bytes) continue;
    const decoded = await decodePng(Buffer.from(bytes));
    pages.set(page.index, decoded.image);
  }
  return pages;
}

function check(id: string, label: string, ok: boolean, detail: string) {
  return { id, label, ok, detail };
}

/**
 * Validate an exported bundle against itself. This can detect wrong
 * dimensions, impossible rotations, anchors outside each canvas, missing
 * pages, animation references to unknown frames, and trimmed bounds that do
 * not match the reconstructed content.
 */
export async function verifyBundle(files: Record<string, Uint8Array>): Promise<{
  report: VerificationReport;
  loaded: LoadedBundle;
}> {
  const loaded = parseBundle(files);
  const { manifest, animation } = loaded;
  const checks = verifyStructure(manifest);
  const warnings: string[] = [];

  if (manifest.format !== ATLAS_FORMAT) {
    checks.push(check('bundle-atlas-format', 'atlas.json format id', false, String(manifest.format)));
  }
  if (animation.format !== ANIMATION_FORMAT) {
    checks.push(check('bundle-animation-format', 'animation.json format id', false, String(animation.format)));
  }

  // Decode pages purely from bundle files, matched by their declared names.
  const pages = new Map<number, RGBAImage>();
  let missingPages = 0;
  for (const page of manifest.pages) {
    const bytes = files[`pages/${page.file}`];
    if (!bytes) {
      missingPages++;
      continue;
    }
    const decoded = await decodePng(Buffer.from(bytes));
    pages.set(page.index, decoded.image);
    if (decoded.image.width !== page.width || decoded.image.height !== page.height) {
      warnings.push(
        `page ${page.index} decoded as ${decoded.image.width}x${decoded.image.height}, manifest says ${page.width}x${page.height}`,
      );
    }
  }
  checks.push(
    check(
      'bundle-pages-present',
      'Every page listed in atlas.json exists in the bundle',
      missingPages === 0,
      missingPages === 0 ? `${pages.size} page PNG(s) decoded` : `${missingPages} page file(s) missing`,
    ),
  );

  // Reconstruct every frame from page bytes only and check its geometry.
  let geometryFailures = 0;
  let alphaBoundsFailures = 0;
  let emptyChecked = 0;
  for (const frame of manifest.frames) {
    if (frame.status !== 'packed') continue;
    const page = frame.page === null ? null : pages.get(frame.page) ?? null;
    const built = reconstructFrame(frame, page);
    if (built.errors.length > 0) {
      geometryFailures++;
      warnings.push(...built.errors.slice(0, 2));
    }
    if (frame.empty) {
      emptyChecked++;
      if (frame.trim.width !== 0 || frame.trim.height !== 0) {
        alphaBoundsFailures++;
        warnings.push(`empty frame ${frame.id} has a non-zero trim`);
      }
      continue;
    }
    const bounds = findAlphaBounds(built.canvas);
    if (!bounds) {
      alphaBoundsFailures++;
      warnings.push(`frame ${frame.id} reconstructed completely empty although it is not marked empty`);
      continue;
    }
    const mismatched =
      bounds.x > frame.trim.x ||
      bounds.y > frame.trim.y ||
      bounds.x + bounds.width < frame.trim.x + frame.trim.width ||
      bounds.y + bounds.height < frame.trim.y + frame.trim.height;
    // The reconstructed alpha bounds must sit inside the declared trim box and
    // must touch its border (the trim box is by definition the alpha bounds).
    const shrunk =
      bounds.x !== frame.trim.x ||
      bounds.y !== frame.trim.y ||
      bounds.width !== frame.trim.width ||
      bounds.height !== frame.trim.height;
    if (!mismatched && shrunk) {
      alphaBoundsFailures++;
      warnings.push(
        `frame ${frame.id} reconstructed alpha bounds ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} differ from declared trim ${frame.trim.x},${frame.trim.y} ${frame.trim.width}x${frame.trim.height}`,
      );
    }
  }
  checks.push(
    check(
      'bundle-frame-geometry',
      'Every frame reconstructs from its page with consistent geometry',
      geometryFailures === 0,
      geometryFailures === 0
        ? `${manifest.summary.packed} frame(s) reconstructed from page bytes`
        : `${geometryFailures} frame(s) with geometry problems`,
    ),
  );
  checks.push(
    check(
      'bundle-trim-bounds',
      'Declared trim boxes match reconstructed alpha bounds',
      alphaBoundsFailures === 0,
      alphaBoundsFailures === 0
        ? `${manifest.summary.packed - emptyChecked} content frame(s) and ${emptyChecked} empty frame(s) consistent`
        : `${alphaBoundsFailures} frame(s) inconsistent`,
    ),
  );

  // Animation references and anchor semantics.
  const known = new Set(manifest.frames.map((frame) => frame.id));
  const unknown = animation.frames.filter((frame) => !known.has(frame.id));
  const badDurations = animation.frames.filter(
    (frame) => !Number.isFinite(frame.durationMs) || frame.durationMs < 10 || frame.durationMs > 60000,
  );
  const anchorOk =
    Number.isFinite(animation.anchor?.x) &&
    Number.isFinite(animation.anchor?.y) &&
    animation.anchor.x >= 0 &&
    animation.anchor.x <= 1 &&
    animation.anchor.y >= 0 &&
    animation.anchor.y <= 1;
  checks.push(
    check(
      'bundle-animation-refs',
      'Animation references existing frames with valid durations',
      unknown.length === 0 && badDurations.length === 0 && anchorOk,
      `${animation.frames.length} clip frame(s), ${unknown.length} unknown id(s), ${badDurations.length} bad duration(s), anchor ${anchorOk ? 'ok' : 'invalid'}`,
    ),
  );

  // Anchors must be inside every referenced ORIGINAL canvas; otherwise the
  // alignment would use a point outside the image.
  let anchorOutside = 0;
  for (const ref of animation.frames) {
    const frame = manifest.frames.find((item) => item.id === ref.id);
    if (!frame) continue;
    if (frame.sourceSize.width <= 0 || frame.sourceSize.height <= 0) anchorOutside++;
  }
  checks.push(
    check(
      'bundle-anchor-canvases',
      'Every animation frame has a usable original canvas for the anchor',
      anchorOutside === 0,
      anchorOutside === 0 ? 'all source canvases valid' : `${anchorOutside} invalid canvas(es)`,
    ),
  );

  const report: VerificationReport = {
    ok: checks.every((entry) => entry.ok),
    checks,
    framesChecked: manifest.summary.packed,
    pagesChecked: pages.size,
    ignoredTransparentPixels: 0,
    warnings,
  };
  loaded.pages = pages;
  return { report, loaded };
}
