import { Piece, PieceRuntime, Settlement, DirSet, DIRS } from './engine';
import { GRID_W, GROUND_Y } from './presets';

export const CELL = 44;
export const CANVAS_W = GRID_W * CELL;
export const CANVAS_H = (GROUND_Y + 1) * CELL;

export interface FallingAnim {
  piece: Piece;
  originY: number; // 起始像素 y
  startedAt: number;
}

export interface RenderState {
  pieces: Piece[];
  settlement: Settlement;
  /** 预览模式下的高亮 id 集合 */
  previewTargetId?: string;
  topoAffectedIds?: Set<string>;
  topoStillStandingIds?: Set<string>;
  simulatedFallenIds?: Set<string>;
  hoverId?: string;
  falling?: FallingAnim[];
  showLoad: boolean;
  showArrows: boolean;
}

const COLORS = {
  grid: '#2a3140',
  ground: '#3d4a3d',
  groundFill: '#232a23',
  text: '#e8e6e3',
  subText: '#9aa3b2',
  ok: '#7ec488',
  warn: '#e0b25f',
  danger: '#e06c5f',
  preview: '#5b9bd5',
  arrow: '#b8d4e3',
};

export function cellFromEvent(canvas: HTMLCanvasElement, ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const x = Math.floor(((ev.clientX - rect.left) * sx) / CELL);
  const y = Math.floor(((ev.clientY - rect.top) * sy) / CELL);
  return { x, y };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#171b24';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_W; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL + 0.5, 0);
    ctx.lineTo(x * CELL + 0.5, GROUND_Y * CELL);
    ctx.stroke();
  }
  for (let y = 0; y <= GROUND_Y; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL + 0.5);
    ctx.lineTo(CANVAS_W, y * CELL + 0.5);
    ctx.stroke();
  }
  // 地面
  ctx.fillStyle = COLORS.groundFill;
  ctx.fillRect(0, GROUND_Y * CELL, CANVAS_W, CELL);
  ctx.strokeStyle = COLORS.ground;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y * CELL);
  ctx.lineTo(CANVAS_W, GROUND_Y * CELL);
  ctx.stroke();
  ctx.fillStyle = COLORS.subText;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('地面 (y = ground)', 8, GROUND_Y * CELL + 27);
}

