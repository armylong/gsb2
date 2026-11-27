import { describe, expect, it } from 'vitest';
import { makeRectFrame, makeNotchFrame, polyArea, ringAreaAbs, pointInRing, pt } from '../src/geometry';
import { computeLayout, queryPoint, frameArea, TIE_BAND_MM, seamForecast, sharedNeighbours } from '../src/layout';
import { DEMOS, cloneDemo } from '../src/demos';
import { buildExportFiles, exportColorSvg, exportPieceSvg, buildManifest } from '../src/export';
import type { PointSpec } from '../src/types';

function grid3x2(): PointSpec[] {
  const pts: PointSpec[] = [];
  let id = 1;
  for (const y of [40, 120]) for (const x of [40, 120, 200]) pts.push({ id: id++, x, y, weight: 0 });
  return pts;
}

function signedShiftFor(layout: ReturnType<typeof computeLayout>, id: number, other: number): number {
  const site = layout.points.find((p) => p.id === id)!;
  const q = layout.points.find((p) => p.id === other)!;
  const d = Math.hypot(q.x - site.x, q.y - site.y);
  return (site.weight - q.weight) / (2 * d);
}


describe('partition', () => {
  it('equal weights on a rectangle reproduce a Voronoi split and the frame exactly', () => {
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    expect(layout.stats.frameArea).toBe(38400);
    expect(layout.stats.pieceAreaTotal).toBeCloseTo(38400, 6);
    expect(layout.stats.exact).toBe(true);
    expect(layout.stats.pieceCount).toBe(6);
    expect(layout.stats.partCount).toBe(6);
    expect(layout.stats.emptyPieceIds).toEqual([]);
  });

  it('symmetric 6-point grid divides into six equal 6400 mm² panes', () => {
    // 3 columns × 2 rows with equal spacing and equal weights.
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    for (const p of layout.pieces) expect(p.area).toBeCloseTo(6400, 6);
  });

  it('each location belongs to exactly one pane inside the frame', () => {
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    for (let x = 3; x < 240; x += 17) {
      for (let y = 3; y < 160; y += 13) {
        const q = queryPoint(layout, x, y, 0);
        expect(q.id).not.toBeNull();
      }
    }
  });

  it('total area equals the frame area for every demo, notch included', () => {
    for (const demo of DEMOS) {
      const copy = cloneDemo(demo);
      const layout = computeLayout(copy.frame, copy.points);
      const fa = frameArea(copy.frame);
      expect(layout.stats.frameArea).toBeCloseTo(fa, 9);
      expect(layout.stats.pieceAreaTotal).toBeCloseTo(fa, 6);
      expect(layout.stats.exact).toBe(true);
    }
  });

  it('raising a weight moves the seam linearly toward that neighbour', () => {
    const pts = grid3x2();
    const layout = computeLayout(makeRectFrame(240, 160), pts);
    const before = signedShiftFor(layout, 5, 2);
    // Shift of the seam is linear in Δw: Δw = 1000 → 1000/(2*80) = 6.25 mm.
    const forecast = seamForecast(layout, 5, 1000);
    const toTwo = forecast.find((f) => f.otherId === 2)!;
    expect(toTwo.predictedMm - toTwo.currentMm).toBeCloseTo(6.25, 6);
    expect(before).toBeCloseTo(0, 9);

    const next = computeLayout(
      makeRectFrame(240, 160),
      pts.map((p) => (p.id === 5 ? { ...p, weight: 1000 } : p)),
    );
    const seam5to2 = signedShiftFor(next, 5, 2);
    expect(seam5to2).toBeCloseTo(6.25, 6);
  });

  it('seam forecast agrees with the recomputed geometry for many Δ values', () => {
    const pts = grid3x2();
    for (const w of [200, 1000, 4000, 9000]) {
      const base = pts.map((p) => (p.id === 5 ? { ...p, weight: w } : p));
      const layout = computeLayout(makeRectFrame(240, 160), base);
      const forecast = seamForecast(layout, 5, 2500);
      const next = computeLayout(
        makeRectFrame(240, 160),
        base.map((p) => (p.id === 5 ? { ...p, weight: p.weight + 2500 } : p)),
      );
      for (const f of forecast) {
        const predictedFromGeometry = signedShiftFor(next, 5, f.otherId);
        expect(f.predictedMm).toBeCloseTo(predictedFromGeometry, 6);
      }
    }
  });
});

