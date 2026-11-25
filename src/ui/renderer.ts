import { colorCss, colorName } from '../engine/colors.js';
import { flowerAt, panelAt } from '../engine/engine.js';
import {
  Board,
  Cell,
  DIRECTION_VECTORS,
  STABLE_TURNS,
  TraceStep,
  TurnReport,
  Wind,
} from '../engine/types.js';

export const CELL = 80;
export const PAD = 90;

/** 像素坐标 -> 格子坐标，点在棋盘外返回 null */
export function pixelToCell(board: Board, px: number, py: number): Cell | null {
  const x = Math.floor((px - PAD) / CELL);
  const y = Math.floor((py - PAD) / CELL);
  if (x < 0 || y < 0 || x >= board.width || y >= board.height) return null;
  return { x, y };
}

function center(x: number, y: number): { cx: number; cy: number } {
  return { cx: PAD + x * CELL + CELL / 2, cy: PAD + y * CELL + CELL / 2 };
}

function drawGrid(ctx: CanvasRenderingContext2D, board: Board) {
  ctx.fillStyle = '#fbf8f0';
  ctx.fillRect(PAD, PAD, board.width * CELL, board.height * CELL);
  ctx.strokeStyle = '#e0d9c8';
  ctx.lineWidth = 1;
  for (let x = 0; x <= board.width; x += 1) {
    ctx.beginPath();
    ctx.moveTo(PAD + x * CELL, PAD);
    ctx.lineTo(PAD + x * CELL, PAD + board.height * CELL);
    ctx.stroke();
  }
  for (let y = 0; y <= board.height; y += 1) {
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + y * CELL);
    ctx.lineTo(PAD + board.width * CELL, PAD + y * CELL);
    ctx.stroke();
  }
}

