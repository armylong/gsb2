import { HEIGHT, WIDTH, keyOf } from '../grid.ts';
import type { CellContent, Layout } from '../layout.ts';
import { stateAmount, type AmountTable } from '../sim.ts';

/**
 * 两个介质层的固定视觉量程。使用固定量程（而非按轮次自动缩放），
 * 这样不同轮次、不同分支之间的颜色可以直接比较。
 */
const CAP: Record<'heat' | 'fog', number> = { heat: 20_000, fog: 20_000 };

/** 低浓度段抬高、高浓度段压缩：既保留排序，又不让微量介质完全看不见。 */
const TINT_MAX = 0.26;

export const COLORS = {
  surface: '#1a1a19',
  cell: '#1f1f1e',
  gridline: '#2c2c2a',
  ink: '#f0efec',
  secondary: '#c3c2b7',
  muted: '#898781',
  heat: '#d95926',
  fog: '#3987e5',
  warning: '#fab219',
  critical: '#d03b3b',
  wall: '#3a3a37',
  wallLine: '#2a2a28',
} as const;

export interface Selection {
  x: number;
  y: number;
}

export interface RenderInput {
  layout: Layout;
  state: AmountTable;
  selection: Selection | null;
  hover: Selection | null;
  pendingValve: Selection | null;
  focus: ReadonlyArray<{ x: number; y: number; label: string }>;
  showFocus: boolean;
}

export interface GridMetrics {
  cell: number;
  pad: number;
  w: number;
  h: number;
}

export const PAD = 14;

export function metricsFor(availableWidth: number): GridMetrics {
  const cell = Math.max(26, Math.min(56, Math.floor((availableWidth - PAD * 2) / WIDTH)));
  return { cell, pad: PAD, w: cell * WIDTH + PAD * 2, h: cell * HEIGHT + PAD * 2 };
}

export function cellAtPoint(
  px: number,
  py: number,
  metrics: GridMetrics,
): { x: number; y: number } | null {
  const x = Math.floor((px - metrics.pad) / metrics.cell);
  const y = Math.floor((py - metrics.pad) / metrics.cell);
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return null;
  return { x, y };
}

function intensity(value: number, medium: 'heat' | 'fog'): number {
  if (value <= 0) return 0;
  const ratio = Math.min(1, value / CAP[medium]);
  return Math.pow(ratio, 0.42);
}

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/** 主渲染入口：所有绘制都只依赖入参，不做任何隐藏的缓存或状态。 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  metrics: GridMetrics,
  input: RenderInput,
): void {
  ctx.clearRect(0, 0, metrics.w, metrics.h);
  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(0, 0, metrics.w, metrics.h);
  drawGridlines(ctx, metrics, input.layout);
  drawMediumBars(ctx, metrics, input);
  drawWalls(ctx, metrics, input.layout);
  drawValves(ctx, metrics, input);
  drawGlyphs(ctx, metrics, input.layout);
  drawFocus(ctx, metrics, input);
  drawSelection(ctx, metrics, input);
}

function drawGridlines(
  ctx: CanvasRenderingContext2D,
  metrics: GridMetrics,
  layout: Layout,
): void {
  const { cell, pad } = metrics;
  ctx.strokeStyle = COLORS.gridline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= WIDTH; x += 1) {
    const px = Math.round(pad + x * cell) + 0.5;
    ctx.moveTo(px, pad);
    ctx.lineTo(px, pad + HEIGHT * cell);
  }
  for (let y = 0; y <= HEIGHT; y += 1) {
    const py = Math.round(pad + y * cell) + 0.5;
    ctx.moveTo(pad, py);
    ctx.lineTo(pad + WIDTH * cell, py);
  }
  ctx.stroke();

  // 可通行格底色；墙格由 drawWalls 覆盖
  ctx.fillStyle = COLORS.cell;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (layout.isPassable(x, y)) {
        ctx.fillRect(pad + x * cell + 1, pad + y * cell + 1, cell - 1, cell - 1);
      }
    }
  }
}

/**
 * 每个格子画两条竖带：左蓝=雾，右橙=热；高度按固定量程开方缩放。
 * 双介质同时在格内时也不会互相遮盖，便于核对计量。
 */