/** 在构件格子边缘画承重方向小刻度: 有承重能力的边画一道亮色短线 */
function drawBearingTicks(ctx: CanvasRenderingContext2D, piece: Piece) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const dirs: { key: keyof DirSet; edge: (x: number, y: number) => [number, number, number, number] }[] = [
    { key: 'north', edge: (x, y) => [x + 10, y + 3, x + CELL - 10, y + 3] },
    { key: 'south', edge: (x, y) => [x + 10, y + CELL - 3, x + CELL - 10, y + CELL - 3] },
    { key: 'west', edge: (x, y) => [x + 3, y + 10, x + 3, y + CELL - 10] },
    { key: 'east', edge: (x, y) => [x + CELL - 3, y + 10, x + CELL - 3, y + CELL - 10] },
  ];
  for (const c of piece.cells) {
    const px = c.x * CELL;
    const py = c.y * CELL;
    for (const d of dirs) {
      if (!piece.bearing[d.key]) continue;
      const [x1, y1, x2, y2] = d.edge(px, py);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function statusColor(rt: PieceRuntime | undefined, capacity: number): string {
  if (!rt || !rt.grounded) return COLORS.danger;
  if (rt.overloaded || rt.totalLoad > capacity + 1e-9) return COLORS.danger;
  if (capacity !== Infinity && rt.totalLoad / capacity >= 0.7) return COLORS.warn;
  return COLORS.ok;
}

function drawPieceBody(ctx: CanvasRenderingContext2D, piece: Piece, fill: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 2;
  for (const c of piece.cells) {
    roundRect(ctx, c.x * CELL + 3, c.y * CELL + 3, CELL - 6, CELL - 6, 6);
    ctx.fill();
    ctx.stroke();
  }
  drawBearingTicks(ctx, piece);
  ctx.restore();
}

function drawPieceLabel(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  rt: PieceRuntime | undefined,
  showLoad: boolean,
) {
  const head = piece.cells.reduce((a, b) => (a.x < b.x || (a.x === b.x && a.y < b.y) ? a : b));
  const cx = head.x * CELL + 6;
  const cy = head.y * CELL + 15;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.font = 'bold 10px sans-serif';
  const cap = piece.capacity === Infinity ? '∞' : String(piece.capacity);
  const lines = [piece.name];
  if (showLoad) {
    // 整数负载不显示小数, 节省横向空间
    const raw = rt ? rt.totalLoad : 0;
    const load = Number.isInteger(raw) ? String(raw) : raw.toFixed(1);
    // 地基自身无自重, 数字表示它承受的上方压力
    const prefix = piece.kind === 'foundation' ? '受' : '';
    lines.push(`${prefix}${load}/${cap}`);
  } else {
    lines.push(`限${cap}`);
  }
  lines.forEach((t, i) => ctx.fillText(t, cx, cy + i * 12));
  ctx.restore();
}

/** 支撑来源箭头: 从支撑边指向被支撑格子中心, 标注该边分到的负载 */
function drawArrows(ctx: CanvasRenderingContext2D, state: RenderState) {
  ctx.save();
  ctx.strokeStyle = COLORS.arrow;
  ctx.fillStyle = COLORS.arrow;
  ctx.lineWidth = 2;
  ctx.font = '10px sans-serif';
  for (const piece of state.pieces) {
    const rt = state.settlement.byId.get(piece.id);
    if (!rt) continue;
    const headCell = piece.cells.reduce((a, b) =>
      a.x < b.x || (a.x === b.x && a.y < b.y) ? a : b,
    );
    for (const src of rt.supportFrom) {
      const d = DIRS.find((dd) => dd.key === src.dir)!;
      const cx = src.cell.x * CELL + CELL / 2;
      const cy = src.cell.y * CELL + CELL / 2;
      // 从接触边(邻居一侧)指向格子中心
      const sx = cx - (d.dx * CELL) / 2.6;
      const sy = cy - (d.dy * CELL) / 2.6;
      const angle = Math.atan2(cy - sy, cx - sx);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - 8 * Math.cos(angle - 0.4), cy - 8 * Math.sin(angle - 0.4));
      ctx.lineTo(cx - 8 * Math.cos(angle + 0.4), cy - 8 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
      if (state.showLoad) {
        // 数字放在靠近格子中心的一侧, 避开左上角构件标签; 构件首格(标签格)不重复画数字
        const isHead = src.cell.x === headCell.x && src.cell.y === headCell.y;
        if (!isHead) {
          ctx.fillStyle = 'rgba(10,14,20,0.85)';
          ctx.fillText(src.edgeLoad.toFixed(1), (sx + cx) / 2 - 2, (sy + cy) / 2 + 12);
          ctx.fillStyle = COLORS.arrow;
        }
      }
    }
  }
  ctx.restore();
}

function drawHighlight(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  color: string,
  dashed: boolean,
  label?: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  if (dashed) ctx.setLineDash([6, 4]);
  for (const c of piece.cells) {
    roundRect(ctx, c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4, 7);
    ctx.stroke();
  }
  if (label) {
    const head = piece.cells.reduce((a, b) => (a.y < b.y || (a.y === b.y && a.x < b.x) ? a : b));
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, head.x * CELL + 4, head.y * CELL - 4 + 12);
  }
  ctx.restore();
}

export function render(ctx: CanvasRenderingContext2D, state: RenderState, now: number) {
  drawGrid(ctx);

  // 坠落动画中的构件(脱落在画布下方渐隐)
  const falling = state.falling ?? [];
  for (const anim of falling) {
    const t = Math.min(1, (now - anim.startedAt) / 900);
    const dy = t * t * CANVAS_H;
    ctx.save();
    ctx.translate(0, dy);
    ctx.globalAlpha = 1 - t;
    drawPieceBody(ctx, anim.piece, COLORS.danger);
    ctx.restore();
  }

  // 正在播放坠落动画的构件 id(动画期间隐藏静态形态)
  const animatingIds = new Set(falling.map((a) => a.piece.id));
  for (const piece of state.pieces) {
    if (animatingIds.has(piece.id)) continue;
    const rt = state.settlement.byId.get(piece.id);
    const base = statusColor(rt, piece.capacity);
    // 悬空构件半透明绘制, 提示它已不受支撑
    drawPieceBody(ctx, piece, piece.color, rt?.grounded === false ? 0.45 : 1);
    // 状态描边: 绿=稳固 琥珀=逼近上限 红=悬空/超载
    ctx.save();
    ctx.strokeStyle = base;
    ctx.lineWidth = 3;
    for (const c of piece.cells) {
      roundRect(ctx, c.x * CELL + 3, c.y * CELL + 3, CELL - 6, CELL - 6, 6);
      ctx.stroke();
    }
    ctx.restore();
    drawPieceLabel(ctx, piece, rt, state.showLoad);
  }

  if (state.showArrows) drawArrows(ctx, state);

  // 预览高亮
  if (state.previewTargetId) {
    const target = state.pieces.find((p) => p.id === state.previewTargetId);
    if (target) drawHighlight(ctx, target, COLORS.preview, true, '拟拆除');
  }
  for (const id of state.topoAffectedIds ?? []) {
    const p = state.pieces.find((pp) => pp.id === id);
    if (p) {
      const stillStanding = state.topoStillStandingIds?.has(id);
      drawHighlight(ctx, p, stillStanding ? COLORS.preview : COLORS.warn, true);
    }
  }
  for (const id of state.simulatedFallenIds ?? []) {
    const p = state.pieces.find((pp) => pp.id === id);
    if (p) drawHighlight(ctx, p, COLORS.danger, false, '结算掉落');
  }
  if (state.hoverId && state.hoverId !== state.previewTargetId) {
    const p = state.pieces.find((pp) => pp.id === state.hoverId);
    if (p) drawHighlight(ctx, p, 'rgba(255,255,255,0.55)', false);
  }

  // 图例
  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  const legends: [string, string][] = [
    ['● 稳固', COLORS.ok],
    ['● ≥70% 上限', COLORS.warn],
    ['● 悬空/超载', COLORS.danger],
  ];
  legends.forEach(([t, c], i) => {
    ctx.fillStyle = c;
    ctx.fillText(t, CANVAS_W - 10, CANVAS_H - 12 - (legends.length - 1 - i) * 16);
  });
  ctx.restore();
}
