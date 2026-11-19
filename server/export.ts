/**
 * Export bundle writer and the independent verifier.
 *
 * The verifier deliberately re-reads the produced PNG files and reconstructs
 * every frame through `shared/reconstruct.ts`, the same code the browser uses.
 * It does not compare against the packer's intermediate raster.
 */

import type {
  AnimationSpec,
  AtlasFrame,
  AtlasManifest,
  VerificationReport,
} from '../shared/types';
import { ANIMATION_FORMAT } from '../shared/types';
import type { RGBAImage } from '../shared/pixels';
import { compareImages } from '../shared/pixels';
import { decodePng, encodePng } from './png';
import { renderPages } from '../shared/atlasRenderer';
import { reconstructFrame } from '../shared/reconstruct';
import { verifyStructure } from '../shared/verify';
import type { StoredSource } from './sourceStore';
import { zipSync, strToU8 } from 'fflate';

export interface ExportInput {
  manifest: AtlasManifest;
  sources: Map<string, StoredSource>;
  animation: AnimationSpec;
}

export interface ExportArtifacts {
  manifest: AtlasManifest;
  pagePngs: { index: number; file: string; png: Buffer }[];
  /** Files keyed by their path inside the bundle. */
  files: Record<string, Uint8Array>;
  zip: Buffer;
  verification: VerificationReport;
}

/**
 * Verify a manifest + page PNGs independently of how they were produced.
 * Structural rules come from shared/verify.ts (the same code the browser
 * runs when loading an export). Returns a report; never throws on bad data.
 */
export function verifyAtlas(
  manifest: AtlasManifest,
  pages: Map<number, RGBAImage>,
  sources: Map<string, StoredSource>,
): VerificationReport {
  const warnings: string[] = [];
  // Structural rules first; they are shared with the browser-side loader.
  const checks: VerificationReport['checks'] = verifyStructure(manifest);

  // Pixel round trip, page by page.
  let framesChecked = 0;
  let pagesChecked = 0;
  let ignoredTransparentPixels = 0;
  let pixelFailures = 0;
  let geometryFailures = 0;
  const failureSamples: string[] = [];
  for (const page of manifest.pages) {
    const image = pages.get(page.index);
    if (!image) {
      pixelFailures++;
      failureSamples.push(`page ${page.index} is missing`);
      continue;
    }
    pagesChecked++;
    for (const frame of manifest.frames) {
      if (frame.page !== page.index || frame.status !== 'packed') continue;
      const source = sources.get(frame.id);
      if (!source) {
        geometryFailures++;
        continue;
      }
      const reconstructed = reconstructFrame(frame, image);
      framesChecked++;
      if (reconstructed.errors.length > 0) {
        geometryFailures++;
        failureSamples.push(...reconstructed.errors.slice(0, 2));
      }
      // Compare against the original canvas, not the page.
      const comparison = compareImages(source.image, reconstructed.canvas);
      ignoredTransparentPixels += comparison.ignoredPixels;
      if (!comparison.match) {
        pixelFailures++;
        if (comparison.firstDiff) {
          failureSamples.push(
            `frame ${frame.id} differs at (${comparison.firstDiff.x},${comparison.firstDiff.y}) expected ${comparison.firstDiff.expected} got ${comparison.firstDiff.actual}`,
          );
        }
      }
      // Edge extrusion must be a copy of the adjacent content pixel: no new colors.
      if (!frame.empty && frame.packedRect && frame.contentRect) {
        const slotCheck = verifyExtrusionPixels(image, frame);
        if (!slotCheck.ok) {
          geometryFailures++;
          failureSamples.push(slotCheck.message);
        }
      }
    }
  }

  checks.push({
    id: 'pixel-roundtrip',
    label: 'Every frame reconstructed from the exported PNG matches its original canvas',
    ok: pixelFailures === 0 && geometryFailures === 0,
    detail:
      pixelFailures === 0 && geometryFailures === 0
        ? `${framesChecked} frame(s) across ${pagesChecked} page(s) match (only RGB under alpha 0 ignored)`
        : `${pixelFailures} pixel mismatch(es), ${geometryFailures} geometry issue(s): ${failureSamples.slice(0, 3).join(' | ')}`,
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    framesChecked,
    pagesChecked,
    ignoredTransparentPixels,
    warnings,
  };
}

/**
 * Check the extrusion ring around a packed content rectangle on the page.
 * Every ring pixel must equal the content pixel it was replicated from.
 * This is what prevents a dark fringe: the ring holds the *edge content*
 * color (including alpha), never transparent black.
 */
function verifyExtrusionPixels(page: RGBAImage, frame: AtlasFrame): { ok: boolean; message: string } {
  const packed = frame.packedRect;
  const content = frame.contentRect;
  if (!packed || !content || frame.extrude <= 0) return { ok: true, message: '' };
  const pixel = (x: number, y: number) => {
    const o = (y * page.width + x) * 4;
    return [page.data[o], page.data[o + 1], page.data[o + 2], page.data[o + 3]];
  };
  for (let dy = 0; dy < packed.height; dy++) {
    for (let dx = 0; dx < packed.width; dx++) {
      const x = packed.x + dx;
      const y = packed.y + dy;
      const inContent =
        x >= content.x && x < content.x + content.width && y >= content.y && y < content.y + content.height;
      if (inContent) continue;
      // Clamp-to-edge source pixel in content space.
      const sx = Math.min(content.x + content.width - 1, Math.max(content.x, x));
      const sy = Math.min(content.y + content.height - 1, Math.max(content.y, y));
      if (content.width === 0 || content.height === 0) continue;
      const a = pixel(x, y);
      const b = pixel(sx, sy);
      for (let c = 0; c < 4; c++) {
        if (a[c] !== b[c]) {
          return {
            ok: false,
            message: `frame ${frame.id} extrusion pixel (${x},${y}) is [${a}] but edge content is [${b}]`,
          };
        }
      }
    }
  }
  return { ok: true, message: '' };
}

/** Build page PNGs, the export bundle and a verification report. */
export async function buildExportBundle(input: ExportInput): Promise<ExportArtifacts> {
  const { manifest, sources, animation } = input;

  // 1. Render pages from the sources.
  const sourcePixels = new Map<string, { image: RGBAImage }>();
  for (const [, stored] of sources) sourcePixels.set(stored.info.id, stored);
  const rasters = renderPages(manifest.pages, manifest.frames, sourcePixels, manifest.settings);

  // 2. Encode to PNG and re-decode. Verification runs on the decoded data.
  const pagePngs: ExportArtifacts['pagePngs'] = [];
  const decodedPages = new Map<number, RGBAImage>();
  for (const raster of rasters) {
    const png = await encodePng(raster.image);
    const decoded = await decodePng(png);
    decodedPages.set(raster.page.index, decoded.image);
    pagePngs.push({ index: raster.page.index, file: raster.page.file, png });
  }

  // 3. Verify with an independent read-back.
  const verification = verifyAtlas(manifest, decodedPages, sources);

  // 4. Bundle everything an offline player needs.
  const files: Record<string, Uint8Array> = {};
  files['atlas.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files[`animation.json`] = strToU8(JSON.stringify(
    {
      format: ANIMATION_FORMAT,
      name: animation.name,
      loop: animation.loop,
      anchor: animation.anchor,
      atlas: 'atlas.json',
      frames: animation.frames,
    } satisfies Record<string, unknown>,
    null,
    2,
  ));
  files['README.txt'] = strToU8(renderReadme(manifest, animation, verification));
  for (const page of pagePngs) {
    files[`pages/${page.file}`] = new Uint8Array(page.png);
  }
  // Archive is deterministic: file order is fixed and mtimes are epoch.
  const ordered: Record<string, Uint8Array> = {};
  for (const key of Object.keys(files).sort()) ordered[key] = files[key];
  const zip = Buffer.from(zipSync(ordered, { level: 9, mtime: ZIP_EPOCH }));

  return { manifest, pagePngs, files, zip, verification };
}

