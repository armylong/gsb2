import type { Vec2 } from '../core/geometry.ts';

/** 相机: 世界坐标 -> 屏幕 CSS 像素。 */
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 6;

export function worldToScreen(cam: Camera, p: Vec2): Vec2 {
  return { x: p.x * cam.scale + cam.tx, y: p.y * cam.scale + cam.ty };
}

export function screenToWorld(cam: Camera, p: Vec2): Vec2 {
  return { x: (p.x - cam.tx) / cam.scale, y: (p.y - cam.ty) / cam.scale };
}

export function fitCamera(
  bounds: { min: Vec2; max: Vec2 },
  width: number,
  height: number,
  padding = 70,
): Camera {
  const bw = Math.max(1, bounds.max.x - bounds.min.x);
  const bh = Math.max(1, bounds.max.y - bounds.min.y);
  const scale = Math.min((width - padding * 2) / bw, (height - padding * 2) / bh);
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  return {
    scale: s,
    tx: (width - bw * s) / 2 - bounds.min.x * s,
    ty: (height - bh * s) / 2 - bounds.min.y * s,
  };
}

export function zoomAt(cam: Camera, screen: Vec2, factor: number): Camera {
  const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale * factor));
  const k = next / cam.scale;
  return {
    scale: next,
    tx: screen.x - (screen.x - cam.tx) * k,
    ty: screen.y - (screen.y - cam.ty) * k,
  };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { scale: cam.scale, tx: cam.tx + dx, ty: cam.ty + dy };
}
