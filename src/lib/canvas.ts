/** Canvas 2D helpers for the browser preview. */

import type { RGBAImage } from '../../shared/pixels';

const cache = new Map<string, HTMLImageElement>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      cache.set(url, image);
      resolve(image);
    };
    image.onerror = () => reject(new Error(`Failed to load image ${url}`));
    image.src = url;
  });
}

export function imageToRGBA(image: HTMLImageElement): RGBAImage {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: data.data };
}

/** Draw an RGBA image into a canvas at an integer position with no smoothing. */
export function drawRGBA(
  ctx: CanvasRenderingContext2D,
  image: RGBAImage,
  dx: number,
  dy: number,
  scale = 1,
): void {
  if (image.width === 0 || image.height === 0) return;
  const tmp = document.createElement('canvas');
  tmp.width = image.width;
  tmp.height = image.height;
  const tmpCtx = tmp.getContext('2d');
  if (!tmpCtx) return;
  const copy = new Uint8ClampedArray(image.data);
  tmpCtx.putImageData(new ImageData(copy, image.width, image.height), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, dx, dy, image.width * scale, image.height * scale);
}

export function makeCanvas(width: number, height: number, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

/** Convert an RGBA image into an offscreen canvas for fast frame blitting. */
export function rgbaToCanvas(image: RGBAImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, image.width);
  canvas.height = Math.max(1, image.height);
  const ctx = canvas.getContext('2d');
  if (ctx && image.width > 0 && image.height > 0) {
    const copy = new Uint8ClampedArray(image.data);
    ctx.putImageData(new ImageData(copy, image.width, image.height), 0, 0);
  }
  return canvas;
}