/** A dependency-free explanation of the coordinate contract. */
// Fixed archive timestamp (1980-01-01) so identical inputs produce identical zips.
const ZIP_EPOCH = Date.UTC(1980, 0, 1, 0, 0, 0);

export function renderReadme(manifest: AtlasManifest, animation: AnimationSpec, verification: VerificationReport): string {
  const lines = [
    'Sprite atlas export',
    '==================',
    '',
    `Format: ${manifest.format}`,
    `Pages: ${manifest.pages.length} (${manifest.pages.map((p) => p.file).join(', ') || 'none'})`,
    `Frames: ${manifest.frames.length} (${manifest.summary.packed} packed, ${manifest.summary.unplaced} unplaced, ${manifest.summary.empty} fully transparent)`,
    '',
    'Coordinate contract',
    '-------------------',
    'All values are pixels with a top-left origin.',
    'sourceSize : original canvas size, untouched by trimming.',
    'trim       : transparent bounds inside the original canvas.',
    'rotation   : CLOCKWISE rotation applied to the trimmed content when packed',
    '             (0 or 90 degrees). To restore, rotate the content 90deg',
    '             counter-clockwise.',
    'extrude    : edge-replication width (bleed guard) on EVERY side inside the slot.',
    'packedRect : slot in page coordinates, including extrusion.',
    'contentRect: effective content in page coordinates. It equals packedRect',
    '             inset by extrude on every side and has the ROTATED content size.',
    '',
    'Restoring a frame',
    '-----------------',
    '1. Crop contentRect (not packedRect) from the page image.',
    '2. Rotate the crop counter-clockwise by `rotation` degrees.',
    '3. Draw it at (trim.x, trim.y) on a transparent sourceSize canvas.',
    'The packed page position is NOT used for placement; trim + sourceSize are.',
    '',
    'Fully transparent frames',
    '------------------------',
    'empty=true, trim=0x0, contentRect=0x0. They keep their id and are still',
    'listed in the manifest. No pixels are written for them, so the page area',
    'under their slot is transparent.',
    '',
    `Spacing (${manifest.settings.spacing}px) is empty space between slots.`,
    `Extrusion (${manifest.settings.extrude}px) replicates edge pixels to stop`,
    'sampling bleeding. They are independent settings and both recorded.',
    '',
    'Animation',
    '---------',
    `Anchor is normalized inside each frame's ORIGINAL canvas: (${animation.anchor.x}, ${animation.anchor.y}).`,
    'Align anchors when drawing, not atlas positions, so trimming cannot',
    'cause positional jumps between frames on different pages.',
    '',
    'Verification',
    '------------',
    `ok=${verification.ok}, frames=${verification.framesChecked}, pages=${verification.pagesChecked}`,
    `Ignored pixels: ${verification.ignoredTransparentPixels} (RGB only, under alpha 0)`,
    ...verification.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`),
    '',
  ];
  return lines.join('\n');
}

