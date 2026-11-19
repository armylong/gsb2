/** In-memory source store used by the local build server. */

import { createHash } from 'node:crypto';
import type { SourceFrameInfo } from '../shared/types';
import type { RGBAImage } from '../shared/pixels';
import { computeFrameId, normalizeSourceKey, sourceBaseName } from '../shared/identity';

import type { SourcePixels } from '../shared/atlasRenderer';

export interface StoredPixels extends SourcePixels {
  png: Buffer;
}

export interface StoredSource extends StoredPixels {
  info: SourceFrameInfo;
}

export function sha256(buffer: Buffer | Uint8ClampedArray): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export class SourceStore {
  private readonly entries = new Map<string, StoredSource>();

  add(key: string, image: RGBAImage, png: Buffer): StoredSource {
    return this.addReporting(key, image, png).stored;
  }

  addReporting(key: string, image: RGBAImage, png: Buffer): { stored: StoredSource; duplicate: boolean } {
    const sourceKey = normalizeSourceKey(key);
    const contentHash = sha256(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
    const id = computeFrameId(contentHash, sourceKey);
    const info: SourceFrameInfo = {
      id,
      name: sourceBaseName(sourceKey),
      sourceKey,
      contentHash,
      sourceSize: { width: image.width, height: image.height },
      trim: { x: 0, y: 0, width: image.width, height: image.height },
      empty: false,
      previewUrl: `/api/src/${encodeURIComponent(id)}.png`,
    };
    const stored: StoredSource = { info, image, png };
    const existing = this.entries.get(id);
    if (existing) return { stored: existing, duplicate: true };
    this.entries.set(id, stored);
    return { stored, duplicate: false };
  }

  updateInfo(id: string, patch: Partial<SourceFrameInfo>): StoredSource | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.info = { ...entry.info, ...patch, id: entry.info.id, contentHash: entry.info.contentHash };
    return entry;
  }

  get(id: string): StoredSource | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): SourceFrameInfo[] {
    return [...this.entries.values()].map((entry) => entry.info);
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
