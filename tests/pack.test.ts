import { describe, expect, it } from 'vitest';
import { packFrames, rectGap, validateSettings, type PackFrameInput } from '../shared/pack';
import { DEFAULT_SETTINGS, type AtlasFrame, type PackSettings } from '../shared/types';

function settings(patch: Partial<PackSettings> = {}): PackSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function frame(id: string, width: number, height: number, patch: Partial<PackFrameInput> = {}): PackFrameInput {
  return {
    id,
    name: `${id}.png`,
    sourceKey: `${id}.png`,
    contentHash: `hash-${id}`,
    sourceSize: { width: width + 4, height: height + 4 },
    trim: { x: 2, y: 2, width, height },
    empty: false,
    ...patch,
  };
}

const baseSettings = settings({ pageWidth: 64, pageHeight: 64, spacing: 2, margin: 2, extrude: 1 });

describe('packer', () => {
  it('produces the same layout regardless of input order', () => {
    const frames = [
      frame('a', 10, 12),
      frame('b', 20, 8),
      frame('c', 9, 9),
      frame('d', 30, 6),
      frame('e', 14, 22),
      frame('f', 7, 30),
    ];
    const forward = packFrames(frames, baseSettings);
    const reversed = packFrames([...frames].reverse(), baseSettings);
    const shuffled = packFrames([frames[3], frames[0], frames[5], frames[2], frames[4], frames[1]], baseSettings);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(shuffled));
  });

  it('produces a different layout only when the frame set changes', () => {
    const frames = [frame('a', 10, 12), frame('b', 20, 8), frame('c', 9, 9)];
    const first = packFrames(frames, baseSettings);
    const second = packFrames(frames.slice(0, 2), baseSettings);
    expect(first.frames.find((entry) => entry.id === 'a')!.packedRect).toEqual(
      second.frames.find((entry) => entry.id === 'a')!.packedRect ?? first.frames.find((entry) => entry.id === 'a')!.packedRect,
    );
    expect(second.frames.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('never overlaps frames and respects spacing and margin', () => {
    const frames = Array.from({ length: 40 }, (_, index) =>
      frame(`f${index}`, 5 + ((index * 7) % 17), 4 + ((index * 5) % 13)),
    );
    const result = packFrames(frames, settings({ pageWidth: 96, pageHeight: 96, spacing: 3, margin: 5, extrude: 1 }));
    expect(result.pages.length).toBeGreaterThan(1);
    for (const page of result.pages) {
      const list = result.frames.filter((entry) => entry.page === page.index && entry.packedRect);
      for (const entry of list) {
        const rect = entry.packedRect!;
        expect(rect.x).toBeGreaterThanOrEqual(5);
        expect(rect.y).toBeGreaterThanOrEqual(5);
        expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - 5);
        expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - 5);
      }
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          expect(rectGap(list[i].packedRect!, list[j].packedRect!)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('reports an oversized frame instead of scaling, splitting or dropping it silently', () => {
    const frames = [frame('small', 10, 10), frame('huge', 200, 20), frame('tall', 20, 200)];
    const result = packFrames(frames, baseSettings);
    expect(result.frames).toHaveLength(3);
    const huge = result.frames.find((entry) => entry.id === 'huge')!;
    expect(huge.status).toBe('unplaced');
    expect(huge.page).toBeNull();
    expect(huge.packedRect).toBeNull();
    expect(huge.issue).toMatch(/cannot fit/i);
    const issues = result.issues.filter((issue) => issue.code === 'FRAME_TOO_LARGE');
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toMatch(/never scaled or split/);
    expect(result.frames.find((entry) => entry.id === 'small')!.status).toBe('packed');
  });

  it('rotates long strips when allowed and records the clockwise direction', () => {
    const strip = frame('strip', 10, 50, { sourceSize: { width: 14, height: 54 }, trim: { x: 2, y: 2, width: 10, height: 50 } });
    const allowed = packFrames([strip], settings({ pageWidth: 60, pageHeight: 24, margin: 1, spacing: 0, extrude: 1, allowRotation: true }));
    const entry = allowed.frames[0];
    expect(entry.status).toBe('packed');
    expect(entry.rotation).toBe(90);
    expect(entry.contentRect).toEqual({
      x: entry.packedRect!.x + 1,
      y: entry.packedRect!.y + 1,
      width: 50,
      height: 10,
    });
    expect(entry.packedRect!.width).toBe(52);
    expect(entry.packedRect!.height).toBe(12);

    const forbidden = packFrames(
      [strip],
      settings({ pageWidth: 60, pageHeight: 24, margin: 1, spacing: 0, extrude: 1, allowRotation: false }),
    );
    expect(forbidden.frames[0].status).toBe('unplaced');
    expect(forbidden.issues[0].code).toBe('FRAME_TOO_LARGE');
  });

  it('keeps empty frames addressable with a 1x1 transparent slot', () => {
    const empty = frame('empty', 0, 0, { empty: true, trim: { x: 0, y: 0, width: 0, height: 0 } });
    const result = packFrames([empty, frame('solid', 8, 8)], baseSettings);
    const entry = result.frames.find((item) => item.id === 'empty')!;
    expect(entry.status).toBe('packed');
    expect(entry.empty).toBe(true);
    expect(entry.packedRect!.width).toBeGreaterThanOrEqual(1);
    expect(entry.contentRect).toEqual({
      x: entry.packedRect!.x + Math.floor(entry.packedRect!.width / 2),
      y: entry.packedRect!.y + Math.floor(entry.packedRect!.height / 2),
      width: 0,
      height: 0,
    });
    expect(entry.rotation).toBe(0);
  });

  it('keeps contentRect as packedRect inset by the extrusion', () => {
    const result = packFrames(
      [frame('a', 12, 7), frame('b', 20, 9)],
      settings({ pageWidth: 64, pageHeight: 64, spacing: 4, margin: 2, extrude: 3 }),
    );
    for (const entry of result.frames as AtlasFrame[]) {
      if (entry.empty) continue;
      expect(entry.contentRect).toEqual({
        x: entry.packedRect!.x + 3,
        y: entry.packedRect!.y + 3,
        width: entry.packedRect!.width - 6,
        height: entry.packedRect!.height - 6,
      });
      expect(entry.extrude).toBe(3);
    }
  });

  it('generates additional pages when one page is not enough', () => {
    const frames = Array.from({ length: 30 }, (_, index) => frame(`p${index}`, 12, 12));
    const result = packFrames(frames, settings({ pageWidth: 64, pageHeight: 64, spacing: 1, margin: 2, extrude: 0 }));
    expect(result.pages.length).toBeGreaterThan(1);
    const pageUsage = new Set(result.frames.map((entry) => entry.page));
    expect(pageUsage.size).toBe(result.pages.length);
    expect(result.pages.map((page) => page.file)).toEqual(
      result.pages.map((_, index) => `atlas_${String(index).padStart(3, '0')}.png`),
    );
  });

  it('rejects invalid settings with explicit issues', () => {
    expect(validateSettings(settings({ pageWidth: 0 })).length).toBeGreaterThan(0);
    expect(validateSettings(settings({ margin: -1 })).length).toBeGreaterThan(0);
    expect(validateSettings(settings({ pageWidth: 10, margin: 5 })).length).toBeGreaterThan(0);
    const result = packFrames([frame('a', 5, 5)], settings({ pageWidth: -4 }));
    expect(result.issues[0].code).toBe('INVALID_SETTINGS');
    expect(result.frames[0].status).toBe('unplaced');
  });

  it('reports duplicate ids without overwriting', () => {
    const original = frame('dup', 10, 10, { name: 'first.png' });
    const copy = frame('dup', 20, 20, { name: 'second.png' });
    const result = packFrames([original, copy], baseSettings);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].name).toBe('first.png');
    expect(result.issues.some((issue) => issue.code === 'DUPLICATE_ID')).toBe(true);
  });
});

describe('spacing vs extrusion', () => {
  it('keeps content spacing and edge replication independent', () => {
    const frames = [frame('a', 20, 20), frame('b', 20, 20)];
    const noBleed = packFrames(frames, settings({ pageWidth: 128, pageHeight: 128, spacing: 6, margin: 2, extrude: 0 }));
    const withBleed = packFrames(frames, settings({ pageWidth: 128, pageHeight: 128, spacing: 6, margin: 2, extrude: 3 }));
    const a0 = noBleed.frames.find((entry) => entry.id === 'a')!;
    const b0 = noBleed.frames.find((entry) => entry.id === 'b')!;
    const a3 = withBleed.frames.find((entry) => entry.id === 'a')!;
    const b3 = withBleed.frames.find((entry) => entry.id === 'b')!;
    // Slots shrink/grow by the extrusion, while the empty gap between the
    // content rectangles is spacing + 2 * extrusion.
    expect(a0.packedRect!.width).toBe(20);
    expect(a3.packedRect!.width).toBe(26);
    expect(a3.contentRect!.width).toBe(20);
    expect(a3.extrude).toBe(3);
    expect(a0.extrude).toBe(0);
    const contentGap = rectGap(a3.contentRect!, b3.contentRect!);
    expect(contentGap).toBe(6 + 3 * 2);
    expect(rectGap(a0.contentRect!, b0.contentRect!)).toBe(6);
  });

  it('fills the usable page exactly when a frame matches the page size', () => {
    const exact = frame('exact', 60, 60);
    const result = packFrames([exact], settings({ pageWidth: 64, pageHeight: 64, margin: 2, spacing: 4, extrude: 0 }));
    const entry = result.frames[0];
    expect(entry.status).toBe('packed');
    expect(entry.packedRect).toEqual({ x: 2, y: 2, width: 60, height: 60 });
    expect(entry.contentRect).toEqual({ x: 2, y: 2, width: 60, height: 60 });
  });
});
