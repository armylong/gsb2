import { describe, expect, it } from 'vitest';
import { computeFrameId, normalizeSourceKey } from '../shared/identity';
import { findAlphaBounds } from '../shared/pixels';
import { AtlasService } from '../server/service';
import { makeImage, rectangle, slash, toPng } from './helpers';
import { DEFAULT_SETTINGS, type PackSettings } from '../shared/types';

function settings(patch: Partial<PackSettings> = {}): PackSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('identity', () => {
  it('is independent of import order and ids do not collide across directories', () => {
    const a = computeFrameId('hash-a', 'characters/hero.png');
    const b = computeFrameId('hash-a', 'characters/hero.png');
    const c = computeFrameId('hash-a', 'alternate/hero.png');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^f_[0-9a-f]{16}$/);
  });

  it('normalizes path separators without losing directories', () => {
    expect(normalizeSourceKey('a\\b\\c.png')).toBe('a/b/c.png');
    expect(normalizeSourceKey('./a//b.png')).toBe('a/b.png');
  });
});

describe('import analysis', () => {
  it('keeps the original canvas size and reports the transparent bounds', async () => {
    const image = rectangle(30, 20, { x: 4, y: 5, width: 10, height: 8 }, [200, 40, 40]);
    expect(findAlphaBounds(image)).toEqual({ x: 4, y: 5, width: 10, height: 8 });
    const service = new AtlasService();
    const imported = await service.importBuffer('rect.png', 'sprites/rect.png', await toPng(image));
    expect(imported.duplicate).toBe(false);
    expect(imported.info.sourceSize).toEqual({ width: 30, height: 20 });
    expect(imported.info.trim).toEqual({ x: 4, y: 5, width: 10, height: 8 });
    expect(imported.info.empty).toBe(false);
    expect(imported.info.id).toBe(computeFrameId(imported.info.contentHash, 'sprites/rect.png'));
  });

  it('keeps a fully transparent image with an explicit, exportable representation', async () => {
    const empty = makeImage(12, 9, () => null);
    const service = new AtlasService();
    const imported = await service.importBuffer('empty.png', 'ui/empty.png', await toPng(empty));
    expect(imported.info.empty).toBe(true);
    expect(imported.info.trim).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(imported.info.sourceSize).toEqual({ width: 12, height: 9 });

    const build = await service.pack(settings({ pageWidth: 64, pageHeight: 64 }));
    const frame = build.manifest.frames.find((entry) => entry.id === imported.info.id)!;
    expect(frame.status).toBe('packed');
    expect(frame.empty).toBe(true);
    expect(frame.page).toBe(0);
    expect(frame.packedRect).not.toBeNull();
    expect(build.manifest.summary.empty).toBe(1);
    expect(build.verification.ok).toBe(true);
  });

  it('does not silently overwrite when the same name comes from a different directory', async () => {
    const red = rectangle(10, 10, { x: 1, y: 1, width: 6, height: 6 }, [255, 0, 0]);
    const blue = rectangle(10, 10, { x: 1, y: 1, width: 6, height: 6 }, [0, 0, 255]);
    const service = new AtlasService();
    const first = await service.importBuffer('hero.png', 'a/hero.png', await toPng(red));
    const second = await service.importBuffer('hero.png', 'b/hero.png', await toPng(blue));
    expect(second.duplicate).toBe(false);
    expect(second.info.id).not.toBe(first.info.id);
    expect(service.listFrames()).toHaveLength(2);
    expect(service.listFrames().map((frame) => frame.sourceKey).sort()).toEqual(['a/hero.png', 'b/hero.png']);
  });

  it('reports an exact duplicate instead of replacing the original frame', async () => {
    const image = rectangle(10, 10, { x: 1, y: 1, width: 6, height: 6 }, [10, 200, 30]);
    const png = await toPng(image);
    const service = new AtlasService();
    await service.importBuffer('hero.png', 'a/hero.png', png);
    const again = await service.importBuffer('hero.png', 'a/hero.png', png);
    expect(again.duplicate).toBe(true);
    expect(service.listFrames()).toHaveLength(1);
  });

  it('rejects non-PNG data with a clear message', async () => {
    const service = new AtlasService();
    await expect(service.importBuffer('bad.png', 'bad.png', Buffer.from('not a png'))).rejects.toThrow(/PNG|format|unsupported/i);
  });
});

describe('trim geometry', () => {
  it('offsets stay in original-canvas coordinates', async () => {
    const image = slash(90, 40);
    const service = new AtlasService();
    const imported = await service.importBuffer('slash.png', 'fx/slash.png', await toPng(image));
    const bounds = findAlphaBounds(image)!;
    expect(imported.info.trim).toEqual(bounds);
    expect(imported.info.sourceSize).toEqual({ width: 90, height: 40 });
    const build = await service.pack(settings({ pageWidth: 128, pageHeight: 128 }));
    const frame = build.manifest.frames[0];
    expect(frame.trim).toEqual(bounds);
  });
});
