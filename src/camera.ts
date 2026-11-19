import { pixelToAxial } from './hex';
import type { Axial, Vec2 } from './types';

export const MIN_ZOOM = 8;
export const MAX_ZOOM = 140;

/**
 * Screen ↔ world camera. `zoom` is screen pixels per world unit (one hex has
 * circumradius 1). `centre` is the world point shown at the middle of the
 * viewport. Kept pure and DOM-free so zoom-aware picking can be unit-tested.
 */
export interface Camera {
  zoom: number;
  centre: Vec2;
  viewport: { width: number; height: number };
}

export function createCamera(viewport: { width: number; height: number }, zoom = 28): Camera {
  return { zoom, centre: { x: 0, y: 0 }, viewport };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(camera: Camera, x: number, y: number): Vec2 {
  return {
    x: (x - camera.centre.x) * camera.zoom + camera.viewport.width / 2,
    y: (y - camera.centre.y) * camera.zoom + camera.viewport.height / 2,
  };
}

export function screenToWorld(camera: Camera, sx: number, sy: number): Vec2 {
  return {
    x: (sx - camera.viewport.width / 2) / camera.zoom + camera.centre.x,
    y: (sy - camera.viewport.height / 2) / camera.zoom + camera.centre.y,
  };
}

/** Zoom around a screen anchor, keeping the world point under the cursor fixed. */
export function zoomAt(camera: Camera, sx: number, sy: number, nextZoom: number): Camera {
  const zoom = clampZoom(nextZoom);
  const anchor = screenToWorld(camera, sx, sy);
  const newCentre = {
    x: anchor.x - (sx - camera.viewport.width / 2) / zoom,
    y: anchor.y - (sy - camera.viewport.height / 2) / zoom,
  };
  return { ...camera, zoom, centre: newCentre };
}

export function panBy(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return {
    ...camera,
    centre: {
      x: camera.centre.x - dxScreen / camera.zoom,
      y: camera.centre.y - dyScreen / camera.zoom,
    },
  };
}

/** Screen pixel → hex cell. Uses size 1 world units, so zoom cannot skew picking. */
export function pickCell(camera: Camera, sx: number, sy: number): Axial {
  const world = screenToWorld(camera, sx, sy);
  return pixelToAxial(world.x, world.y, 1);
}

export function fitCamera(
  viewport: { width: number; height: number },
  mapWidth: number,
  mapHeight: number,
  padding = 48,
): Camera {
  const zoom = clampZoom(
    Math.min((viewport.width - padding * 2) / mapWidth, (viewport.height - padding * 2) / mapHeight),
  );
  return {
    zoom,
    centre: { x: 0, y: 0 },
    viewport,
  };
}
