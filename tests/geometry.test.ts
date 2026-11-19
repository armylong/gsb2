import { describe, expect, it } from 'vitest';
import {
  axialToOffset,
  cellsInRange,
  grazesHex,
  hexCentre,
  hexDistance,
  intermediateCells,
  offsetToAxial,
  pixelToAxial,
  segmentHexOverlapLength,
} from '../src/hex';
import { GameMap } from '../src/map';
import { computeLineOfSight } from '../src/vision';

function key(c: { q: number; r: number }): string {
  const { col, row } = axialToOffset(c.q, c.r);
  return `${col},${row}`;
}

function emptyMap(): GameMap {
  const map = new GameMap();
  return map;
}

describe('hex geometry', () => {
  it('centres follow the documented pointy-top formula', () => {
    expect(hexCentre(0, 0)).toEqual({ x: 0, y: 0 });
    const c = hexCentre(1, 0);
    expect(c.x).toBeCloseTo(Math.sqrt(3), 12);
    expect(c.y).toBeCloseTo(0, 12);
    const c2 = hexCentre(0, 1);
    expect(c2.x).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(c2.y).toBeCloseTo(1.5, 12);
  });

  it('distance and neighbours agree', () => {
    expect(hexDistance(0, 0, 0, 0)).toBe(0);
    expect(hexDistance(0, 0, 1, 0)).toBe(1);
    expect(hexDistance(0, 0, 0, 1)).toBe(1);
    expect(hexDistance(0, 0, 2, -1)).toBe(2);
    for (const n of cellsInRange(0, 0, 1)) {
      if (n.q === 0 && n.r === 0) continue;
      expect(hexDistance(0, 0, n.q, n.r)).toBe(1);
    }
  });

  it('pixelToAxial round-trips cell centres at any zoom size', () => {
    for (const size of [1, 22, 37.5, 4.25]) {
      for (let row = 0; row < 12; row++) {
        for (let col = 0; col < 15; col++) {
          const { q, r } = offsetToAxial(col, row);
          const c = hexCentre(q, r, size);
          expect(pixelToAxial(c.x, c.y, size)).toEqual({ q, r });
        }
      }
    }
  });

  it('pixelToAxial resolves an exact corner deterministically', () => {
    const { q, r } = offsetToAxial(4, 4);
    const c = hexCentre(q, r);
    const corner = { x: c.x + Math.sqrt(3) / 2, y: c.y - 0.5 * 0 + 0.5 };
    // Any point must map to some cell and the same point must be stable.
    const first = pixelToAxial(corner.x, corner.y);
    for (let i = 0; i < 20; i++) expect(pixelToAxial(corner.x, corner.y)).toEqual(first);
  });
});

describe('line-of-sight geometry', () => {
  it('a straight line between two adjacent centres crosses nothing', () => {
    const a = { q: 0, r: 0 };
    const b = { q: 1, r: 0 };
    expect(intermediateCells(a, b)).toEqual([]);
  });

  it('distance-2 lines: six directions cross one cell, six pass through a shared vertex', () => {
    const a = { q: 0, r: 0 };
    const oneIntermediate = [
      { q: 2, r: 0 }, { q: 0, r: 2 }, { q: -2, r: 2 },
      { q: -2, r: 0 }, { q: 0, r: -2 }, { q: 2, r: -2 },
    ];
    const vertexOnly = [
      { q: 1, r: 1 }, { q: -2, r: 1 }, { q: -1, r: 2 },
      { q: -1, r: -1 }, { q: 1, r: -2 }, { q: 2, r: -1 },
    ];
    for (const b of oneIntermediate) {
      const between = intermediateCells(a, b);
      expect(between).toHaveLength(1);
      expect(hexDistance(0, 0, between[0]!.q, between[0]!.r)).toBe(1);
    }
    for (const b of vertexOnly) {
      expect(intermediateCells(a, b)).toEqual([]);
    }
  });

  it('corner touch only: the segment grazes at least one flanking cell, none is intermediate', () => {
    // From (0,0) to (-2,1) the centre line passes exactly through a hex corner
    // shared by (-1,0) and (-1,1). Under the "interior only" rule the grazed
    // flank is not counted as an intermediate cell.
    const a = { q: 0, r: 0 };
    const b = { q: -2, r: 1 };
    expect(intermediateCells(a, b)).toEqual([]);
    const ac = hexCentre(a.q, a.r);
    const bc = hexCentre(b.q, b.r);
    const grazing = [{ q: -1, r: 0 }, { q: -1, r: 1 }].filter((g) =>
      grazesHex(ac.x, ac.y, bc.x, bc.y, g),
    );
    expect(grazing.length).toBeGreaterThanOrEqual(1);
    for (const g of grazing) {
      const shrunkOverlap = segmentHexOverlapLength(
        ac.x, ac.y, bc.x, bc.y, hexCentre(g.q, g.r), 1e-6,
      );
      expect(shrunkOverlap).toBeLessThan(1e-9);
      expect(intermediateCells(a, b).some((c) => c.q === g.q && c.r === g.r)).toBe(false);
    }
  });

  it('edge-hugging: the segment runs exactly along the shared edge of two cells', () => {
    // From (0,0) to (0,2) the centre line passes through the shared vertex...
    // choose (0,0)->(1,1): line along an edge of (1,0) and (0,1).
    const a = { q: 0, r: 0 };
    const b = { q: 1, r: 1 };
    const ac = hexCentre(a.q, a.r);
    const bc = hexCentre(b.q, b.r);
    const left = { q: 1, r: 0 };
    const right = { q: 0, r: 1 };
    const grazed = [left, right].filter((g) => grazesHex(ac.x, ac.y, bc.x, bc.y, g));
    expect(grazed.length).toBeGreaterThanOrEqual(1);
    const between = intermediateCells(a, b);
    expect(between.every((c) => key(c) !== key(left) && key(c) !== key(right))).toBe(true);
  });

  it('an exact corner-touch wall does not block the cell behind it', () => {
    // From (0,0) to (4,4) the centre line passes through the corner shared by
    // (1,1) and (2,2)-adjacent cells. (1,1) is grazed, and so is (0,1)/(1,0).
    const map = emptyMap();
    const a = { q: 0, r: 0 };
    const target = { q: 4, r: 4 };
    const ac = hexCentre(a.q, a.r);
    const tc = hexCentre(target.q, target.r);
    expect(grazesHex(ac.x, ac.y, tc.x, tc.y, { q: 0, r: 1 })).toBe(true);
    expect(grazesHex(ac.x, ac.y, tc.x, tc.y, { q: 1, r: 0 })).toBe(true);
    map.setTerrain(0, 1, 'wall');
    map.setTerrain(1, 0, 'wall');
    const los = computeLineOfSight(map, a, target);
    expect(los.visible).toBe(true);
    expect(los.blocker).toBeNull();
  });

  it('a wall that the line genuinely crosses does block', () => {
    const map = emptyMap();
    const a = { q: 0, r: 0 };
    const target = offsetToAxial(4, 3);
    const crossed = intermediateCells(a, target);
    expect(crossed.length).toBeGreaterThan(0);
    map.setTerrain(crossed[0]!.q, crossed[0]!.r, 'wall');
    const los = computeLineOfSight(map, a, target);
    expect(los.visible).toBe(false);
    expect(los.blocker).toMatchObject({ q: crossed[0]!.q, r: crossed[0]!.r, terrain: 'wall' });
  });
});
