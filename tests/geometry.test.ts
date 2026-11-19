import { describe, expect, it } from 'vitest';
import { sourceCanvasOutline } from '../shared/geometry';

describe('source canvas outline', () => {
  it('maps the unrotated canvas around the content rect using trim offsets', () => {
    const outline = sourceCanvasOutline(
      { x: 30, y: 40, width: 20, height: 10 },
      0,
      { width: 50, height: 40 },
      { x: 5, y: 12, width: 20, height: 10 },
    );
    expect(outline).toEqual({ x: 25, y: 28, width: 50, height: 40 });
  });

  it('rotates the outline clockwise with the content', () => {
    // Source 40x20, trim at (6, 2) size 10x14, content rotated 90 CW.
    const outline = sourceCanvasOutline(
      { x: 100, y: 50, width: 14, height: 10 },
      90,
      { width: 40, height: 20 },
      { x: 6, y: 2, width: 10, height: 14 },
    );
    // Outline is source.height x source.width, and it must enclose the content.
    expect(outline).toEqual({ x: 100 + 2 + 14 - 20, y: 50 - 6, width: 20, height: 40 });
    expect(outline!.x).toBeLessThanOrEqual(100);
    expect(outline!.y).toBeLessThanOrEqual(50);
    expect(outline!.x + outline!.width).toBeGreaterThanOrEqual(100 + 14);
    expect(outline!.y + outline!.height).toBeGreaterThanOrEqual(50 + 10);
  });

  it('returns null for fully transparent frames', () => {
    expect(sourceCanvasOutline({ x: 0, y: 0, width: 0, height: 0 }, 0, { width: 8, height: 8 }, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    expect(sourceCanvasOutline(null, 0, { width: 8, height: 8 }, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  });
});