function drawWind(ctx: CanvasRenderingContext2D, wind: Wind) {
  const { cx, cy } = center(wind.from.x, wind.from.y);
  const v = DIRECTION_VECTORS[wind.dir];
  // 从花朵边缘外侧起笔，避免被花瓣盖住
  const startR = 27;
  const length = wind.kind === 'gale' ? 24 : 16;
  const sx = cx + v.dx * startR;
  const sy = cy + v.dy * startR;
  const ex = sx + v.dx * length;
  const ey = sy + v.dy * length;

  ctx.save();
  ctx.strokeStyle = '#5d6b62';
  ctx.fillStyle = '#5d6b62';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  // 箭头头部
  const angle = Math.atan2(v.dy, v.dx);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - 8 * Math.cos(angle - Math.PI / 6), ey - 8 * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(ex - 8 * Math.cos(angle + Math.PI / 6), ey - 8 * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();

  // 风种标记：疾风两条尾羽、微风一条
  ctx.lineWidth = 1.5;
  const perpX = -v.dy;
  const perpY = v.dx;
  const feathers = wind.kind === 'gale' ? 2 : 1;
  for (let i = 0; i < feathers; i += 1) {
    const k = 4 + i * 6;
    ctx.beginPath();
    ctx.moveTo(sx + v.dx * k, sy + v.dy * k);
    ctx.lineTo(sx + v.dx * k + perpX * 6 + v.dx * 3, sy + v.dy * k + perpY * 6 + v.dy * 3);
    ctx.stroke();
  }

  // 风种文字（带底色，避免压在花粉线上）
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = wind.kind === 'gale' ? '疾' : '微';
  const lx = sx + perpX * 17;
  const ly = sy + perpY * 17;
  ctx.fillStyle = '#fbf8f0';
  ctx.fillRect(lx - 7, ly - 7, 14, 14);
  ctx.fillStyle = '#5d6b62';
  ctx.fillText(label, lx, ly + 0.5);
  ctx.restore();
}

function drawPanel(ctx: CanvasRenderingContext2D, x: number, y: number, selected: boolean) {
  const { cx, cy } = center(x, y);
  ctx.save();
  ctx.fillStyle = selected ? '#b0793a' : '#8a6a45';
  ctx.strokeStyle = selected ? '#e0a85e' : '#6b5233';
  ctx.lineWidth = selected ? 3 : 2;
  const w = CELL * 0.42;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - w / 2, w, w, 6);
  ctx.fill();
  ctx.stroke();
  // 斜纹
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  for (let i = -1; i <= 1; i += 1) {
    ctx.beginPath();
    ctx.moveTo(cx - w / 2 + 8, cy + i * 9 + 6);
    ctx.lineTo(cx + w / 2 - 8, cy + i * 9 - 6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFlower(
  ctx: CanvasRenderingContext2D,
  board: Board,
  flowerId: string,
  x: number,
  y: number,
  color: number,
  pendingColor: number,
  progress: number,
  selected: boolean,
) {
  const { cx, cy } = center(x, y);
  const r = 22;
  ctx.save();

  // 花瓣：稳定颜色
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = colorCss(color);
  ctx.fill();
  ctx.strokeStyle = selected ? '#d65a3f' : '#5a665d';
  ctx.lineWidth = selected ? 3.5 : 2;
  ctx.stroke();

  // 花心：正在积累的颜色（半透明），稳定后变白
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fillStyle = pendingColor === 0 ? '#fffdf6' : colorCss(pendingColor);
  ctx.globalAlpha = pendingColor === 0 ? 1 : 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 连续积累进度小格（3 格），画在花朵下方
  const pipW = 9;
  const gap = 4;
  const totalW = STABLE_TURNS * pipW + (STABLE_TURNS - 1) * gap;
  for (let i = 0; i < STABLE_TURNS; i += 1) {
    ctx.fillStyle = i < progress ? '#3f7fd6' : '#e4ddcd';
    ctx.fillRect(cx - totalW / 2 + i * (pipW + gap), cy + r + 5, pipW, 5);
  }

  // id 标签
  ctx.fillStyle = '#6b766e';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(flowerId, cx, cy - r - 7);
  ctx.restore();
}

interface TraceDraw {
  steps: TraceStep[];
  delivered: boolean;
  color: number;
  preview: boolean;
}

function drawTrace(ctx: CanvasRenderingContext2D, from: Cell, trace: TraceDraw) {
  const start = center(from.x, from.y);
  ctx.save();
  ctx.strokeStyle = trace.color === 0 ? '#b6b0a2' : colorCss(trace.color);
  ctx.globalAlpha = trace.preview ? 0.55 : 0.9;
  ctx.lineWidth = trace.preview ? 3 : 4;
  ctx.setLineDash(trace.preview ? [7, 6] : []);
  ctx.beginPath();
  ctx.moveTo(start.cx, start.cy);
  for (const step of trace.steps) {
    const p = center(step.x, step.y);
    ctx.lineTo(p.cx, p.cy);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 拦截点画叉
  const blockedStep = trace.steps.find((s) => s.blocked);
  if (blockedStep) {
    const p = center(blockedStep.x, blockedStep.y);
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.cx - 9, p.cy - 9);
    ctx.lineTo(p.cx + 9, p.cy + 9);
    ctx.moveTo(p.cx + 9, p.cy - 9);
    ctx.lineTo(p.cx - 9, p.cy + 9);
    ctx.stroke();
  }
  ctx.restore();
}

export interface RenderOptions {
  /** 执行后的上一轮报告（画实线实际路径） */
  lastReport: TurnReport | null;
  /** 本轮预看报告（画虚线预测路径） */
  preview: TurnReport | null;
  selectedPanelId: string | null;
  selectedFlowerId: string | null;
  hoverCell: Cell | null;
}

export function render(ctx: CanvasRenderingContext2D, board: Board, options: RenderOptions) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  drawGrid(ctx, board);

  // 悬停且可放置的目标格高亮
  if (options.hoverCell && options.selectedPanelId) {
    const { x, y } = options.hoverCell;
    const ok = !flowerAt(board, x, y) && !panelAt(board, x, y);
    ctx.save();
    ctx.fillStyle = ok ? 'rgba(63,127,214,0.18)' : 'rgba(192,57,43,0.18)';
    ctx.fillRect(PAD + x * CELL, PAD + y * CELL, CELL, CELL);
    ctx.restore();
  }

  // 路径：先预看（虚线），再实际（实线）
  if (options.preview) {
    for (const wind of board.winds) {
      const trace = options.preview.traces.find((t) => t.windId === wind.id);
      if (!trace) continue;
      const source = flowerAt(board, wind.from.x, wind.from.y);
      drawTrace(ctx, wind.from, {
        steps: trace.steps,
        delivered: trace.delivered,
        color: source?.color ?? 0,
        preview: true,
      });
    }
  }
  if (options.lastReport) {
    for (const wind of board.winds) {
      const trace = options.lastReport.traces.find((t) => t.windId === wind.id);
      if (!trace || !trace.delivered) continue;
      const detail = options.lastReport.details
        .flatMap((d) => d.arrivals)
        .find((a) => a.windId === wind.id);
      drawTrace(ctx, wind.from, {
        steps: trace.steps,
        delivered: true,
        color: detail?.sourceColor ?? 0,
        preview: false,
      });
    }
  }

  for (const wind of board.winds) drawWind(ctx, wind);
  for (const panel of board.panels) {
    drawPanel(ctx, panel.x, panel.y, panel.id === options.selectedPanelId);
  }
  for (const flower of board.flowers) {
    drawFlower(
      ctx,
      board,
      flower.id,
      flower.x,
      flower.y,
      flower.color,
      flower.pendingColor,
      flower.progress,
      flower.id === options.selectedFlowerId,
    );
  }
}

export { colorName };
