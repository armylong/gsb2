import type { ActionResult, GameState, Scenario } from './types.ts';
import { dirDelta } from './scenarios.ts';

const COLORS = {
  red: '#d4453d',
  blue: '#3d6fd4',
  redSoft: '#f7dedc',
  blueSoft: '#dde7fa',
  wall: '#3a4654',
  floor: '#fbfcfd',
  grid: '#e6eaee',
  shelf: '#8d6e3f',
  desk: '#b9c2cc',
  ink: '#23303f',
  ghost: '#b9770e',
};

export interface RenderOptions {
  cell: number;
  state: GameState;
  scenario: Scenario;
  /** 当前查看的拍（1 起）；0 表示初始局面 */
  viewTick: number;
  /** 当前拍两车的请求结果，用于画幽灵目标格 */
  results?: Record<string, ActionResult>;
}

function bookColor(color: 'red' | 'blue'): string {
  return color === 'red' ? COLORS.red : COLORS.blue;
}

export function draw(ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const { cell, state, scenario, viewTick, results } = opts;
  const w = scenario.width * cell;
  const h = scenario.height * cell;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, w, h);

  // 网格
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= scenario.width; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= scenario.height; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(w, y * cell + 0.5);
    ctx.stroke();
  }

  // 墙
  ctx.fillStyle = COLORS.wall;
  for (const wall of scenario.walls) {
    roundRect(ctx, wall.x * cell + 2, wall.y * cell + 2, cell - 4, cell - 4, 4);
    ctx.fill();
  }

  // 台面
  for (const table of scenario.tables) {
    const x = table.pos.x * cell;
    const y = table.pos.y * cell;
    const isShelf = table.acceptColor !== null;
    ctx.fillStyle = isShelf
      ? (table.acceptColor === 'red' ? COLORS.redSoft : COLORS.blueSoft)
      : '#eef1f4';
    roundRect(ctx, x + 3, y + 3, cell - 6, cell - 6, 6);
    ctx.fill();
    ctx.strokeStyle = isShelf ? bookColor(table.acceptColor!) : COLORS.desk;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = COLORS.ink;
    ctx.font = `${Math.round(cell * 0.16)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(
      isShelf ? `${table.acceptColor === 'red' ? '红' : '蓝'}角台` : '台面',
      x + cell / 2,
      y + cell - 6,
    );
  }

  // 台面上的书
  for (const book of state.books) {
    if (book.tableId === null) continue;
    const table = scenario.tables.find((t) => t.id === book.tableId);
    if (!table) continue;
    drawBook(ctx, table.pos.x * cell, table.pos.y * cell, cell, book.color, 0);
  }

  // 当前拍的请求幽灵标记（被挡的前进目标）
  if (results && viewTick > 0) {
    for (const cart of state.carts) {
      const r = results[cart.id];
      if (!r || !r.targetPos) continue;
      const gx = r.targetPos.x * cell;
      const gy = r.targetPos.y * cell;
      ctx.save();
      ctx.strokeStyle = r.status === 'blocked' ? COLORS.ghost : 'rgba(31,138,76,0.7)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      roundRect(ctx, gx + 5, gy + 5, cell - 10, cell - 10, 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = r.status === 'blocked' ? COLORS.ghost : 'rgba(31,138,76,0.85)';
      ctx.font = `${Math.round(cell * 0.2)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(cart.id, gx + cell / 2, gy + cell / 2);
      ctx.restore();
    }
  }

  // 书车（同格时横向错开一点）
  const stacked = state.carts[0].pos.x === state.carts[1].pos.x
    && state.carts[0].pos.y === state.carts[1].pos.y;
  state.carts.forEach((cart, idx) => {
    const offset = stacked ? (idx === 0 ? -cell * 0.18 : cell * 0.18) : 0;
    const carriedBook = cart.carrying
      ? state.books.find((b) => b.id === cart.carrying) ?? null
      : null;
    drawCart(ctx, cart, cell, offset, carriedBook?.color ?? null);
  });
}

function drawCart(
  ctx: CanvasRenderingContext2D,
  cart: GameState['carts'][number],
  cell: number,
  xOffset: number,
  carriedColor: 'red' | 'blue' | null,
): void {
  const cx = cart.pos.x * cell + cell / 2 + xOffset;
  const cy = cart.pos.y * cell + cell / 2;
  const r = cell * 0.3;
  const main = cart.color === 'red' ? COLORS.red : COLORS.blue;
  const soft = cart.color === 'red' ? COLORS.redSoft : COLORS.blueSoft;

  // 车身
  ctx.fillStyle = soft;
  ctx.strokeStyle = main;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 朝向三角
  const d = dirDelta(cart.dir);
  const tipX = cx + d.x * r * 0.95;
  const tipY = cy + d.y * r * 0.95;
  const baseX = cx - d.x * r * 0.4;
  const baseY = cy - d.y * r * 0.4;
  const perpX = -d.y;
  const perpY = d.x;
  ctx.fillStyle = main;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + perpX * r * 0.35, baseY + perpY * r * 0.35);
  ctx.lineTo(baseX - perpX * r * 0.35, baseY - perpY * r * 0.35);
  ctx.closePath();
  ctx.fill();

  // 车号
  ctx.fillStyle = COLORS.ink;
  ctx.font = `bold ${Math.round(cell * 0.22)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cart.id, cx, cy + r * 0.45);
  ctx.textBaseline = 'alphabetic';

  // 车箱里的书（车顶小方块，颜色取书本身的颜色）
  if (carriedColor) {
    ctx.fillStyle = bookColor(carriedColor);
    const bs = cell * 0.16;
    roundRect(ctx, cx - bs / 2, cy - r - bs - 2, bs, bs, 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawBook(
  ctx: CanvasRenderingContext2D,
  cellX: number,
  cellY: number,
  cell: number,
  color: 'red' | 'blue',
  angle: number,
): void {
  const bw = cell * 0.28;
  const bh = cell * 0.36;
  const bx = cellX + cell / 2 - bw / 2;
  const by = cellY + cell * 0.28;
  ctx.save();
  ctx.translate(bx + bw / 2, by + bh / 2);
  ctx.rotate(angle);
  ctx.fillStyle = bookColor(color);
  roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-bw / 2 + 3, -bh / 2 + 6);
  ctx.lineTo(bw / 2 - 3, -bh / 2 + 6);
  ctx.stroke();
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
