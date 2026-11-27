import * as THREE from 'three';

/**
 * 所有牌面都由 Canvas2D 本地绘制，不依赖任何外部图片。
 * 通过不同的图形形状、横排/竖排文字、箭头方向构造“方向各不相同”的牌。
 */

export type GlyphShape =
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-up'
  | 'triangle'
  | 'circle'
  | 'cross'
  | 'chevron';

export interface SignTextureSpec {
  title: string;
  subtitle: string;
  /** 主背景色 */
  bg: string;
  /** 图形与强调色 */
  accent: string;
  shape: GlyphShape;
  /** 竖排标题（文字方向变体） */
  verticalTitle: boolean;
  /** 牌面整体翻转（图形/文字朝左的变体） */
  flip: boolean;
  /** 画布逻辑宽高（像素），默认 512x256 */
  width?: number;
  height?: number;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: GlyphShape,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const s = size;
  switch (shape) {
    case 'arrow-right':
    case 'arrow-left': {
      const dir = shape === 'arrow-right' ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx - dir * s * 0.45, cy - s * 0.18);
      ctx.lineTo(cx + dir * s * 0.12, cy - s * 0.18);
      ctx.lineTo(cx + dir * s * 0.12, cy - s * 0.38);
      ctx.lineTo(cx + dir * s * 0.5, cy);
      ctx.lineTo(cx + dir * s * 0.12, cy + s * 0.38);
      ctx.lineTo(cx + dir * s * 0.12, cy + s * 0.18);
      ctx.lineTo(cx - dir * s * 0.45, cy + s * 0.18);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'arrow-up':
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.5);
      ctx.lineTo(cx + s * 0.38, cy - s * 0.08);
      ctx.lineTo(cx + s * 0.18, cy - s * 0.08);
      ctx.lineTo(cx + s * 0.18, cy + s * 0.45);
      ctx.lineTo(cx - s * 0.18, cy + s * 0.45);
      ctx.lineTo(cx - s * 0.18, cy - s * 0.08);
      ctx.lineTo(cx - s * 0.38, cy - s * 0.08);
      ctx.closePath();
      ctx.fill();
      break;
    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.48);
      ctx.lineTo(cx + s * 0.46, cy + s * 0.4);
      ctx.lineTo(cx - s * 0.46, cy + s * 0.4);
      ctx.closePath();
      ctx.lineWidth = s * 0.1;
      ctx.stroke();
      ctx.font = `bold ${s * 0.45}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', cx, cy + s * 0.08);
      break;
    case 'circle':
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2);
      ctx.lineWidth = s * 0.12;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'cross':
      ctx.lineWidth = s * 0.22;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.32, cy - s * 0.32);
      ctx.lineTo(cx + s * 0.32, cy + s * 0.32);
      ctx.moveTo(cx + s * 0.32, cy - s * 0.32);
      ctx.lineTo(cx - s * 0.32, cy + s * 0.32);
      ctx.stroke();
      break;
    case 'chevron':
      ctx.lineWidth = s * 0.16;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.35, cy - s * 0.3);
      ctx.lineTo(cx + s * 0.05, cy);
      ctx.lineTo(cx - s * 0.35, cy + s * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.3);
      ctx.lineTo(cx + s * 0.4, cy);
      ctx.lineTo(cx, cy + s * 0.3);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

export function makeSignTexture(spec: SignTextureSpec): THREE.CanvasTexture {
  const W = spec.width ?? 512;
  const H = spec.height ?? 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.save();
  if (spec.flip) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }

  // 底板
  roundRect(ctx, 8, 8, W - 16, H - 16, 28);
  ctx.fillStyle = spec.bg;
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();

  // 左侧图形区
  const iconCx = spec.verticalTitle ? W * 0.5 : W * 0.24;
  const iconCy = spec.verticalTitle ? H * 0.28 : H * 0.5;
  drawShape(ctx, spec.shape, iconCx, iconCy, H * 0.62, spec.accent);

  // 文字
  ctx.fillStyle = '#ffffff';
  if (spec.verticalTitle) {
    // 竖排：逐字向下堆叠
    ctx.font = `bold ${H * 0.2}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const chars = [...spec.title];
    const startY = H * 0.52;
    const step = H * 0.21;
    chars.forEach((ch, i) => {
      ctx.fillText(ch, W * 0.5, startY + i * step);
    });
  } else {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${H * 0.3}px sans-serif`;
    ctx.fillText(spec.title, W * 0.44, H * 0.38);
    ctx.font = `${H * 0.15}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillText(spec.subtitle, W * 0.44, H * 0.68);
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
