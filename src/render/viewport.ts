import type { LocationDef, Point } from '../engine/types';
import { locationAnchor } from '../engine/boards';

/** 盘面坐标（以格为单位）→ 像素。 */
export interface Viewport {
  readonly tile: number;
  readonly ox: number;
  readonly oy: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 盘面用到的有效列/行（从 0 到最右/最下的地点）。
 * 棋盘声明的 cols/rows 常比实际用到的多，按有效范围取景可少留白。
 */
export const effectiveBounds = (locations: readonly { rect: { x: number; y: number; w: number; h: number } }[]) => {
  let cols = 1;
  let rows = 1;
  for (const l of locations) {
    cols = Math.max(cols, l.rect.x + l.rect.w);
    rows = Math.max(rows, l.rect.y + l.rect.h);
  }
  return { cols, rows };
};

export const makeViewport = (
  canvasW: number,
  canvasH: number,
  cols: number,
  rows: number,
  pad = 24,
): Viewport => {
  const tile = Math.min((canvasW - pad * 2) / cols, (canvasH - pad * 2) / rows);
  const w = tile * cols;
  const h = tile * rows;
  return { tile, ox: (canvasW - w) / 2, oy: (canvasH - h) / 2, w, h };
};

export const px = (v: Viewport, x: number) => v.ox + x * v.tile;
export const py = (v: Viewport, y: number) => v.oy + y * v.tile;
export const pt = (v: Viewport, p: Point) => ({ x: px(v, p.x), y: py(v, p.y) });

export const rectPx = (v: Viewport, loc: LocationDef) => ({
  x: px(v, loc.rect.x),
  y: py(v, loc.rect.y),
  w: loc.rect.w * v.tile,
  h: loc.rect.h * v.tile,
});

export const anchorPx = (v: Viewport, loc: LocationDef) => {
  const a = locationAnchor(loc);
  return { x: px(v, a.x), y: py(v, a.y) };
};

export const dist2 = (
  a: { x: number; y: number },
  b: { x: number; y: number },
) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
