import { CANVAS_WIDTH, VIEW_SIZE } from '../webgl/renderer.ts';

export const ROI_SIZE = 48;
export const ZOOM_SCALE = 6;
export const ZOOM_PIXELS = ROI_SIZE * ZOOM_SCALE;

export interface Roi {
  /** Center, normalized inside one 640×640 comparison viewport. */
  nx: number;
  ny: number;
}

export interface ZoomPaintResult {
  ordinaryDrawn: number;
  areaDrawn: number;
}

export function clampRoi(roi: Roi): Roi {
  return { nx: Math.max(0, Math.min(1, roi.nx)), ny: Math.max(0, Math.min(1, roi.ny)) };
}

export function roiTopLeft(roi: Roi): { x: number; y: number } {
  const centerX = roi.nx * VIEW_SIZE;
  const centerY = roi.ny * VIEW_SIZE;
  return {
    x: Math.round(Math.max(0, Math.min(VIEW_SIZE - ROI_SIZE, centerX - ROI_SIZE / 2))),
    y: Math.round(Math.max(0, Math.min(VIEW_SIZE - ROI_SIZE, centerY - ROI_SIZE / 2))),
  };
}

function paintBackground(ctx: CanvasRenderingContext2D, background: 'dark' | 'checker'): void {
  if (background === 'dark') {
    ctx.fillStyle = '#11161d';
    ctx.fillRect(0, 0, ZOOM_PIXELS, ZOOM_PIXELS);
    return;
  }

  const cell = ZOOM_SCALE * 2;
  for (let y = 0; y < ZOOM_PIXELS; y += cell) {
    for (let x = 0; x < ZOOM_PIXELS; x += cell) {
      const odd = (x / cell + y / cell) % 2 === 1;
      ctx.fillStyle = odd ? '#d8d8d2' : '#f7f7f2';
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

interface CropLayers {
  raw: HTMLCanvasElement;
  outline: HTMLCanvasElement;
  drawnPixels: number;
}

function extractCrop(
  source: HTMLCanvasElement,
  side: 0 | 1,
  roi: Roi,
): CropLayers {
  const { x, y } = roiTopLeft(roi);
  const fullX = side * VIEW_SIZE + x;
  const raw = document.createElement('canvas');
  raw.width = ROI_SIZE;
  raw.height = ROI_SIZE;
  const ctx = raw.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D crop context unavailable');
  ctx.clearRect(0, 0, ROI_SIZE, ROI_SIZE);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, fullX, y, ROI_SIZE, ROI_SIZE, 0, 0, ROI_SIZE, ROI_SIZE);

  const pixels = ctx.getImageData(0, 0, ROI_SIZE, ROI_SIZE).data;
  let drawnPixels = 0;
  const drawn = new Uint8Array(ROI_SIZE * ROI_SIZE);
  for (let p = 0; p < ROI_SIZE * ROI_SIZE; p++) {
    if (pixels[p * 4 + 3] >= 128) {
      drawn[p] = 1;
      drawnPixels++;
    }
  }

  const outline = document.createElement('canvas');
  outline.width = ROI_SIZE;
  outline.height = ROI_SIZE;
  const outlineCtx = outline.getContext('2d');
  if (!outlineCtx) throw new Error('Outline context unavailable');
  const outlineImage = outlineCtx.createImageData(ROI_SIZE, ROI_SIZE);
  for (let y0 = 0; y0 < ROI_SIZE; y0++) {
    for (let x0 = 0; x0 < ROI_SIZE; x0++) {
      const p = y0 * ROI_SIZE + x0;
      if (!drawn[p]) continue;
      const left = x0 > 0 ? drawn[p - 1] : 0;
      const right = x0 < ROI_SIZE - 1 ? drawn[p + 1] : 0;
      const up = y0 > 0 ? drawn[p - ROI_SIZE] : 0;
      const down = y0 < ROI_SIZE - 1 ? drawn[p + ROI_SIZE] : 0;
      if (left && right && up && down) continue;
      const i = p * 4;
      outlineImage.data[i] = 255;
      outlineImage.data[i + 1] = 214;
      outlineImage.data[i + 2] = 64;
      outlineImage.data[i + 3] = 255;
    }
  }
  outlineCtx.putImageData(outlineImage, 0, 0);
  return { raw, outline, drawnPixels };
}

function paintZoomCanvas(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  side: 0 | 1,
  roi: Roi,
  showOutline: boolean,
  background: 'dark' | 'checker',
): number {
  target.width = ZOOM_PIXELS;
  target.height = ZOOM_PIXELS;
  const ctx = target.getContext('2d');
  if (!ctx) throw new Error('Zoom 2D context unavailable');
  paintBackground(ctx, background);
  ctx.imageSmoothingEnabled = false;

  const crop = extractCrop(source, side, roi);
  ctx.drawImage(crop.raw, 0, 0, ZOOM_PIXELS, ZOOM_PIXELS);
  if (showOutline) {
    ctx.drawImage(crop.outline, 0, 0, ZOOM_PIXELS, ZOOM_PIXELS);
  }
  return crop.drawnPixels;
}

export function paintZoomPair(args: {
  source: HTMLCanvasElement;
  roi: Roi;
  showOutline: boolean;
  background: 'dark' | 'checker';
  ordinary: HTMLCanvasElement;
  area: HTMLCanvasElement;
}): ZoomPaintResult {
  return {
    ordinaryDrawn: paintZoomCanvas(args.ordinary, args.source, 0, args.roi, args.showOutline, args.background),
    areaDrawn: paintZoomCanvas(args.area, args.source, 1, args.roi, args.showOutline, args.background),
  };
}

export function eventToRoi(event: MouseEvent, canvas: HTMLCanvasElement): Roi | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return null;
  const bufferX = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
  const bufferY = ((event.clientY - rect.top) / rect.height) * VIEW_SIZE;
  if (bufferX < 0 || bufferX > CANVAS_WIDTH || bufferY < 0 || bufferY > VIEW_SIZE) return null;
  const side = bufferX < VIEW_SIZE ? 0 : 1;
  const localX = bufferX - side * VIEW_SIZE;
  return clampRoi({ nx: localX / VIEW_SIZE, ny: bufferY / VIEW_SIZE });
}
