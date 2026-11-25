/**
 * 程序化横向测试图。
 * 图案本身由纯函数 samplePattern 定义(不依赖 DOM, Node 验证脚本可直接调用),
 * drawPattern 用 Canvas 画出同样的内容并额外叠加文字标注。
 */

export const PATTERN_W = 1600;
export const PATTERN_H = 600;
export const CELL = 50;
export const MAJOR = 200;
export const HEADER_H = 40;
export const RAMP_GRAY_Y = 520;
export const RAMP_RGB_Y = 560;

export type RGB = [number, number, number];

const MAJOR_COLORS: RGB[] = [
  [220, 40, 40],
  [40, 170, 40],
  [40, 80, 220],
  [25, 25, 25],
];

function smoothBand(dist: number, halfWidth: number): boolean {
  return Math.abs(dist) <= halfWidth;
}

/** 纯函数: 取测试图在 (x,y) 处的颜色, 0..255。越界返回黑色。 */
export function samplePattern(x: number, y: number): RGB {
  if (x < 0 || y < 0 || x >= PATTERN_W || y >= PATTERN_H) return [0, 0, 0];

  // ---- 底层棋盘格(每格交替底色, 变形时格子形状一目了然) ----
  const col = Math.floor(x / CELL);
  const row = Math.floor(y / CELL);
  let r: number = (col + row) % 2 === 0 ? 255 : 236;
  let g = r;
  let b = r;

  // ---- 顶部标题带(文字仅在 canvas 绘制时叠加) ----
  if (y < HEADER_H) {
    r = 208;
    g = 214;
    b = 224;
  }

  // ---- 底部两条亮度 ramp: 灰度 + 红绿 ----
  if (y >= RAMP_GRAY_Y && y < RAMP_RGB_Y) {
    const v = Math.round((x / (PATTERN_W - 1)) * 255);
    return [v, v, v];
  }
  if (y >= RAMP_RGB_Y) {
    return [
      Math.round((x / (PATTERN_W - 1)) * 255),
      Math.round((1 - x / (PATTERN_W - 1)) * 255),
      128,
    ];
  }

  // ---- 基准点(每 200px 一个, 中线 y=300): 白盘 + 黑色十字 + 环 ----
  const fx = MAJOR / 2 + Math.floor(x / MAJOR) * MAJOR;
  const dx = x - fx;
  const dy = y - PATTERN_H / 2;
  const dist = Math.hypot(dx, dy);
  if (dist <= 26) {
    r = 255; g = 255; b = 255;
    if (smoothBand(dx, 2) || smoothBand(dy, 2)) {
      r = 15; g = 15; b = 15;
    }
    if (dist >= 22 && dist <= 25) {
      r = 15; g = 15; b = 15;
    }
  }

  // ---- 细网格线(50px, 灰) ----
  const gx = x % CELL;
  const gy = y % CELL;
  if (gx < 2 || gy < 2) {
    r = 95; g = 95; b = 95;
  }

  // ---- 主网格线(200px, 彩色循环, 用于跨交界对齐辨认) ----
  if (gx < 4 && col % (MAJOR / CELL) === 0) {
    [r, g, b] = MAJOR_COLORS[Math.floor(x / MAJOR) % 4];
  }
  if (y >= HEADER_H && Math.abs(y - 200) < 3) {
    r = 200; g = 110; b = 20;
  }

  // ---- 外边框 ----
  if (x < 4 || y < 4 || x >= PATTERN_W - 4 || y >= PATTERN_H - 4) {
    r = 10; g = 10; b = 10;
  }

  return [r, g, b];
}

/** 双线性采样(亚像素, 供透视映射使用) */
export function samplePatternBilinear(x: number, y: number): RGB {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const p00 = samplePattern(x0, y0);
  const p10 = samplePattern(x0 + 1, y0);
  const p01 = samplePattern(x0, y0 + 1);
  const p11 = samplePattern(x0 + 1, y0 + 1);
  const out: RGB = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const top = p00[k] * (1 - tx) + p10[k] * tx;
    const bot = p01[k] * (1 - tx) + p11[k] * tx;
    out[k] = Math.round(top * (1 - ty) + bot * ty);
  }
  return out;
}

/** 在 canvas 上绘制完整测试图(含文字)。目标画布尺寸应为 PATTERN_W × PATTERN_H。 */
export function drawPattern(ctx: CanvasRenderingContext2D): void {
  const img = ctx.createImageData(PATTERN_W, PATTERN_H);
  for (let y = 0; y < PATTERN_H; y++) {
    for (let x = 0; x < PATTERN_W; x++) {
      const [r, g, b] = samplePattern(x, y);
      const i = (y * PATTERN_W + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // ---- 文字标注层 ----
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a2233';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`横向拼接测试图  ${PATTERN_W}×${PATTERN_H}  格距 ${CELL}px`, 12, HEADER_H / 2);

  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  // 每格写列号/行号, 变形后数字是否扭曲可直接肉眼判断
  for (let c = 0; c < PATTERN_W / CELL; c++) {
    for (let rw = 0; rw < (RAMP_GRAY_Y - HEADER_H) / CELL; rw++) {
      const cx = c * CELL + CELL / 2;
      const cy = HEADER_H + rw * CELL + CELL / 2;
      ctx.fillStyle = (c + rw) % 2 === 0 ? 'rgba(40,40,40,0.55)' : 'rgba(40,40,40,0.8)';
      ctx.fillText(`${c},${rw}`, cx, cy);
    }
  }
  // 主网格线坐标标签
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  for (let k = 0; k < PATTERN_W / MAJOR; k++) {
    const x = k * MAJOR;
    ctx.fillStyle = 'rgba(20,20,20,0.9)';
    ctx.fillText(`x=${x}`, x + MAJOR / 2 - 60, HEADER_H + 16);
  }
}