function drawMediumBars(
  ctx: CanvasRenderingContext2D,
  metrics: GridMetrics,
  input: RenderInput,
): void {
  const { cell, pad } = metrics;
  const inset = Math.max(3, cell * 0.1);
  const gap = Math.max(2, cell * 0.05);
  const innerW = cell - inset * 2;
  const bandW = (innerW - gap) / 2;
  const innerH = cell - inset * 2;
  const baseY = pad + inset;

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const key = keyOf(x, y);
      const heat = stateAmount(input.state, key, 'heat');
      const fog = stateAmount(input.state, key, 'fog');
      if (heat === 0 && fog === 0) continue;
      const left = pad + x * cell + inset;
      const top = baseY + y * cell;

      const heatA = intensity(heat, 'heat');
      const fogA = intensity(fog, 'fog');
      // 整格淡彩：提示该格以哪种介质为主
      ctx.fillStyle = withAlpha(
        heatA >= fogA ? COLORS.heat : COLORS.fog,
        TINT_MAX * Math.max(heatA, fogA),
      );
      ctx.fillRect(left - 2, top - 2, innerW + 4, innerH + 4);

      for (const [medium, value, dx] of [
        ['fog', fogA, 0],
        ['heat', heatA, bandW + gap],
      ] as const) {
        if (value <= 0) continue;
        const barH = Math.max(2, innerH * value);
        const bx = left + dx;
        const by = top + innerH - barH;
        ctx.fillStyle = medium === 'fog' ? COLORS.fog : COLORS.heat;
        roundedRect(ctx, bx, by, bandW, barH, Math.min(3, bandW / 2));
        ctx.fill();
      }
    }
  }
}

