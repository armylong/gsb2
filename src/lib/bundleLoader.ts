/**
 * Browser-side export loader. Reads only exported files (atlas.json,
 * animation.json, pages/*.png) — either from a ZIP or a multi-file selection —
 * and builds object URLs so the standalone preview never touches the server
 * or the original images.
 */

import { unzipSync } from 'fflate';
import type { AnimationFrameRef, AnimationSpec, AtlasManifest, VerificationCheck } from '../../shared/types';
import { ANIMATION_FORMAT, ATLAS_FORMAT } from '../../shared/types';
import { verifyStructure } from '../../shared/verify';

export interface LoadedExport {
  manifest: AtlasManifest;
  animation: AnimationSpec;
  pageUrls: string[];
  /** Structural checks run purely on the loaded JSON. */
  checks: VerificationCheck[];
  /** Object URLs created for the pages; must be revoked when replaced. */
  objectUrls: string[];
  /** Where the data came from: in-memory export, ZIP file or loose files. */
  source: 'server' | 'zip' | 'files';
}

function parseAtlas(text: string): AtlasManifest {
  const parsed = JSON.parse(text) as AtlasManifest;
  if (!parsed || parsed.format !== ATLAS_FORMAT) {
    throw new Error(`atlas.json is not ${ATLAS_FORMAT}`);
  }
  if (!Array.isArray(parsed.pages) || !Array.isArray(parsed.frames)) {
    throw new Error('atlas.json is missing pages or frames');
  }
  return parsed;
}

function parseAnimation(text: string): AnimationSpec {
  const parsed = JSON.parse(text) as Partial<AnimationSpec>;
  if (parsed.format !== ANIMATION_FORMAT) {
    throw new Error(`animation.json is not ${ANIMATION_FORMAT}`);
  }
  const anchor = parsed.anchor ?? { x: 0.5, y: 1 };
  return {
    format: ANIMATION_FORMAT,
    name: String(parsed.name ?? 'animation'),
    loop: parsed.loop !== false,
    anchor: {
      x: Number.isFinite(anchor.x) ? anchor.x : 0.5,
      y: Number.isFinite(anchor.y) ? anchor.y : 1,
    },
    frames: Array.isArray(parsed.frames)
      ? (parsed.frames as AnimationFrameRef[])
          .filter((frame) => frame && typeof frame.id === 'string')
          .map((frame) => ({ id: String(frame.id), durationMs: Number(frame.durationMs) || 120 }))
      : [],
  };
}

function assemble(
  atlasText: string,
  animationText: string,
  pageBlobs: Map<string, Blob>,
  source: LoadedExport['source'],
): LoadedExport {
  const manifest = parseAtlas(atlasText);
  const animation = parseAnimation(animationText);
  const objectUrls: string[] = [];
  const pageUrls = manifest.pages.map((page) => {
    const blob = pageBlobs.get(page.file);
    if (!blob) throw new Error(`缺少页面文件 pages/${page.file}`);
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  });
  return {
    manifest,
    animation,
    pageUrls,
    checks: verifyStructure(manifest),
    objectUrls,
    source,
  };
}

/** Load an exported ZIP (sprite-atlas.zip). */
export async function loadExportZip(file: File): Promise<LoadedExport> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(bytes);
  const decoder = new TextDecoder();
  const read = (path: string): string | null => {
    const entry = entries[path];
    return entry ? decoder.decode(entry) : null;
  };
  const readLoose = (name: string): string | null => {
    const key = Object.keys(entries).find((path) => path === name || path.endsWith(`/${name}`));
    return key ? decoder.decode(entries[key]) : null;
  };
  const atlasText = read('atlas.json') ?? readLoose('atlas.json');
  const animationText = read('animation.json') ?? readLoose('animation.json');
  if (!atlasText) throw new Error('ZIP 中缺少 atlas.json');
  if (!animationText) throw new Error('ZIP 中缺少 animation.json');
  const pageBlobs = new Map<string, Blob>();
  for (const [path, data] of Object.entries(entries)) {
    const match = /(?:^|\/)pages\/(.+)$/.exec(path);
    if (!match) continue;
    const copy = new Uint8Array(data);
    pageBlobs.set(match[1], new Blob([copy.buffer as ArrayBuffer], { type: 'image/png' }));
  }
  return assemble(atlasText, animationText, pageBlobs, 'zip');
}

/** Load a manual selection of exported files (atlas.json, animation.json, pages). */
export async function loadExportFiles(files: File[]): Promise<LoadedExport> {
  let atlasText: string | null = null;
  let animationText: string | null = null;
  const pageBlobs = new Map<string, Blob>();
  for (const file of files) {
    const path = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, '/');
    if (path.endsWith('atlas.json')) {
      atlasText = await file.text();
    } else if (path.endsWith('animation.json')) {
      animationText = await file.text();
    } else if (path.toLowerCase().endsWith('.png')) {
      pageBlobs.set(path.split('/').pop()!, file);
    }
  }
  if (!atlasText) throw new Error('请包含 atlas.json');
  if (!animationText) throw new Error('请包含 animation.json');
  return assemble(atlasText, animationText, pageBlobs, 'files');
}

export function parseAnimationJsonText(text: string): AnimationSpec {
  return parseAnimation(text);
}