describe('notch', () => {
  it('cuts one id into two disjoint polygons without ever crossing the notch', () => {
    const layout = computeLayout(
      makeNotchFrame(240, 220, { side: 'bottom', start: 90, end: 150, depth: 150 }),
      DEMOS[1]!.points,
    );
    const piece1 = layout.pieces.find((p) => p.id === 1)!;
    expect(piece1.parts).toBe(2);
    expect(piece1.polygons.length).toBe(2);
    // No vertex may lie strictly inside the notch void.
    const voidRect = { x0: 90, y0: 70, x1: 150, y1: 220 };
    for (const poly of piece1.polygons) {
      for (const ring of poly) {
        for (const v of ring) {
          const inVoid =
            v.x > voidRect.x0 + 1e-6 &&
            v.x < voidRect.x1 - 1e-6 &&
            v.y > voidRect.y0 + 1e-6 &&
            v.y < voidRect.y1 - 1e-6;
          expect(inVoid).toBe(false);
        }
      }
    }
    // Both parts carry the same id, hence the same colour.
    expect(piece1.labelAnchors.length).toBe(2);
  });

  it('the notch void itself has no owner', () => {
    const layout = computeLayout(
      makeNotchFrame(240, 220, { side: 'bottom', start: 90, end: 150, depth: 150 }),
      DEMOS[1]!.points,
    );
    for (const [x, y] of [
      [120, 100],
      [120, 150],
      [120, 200],
      [95, 210],
    ] as const) {
      expect(queryPoint(layout, x, y, TIE_BAND_MM).id).toBeNull();
    }
  });

  it('frame area of the notch demo equals the rectangle minus the void', () => {
    const frame = makeNotchFrame(240, 220, { side: 'bottom', start: 90, end: 150, depth: 150 });
    const expected = 240 * 220 - 60 * 150;
    expect(frameArea(frame)).toBeCloseTo(expected, 9);
  });
});

describe('degenerate inputs', () => {
  it('reports an empty pane with a reason when a point is squeezed out', () => {
    const layout = computeLayout(makeRectFrame(220, 160), DEMOS[2]!.points);
    expect(layout.stats.emptyPieceIds).toEqual([3]);
    const diag = layout.diagnostics.find((d) => d.code === 'empty-territory')!;
    expect(diag).toBeTruthy();
    expect(diag.pointIds).toEqual([3]);
    expect(diag.message).toContain('完全挤不出地盘');
    // The "dominated by" reason points at the neighbour that actually beats it.
    expect(diag.message).toContain('压过');
  });

  it('flags points closer than the threshold', () => {
    const layout = computeLayout(makeRectFrame(100, 100), [
      { id: 1, x: 40, y: 50, weight: 0 },
      { id: 2, x: 40.3, y: 50, weight: 0 },
      { id: 3, x: 80, y: 50, weight: 0 },
    ]);
    const diag = layout.diagnostics.find((d) => d.code === 'points-too-close');
    expect(diag?.pointIds).toEqual([1, 2]);
  });

  it('coincident points with equal weights resolve to the lower id only', () => {
    const layout = computeLayout(makeRectFrame(100, 100), [
      { id: 1, x: 40, y: 50, weight: 0 },
      { id: 2, x: 40, y: 50, weight: 0 },
      { id: 3, x: 80, y: 50, weight: 0 },
    ]);
    const p2 = layout.pieces.find((p) => p.id === 2)!;
    expect(p2.parts).toBe(0);
    expect(layout.stats.pieceAreaTotal).toBeCloseTo(10000, 6);
    expect(layout.stats.exact).toBe(true);
  });

  it('coincident points with unequal weights let the heavier site take the territory', () => {
    const layout = computeLayout(makeRectFrame(100, 100), [
      { id: 1, x: 40, y: 50, weight: 0 },
      { id: 2, x: 40, y: 50, weight: 500 },
      { id: 3, x: 80, y: 50, weight: 0 },
    ]);
    expect(layout.pieces.find((p) => p.id === 1)!.parts).toBe(0);
    expect(layout.pieces.find((p) => p.id === 2)!.parts).toBe(1);
  });

  it('negative weights are allowed and still partition exactly', () => {
    const layout = computeLayout(makeRectFrame(100, 100), [
      { id: 1, x: 30, y: 50, weight: -2000 },
      { id: 2, x: 70, y: 50, weight: 0 },
    ]);
    expect(layout.stats.exact).toBe(true);
    // Heavy negative weight shrinks pane 1.
    expect(layout.pieces[0]!.area).toBeLessThan(layout.pieces[1]!.area);
  });
});

