/**
 * cpuRenderer.ts — WebGL 不可用时的回退渲染器
 *
 * 在逻辑坐标降采样栅格上逐格调用 analyticVisibility / pointVisibility，
 * 与着色器使用完全相同的数学（src/core/visibility.ts），再用 ImageData 放大。
 * 分辨率固定为每格 4 逻辑单位，保证交互拖动时仍可实时刷新。
 */

import { Circle, Poly } from './renderTypes';
import { Scene, analyticVisibility, pointVisibility, rangeFactor } from '../core/visibility';
import { ROOM_H, ROOM_W } from '../core/presets';

const CELL = 4;

export interface CpuRenderer {
  canvas: HTMLCanvasElement;
  render: (params: {
    light: Circle;
    polys: Poly[];
    range: number;
    brightness: number;
    pointMode: boolean;
  }) => void;
  readPixel: (world: { x: number; y: number }) => [number, number, number];
}

export function createCpuRenderer(canvas: HTMLCanvasElement): CpuRenderer {
  const gw = Math.ceil(ROOM_W / CELL);
  const gh = Math.ceil(ROOM_H / CELL);
  const off = document.createElement('canvas');
  off.width = gw;
  off.height = gh;
  const octx = off.getContext('2d');
  if (!octx) throw new Error('Canvas 2D 不可用');
  const offCtx: CanvasRenderingContext2D = octx;
  const img = offCtx.createImageData(gw, gh);
  const lastParams = { cell: new Uint8ClampedArray(gw * gh * 3) };

  function render(params: {
    light: Circle;
    polys: Poly[];
    range: number;
    brightness: number;
    pointMode: boolean;
  }): void {
    const scene: Scene = {
      light: params.light,
      polys: params.polys,
      range: params.range,
      brightness: params.brightness,
    };
    const floor = [0.86, 0.85, 0.82];
    const polyCol = [0.32, 0.4, 0.52];
    for (let gy = 0; gy < gh; gy++) {
      const wy = (gy + 0.5) * CELL;
      for (let gx = 0; gx < gw; gx++) {
        const wx = (gx + 0.5) * CELL;
        const p = { x: wx, y: wy };
        let r: number;
        let g: number;
        let b: number;
        if (params.polys.some((poly) => inside(p, poly))) {
          [r, g, b] = polyCol;
        } else {
          const vis = params.pointMode
            ? pointVisibility(p, scene)
            : analyticVisibility(p, scene);
          const fall = rangeFactor(p, scene);
          const direct = vis * fall * params.brightness;
          const amb = 0.1;
          r = floor[0] * (amb + direct * 0.9);
          g = floor[1] * (amb + direct * 0.9);
          b = floor[2] * (amb + direct * 0.9);
        }
        const idx = (gy * gw + gx) * 4;
        img.data[idx] = clamp255(r * 255);
        img.data[idx + 1] = clamp255(g * 255);
        img.data[idx + 2] = clamp255(b * 255);
        img.data[idx + 3] = 255;
        const cidx = (gy * gw + gx) * 3;
        lastParams.cell[cidx] = img.data[idx];
        lastParams.cell[cidx + 1] = img.data[idx + 1];
        lastParams.cell[cidx + 2] = img.data[idx + 2];
      }
    }
    offCtx.putImageData(img, 0, 0);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = ROOM_W;
    canvas.height = ROOM_H;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, ROOM_W, ROOM_H);
  }

  function readPixel(world: { x: number; y: number }): [number, number, number] {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor(world.x / CELL)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor(world.y / CELL)));
    const i = (gy * gw + gx) * 3;
    return [lastParams.cell[i], lastParams.cell[i + 1], lastParams.cell[i + 2]];
  }

  return { canvas, render, readPixel };
}

function inside(p: { x: number; y: number }, poly: Poly): boolean {
  for (let i = 0; i < poly.verts.length; i++) {
    const a = poly.verts[i];
    const b = poly.verts[(i + 1) % poly.verts.length];
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cr < -1e-9) return false;
  }
  return true;
}

function clamp255(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}
