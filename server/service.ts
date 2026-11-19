/** Local build service: import, pack, build preview, export. */

import { createHash } from 'node:crypto';
import type {
  AnimationSpec,
  AtlasManifest,
  AtlasPage,
  BuildPage,
  BuildResult,
  ImportResult,
  PackIssue,
  PackSettings,
  SourceFrameInfo,
  VerificationReport,
} from '../shared/types';
import { ANIMATION_FORMAT, ATLAS_FORMAT } from '../shared/types';
import { packFrames } from '../shared/pack';
import { analyzeImage } from './analyze';
import { SourceStore, type StoredSource } from './sourceStore';
import { decodePng } from './png';
import { buildExportBundle, type ExportArtifacts } from './export';
import { generateSamples } from './samples';
import { normalizeSourceKey } from '../shared/identity';

interface BuildRecord {
  buildId: string;
  manifest: AtlasManifest;
  pages: BuildPage[];
  issues: PackIssue[];
  verification: VerificationReport;
  pagePngs: Map<number, Buffer>;
}

interface ExportRecord {
  exportId: string;
  buildId: string;
  artifacts: ExportArtifacts;
  animation: AnimationSpec;
  createdAt: number;
}

export interface ImportOutcome {
  info: SourceFrameInfo;
  /** True when this exact id was already imported; the first copy is kept. */
  duplicate: boolean;
}

export interface ServiceOptions {
  maxUploadBytes?: number;
}

const MAX_BUILDS = 12;
const MAX_EXPORTS = 12;

function manifestHash(manifest: Omit<AtlasManifest, 'pages'> & { pages: AtlasPage[] }): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
}

export function validateAnimation(spec: AnimationSpec, known: Set<string>): string[] {
  const errors: string[] = [];
  if (spec.format !== ANIMATION_FORMAT) errors.push(`animation.format must be ${ANIMATION_FORMAT}`);
  if (!spec.name || typeof spec.name !== 'string') errors.push('animation.name must be a non-empty string');
  if (typeof spec.loop !== 'boolean') errors.push('animation.loop must be a boolean');
  if (
    !Number.isFinite(spec.anchor?.x) ||
    !Number.isFinite(spec.anchor?.y) ||
    spec.anchor.x < 0 ||
    spec.anchor.x > 1 ||
    spec.anchor.y < 0 ||
    spec.anchor.y > 1
  ) {
    errors.push('animation.anchor must be normalized coordinates in [0, 1]');
  }
  if (!Array.isArray(spec.frames)) {
    errors.push('animation.frames must be an array (it may be empty)');
  }
  const seen = new Set<string>();
  for (const frame of spec.frames ?? []) {
    if (!known.has(frame.id)) errors.push(`animation references unknown frame id ${frame.id}`);
    if (seen.has(frame.id)) errors.push(`animation repeats frame id ${frame.id}`);
    seen.add(frame.id);
    if (!Number.isFinite(frame.durationMs) || frame.durationMs < 10 || frame.durationMs > 60000) {
      errors.push(`duration for ${frame.id} must be between 10 and 60000 ms`);
    }
  }
  return errors;
}

export class AtlasService {
  readonly store = new SourceStore();
  private builds = new Map<string, BuildRecord>();
  private exports = new Map<string, ExportRecord>();
  private readonly maxUploadBytes: number;

  constructor(options: ServiceOptions = {}) {
    this.maxUploadBytes = options.maxUploadBytes ?? 64 * 1024 * 1024;
  }