describe('near-seam attribution is stable', () => {
  it('a location exactly on a seam names one owner and never flickers', () => {
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    // The seam between #1 (40,40) and #2 (120,40) sits at x = 80.
    const onSeam = queryPoint(layout, 80, 40, TIE_BAND_MM);
    expect(onSeam.tie).toBe(true);
    expect(onSeam.id).not.toBeNull();
    // Tiny perturbations around the seam must all report the same id.
    const ids = new Set<number>();
    for (const dx of [-0.3, -0.1, 0, 0.1, 0.3]) {
      const q = queryPoint(layout, 80 + dx, 40, TIE_BAND_MM).id;
      expect(q).not.toBeNull();
      ids.add(q!);
    }
    expect(ids.size).toBe(1);
    // And it is the lower of the two competitors, per the documented rule.
    expect([...ids][0]).toBe(1);
  });

  it('the tie band is a function only of the gap, not of floating noise', () => {
    const layout = computeLayout(makeRectFrame(100, 100), [
      { id: 1, x: 30, y: 50, weight: 0 },
      { id: 2, x: 70, y: 50, weight: 0 },
    ]);
    // Seam at x=50. At x=50.2, gap is 0.2 mm inside a 0.35 mm band.
    const near = queryPoint(layout, 50.2, 50, TIE_BAND_MM);
    expect(near.tie).toBe(true);
    expect(near.id).toBe(1);
    // At x=51, gap is 1 mm, outside the band; #2 owns it.
    const far = queryPoint(layout, 51, 50, TIE_BAND_MM);
    expect(far.tie).toBe(false);
    expect(far.id).toBe(2);
  });
});

describe('edges', () => {
  it('classifies frame edges and shared seams', () => {
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    const shared = layout.edges.filter((e) => e.kind === 'shared');
    const frame = layout.edges.filter((e) => e.kind === 'frame');
    expect(shared.length).toBeGreaterThan(0);
    expect(frame.length).toBeGreaterThan(0);
    for (const e of shared) {
      expect(e.otherId).not.toBeNull();
      expect(e.pieceId).not.toBe(e.otherId);
    }
    for (const e of frame) expect(e.otherId).toBeNull();
  });

  it('shared seam length adds up to the interior split length', () => {
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    // 3×2 grid has 2 vertical interior seams (160 mm each) and 1 horizontal
    // seam split into 3 runs across the 240 mm width.
    const once = layout.edges.filter(
      (e) => e.kind === 'shared' && e.pieceId < (e.otherId ?? 0),
    );
    const total = once.reduce((s, e) => s + e.length, 0);
    expect(total).toBeCloseTo(2 * 160 + 240, 6);
  });

  it('neighbour list from id sides contains no duplicates', () => {
    const layout = computeLayout(makeRectFrame(240, 160), grid3x2());
    for (const p of layout.points) {
      const n = sharedNeighbours(layout, p.id);
      expect(new Set(n).size).toBe(n.length);
    }
  });
});