function drawWalls(ctx: CanvasRenderingContext2D, metrics: GridMetrics, layout: Layout): void {
  const { cell, pad } = metrics;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const content = layout.getCell(x, y);
      if (content?.kind !== 'wall') continue;
      const px = pad + x * cell;
      const py = pad + y * cell;
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px + 1, py + 1, cell - 1, cell - 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(px + 1, py + 1, cell - 1, cell - 1);
      ctx.clip();
      ctx.strokeStyle = COLORS.wallLine;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let d = -cell; d < cell * 2; d += Math.max(7, cell / 4)) {
        ctx.moveTo(px + d, py);
        ctx.lineTo(px + d + cell, py + cell);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawGlyphs(ctx: CanvasRenderingContext2D, metrics: GridMetrics, layout: Layout): void {
  const { cell, pad } = metrics;
  const r = Math.max(6, cell * 0.18);
  for (const { x, y, content } of layout.sortedCells()) {
    const cx = pad + x * cell + cell / 2;
    const cy = pad + y * cell + cell / 2;
    if (content.kind === 'source') {
      ctx.beginPath();
      ctx.arc(cx + (content.medium === 'heat' ? cell * 0.17 : -cell * 0.17), cy, r, 0, Math.PI * 2);
      ctx.fillStyle = content.medium === 'heat' ? COLORS.heat : COLORS.fog;
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = COLORS.ink;
      ctx.font = `600 ${Math.max(9, Math.round(cell * 0.22))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(content.medium === 'heat' ? 'H' : 'F', cx + (content.medium === 'heat' ? cell * 0.17 : -cell * 0.17), cy + 0.5);
    } else if (content.kind === 'vent') {
      const color =
        content.medium === 'both' ? COLORS.secondary : content.medium === 'heat' ? COLORS.heat : COLORS.fog;
      ctx.strokeStyle = content.open ? color : COLORS.muted;
      ctx.lineWidth = 1.5;
      const size = cell * 0.34;
      ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
      ctx.beginPath();
      for (let i = 1; i <= 3; i += 1) {
        const yy = cy - size / 2 + (size * i) / 4;
        ctx.moveTo(cx - size / 2, yy);
        ctx.lineTo(cx + size / 2, yy);
      }
      ctx.stroke();
      if (!content.open) {
        ctx.strokeStyle = COLORS.critical;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - size / 2, cy - size / 2);
        ctx.lineTo(cx + size / 2, cy + size / 2);
        ctx.stroke();
      }
    }
  }
}

function drawValves(ctx: CanvasRenderingContext2D, metrics: GridMetrics, input: RenderInput): void {
  const { cell, pad } = metrics;
  for (const valve of input.layout.getValves()) {
    const [ax, ay] = valve.a.split(',').map(Number) as [number, number];
    const [bx, by] = valve.b.split(',').map(Number) as [number, number];
    const acx = pad + ax * cell + cell / 2;
    const acy = pad + ay * cell + cell / 2;
    const bcx = pad + bx * cell + cell / 2;
    const bcy = pad + by * cell + cell / 2;
    // 边中点
    const mx = (acx + bcx) / 2;
    const my = (acy + bcy) / 2;
    const len = cell * 0.5;
    const ux = (bcx - acx) / cell;
    const uy = (bcy - acy) / cell;
    const fromToB = valve.allowAtoB;
    const dirX = fromToB ? ux : -ux;
    const dirY = fromToB ? uy : -uy;

    ctx.strokeStyle = COLORS.secondary;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx - ux * (len / 2), my - uy * (len / 2));
    ctx.lineTo(mx + ux * (len / 2), my + uy * (len / 2));
    ctx.stroke();

    ctx.fillStyle = COLORS.secondary;
    ctx.beginPath();
    ctx.moveTo(mx + dirX * (len / 2) + dirX * 4, my + dirY * (len / 2) + dirY * 4);
    ctx.lineTo(mx + dirX * (len / 2) - dirY * 5 - dirX * 4, my + dirY * (len / 2) + dirX * 5 - dirY * 4);
    ctx.lineTo(mx + dirX * (len / 2) + dirY * 5 - dirX * 4, my + dirY * (len / 2) - dirX * 5 - dirY * 4);
    ctx.closePath();
    ctx.fill();
  }

  if (input.pendingValve) {
    const { x, y } = input.pendingValve;
    const cx = pad + x * cell + cell / 2;
    const cy = pad + y * cell + cell / 2;
    ctx.strokeStyle = COLORS.warning;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawFocus(ctx: CanvasRenderingContext2D, metrics: GridMetrics, input: RenderInput): void {
  if (!input.showFocus || input.focus.length === 0) return;
  const { cell, pad } = metrics;
  ctx.font = `500 ${Math.max(9, Math.round(cell * 0.2))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const item of input.focus) {
    const cx = pad + item.x * cell + cell / 2;
    const cy = pad + item.y * cell;
    ctx.fillStyle = COLORS.ink;
    const text = item.label;
    const width = ctx.measureText(text).width + 8;
    const bx = Math.max(pad, Math.min(metrics.w - pad - width, cx - width / 2));
    ctx.fillStyle = withAlpha('#0d0d0d', 0.85);
    roundedRect(ctx, bx, cy - 16, width, 15, 4);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(text, bx + width / 2, cy - 3);
  }
}

function drawSelection(ctx: CanvasRenderingContext2D, metrics: GridMetrics, input: RenderInput): void {
  const { cell, pad } = metrics;
  if (input.hover) {
    ctx.strokeStyle = withAlpha(COLORS.ink, 0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + input.hover.x * cell + 1, pad + input.hover.y * cell + 1, cell - 2, cell - 2);
  }
  if (input.selection) {
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      pad + input.selection.x * cell + 1,
      pad + input.selection.y * cell + 1,
      cell - 2,
      cell - 2,
    );
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function contentLabel(content: CellContent | undefined): string {
  if (!content) return '空地';
  switch (content.kind) {
    case 'wall':
      return '墙';
    case 'source':
      return content.medium === 'heat' ? '热源' : '雾源';
    case 'vent':
      return `${content.medium === 'both' ? '双介质' : content.medium === 'heat' ? '热量' : '雾'}风口 · ${content.open ? '开' : '关'}`;
  }
}
