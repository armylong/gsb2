// 俯视 Canvas 渲染：地图、车辆、未来数步预约幽灵与封路标记
import type { Cell, Simulator } from './simulator';

export const CELL = 64;

const COLORS = {
  bg: '#10141b',
  road: '#26303d',
  bridge: '#3d4a3a',
  bridgeEdge: '#7cb342',
  wait: '#34404f',
  waitEdge: '#5c8bd6',
  closed: '#2a1618',
  closedX: '#ef5350',
  grid: '#1b222c',
  goal: '#fdd835',
};

export function draw(
  ctx: CanvasRenderingContext2D,
  sim: Simulator,
  showReservations: boolean,
) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, sim.width * CELL, sim.height * CELL);

  // 1. 格子
  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      const cell = sim.grid[y][x];
      const px = x * CELL;
      const py = y * CELL;
      if (!cell) {
        ctx.strokeStyle = COLORS.grid;
        ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
        continue;
      }
      drawCell(ctx, cell, px, py);
      if (cell.closed) drawClosed(ctx, px, py);
    }
  }

  // 2. 终点标记
  for (const car of sim.cars) {
    if (car.status === 'done') continue;
    const px = car.goal.x * CELL;
    const py = car.goal.y * CELL;
    ctx.save();
    ctx.strokeStyle = car.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(px + 8, py + 8, CELL - 16, CELL - 16);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.goal;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('★', px + CELL / 2, py + 18);
    ctx.restore();
  }

  // 3. 未来预约幽灵（顶点预约）
  if (showReservations) drawReservations(ctx, sim);

  // 4. 车辆本体
  for (const car of sim.cars) {
    drawCar(ctx, car);
  }
}

function drawCell(ctx: CanvasRenderingContext2D, cell: Cell, px: number, py: number) {
  ctx.fillStyle = cell.closed
    ? COLORS.closed
    : cell.type === 'bridge'
      ? COLORS.bridge
      : cell.type === 'wait'
        ? COLORS.wait
        : COLORS.road;
  ctx.fillRect(px, py, CELL, CELL);
  ctx.strokeStyle = COLORS.grid;
  ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);

  if (cell.type === 'bridge' && !cell.closed) {
    ctx.strokeStyle = COLORS.bridgeEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 3, py + 3, CELL - 6, CELL - 6);
    // 桥面纹理
    ctx.strokeStyle = 'rgba(124,179,66,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 12, py + CELL - 14);
    ctx.lineTo(px + CELL - 12, py + 14);
    ctx.moveTo(px + 12, py + 14);
    ctx.lineTo(px + CELL - 12, py + CELL - 14);
    ctx.stroke();
  }
  if (cell.type === 'wait' && !cell.closed) {
    ctx.strokeStyle = COLORS.waitEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 5, py + 5, CELL - 10, CELL - 10);
    ctx.fillStyle = 'rgba(92,139,214,0.8)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待格', px + CELL / 2, py + CELL - 10);
  }
}

function drawClosed(ctx: CanvasRenderingContext2D, px: number, py: number) {
  ctx.strokeStyle = COLORS.closedX;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(px + 10, py + 10);
  ctx.lineTo(px + CELL - 10, py + CELL - 10);
  ctx.moveTo(px + CELL - 10, py + 10);
  ctx.lineTo(px + 10, py + CELL - 10);
  ctx.stroke();
}

// 把预约表 vertex[(x,y,t)] 按「车 → 相对步数」画成半透明幽灵
function drawReservations(ctx: CanvasRenderingContext2D, sim: Simulator) {
  const byCar = new Map<string, { x: number; y: number; step: number }[]>();
  for (const [vk, owner] of sim.reservations.vertex) {
    const [xs, ys, ts] = vk.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const t = Number(ts);
    const step = t - sim.tick;
    if (step <= 0 || step > sim.horizon) continue;
    if (!byCar.has(owner)) byCar.set(owner, []);
    byCar.get(owner)!.push({ x, y, step });
  }
  for (const car of sim.cars) {
    const list = byCar.get(car.id);
    if (!list) continue;
    for (const r of list) {
      const px = r.x * CELL;
      const py = r.y * CELL;
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = car.color;
      ctx.fillRect(px + 6, py + 6, CELL - 12, CELL - 12);
      ctx.globalAlpha = 1;
      ctx.fillStyle = car.color;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`+${r.step}`, px + CELL / 2, py + 16);
      ctx.restore();
    }
  }
}

function drawCar(
  ctx: CanvasRenderingContext2D,
  car: ReturnType<Simulator['cars']['filter']>[number],
) {
  const px = car.pos.x * CELL;
  const py = car.pos.y * CELL;
  const cx = px + CELL / 2;
  const cy = py + CELL / 2;
  ctx.save();
  if (car.status === 'failed') ctx.globalAlpha = 0.45;

  // 车身
  ctx.fillStyle = car.color;
  ctx.beginPath();
  ctx.arc(cx, cy, CELL * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = car.status === 'failed' ? '#ef5350' : '#0e1117';
  ctx.stroke();

  // 车号
  ctx.fillStyle = '#0e1117';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(car.id, cx, cy + 1);

  // 状态角标
  ctx.textBaseline = 'alphabetic';
  if (car.status === 'done') {
    badge(ctx, px + CELL - 14, py + 14, '✓', '#66bb6a');
  } else if (car.status === 'failed') {
    badge(ctx, px + CELL - 14, py + 14, '✕', '#ef5350');
  } else if (car.waitCount > 0) {
    badge(ctx, px + CELL - 14, py + 14, String(car.waitCount), '#ffb74d');
  }
  ctx.restore();

  // 失败原因浮在车下方（绘制在 save/restore 外，避免透明）
  if (car.status === 'failed' && car.failReason) {
    ctx.save();
    ctx.fillStyle = 'rgba(239,83,80,0.95)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    wrapText(ctx, car.failReason, cx, py + CELL + 12, CELL * 2.2, 13);
    ctx.restore();
  }
}

function badge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0e1117';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.textBaseline = 'alphabetic';
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const chars = text.split('');
  let line = '';
  let yy = y;
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = ch;
      yy += lineHeight;
    } else {
      line += ch;
    }
  }
  if (line) ctx.fillText(line, x, yy);
}
