import { describe, expect, it } from 'vitest';
import { AtlasService } from '../server/service';
import { verifyBundle } from '../server/bundle';
import { reconstructFrame } from '../shared/reconstruct';
import { compareImages, extrudeImage, findAlphaBounds } from '../shared/pixels';
import { DEFAULT_SETTINGS, type PackSettings } from '../shared/types';
import { makeImage, rectangle, slash, toPng } from './helpers';

function settings(patch: Partial<PackSettings> = {}): PackSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('pixel round trip', () => {
  it('preserves every frame through packing, rotation and multi-page export', async () => {
    const service = new AtlasService();
    const sources = [
      await service.importBuffer('slash.png', 'fx/slash.png', await toPng(slash(100, 50))),
      await service.importBuffer(
        'rect.png',
        'ui/rect.png',
        await toPng(rectangle(40, 30, { x: 0, y: 0, width: 40, height: 30 }, [20, 180, 120])),
      ),
      await service.importBuffer(
        'strip.png',
        'ui/strip.png',
        await toPng(rectangle(12, 90, { x: 1, y: 1, width: 9, height: 85 }, [240, 140, 20])),
      ),
      await service.importBuffer('empty.png', 'ui/empty.png', await toPng(makeImage(20, 20, () => null))),
      ...(await Promise.all(
        Array.from({ length: 10 }, async (_, index) =>
          service.importBuffer(
            `tile_${index}.png`,
            `tiles/tile_${index}.png`,
            await toPng(
              rectangle(28, 28, { x: 2, y: 2, width: 24, height: 24 }, [
                30 + index * 20,
                90,
                200 - index * 10,
              ]),
            ),
          ),
        ),
      )),
    ];

    const build = await service.pack(
      settings({ pageWidth: 110, pageHeight: 110, spacing: 2, margin: 3, extrude: 1, allowRotation: true }),
    );
    expect(build.manifest.pages.length).toBeGreaterThan(1);
    expect(build.verification.ok).toBe(true);
    const report = build.verification.checks.find((check) => check.id === 'pixel-roundtrip')!;
    expect(report.ok).toBe(true);
    expect(report.detail).toMatch(/match/);

    const pageById = new Map(build.pages.map((page) => [page.index, page]));
    const pageBuffers = build.pages.map((page) => service.getPagePng(build.buildId, page.file)!);
    const { decodePng } = await import('../server/png');
    const decoded = await Promise.all(pageBuffers.map((buffer) => decodePng(buffer)));

    let rotated = 0;
    for (const source of sources) {
      const frame = build.manifest.frames.find((entry) => entry.id === source.info.id)!;
      if (frame.status !== 'packed') continue;
      if (frame.rotation !== 0) rotated++;
      const page = decoded[frame.page!];
      const reconstructed = reconstructFrame(frame, page.image);
      expect(reconstructed.errors).toEqual([]);
      const stored = service.store.get(frame.id)!;
      const comparison = compareImages(stored.image, reconstructed.canvas);
      expect(comparison.match).toBe(true);
      expect(reconstructed.canvas.width).toBe(stored.info.sourceSize.width);
      expect(reconstructed.canvas.height).toBe(stored.info.sourceSize.height);
    }
    expect(rotated).toBeGreaterThan(0);
    void pageById;
  });

  it('only ignores RGB under fully transparent pixels, never alpha differences', async () => {
    const withHiddenColor = makeImage(16, 16, (x, y) => {
      if (x >= 4 && x < 12 && y >= 4 && y < 12) return [230, 80, 40, 255];
      // Fully transparent pixels with visible-if-premultiplied colors.
      return [123, 45, 67, 0];
    });
    const service = new AtlasService();
    await service.importBuffer('hidden.png', 'a/hidden.png', await toPng(withHiddenColor));
    const build = await service.pack(settings({ pageWidth: 32, pageHeight: 32, extrude: 0 }));
    const check = build.verification.checks.find((entry) => entry.id === 'pixel-roundtrip')!;
    expect(check.ok).toBe(true);
    // Transparent RGB may have been normalised by the encoder, that is allowed.
    expect(build.verification.ignoredTransparentPixels).toBeGreaterThan(0);

    const expected = makeImage(2, 1, (x) => (x === 0 ? [10, 20, 30, 0] : [10, 20, 30, 255]));
    const actualRgbOnly = makeImage(2, 1, (x) => (x === 0 ? [99, 88, 77, 0] : [10, 20, 30, 255]));
    expect(compareImages(expected, actualRgbOnly).match).toBe(true);
    expect(compareImages(expected, actualRgbOnly).ignoredPixels).toBe(1);

    const alphaChanged = makeImage(2, 1, (x) => (x === 0 ? [10, 20, 30, 0] : [10, 20, 30, 254]));
    expect(compareImages(expected, alphaChanged).match).toBe(false);

    const visibleRgbChanged = makeImage(2, 1, (x) => (x === 0 ? [10, 20, 30, 0] : [11, 20, 30, 255]));
    expect(compareImages(expected, visibleRgbChanged).match).toBe(false);
  });

  it('replicates edge pixels for the bleed ring instead of transparent black', () => {
    const pixel = { width: 1, height: 1, data: new Uint8ClampedArray([250, 10, 20, 255]) };
    const extruded = extrudeImage(pixel, 2);
    expect(extruded.width).toBe(5);
    expect(extruded.height).toBe(5);
    for (let i = 0; i < 25; i++) {
      expect(Array.from(extruded.data.subarray(i * 4, i * 4 + 4))).toEqual([250, 10, 20, 255]);
    }
    // Every pixel of the trimmed content is opaque here (that is what trimming
    // guarantees at the border), so the ring can only hold edge colors.
    const opaque = makeImage(3, 3, (x, y) => [40 + x * 30, 120 + y * 30, 200, 255]);
    const ring = extrudeImage(opaque, 1);
    expect(ring.width).toBe(5);
    // Corner takes the nearest content corner; no new black pixel is introduced.
    expect(Array.from(ring.data.subarray(0, 4))).toEqual([40, 120, 200, 255]);
    expect(Array.from(ring.data.subarray(ring.data.length - 4))).toEqual([100, 180, 200, 255]);
    // Right-edge ring of the top row replicates (2,0).
    const topRing = (0 * ring.width + 4) * 4;
    expect(Array.from(ring.data.subarray(topRing, topRing + 4))).toEqual([100, 120, 200, 255]);
  });

  it('preserves orientation: rotated packing does not flip the content', async () => {
    // Asymmetric L shape: rotation must be undone exactly.
    const shape = makeImage(20, 30, (x, y) => {
      const vertical = x >= 2 && x < 6 && y >= 3 && y < 27;
      const horizontal = x >= 2 && x < 18 && y >= 23 && y < 27;
      if (!vertical && !horizontal) return null;
      return [40, 90, 220, 255];
    });
    const bounds = findAlphaBounds(shape)!;
    const service = new AtlasService();
    const imported = await service.importBuffer(
      'l.png',
      'shape/l.png',
      await toPng(makeImage(40, 40, (x, y) => {
        const dx = x - 5;
        const dy = y - 5;
        if (dx < 0 || dy < 0) return null;
        const o = (dy * shape.width + dx) * 4;
        if (dx >= shape.width || dy >= shape.height) return null;
        return [shape.data[o], shape.data[o + 1], shape.data[o + 2], shape.data[o + 3]];
      })),
    );
    const build = await service.pack(
      settings({ pageWidth: 28, pageHeight: 20, margin: 1, spacing: 0, extrude: 1, allowRotation: true }),
    );
    const frame = build.manifest.frames.find((entry) => entry.id === imported.info.id)!;
    expect(frame.rotation).toBe(90);
    expect(frame.trim).toEqual({ x: bounds.x + 5, y: bounds.y + 5, width: bounds.width, height: bounds.height });
    const page = (await import('../server/png')).decodePng(service.getPagePng(build.buildId, build.pages[frame.page!].file)!);
    const reconstructed = reconstructFrame(frame, (await page).image);
    const stored = service.store.get(frame.id)!;
    expect(compareImages(stored.image, reconstructed.canvas).match).toBe(true);
    expect(build.verification.ok).toBe(true);
  });
});

