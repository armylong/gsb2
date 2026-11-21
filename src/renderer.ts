import type { Simulation } from './engine.ts';
import { CELL_CAPACITY } from './engine.ts';
import { GRID_W, GRID_H } from './presets.ts';

export const CELL = 32;

const COLORS = {
  empty: '#101822',
  grid: '#1c2836',
  wall: '#3a4a5e',
  wallEdge: '#5d748f',
  water: '#3b9dff',
  waterEdge: 'rgba(120,190,255,0.85)',
  oil: '#f0a838',
  oilEdge: 'rgba(255,214,140,0.85)',
  portOpen: '#5ad1a3',
  portClosed: '#ff6b6b',
};

/** 纯绘制函数：只读 sim，不推进仿真，因此任意帧率调用都不改变结果 */
export function render(ctx: CanvasRenderingContext2D, sim: Simulation): void {
  const { width: W, height: H } = sim;
  ctx.clearRect(0, 0, W * CELL, H * CELL);

  // 格子底色与网格
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x * CELL;
      const py = y * CELL;
      ctx.fillStyle = COLORS.empty;
      ctx.fillRect(px, py, CELL, CELL);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
    }
  }

  // 液体：油在水上（油密度小），自下而上水、油分层
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = sim.cells[y * W + x];
      if (c.wall || (c.w === 0 && c.o === 0)) continue;
      const px = x * CELL;
      const py = y * CELL;
      let cursor = py + CELL; // 自底向上绘制

      if (c.w > 0) {
        const h = (c.w / CELL_CAPACITY) * CELL;
        ctx.fillStyle = COLORS.water;
        ctx.fillRect(px + 1, cursor - h, CELL - 2, h);
        ctx.strokeStyle = COLORS.waterEdge;
        ctx.strokeRect(px + 1.5, cursor - h + 0.5, CELL - 3, h - 1);
        cursor -= h;
      }
      if (c.o > 0) {
        const h = (c.o / CELL_CAPACITY) * CELL;
        ctx.fillStyle = COLORS.oil;
        ctx.fillRect(px + 1, cursor - h, CELL - 2, h);
        ctx.strokeStyle = COLORS.oilEdge;
        ctx.strokeRect(px + 1.5, cursor - h + 0.5, CELL - 3, h - 1);
      }
    }
  }

  // 挡板
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = sim.cells[y * W + x];
      if (!c.wall) continue;
      const px = x * CELL;
      const py = y * CELL;
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
      ctx.strokeStyle = COLORS.wallEdge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 2.5, py + 2.5, CELL - 5, CELL - 5);
      // 斜纹
      ctx.beginPath();
      ctx.moveTo(px + 5, py + CELL - 5);
      ctx.lineTo(px + CELL - 5, py + 5);
      ctx.stroke();
    }
  }

  // 排水口标记
  for (const p of sim.ports.values()) {
    const px = p.x * CELL;
    const py = p.y * CELL;
    ctx.strokeStyle = p.open ? COLORS.portOpen : COLORS.portClosed;
    ctx.lineWidth = 3;
    ctx.strokeRect(px + 4, py + 4, CELL - 8, CELL - 8);
    ctx.beginPath();
    ctx.arc(px + CELL / 2, py + CELL / 2, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = p.open ? COLORS.portOpen : COLORS.portClosed;
    ctx.fill();
  }
}

export function canvasSize(): { w: number; h: number } {
  return { w: GRID_W * CELL, h: GRID_H * CELL };
}
