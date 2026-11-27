import type { AnimalDef, Species } from '../engine/types';
import { withAlpha, shade } from './util';

/**
 * 手绘感的小动物。全部用 canvas 路径画，不依赖图片。
 * facing: -1 朝左，1 朝右；bob 用来做呼吸起伏。
 */
export function drawAnimal(
  ctx: CanvasRenderingContext2D,
  animal: AnimalDef,
  x: number,
  y: number,
  radius: number,
  opts: { t: number; facing?: number; alpha?: number; glow?: number } = { t: 0 },
) {
  const { t } = opts;
  const facing = opts.facing ?? 1;
  const alpha = opts.alpha ?? 1;
  const bob = Math.sin(t * 2.2 + animal.number) * radius * 0.04;

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y + bob);

  // 影子
  ctx.save();
  ctx.globalAlpha *= 0.18;
  ctx.fillStyle = '#20352c';
  ctx.beginPath();
  ctx.ellipse(0, radius * 0.92, radius * 0.72, radius * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (opts.glow) {
    ctx.save();
    const g = ctx.createRadialGradient(0, 0, radius * 0.4, 0, 0, radius * 1.7);
    g.addColorStop(0, withAlpha(animal.color, 0.45 * opts.glow));
    g.addColorStop(1, withAlpha(animal.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.scale(facing, 1);

  switch (animal.species) {
    case 'turtle':
      drawTurtle(ctx, animal, radius);
      break;
    case 'duck':
      drawDuck(ctx, animal, radius);
      break;
    case 'carp':
      drawCarp(ctx, animal, radius);
      break;
    case 'frog':
      drawFrog(ctx, animal, radius);
      break;
  }

  ctx.restore();
}

function drawTurtle(ctx: CanvasRenderingContext2D, a: AnimalDef, r: number) {
  // 手脚
  ctx.fillStyle = shade(a.color, -0.18);
  for (const [dx, dy, rot] of [
    [-0.55, 0.3, -0.5],
    [0.55, 0.3, 0.5],
    [-0.5, -0.35, -0.7],
    [0.5, -0.35, 0.7],
  ] as const) {
    ctx.save();
    ctx.translate(dx * r, dy * r);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.24, r * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // 头
  ctx.fillStyle = shade(a.color, 0.12);
  ctx.beginPath();
  ctx.ellipse(r * 0.74, -r * 0.08, r * 0.28, r * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = a.ink;
  ctx.beginPath();
  ctx.arc(r * 0.86, -r * 0.14, r * 0.045, 0, Math.PI * 2);
  ctx.fill();
  // 壳
  const g = ctx.createRadialGradient(-r * 0.2, -r * 0.25, r * 0.1, 0, 0, r * 0.9);
  g.addColorStop(0, shade(a.color, 0.28));
  g.addColorStop(1, a.color);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.76, r * 0.64, 0, 0, Math.PI * 2);
  ctx.fill();
  // 壳纹
  ctx.strokeStyle = withAlpha(a.ink, 0.5);
  ctx.lineWidth = Math.max(1, r * 0.05);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(0, 0, r * (0.26 + i * 0.16), Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.6);
  ctx.lineTo(0, r * 0.6);
  ctx.stroke();
}

function drawDuck(ctx: CanvasRenderingContext2D, a: AnimalDef, r: number) {
  // 身体
  const g = ctx.createLinearGradient(0, -r * 0.7, 0, r * 0.7);
  g.addColorStop(0, shade(a.color, 0.3));
  g.addColorStop(1, shade(a.color, -0.08));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(-r * 0.08, r * 0.2, r * 0.68, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // 尾巴
  ctx.beginPath();
  ctx.moveTo(-r * 0.62, r * 0.05);
  ctx.quadraticCurveTo(-r * 0.98, -r * 0.1, -r * 0.7, -r * 0.32);
  ctx.quadraticCurveTo(-r * 0.6, -r * 0.02, -r * 0.62, r * 0.05);
  ctx.fill();
  // 头
  ctx.fillStyle = shade(a.color, 0.16);
  ctx.beginPath();
  ctx.arc(r * 0.32, -r * 0.42, r * 0.34, 0, Math.PI * 2);
  ctx.fill();
  // 嘴
  ctx.fillStyle = '#e8892f';
  ctx.beginPath();
  ctx.moveTo(r * 0.58, -r * 0.4);
  ctx.quadraticCurveTo(r * 0.98, -r * 0.34, r * 0.62, -r * 0.22);
  ctx.closePath();
  ctx.fill();
  // 眼
  ctx.fillStyle = a.ink;
  ctx.beginPath();
  ctx.arc(r * 0.42, -r * 0.5, r * 0.055, 0, Math.PI * 2);
  ctx.fill();
  // 翅膀
  ctx.strokeStyle = withAlpha(a.ink, 0.35);
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.beginPath();
  ctx.arc(-r * 0.16, r * 0.16, r * 0.34, -0.2, Math.PI * 0.9);
  ctx.stroke();
}

function drawCarp(ctx: CanvasRenderingContext2D, a: AnimalDef, r: number) {
  const g = ctx.createLinearGradient(-r * 0.7, 0, r * 0.7, 0);
  g.addColorStop(0, shade(a.color, -0.1));
  g.addColorStop(0.55, shade(a.color, 0.25));
  g.addColorStop(1, shade(a.color, 0.45));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.76, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // 尾
  ctx.fillStyle = withAlpha(a.color, 0.85);
  ctx.beginPath();
  ctx.moveTo(-r * 0.66, 0);
  ctx.lineTo(-r * 1.02, -r * 0.34);
  ctx.lineTo(-r * 0.88, 0);
  ctx.lineTo(-r * 1.02, r * 0.34);
  ctx.closePath();
  ctx.fill();
  // 背鳍
  ctx.beginPath();
  ctx.moveTo(-r * 0.2, -r * 0.36);
  ctx.quadraticCurveTo(r * 0.05, -r * 0.66, r * 0.32, -r * 0.3);
  ctx.closePath();
  ctx.fill();
  // 鳞
  ctx.strokeStyle = withAlpha('#fff7e6', 0.5);
  ctx.lineWidth = Math.max(1, r * 0.04);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(-r * 0.34 + i * r * 0.26, 0, r * 0.16, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.stroke();
  }
  // 眼
  ctx.fillStyle = a.ink;
  ctx.beginPath();
  ctx.arc(r * 0.5, -r * 0.1, r * 0.06, 0, Math.PI * 2);
  ctx.fill();
}

function drawFrog(ctx: CanvasRenderingContext2D, a: AnimalDef, r: number) {
  // 后腿
  ctx.fillStyle = shade(a.color, -0.16);
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * r * 0.52, r * 0.34, r * 0.26, r * 0.16, s * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // 身体
  const g = ctx.createRadialGradient(-r * 0.15, -r * 0.25, r * 0.1, 0, 0, r * 0.85);
  g.addColorStop(0, shade(a.color, 0.3));
  g.addColorStop(1, a.color);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, r * 0.1, r * 0.6, r * 0.44, 0, 0, Math.PI * 2);
  ctx.fill();
  // 眼睛
  for (const s of [-1, 1]) {
    ctx.fillStyle = shade(a.color, 0.18);
    ctx.beginPath();
    ctx.arc(s * r * 0.28, -r * 0.34, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f7f3e6';
    ctx.beginPath();
    ctx.arc(s * r * 0.28, -r * 0.36, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = a.ink;
    ctx.beginPath();
    ctx.arc(s * r * 0.28, -r * 0.37, r * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  // 嘴
  ctx.strokeStyle = withAlpha(a.ink, 0.6);
  ctx.lineWidth = Math.max(1, r * 0.045);
  ctx.beginPath();
  ctx.arc(0, r * 0.06, r * 0.22, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
}

/** 关卡选择 / 图鉴里的剪影。 */
export function drawSilhouette(
  ctx: CanvasRenderingContext2D,
  species: Species,
  x: number,
  y: number,
  r: number,
  color: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  switch (species) {
    case 'turtle':
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.7, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r * 0.66, 0, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'duck':
      ctx.beginPath();
      ctx.ellipse(-r * 0.05, r * 0.15, r * 0.6, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r * 0.32, -r * 0.36, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'carp':
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.7, r * 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.6, 0);
      ctx.lineTo(-r * 0.98, -r * 0.3);
      ctx.lineTo(-r * 0.8, 0);
      ctx.lineTo(-r * 0.98, r * 0.3);
      ctx.closePath();
      ctx.fill();
      break;
    case 'frog':
      ctx.beginPath();
      ctx.ellipse(0, r * 0.1, r * 0.55, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-r * 0.26, -r * 0.3, r * 0.18, 0, Math.PI * 2);
      ctx.arc(r * 0.26, -r * 0.3, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  ctx.restore();
}