  listFrames(): SourceFrameInfo[] {
    return this.store.list().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async importBase64(name: string, sourceKey: string, dataBase64: string): Promise<ImportOutcome> {
    const raw = Buffer.from(dataBase64, 'base64');
    return this.importBuffer(name, sourceKey, raw);
  }

  /**
   * Import one PNG. Never overwrites an existing frame: an identical id is
   * reported back as a duplicate so callers can surface it.
   */
  async importBuffer(name: string, sourceKey: string, raw: Buffer): Promise<ImportOutcome> {
    if (raw.byteLength === 0) throw new Error(`${name}: file is empty`);
    if (raw.byteLength > this.maxUploadBytes) {
      throw new Error(`${name}: file exceeds the ${Math.round(this.maxUploadBytes / (1024 * 1024))} MB limit`);
    }
    const decoded = await decodePng(raw);
    const analysis = analyzeImage(decoded.image);
    const key = normalizeSourceKey(sourceKey);
    const { stored, duplicate } = this.store.addReporting(key, decoded.image, raw);
    if (!duplicate) {
      this.store.updateInfo(stored.info.id, { ...analysis, name, sourceKey: key });
    }
    return { info: this.store.get(stored.info.id)!.info, duplicate };
  }

  async importMany(files: { name: string; sourceKey: string; dataBase64: string }[]): Promise<ImportResult> {
    const frames: SourceFrameInfo[] = [];
    const rejected: ImportResult['rejected'] = [];
    const duplicates: ImportResult['duplicates'] = [];
    for (const file of files) {
      try {
        const outcome = await this.importBase64(file.name, file.sourceKey || file.name, file.dataBase64);
        frames.push(outcome.info);
        if (outcome.duplicate) {
          duplicates.push({ name: file.name, sourceKey: outcome.info.sourceKey, id: outcome.info.id });
        }
      } catch (error) {
        rejected.push({ name: file.name, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { frames, rejected, duplicates };
  }

  async loadSamples(): Promise<ImportResult> {
    const samples = await generateSamples();
    const frames: SourceFrameInfo[] = [];
    const duplicates: ImportResult['duplicates'] = [];
    for (const sample of samples) {
      const outcome = await this.importBuffer(sample.key.split('/').pop() ?? sample.key, sample.key, sample.png);
      frames.push(outcome.info);
      if (outcome.duplicate) {
        duplicates.push({ name: outcome.info.name, sourceKey: outcome.info.sourceKey, id: outcome.info.id });
      }
    }
    return { frames, rejected: [], duplicates };
  }

  removeFrames(ids: string[]): void {
    for (const id of ids) this.store.delete(id);
  }

  async pack(settings: PackSettings, frameIds?: string[]): Promise<BuildResult> {
    const ids = frameIds && frameIds.length > 0 ? frameIds : this.listFrames().map((f) => f.id);
    const issues: PackIssue[] = [];
    const inputs = [];
    for (const id of ids) {
      const stored = this.store.get(id);
      if (!stored) {
        issues.push({ code: 'MISSING_SOURCE', frameId: id, message: `Frame ${id} is not imported.` });
        continue;
      }
      inputs.push({
        id,
        name: stored.info.name,
        sourceKey: stored.info.sourceKey,
        contentHash: stored.info.contentHash,
        sourceSize: stored.info.sourceSize,
        trim: stored.info.trim,
        empty: stored.info.empty,
      });
    }

    const outcome = packFrames(inputs, settings);
    issues.push(...outcome.issues);
    const frames = outcome.frames.map((frame) => ({ ...frame }));
    const manifest: AtlasManifest = {
      format: ATLAS_FORMAT,
      settings: { ...settings },
      pages: outcome.pages,
      frames,
      summary: {
        total: frames.length,
        packed: frames.filter((f) => f.status === 'packed').length,
        unplaced: frames.filter((f) => f.status === 'unplaced').length,
        empty: frames.filter((f) => f.empty).length,
      },
    };

    const sources = new Map<string, StoredSource>();
    for (const frame of frames) {
      const stored = this.store.get(frame.id);
      if (stored) sources.set(frame.id, stored);
    }
    const built = await buildExportBundle({
      manifest,
      sources,
      animation: {
        format: ANIMATION_FORMAT,
        name: 'preview',
        loop: true,
        anchor: { x: 0.5, y: 1 },
        frames: [],
      },
    });
    const pagePngs = new Map(built.pagePngs.map((page) => [page.index, page.png]));
    const buildId = manifestHash(manifest);

    const pages: BuildPage[] = manifest.pages.map((page) => ({
      ...page,
      url: `/api/build/${buildId}/${page.file}`,
    }));

    this.builds.set(buildId, {
      buildId,
      manifest,
      pages,
      issues,
      verification: built.verification,
      pagePngs,
    });
    this.trimCache(this.builds, MAX_BUILDS);
    return {
      buildId,
      manifest,
      pages,
      issues,
      verification: built.verification,
    };
  }

  getBuild(buildId: string): BuildRecord | undefined {
    return this.builds.get(buildId);
  }

  getPagePng(buildId: string, file: string): Buffer | undefined {
    const build = this.builds.get(buildId);
    if (!build) return undefined;
    for (const [index, png] of build.pagePngs) {
      const page = build.manifest.pages.find((p) => p.index === index);
      if (page && page.file === file) return png;
    }
    return undefined;
  }

  getSourcePng(id: string): Buffer | undefined {
    return this.store.get(id)?.png;
  }

  animationWarnings(spec: AnimationSpec, manifest: AtlasManifest): string[] {
    const warnings: string[] = [];
    const unplaced = new Set(manifest.frames.filter((f) => f.status !== 'packed').map((f) => f.id));
    for (const frame of spec.frames) {
      if (unplaced.has(frame.id)) warnings.push(`Animation frame ${frame.id} is not placed on any page.`);
    }
    return warnings;
  }

  async export(buildId: string, animation: AnimationSpec): Promise<{
    exportId: string;
    verification: VerificationReport;
    warnings: string[];
    files: string[];
  }> {
    const build = this.builds.get(buildId);
    if (!build) throw new Error(`Unknown build ${buildId}; pack again.`);
    const known = new Set(build.manifest.frames.map((frame) => frame.id));
    const errors = validateAnimation(animation, known);
    if (errors.length > 0) throw new Error(errors.join('; '));

    const sources = new Map<string, StoredSource>();
    for (const frame of build.manifest.frames) {
      const stored = this.store.get(frame.id);
      if (stored) sources.set(frame.id, stored);
    }
    const artifacts = await buildExportBundle({ manifest: build.manifest, sources, animation });
    const exportId = createHash('sha256')
      .update(buildId)
      .update(JSON.stringify(animation))
      .digest('hex')
      .slice(0, 16);
    this.exports.set(exportId, { exportId, buildId, artifacts, animation, createdAt: Date.now() });
    this.trimCache(this.exports, MAX_EXPORTS);
    return {
      exportId,
      verification: artifacts.verification,
      warnings: this.animationWarnings(animation, build.manifest),
      files: Object.keys(artifacts.files).sort(),
    };
  }

  getExport(exportId: string): ExportRecord | undefined {
    return this.exports.get(exportId);
  }

  getExportFile(exportId: string, path: string): Uint8Array | undefined {
    const record = this.exports.get(exportId);
    if (!record) return undefined;
    return record.artifacts.files[path];
  }

  private trimCache<T>(cache: Map<string, T>, max: number): void {
    while (cache.size > max) {
      const first = cache.keys().next().value as string | undefined;
      if (first === undefined) break;
      cache.delete(first);
    }
  }
}

export { generateSamples };
