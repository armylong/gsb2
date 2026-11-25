/**
 * 2D 相机。世界坐标 +Y 向下（和画布一致），单位与精灵尺寸相同。
 * 参考路径与合批路径共用同一台相机，保证两侧离屏缓冲逐像素对齐。
 */
export interface Camera {
  cx: number;
  cy: number;
  /** 世界单位 → 设备像素。 */
  zoom: number;
}

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_ZOOM = 0.04;
export const MAX_ZOOM = 8;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function fitCamera(worldW: number, worldH: number, eyeW: number, eyeH: number): Camera {
  const zoom = clampZoom(Math.min(eyeW / worldW, eyeH / worldH) * 0.9);
  return { cx: worldW / 2, cy: worldH / 2, zoom };
}

export function worldToEye(
  camera: Camera,
  eyeW: number,
  eyeH: number,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return {
    x: (wx - camera.cx) * camera.zoom + eyeW / 2,
    y: (wy - camera.cy) * camera.zoom + eyeH / 2,
  };
}

export function eyeToWorld(
  camera: Camera,
  eyeW: number,
  eyeH: number,
  ex: number,
  ey: number,
): { x: number; y: number } {
  return {
    x: (ex - eyeW / 2) / camera.zoom + camera.cx,
    y: (ey - eyeH / 2) / camera.zoom + camera.cy,
  };
}

export function visibleWorldRect(camera: Camera, eyeW: number, eyeH: number): WorldRect {
  const halfW = eyeW / (2 * camera.zoom);
  const halfH = eyeH / (2 * camera.zoom);
  return {
    minX: camera.cx - halfW,
    minY: camera.cy - halfH,
    maxX: camera.cx + halfW,
    maxY: camera.cy + halfH,
  };
}

/** 以光标下的世界点为锚点缩放，手感与常见的图片查看器一致。 */
export function zoomAt(
  camera: Camera,
  factor: number,
  ex: number,
  ey: number,
  eyeW: number,
  eyeH: number,
): Camera {
  const anchor = eyeToWorld(camera, eyeW, eyeH, ex, ey);
  const zoom = clampZoom(camera.zoom * factor);
  return {
    cx: anchor.x - (ex - eyeW / 2) / zoom,
    cy: anchor.y - (ey - eyeH / 2) / zoom,
    zoom,
  };
}

export function panByEye(camera: Camera, dxEye: number, dyEye: number): Camera {
  return {
    cx: camera.cx - dxEye / camera.zoom,
    cy: camera.cy - dyEye / camera.zoom,
    zoom: camera.zoom,
  };
}

/** 世界矩形是否与镜头相交（含边界接触）。 */
export function rectIntersects(a: WorldRect, b: WorldRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