describe('exported bundle', () => {
  it('can be reloaded and verified without the original images', async () => {
    const service = new AtlasService();
    const samples = await service.loadSamples();
    const build = await service.pack(settings({ pageWidth: 192, pageHeight: 192, spacing: 2, margin: 2, extrude: 1 }));
    const animation = {
      format: 'sprite-atlas-animation/1' as const,
      name: 'bundle',
      loop: true,
      anchor: { x: 0.5, y: 1 },
      frames: build.manifest.frames
        .filter((frame) => frame.status === 'packed')
        .slice(0, 4)
        .map((frame) => ({ id: frame.id, durationMs: 100 })),
    };
    const exported = await service.export(build.buildId, animation);
    expect(exported.verification.ok).toBe(true);
    const record = service.getExport(exported.exportId)!;
    const files = record.artifacts.files;
    expect(Object.keys(files)).toContain('atlas.json');
    expect(Object.keys(files)).toContain('animation.json');
    expect(Object.keys(files)).toContain('README.txt');
    expect(Object.keys(files).filter((file) => file.startsWith('pages/'))).toHaveLength(build.manifest.pages.length);

    const bundle = await verifyBundle(files);
    expect(bundle.report.ok).toBe(true);
    expect(bundle.loaded.animation.frames).toHaveLength(4);
    expect(bundle.loaded.pages.size).toBe(build.manifest.pages.length);
    expect(samples.frames.length).toBeGreaterThan(0);

    // Animation references survive a re-layout: ids still resolve.
    const ids = new Set(build.manifest.frames.map((frame) => frame.id));
    for (const ref of bundle.loaded.animation.frames) expect(ids.has(ref.id)).toBe(true);
  });

  it('reports an animation that references an unknown id', async () => {
    const service = new AtlasService();
    await service.loadSamples();
    const build = await service.pack(settings({ pageWidth: 256, pageHeight: 256 }));
    const exported = await service.export(build.buildId, {
      format: 'sprite-atlas-animation/1',
      name: 'bad',
      loop: true,
      anchor: { x: 0.5, y: 0.5 },
      frames: [{ id: 'f_0000000000000000', durationMs: 100 }],
    }).catch((error: Error) => error);
    expect(exported).toBeInstanceOf(Error);
    expect((exported as Error).message).toMatch(/unknown frame id/);
  });
});

describe('determinism', () => {
  it('produces byte-identical bundles for identical input and settings', async () => {
    const { createHash } = await import('node:crypto');
    const run = async () => {
      const service = new AtlasService();
      await service.loadSamples();
      const build = await service.pack(settings({ pageWidth: 200, pageHeight: 200 }));
      const animation = {
        format: 'sprite-atlas-animation/1' as const,
        name: 'repeat',
        loop: true,
        anchor: { x: 0.5, y: 1 },
        frames: build.manifest.frames
          .filter((frame) => frame.status === 'packed')
          .slice(0, 4)
          .map((frame) => ({ id: frame.id, durationMs: 100 })),
      };
      const exported = await service.export(build.buildId, animation);
      const record = service.getExport(exported.exportId)!;
      const digest = (bytes: Uint8Array) =>
        createHash('sha256').update(Buffer.from(bytes)).digest('hex');
      return {
        buildId: build.buildId,
        manifest: digest(Buffer.from(JSON.stringify(build.manifest))),
        files: Object.fromEntries(
          Object.entries(record.artifacts.files)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, bytes]) => [name, digest(bytes)]),
        ),
        zip: digest(record.artifacts.zip),
      };
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });
});
