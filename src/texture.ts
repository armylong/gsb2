// 程序生成纹理：细线网格 + 棋盘 + 不规则字母块，无需任何外部贴图。
// 同时手工做 2x2 box 缩小的 mip 链，保证缩小层行为可预期、可解释。

export const TEX_BASE = 256;
export const TEX_LEVELS = 9; // 256 -> 1
/** 一张纹理砖在世界坐标里铺多大（平面 X/Z 各占 TILE_WORLD 个单位）。 */
export const TILE_WORLD = 2;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 画一条在 256x256 上可无缝循环的线（把四个周期平移都画一遍）。 */
function wrapLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  for (const ox of [-TEX_BASE, 0, TEX_BASE]) {
    for (const oy of [-TEX_BASE, 0, TEX_BASE]) {
      ctx.beginPath();
      ctx.moveTo(x0 + ox, y0 + oy);
      ctx.lineTo(x1 + ox, y1 + oy);
      ctx.stroke();
    }
  }
}

function paintBase(): ImageData {
  const c = document.createElement('canvas');
  c.width = TEX_BASE;
  c.height = TEX_BASE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const rand = mulberry32(14903);

  // 1) 底色：暖灰瓷砖
  ctx.fillStyle = '#e8e2d6';
  ctx.fillRect(0, 0, TEX_BASE, TEX_BASE);

  // 2) 棋盘（8x8，色差很轻，缩小后仍能看到明暗块）
  const cell = TEX_BASE / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#e8e2d6' : '#d9d2c4';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // 3) 细线：每 32 texel 一道 1px 正交网格（贴边也画，配合 REPEAT 无缝）
  ctx.strokeStyle = 'rgba(60,52,44,0.9)';
  ctx.lineWidth = 1;
  for (let i = 0; i < TEX_BASE; i += 32) {
    wrapLine(ctx, i + 0.5, 0, i + 0.5, TEX_BASE);
    wrapLine(ctx, 0, i + 0.5, TEX_BASE, i + 0.5);
  }

  // 4) 斜向 1px 发丝线（可无缝循环），斜视时最容易闪
  ctx.strokeStyle = 'rgba(40,70,110,0.85)';
  wrapLine(ctx, 0, TEX_BASE * 0.25, TEX_BASE, TEX_BASE * 0.25 + 64);
  wrapLine(ctx, 0, TEX_BASE * 0.75, TEX_BASE, TEX_BASE * 0.75 - 48);

  // 5) 不规则字母块：随机位置/旋转/大小的实心块 + 粗体字母
  const glyphs = 'ABCDEFGHJKMNPQRSTUVWXYZ0123456789#%&';
  for (let i = 0; i < 16; i++) {
    const gx = 26 + rand() * (TEX_BASE - 52);
    const gy = 26 + rand() * (TEX_BASE - 52);
    const size = 13 + rand() * 13;
    const rot = (rand() - 0.5) * 0.5;
    const ch = glyphs[Math.floor(rand() * glyphs.length)];

    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(rot);
    // 不规则底块（矩形宽高随机），留出边距避免跨接缝
    const bw = size * (0.9 + rand() * 0.9);
    const bh = size * (0.9 + rand() * 0.9);
    ctx.fillStyle = rand() > 0.5 ? 'rgba(120,90,60,0.28)' : 'rgba(70,90,120,0.25)';
    ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    // 字母本体
    ctx.fillStyle = '#3a332b';
    ctx.font = `700 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, 1);
    ctx.restore();
  }

  return ctx.getImageData(0, 0, TEX_BASE, TEX_BASE);
}

function boxDown(src: ImageData): ImageData {
  const w = src.width;
  const h = src.height;
  const out = new ImageData(w / 2, h / 2);
  const s = src.data;
  const o = out.data;
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w / 2; x++) {
      const i00 = ((2 * y) * w + 2 * x) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      const k = (y * (w / 2) + x) * 4;
      for (let b = 0; b < 4; b++) {
        o[k + b] = (s[i00 + b] + s[i10 + b] + s[i01 + b] + s[i11 + b]) >> 2;
      }
    }
  }
  return out;
}

export interface GeneratedTexture {
  /** 每一级缩小层的 ImageData，levels[0] 为原始 256×256。 */
  levels: ImageData[];
}

export function generateTexture(): GeneratedTexture {
  const base = paintBase();
  const levels: ImageData[] = [base];
  for (let l = 1; l < TEX_LEVELS; l++) {
    levels.push(boxDown(levels[l - 1]));
  }
  return { levels };
}

/** 第 level 级缩小层上一个 texel 对应的世界尺寸（正方形）。 */
export function texelWorldSize(level: number): number {
  return (TILE_WORLD / TEX_BASE) * 2 ** level;
}

/** LOD 伪色，供调试叠加使用。 */
export function lodDebugColor(level: number): [number, number, number] {
  const palette: [number, number, number][] = [
    [0.25, 0.55, 1.0], // 0 蓝
    [0.2, 0.85, 0.9],
    [0.2, 0.9, 0.55],
    [0.55, 0.9, 0.25],
    [0.9, 0.9, 0.2],
    [1.0, 0.7, 0.2],
    [1.0, 0.45, 0.2],
    [0.95, 0.3, 0.35],
    [0.85, 0.45, 0.95], // 8 紫
  ];
  const l = Math.max(0, Math.min(TEX_LEVELS - 1, Math.round(level)));
  return palette[l];
}
