import { describe, expect, it } from 'vitest';
import { AtlasService } from '../server/service';
import { decodeBundlePages, parseBundle, verifyBundle } from '../server/bundle';
import { composeAnimation, composeAlignedFrame } from '../shared/animation';
import { reconstructFrame } from '../shared/reconstruct';
import { compareImages } from '../shared/pixels';
import { DEFAULT_SETTINGS, type AnimationSpec, type PackSettings } from '../shared/types';
import { makeImage, rectangle, toPng } from './helpers';

function settings(patch: Partial<PackSettings> = {}): PackSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

/**
 * Build a small clip whose members have deliberately different transparent
 * bounds, different original canvases and are spread over several pages.
 */
async function setup() {
  const service = new AtlasService();
  const ids: string[] = [];
  const specs = [
    { key: 'walk/a.png', w: 40, h: 60, rect: { x: 5, y: 8, width: 12, height: 20 } },
    { key: 'walk/b.png', w: 40, h: 60, rect: { x: 20, y: 2, width: 14, height: 34 } },
    { key: 'walk/c.png', w: 48, h: 72, rect: { x: 1, y: 40, width: 30, height: 30 } },
    { key: 'walk/d.png', w: 40, h: 60, rect: { x: 12, y: 12, width: 8, height: 8 } },
    { key: 'walk/e.png', w: 20, h: 44, rect: { x: 2, y: 2, width: 16, height: 40 } },
  ];
  for (const spec of specs) {
    const imported = await service.importBuffer(
      spec.key.split('/').pop()!,
      spec.key,
      await toPng(rectangle(spec.w, spec.h, spec.rect, [200, 90, 40])),
    );
    ids.push(imported.info.id);
  }
  const build = await service.pack(
    settings({ pageWidth: 48, pageHeight: 48, spacing: 2, margin: 2, extrude: 1, allowRotation: true }),
  );
  const animation: AnimationSpec = {
    format: 'sprite-atlas-animation/1',
    name: 'walk',
    loop: true,
    anchor: { x: 0.5, y: 1 },
    frames: ids.map((id) => ({ id, durationMs: 90 })),
  };
  return { service, build, animation, ids };
}

