// Canvas 渲染：只负责把引擎状态画出来，不修改任何游戏状态。
import type { GameState, Piece, Pos } from './engine.js';
import { keyOf } from './engine.js';

export const CELL = 64;
const LAYER_DX = 5;
const LAYER_DY = -5;

export interface Palette {
  paper: string;
  paperEdge: string;
  hole: string;
  grid: string;
  footprint: string;
  target: string;
  preserve: string;
  select: string;
  hover: string;
  bg: string;
  text: string;
}

export const PALETTE: Palette = {
  paper: '#f3e2c0',
  paperEdge: '#b98d4f',
  hole: '#2b2118',
  grid: '#d8d2c4',
  footprint: 'rgba(120,110,90,0.28)',
  target: '#2f7d4f',
  preserve: '#1f5fa8',
  select: '#d4543a',
  hover: 'rgba(212,84,58,0.25)',
  bg: '#f7f3ea',
  text: '#3a3328',
};

/** 每片原始格子固定一个颜色，便于在叠层和展开图中追踪同一张纸 */
export function pieceColor(p: Piece, total: number): string {
  const hue = Math.round((p.id * 47) % 360);
  const sat = 46 + (p.id % 3) * 8;
  const light = 78 - (p.id % 4) * 3;
  void total;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export interface Camera {
  minX: number;
  minY: number;
}

/** 根据当前所有纸格位置（含负坐标）计算可视范围 */
export function computeCamera(s: GameState): Camera {
  let minX = 0;
  let minY = 0;
  for (const k of s.cells.keys()) {
    const [x, y] = k.split(',').map(Number);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  // 留一格边距，容纳层叠阴影偏移
  return { minX: minX - 1, minY: minY - 1 };
}

export function cellToPx(cam: Camera, x: number, y: number): Pos {
  return { x: (x - cam.minX) * CELL, y: (y - cam.minY) * CELL };
}

export function pxToCell(cam: Camera, px: number, py: number): Pos {
  return {
    x: Math.floor(px / CELL) + cam.minX,
    y: Math.floor(py / CELL) + cam.minY,
  };
}

export function canvasSize(s: GameState, cam: Camera): { w: number; h: number } {
  let maxX = s.level.width - 1;
  let maxY = s.level.height - 1;
  for (const k of s.cells.keys()) {
    const [x, y] = k.split(',').map(Number);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    w: (maxX - cam.minX + 2) * CELL,
    h: (maxY - cam.minY + 2) * CELL,
  };
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  fx: 0 | 1,
  fy: 0 | 1,
): void {
  // 用 “↑” 形态随朝向变换：fx 翻转左右，fy 翻转上下
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
  ctx.fillStyle = 'rgba(60,45,25,0.75)';
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(7, 0);
  ctx.lineTo(2.5, 0);
  ctx.lineTo(2.5, 9);
  ctx.lineTo(-2.5, 9);
  ctx.lineTo(-2.5, 0);
  ctx.lineTo(-7, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHole(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.fillStyle = PALETTE.hole;
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(cx - 2.5, cy - 2.5, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 主画布：折叠后的纸面、层序、朝向与孔 */
export function drawFolded(
  ctx: CanvasRenderingContext2D,
  s: GameState,
  cam: Camera,
  selected: Pos | null,
  hover: Pos | null,
): void {
  const size = canvasSize(s, cam);
  ctx.canvas.width = size.w;
  ctx.canvas.height = size.h;
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, size.w, size.h);

  // 原始纸面范围（含负坐标下的偏移）用虚线脚印标出
  ctx.save();
  ctx.strokeStyle = PALETTE.footprint;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  const origin = cellToPx(cam, 0, 0);
  ctx.strokeRect(origin.x, origin.y, s.level.width * CELL, s.level.height * CELL);
  ctx.restore();

  // 目标 / 保留标记画在原始脚印内
  for (const t of s.level.targets) markCell(ctx, cam, t.x, t.y, PALETTE.target, '目');
  for (const t of s.level.preserves) markCell(ctx, cam, t.x, t.y, PALETTE.preserve, '留');

  // 按坐标排序保证绘制稳定
  const keys = [...s.cells.keys()].sort();
  for (const k of keys) {
    const [x, y] = k.split(',').map(Number);
    const stack = s.cells.get(k)!;
    const base = cellToPx(cam, x, y);

    // 每层画一张带错位的纸片，顶层最后画
    stack.forEach((p, i) => {
      const ox = base.x + i * LAYER_DX;
      const oy = base.y + i * LAYER_DY;
      ctx.save();
      ctx.fillStyle = pieceColor(p, stack.length);
      ctx.strokeStyle = PALETTE.paperEdge;
      ctx.lineWidth = 1.2;
      roundedRect(ctx, ox + 2, oy + 2, CELL - 4, CELL - 4, 6);
      ctx.fill();
      ctx.stroke();
      // 原始格编号 + 朝向箭头（小图也能认出每片纸）
      ctx.fillStyle = PALETTE.text;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${p.ox},${p.oy}`, ox + 7, oy + 16);
      drawArrow(ctx, ox + CELL / 2, oy + CELL / 2 + 4, p.fx, p.fy);
      if (p.holed) drawHole(ctx, ox + CELL - 14, oy + CELL - 14);
      ctx.restore();
    });

    // 层序徽标
    const top = base;
    ctx.save();
    ctx.fillStyle = 'rgba(43,33,24,0.82)';
    roundedRect(ctx, top.x + 4, top.y + 22, 46, 18, 5);
    ctx.fill();
    ctx.fillStyle = '#fff4dd';
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${stack.length} 层`, top.x + 27, top.y + 35);
    ctx.restore();
  }

  if (hover && s.cells.has(keyOf(hover.x, hover.y))) {
    const p = cellToPx(cam, hover.x, hover.y);
    ctx.save();
    ctx.fillStyle = PALETTE.hover;
    ctx.fillRect(p.x, p.y, CELL, CELL);
    ctx.restore();
  }
  if (selected) {
    const p = cellToPx(cam, selected.x, selected.y);
    ctx.save();
    ctx.strokeStyle = PALETTE.select;
    ctx.lineWidth = 3;
    ctx.strokeRect(p.x + 1.5, p.y + 1.5, CELL - 3, CELL - 3);
    ctx.restore();
  }
}

function markCell(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  x: number,
  y: number,
  color: string,
  tag: string,
): void {
  const p = cellToPx(cam, x, y);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(p.x + 3, p.y + 3, CELL - 6, CELL - 6);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(tag, p.x + 7, p.y + 14);
  ctx.restore();
}

/** 展开预览：把每片纸按原始格子归位画整张纸（不消耗任何次数） */
export function drawUnfoldPreview(ctx: CanvasRenderingContext2D, s: GameState): void {
  const mini = 40;
  const w = s.level.width * mini;
  const h = s.level.height * mini;
  ctx.canvas.width = w + 2;
  ctx.canvas.height = h + 2;
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w + 2, h + 2);

  const byOrigin = new Map<string, Piece>();
  for (const stacks of s.cells.values()) for (const p of stacks) byOrigin.set(keyOf(p.ox, p.oy), p);

  for (let y = 0; y < s.level.height; y++) {
    for (let x = 0; x < s.level.width; x++) {
      const px = x * mini;
      const py = y * mini;
      const p = byOrigin.get(keyOf(x, y));
      ctx.save();
      ctx.fillStyle = p ? pieceColor(p, 1) : PALETTE.paper;
      ctx.strokeStyle = PALETTE.grid;
      ctx.lineWidth = 1;
      ctx.fillRect(px + 1, py + 1, mini - 2, mini - 2);
      ctx.strokeRect(px + 1, py + 1, mini - 2, mini - 2);
      const isTarget = s.level.targets.some((t) => t.x === x && t.y === y);
      const isPreserve = s.level.preserves.some((t) => t.x === x && t.y === y);
      if (isTarget || isPreserve) {
        ctx.strokeStyle = isTarget ? PALETTE.target : PALETTE.preserve;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(px + 3, py + 3, mini - 6, mini - 6);
        ctx.setLineDash([]);
      }
      if (p?.holed) drawHole(ctx, px + mini / 2, py + mini / 2);
      ctx.restore();
    }
  }
}

/** 侧边逐层小图：选中格的每一摞，自底向上逐片列出 */
export function drawLayerInspector(
  ctx: CanvasRenderingContext2D,
  s: GameState,
  selected: Pos | null,
): void {
  const rowH = 46;
  const width = 190;
  const stack = selected ? s.cells.get(keyOf(selected.x, selected.y)) : undefined;
  const rows = stack?.length ?? 0;
  ctx.canvas.width = width;
  ctx.canvas.height = Math.max(rows * rowH + 12, 60);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  if (!selected || !stack) {
    ctx.fillStyle = PALETTE.text;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('在主图点选一个纸格', 12, 26);
    ctx.fillText('即可逐层查看', 12, 44);
    return;
  }

  ctx.fillStyle = PALETTE.text;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`(${selected.x},${selected.y}) 自底向上：`, 10, 16);

  stack.forEach((p, i) => {
    const top = 24 + i * rowH;
    ctx.save();
    ctx.fillStyle = pieceColor(p, stack.length);
    ctx.strokeStyle = PALETTE.paperEdge;
    roundedRect(ctx, 10, top, 34, 30, 5);
    ctx.fill();
    ctx.stroke();
    drawArrow(ctx, 27, top + 17, p.fx, p.fy);
    if (p.holed) drawHole(ctx, 38, top + 24);
    ctx.fillStyle = PALETTE.text;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(
      `${i === stack.length - 1 ? '顶层' : `第${i + 1}层`} 原(${p.ox},${p.oy})` +
        ` 朝[${p.fx},${p.fy}]${p.holed ? ' ●孔' : ''}`,
      52,
      top + 19,
    );
    ctx.restore();
  });
}

function roundedRect(
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
