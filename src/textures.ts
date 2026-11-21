/**
 * 程序纹理：Canvas 生成，无需外部资源。
 * 种子固定 → 每次生成的纹理一致（与高度场一样可重复）。
 */
import * as THREE from 'three';
import { mulberry32 } from './heightfield';

export interface LayerTextures {
  grass: THREE.CanvasTexture;
  rock: THREE.CanvasTexture;
  snow: THREE.CanvasTexture;
  fallback: THREE.CanvasTexture;
}

const TEX_SIZE = 256;

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D canvas');
  return [c, ctx];
}

function toTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 在底色上撒噪点 */
function speckle(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  count: number,
  colors: string[],
  rMin: number,
  rMax: number,
): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const r = rMin + rand() * (rMax - rMin);
    ctx.beginPath();
    ctx.arc(rand() * TEX_SIZE, rand() * TEX_SIZE, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function makeTextures(seed = 20240601): LayerTextures {
  // 草地
  const [gc, gctx] = makeCanvas();
  const grand = mulberry32(seed + 1);
  gctx.fillStyle = '#4c7a33';
  gctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  speckle(gctx, grand, 2600, ['#3d6329', '#5a8c3e', '#6b9a48', '#446f2e'], 0.6, 2.4);

  // 岩石
  const [rc, rctx] = makeCanvas();
  const rrand = mulberry32(seed + 2);
  rctx.fillStyle = '#7b7670';
  rctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  speckle(rctx, rrand, 180, ['#6a6560', '#8a8580', '#5d5852', '#948e87'], 4, 18);
  speckle(rctx, rrand, 1500, ['#55504b', '#8f8a83'], 0.5, 1.8);
  // 裂纹
  rctx.strokeStyle = 'rgba(40,38,35,0.55)';
  rctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    rctx.beginPath();
    let x = rrand() * TEX_SIZE;
    let y = rrand() * TEX_SIZE;
    rctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rrand() - 0.5) * 40;
      y += (rrand() - 0.5) * 40;
      rctx.lineTo(x, y);
    }
    rctx.stroke();
  }

  // 雪
  const [sc, sctx] = makeCanvas();
  const srand = mulberry32(seed + 3);
  sctx.fillStyle = '#eef3fa';
  sctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  speckle(sctx, srand, 1200, ['#e2eaf6', '#f7fbff', '#d7e2f2'], 0.8, 3);

  // 回退层：品红/黑棋盘，一眼可辨
  const [fc, fctx] = makeCanvas();
  const cell = TEX_SIZE / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      fctx.fillStyle = (x + y) % 2 === 0 ? '#ff00e6' : '#1a0018';
      fctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  return {
    grass: toTexture(gc),
    rock: toTexture(rc),
    snow: toTexture(sc),
    fallback: toTexture(fc),
  };
}
