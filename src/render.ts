import { Sim, estimateDirText } from './sim';
import { OPPOSITE, Dir } from './propagate';

export const CELL = 26;

export interface ViewState {
  /** 当前显示传播范围的事件 id;null 表示自动取最新事件 */
  selectedEventId: number | null;
  hover: { x: number; y: number } | null;
  /** true 显示到达时刻,false 显示剩余强度 */
  showTime: boolean;
}

const COLORS = {
  wall: '#3a3f4a',
  floor: '#f4f1e8',
  doorOpen: '#8fbf6b',
  doorClosed: '#d08a2e',
  grid: '#c9c4b4',
  heat: '220, 60, 50',
  frontier: '#1fa8c9',
  npc: '#3b6ea5',
  npcInvestigate: '#d35400',
  text: '#333',
};

export function draw(ctx: CanvasRenderingContext2D, sim: Sim, view: ViewState): void {
  const { map } = sim;
  ctx.clearRect(0, 0, map.w * CELL, map.h * CELL);

  const ev =
    view.selectedEventId !== null
      ? (sim.events.find((e) => e.id === view.selectedEventId) ?? null)
      : (sim.events[sim.events.length - 1] ?? null);

  // 1. 地形
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const c = map.at(x, y);
      ctx.fillStyle =
        c.terrain === 'wall' ? COLORS.wall : c.terrain === 'door' ? (c.doorOpen ? COLORS.doorOpen : COLORS.doorClosed) : COLORS.floor;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }

  // 2. 选中事件的传播热力(只画已到达的格)
  if (ev) {
    for (let i = 0; i < ev.reach.length; i++) {
      const r = ev.reach[i];
      if (!r || r.time > sim.time) continue;
      const x = i % map.w;
      const y = Math.floor(i / map.w);
      const ratio = r.intensity / ev.initialIntensity;
      ctx.fillStyle = `rgba(${COLORS.heat}, ${0.12 + 0.5 * ratio})`;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      // 数字:剩余强度或到达时刻
      ctx.fillStyle = '#7a1f1a';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(view.showTime ? r.time : r.intensity), x * CELL + CELL / 2, y * CELL + CELL / 2);
      // 传播前沿
      if (r.time === sim.time) {
        ctx.strokeStyle = COLORS.frontier;
        ctx.lineWidth = 2;
        ctx.strokeRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    // 声源标记
    ctx.fillStyle = '#8e44ad';
    ctx.beginPath();
    ctx.arc(ev.x * CELL + CELL / 2, ev.y * CELL + CELL / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText(String(ev.id), ev.x * CELL + CELL / 2, ev.y * CELL + CELL / 2 + 0.5);
  }

  // 3. 网格线
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= map.w; x++) {
    ctx.moveTo(x * CELL + 0.5, 0);
    ctx.lineTo(x * CELL + 0.5, map.h * CELL);
  }
  for (let y = 0; y <= map.h; y++) {
    ctx.moveTo(0, y * CELL + 0.5);
    ctx.lineTo(map.w * CELL, y * CELL + 0.5);
  }
  ctx.stroke();

  // 4. NPC
  for (const n of sim.npcs) {
    const cx = n.x * CELL + CELL / 2;
    const cy = n.y * CELL + CELL / 2;
    const target = n.investigationTarget();
    ctx.fillStyle = target ? COLORS.npcInvestigate : COLORS.npc;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.38, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n.name, cx, cy);
    if (target && target.entry) {
      drawArrow(ctx, cx, cy, OPPOSITE[target.entry]);
    }
  }

  // 5. 悬停高亮
  if (view.hover && map.inBounds(view.hover.x, view.hover.y)) {
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.strokeRect(view.hover.x * CELL + 1, view.hover.y * CELL + 1, CELL - 2, CELL - 2);
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: Dir): void {
  const v: Record<Dir, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const [dx, dy] = v[dir];
  const tx = cx + dx * CELL * 0.62;
  const ty = cy + dy * CELL * 0.62;
  ctx.strokeStyle = '#d35400';
  ctx.fillStyle = '#d35400';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx + dx * CELL * 0.3, cy + dy * CELL * 0.3);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  // 箭头头部
  const px = -dy;
  const py = dx;
  ctx.beginPath();
  ctx.moveTo(tx + dx * 5, ty + dy * 5);
  ctx.lineTo(tx + px * 4, ty + py * 4);
  ctx.lineTo(tx - px * 4, ty - py * 4);
  ctx.closePath();
  ctx.fill();
}

/** 悬停提示内容 */
export function hoverText(sim: Sim, view: ViewState, x: number, y: number): string {
  const { map } = sim;
  if (!map.inBounds(x, y)) return '';
  const c = map.at(x, y);
  const terrain =
    c.terrain === 'wall' ? '墙(完全阻断)' : c.terrain === 'door' ? (c.doorOpen ? '门(开)' : '门(关,额外衰减)') : '空地';
  const lines = [`(${x},${y}) ${terrain}`];
  const ev =
    view.selectedEventId !== null
      ? sim.events.find((e) => e.id === view.selectedEventId)
      : sim.events[sim.events.length - 1];
  if (ev) {
    const r = ev.reach[map.idx(x, y)];
    if (r) {
      const state = r.time <= sim.time ? '已到达' : `将于 t=${r.time} 到达`;
      lines.push(`事件#${ev.id}: ${state},剩余强度 ${r.intensity}`);
    } else {
      lines.push(`事件#${ev.id}: 传播不到此格`);
    }
  }
  const n = sim.npcs.find((p) => p.x === x && p.y === y);
  if (n) {
    const t = n.investigationTarget();
    lines.push(`NPC ${n.name} 阈值${n.threshold}:${t ? `调查事件#${t.eventId}(${estimateDirText(t.entry)})` : '待机'}`);
  }
  return lines.join('\n');
}