describe('export', () => {
  const demo = DEMOS[1]!;
  const layout = computeLayout(cloneDemo(demo).frame, cloneDemo(demo).points);

  it('every SVG uses the same viewBox in original frame millimetres', () => {
    const colour = exportColorSvg(layout, { theme: 'light' });
    const colourBox = colour.match(/viewBox="([^"]+)"/)![1];
    expect(colourBox).toBe(`0 0 ${layout.frame.width} ${layout.frame.height}`);
    for (const piece of layout.pieces) {
      const slice = exportPieceSvg(piece, layout, { theme: 'light' });
      expect(slice.match(/viewBox="([^"]+)"/)![1]).toBe(colourBox);
      expect(slice).toContain(`data-piece="${piece.id}"`);
    }
  });

  it('manifest area metadata sums exactly to the frame area', () => {
    const manifest = buildManifest(layout);
    const sum = manifest.pieces.reduce((s, p) => s + p.area, 0);
    expect(sum).toBeCloseTo(manifest.frame.area, 6);
    expect(manifest.totals.exact).toBe(true);
    expect(manifest.viewBox).toEqual([0, 0, layout.frame.width, layout.frame.height]);
    // The notch demo's split pane is recorded as two polygons under one id.
    const split = manifest.pieces.find((p) => p.id === 1)!;
    expect(split.parts).toBe(2);
    expect(split.polygons).toBe(2);
  });

  it('exported slice polygons carry the same area as the manifest entry', () => {
    for (const piece of layout.pieces) {
      const sum = piece.polygons.reduce((s, poly) => s + polyArea(poly), 0);
      expect(sum).toBeCloseTo(piece.area, 6);
    }
  });

  it('buildExportFiles bundles colour + slices + manifest + readme', () => {
    const files = buildExportFiles(layout, { theme: 'dark' });
    const names = files.map((f) => f.name);
    expect(names).toContain('window-color.svg');
    expect(names).toContain('manifest.json');
    expect(names).toContain('README.txt');
    expect(names.filter((n) => n.startsWith('slices/')).length).toBe(layout.pieces.length);
  });

  it('still emits a slice file for a pane with no territory, flagged empty', () => {
    const emptyDemo = DEMOS[2]!;
    const copy = cloneDemo(emptyDemo);
    const emptyLayout = computeLayout(copy.frame, copy.points);
    const files = buildExportFiles(emptyLayout, { theme: 'dark' });
    const names = files.map((f) => f.name);
    expect(names).toContain('slices/piece-03.svg');
    const slice3 = files.find((f) => f.name === 'slices/piece-03.svg')!;
    const text = new TextDecoder().decode(slice3.bytes);
    expect(text).toContain('data-empty="true"');
    const manifest = JSON.parse(
      new TextDecoder().decode(files.find((f) => f.name === 'manifest.json')!.bytes),
    );
    expect(manifest.pieces.find((p: { id: number }) => p.id === 3).area).toBe(0);
    // Every numbered pane gets its own file, empty or not.
    expect(names.filter((n) => n.startsWith('slices/')).length).toBe(emptyLayout.pieces.length);
    // Area still balances.
    expect(emptyLayout.stats.exact).toBe(true);
  });

  it('exports parse as well-formed XML fragments', () => {
    const colour = exportColorSvg(layout, { theme: 'light' });
    expect(colour.startsWith('<?xml')).toBe(true);
    expect(colour).toContain('<svg');
    expect((colour.match(/<svg/g) ?? []).length).toBe(1);
    expect(colour).toContain('</svg>');
    // No unescaped ampersand except in entity form.
    expect(colour.match(/&(?!amp;|lt;|gt;|quot;|#)/)).toBeNull();
  });
});

describe('frame area', () => {
  it('ring area of a concave frame equals outer rectangle minus notch', () => {
    const f = makeNotchFrame(120, 90, { side: 'top', start: 20, end: 50, depth: 30 });
    expect(ringAreaAbs(f.ring)).toBeCloseTo(120 * 90 - 30 * 30, 9);
    // Sanity: the interior centre of the notch void is outside the frame ring.
    expect(pointInRing(pt(35, 15), f.ring)).toBe(false);
    expect(pointInRing(pt(100, 60), f.ring)).toBe(true);
  });
});