describe('animation', () => {
  it('aligns frames on the original canvas and anchor, not on atlas position', async () => {
    const { service, build, animation, ids } = await setup();
    expect(build.manifest.pages.length).toBeGreaterThan(1);
    const pageImages = new Map<number, ReturnType<typeof makeImage>>();
    const { decodePng } = await import('../server/png');
    for (const page of build.pages) {
      const decoded = await decodePng(service.getPagePng(build.buildId, page.file)!);
      pageImages.set(page.index, decoded.image);
    }
    const composed = composeAnimation(build.manifest, animation, pageImages);
    expect(composed.errors).toEqual([]);
    expect(composed.frames).toHaveLength(5);

    const byId = new Map(build.manifest.frames.map((frame) => [frame.id, frame]));
    composed.frames.forEach((entry, index) => {
      const frame = byId.get(ids[index])!;
      // The aligned stage must be identical to placing the original canvas at
      // the anchor-derived offset — no dependence on page or packed rect.
      const direct = composeAlignedFrame(frame, pageImages.get(frame.page!)!, composed.stage, animation.anchor);
      const comparison = compareImages(entry.image, direct.image);
      expect(comparison.match).toBe(true);
      // Offset is determined by the original canvas and anchor only.
      const expectedX = Math.round(animation.anchor.x * composed.stage.width - animation.anchor.x * frame.sourceSize.width);
      const expectedY = Math.round(animation.anchor.y * composed.stage.height - animation.anchor.y * frame.sourceSize.height);
      expect(entry.offset).toEqual({ x: expectedX, y: expectedY });
    });

    // Reconstructing each frame must land its content exactly where the
    // original had it, so content stays fixed relative to the anchor.
    for (const id of ids) {
      const frame = byId.get(id)!;
      const stored = service.store.get(id)!;
      const rebuilt = reconstructFrame(frame, pageImages.get(frame.page!)!);
      expect(compareImages(stored.image, rebuilt.canvas).match).toBe(true);
    }
  });

  it('keeps playback identical when the same frames are repacked with another layout', async () => {
    const { service, build, animation, ids } = await setup();
    const { decodePng } = await import('../server/png');
    const loadPages = async (buildId: string, pages: { index: number; file: string }[]) => {
      const map = new Map<number, ReturnType<typeof makeImage>>();
      for (const page of pages) {
        const decoded = await decodePng(service.getPagePng(buildId, page.file)!);
        map.set(page.index, decoded.image);
      }
      return map;
    };
    const first = composeAnimation(build.manifest, animation, await loadPages(build.buildId, build.pages));

    // Repack with a different page size and rotation policy, as a normal user
    // would after importing more images.
    const repacked = await service.pack(
      settings({ pageWidth: 56, pageHeight: 56, spacing: 2, margin: 2, extrude: 1, allowRotation: false }),
    );
    const second = composeAnimation(repacked.manifest, animation, await loadPages(repacked.buildId, repacked.pages));
    expect(second.errors).toEqual([]);
    expect(second.stage).toEqual(first.stage);
    expect(second.frames.map((frame) => frame.offset)).toEqual(first.frames.map((frame) => frame.offset));
    second.frames.forEach((frame, index) => {
      const comparison = compareImages(first.frames[index].image, frame.image);
      expect(comparison.match).toBe(true);
      const idsMatch = repacked.manifest.frames.some((entry) => entry.id === ids[index]);
      expect(idsMatch).toBe(true);
    });
  });

  it('composes the animation from exported bundle files only', async () => {
    const { service, build, animation } = await setup();
    const exported = await service.export(build.buildId, animation);
    expect(exported.verification.ok).toBe(true);
    const files = service.getExport(exported.exportId)!.artifacts.files;
    const loaded = parseBundle(files);
    const pages = await decodeBundlePages(loaded.manifest, files);
    const composed = composeAnimation(loaded.manifest, loaded.animation, pages);
    expect(composed.errors).toEqual([]);
    expect(composed.frames).toHaveLength(animation.frames.length);
    expect(composed.stage.width).toBe(48);
    expect(composed.stage.height).toBe(72);

    const bundled = await verifyBundle(files);
    expect(bundled.report.ok).toBe(true);
  });

  it('rejects animation specs that break the id contract', async () => {
    const { service, build } = await setup();
    const bad: AnimationSpec = {
      format: 'sprite-atlas-animation/1',
      name: 'bad',
      loop: true,
      anchor: { x: 1.5, y: 0.5 },
      frames: [{ id: 'f_deadbeefdeadbeef', durationMs: 5 }],
    };
    await expect(service.export(build.buildId, bad)).rejects.toThrow(/unknown frame id|anchor/);
  });
});

describe('anchor semantics', () => {
  it('is normalized inside each original canvas, so different canvas sizes share one pivot', async () => {
    const { alignedOffset } = await import('../shared/animation');
    const stage = { width: 48, height: 72 };
    const small = { width: 40, height: 60 };
    const offset = alignedOffset(small, stage, { x: 0.5, y: 1 });
    expect(offset).toEqual({ x: 4, y: 12 });
    // Bottom-center of the small canvas lands on bottom-center of the stage.
    expect(offset.x + small.width / 2).toBe(stage.width / 2);
    expect(offset.y + small.height).toBe(stage.height);
  });

  it('keeps offsets identical when the trim differs but the canvas is the same', async () => {
    const { alignedOffset } = await import('../shared/animation');
    const stage = { width: 64, height: 96 };
    const a = alignedOffset({ width: 64, height: 96 }, stage, { x: 0.5, y: 1 });
    const b = alignedOffset({ width: 64, height: 96 }, stage, { x: 0.5, y: 1 });
    expect(a).toEqual(b);
    expect(a).toEqual({ x: 0, y: 0 });
  });
});
