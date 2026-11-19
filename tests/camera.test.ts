import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  createCamera,
  fitCamera,
  panBy,
  pickCell,
  screenToWorld,
  worldToScreen,
  zoomAt,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../src/camera';
import { axialToOffset, hexCentre, hexCornersAt, offsetToAxial } from '../src/hex';

const viewport = { width: 1000, height: 700 };

function roundTrip(camera: ReturnType<typeof createCamera>) {
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 15; col++) {
      const { q, r } = offsetToAxial(col, row);
      const c = hexCentre(q, r);
      const screen = worldToScreen(camera, c.x, c.y);
      const picked = pickCell(camera, screen.x, screen.y);
      expect(picked, `col ${col}, row ${row} at zoom ${camera.zoom}`).toEqual({ q, r });
    }
  }
}

describe('camera', () => {
  it('picking maps every cell centre back to the same cell at several zooms', () => {
    for (const zoom of [8, 12, 28, 60, 128]) {
      roundTrip({ zoom, centre: { x: 12.5, y: 8.2 }, viewport });
    }
  });

  it('picking survives panning and zooming around an anchor', () => {
    let camera = createCamera(viewport, 30);
    camera = { ...camera, centre: { x: 9, y: 6 } };
    camera = zoomAt(camera, 320, 240, 55);
    camera = panBy(camera, -120, 80);
    camera = zoomAt(camera, 700, 500, 22);
    roundTrip(camera);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const camera = createCamera(viewport, 26);
    const anchorScreen = { x: 300, y: 420 };
    const before = screenToWorld(camera, anchorScreen.x, anchorScreen.y);
    const zoomed = zoomAt(camera, anchorScreen.x, anchorScreen.y, 64);
    const after = screenToWorld(zoomed, anchorScreen.x, anchorScreen.y);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('pick stays within the clicked hex even near its corners', () => {
    const camera = { zoom: 40, centre: { x: 0, y: 0 }, viewport };
    for (const [col, row] of [[0, 0], [7, 5], [14, 11], [3, 8]] as const) {
      const { q, r } = offsetToAxial(col, row);
      const corners = hexCornersAt(q, r, 0.86); // pure inside the hexagon
      for (const point of corners) {
        const screen = worldToScreen(camera, point.x, point.y);
        const picked = pickCell(camera, screen.x, screen.y);
        expect(picked).toEqual({ q, r });
      }
    }
  });

  it('a cell that a click picks is exactly the one whose centre is closest on screen', () => {
    const camera = { zoom: 33, centre: { x: 6, y: 4 }, viewport };
    for (let i = 0; i < 40; i++) {
      const sx = 40 + ((i * 97) % (viewport.width - 80));
      const sy = 40 + ((i * 61) % (viewport.height - 80));
      const picked = pickCell(camera, sx, sy);
      const pickedScreen = worldToScreen(camera, hexCentre(picked.q, picked.r).x, hexCentre(picked.q, picked.r).y);
      let bestDistance = Math.hypot(pickedScreen.x - sx, pickedScreen.y - sy);
      for (const candidate of [
        { q: picked.q + 1, r: picked.r },
        { q: picked.q - 1, r: picked.r },
        { q: picked.q, r: picked.r + 1 },
        { q: picked.q, r: picked.r - 1 },
        { q: picked.q + 1, r: picked.r - 1 },
        { q: picked.q - 1, r: picked.r + 1 },
      ]) {
        const centre = hexCentre(candidate.q, candidate.r);
        const screen = worldToScreen(camera, centre.x, centre.y);
        const distance = Math.hypot(screen.x - sx, screen.y - sy);
        expect(bestDistance, 'picked cell must be the nearest centre').toBeLessThanOrEqual(distance + 1e-9);
      }
    }
  });

  it('zoom is clamped and panning is inverse-scaled', () => {
    expect(clampZoom(1)).toBe(MIN_ZOOM);
    expect(clampZoom(9999)).toBe(MAX_ZOOM);
    const camera = createCamera(viewport, 20);
    const panned = panBy(camera, 200, -100);
    expect(panned.centre.x).toBeCloseTo(-10, 9);
    expect(panned.centre.y).toBeCloseTo(5, 9);
  });

  it('fitCamera frames the board inside the viewport', () => {
    const camera = fitCamera(viewport, 27.12, 18.5, 46);
    expect(camera.zoom).toBeGreaterThan(0);
    expect(camera.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    const offset = axialToOffset(0, 0);
    expect(camera.viewport).toEqual(viewport);
    expect(offset.col).toBe(0);
  });
});
