// 群岛潮汐传送 —— Canvas 渲染层（纯绘制，不持有游戏状态）

import { ISLANDS, SIDE_NAME } from './data.js';
import type { Dir, Gate, Island, PlayerState, Side } from './types.js';

export const VIEW_W = 1150;
export const VIEW_H = 780;

const COLORS = {
  seaTop: '#0e2740',
  seaBottom: '#163a5c',
  seaGrid: 'rgba(120, 190, 230, 0.08)',
  land: '#d9c9a3',
  landEdge: '#8a7a55',
  currentRing: '#ffe08a',
  reachGlow: 'rgba(110, 231, 160, 0.55)',
  trapRing: 'rgba(255, 110, 110, 0.85)',
  gateStone: '#ece3cf',
  gateStoneEdge: '#6d6450',
  sealed: '#5b5648',
  sealedCross: '#d9534f',
  oneWay: '#e8a33d',
  gateOpen: '#3fa7d6',
  text: '#f4f1e8',
  textDim: '#a9b7c6',
  player: '#ff5d5d',
  playerEdge: '#fff3f3',
  gold: '#ffd34d',
  clock: '#9ad1ff',
};

function dirVector(dir: Dir): { dx: number; dy: number } {
  switch (dir) {
    case 'N':
      return { dx: 0, dy: -1 };
    case 'S':
      return { dx: 0, dy: 1 };
    case 'E':
      return { dx: 1, dy: 0 };
    case 'W':
      return { dx: -1, dy: 0 };
  }
}

/** 玩家落在某门旁时的站位（门内一侧，距门 30px） */
export function standAtGate(gate: Gate): { x: number; y: number } {
  const v = dirVector(gate.dir);
  return { x: gate.x - v.dx * 34, y: gate.y - v.dy * 34 };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawSea(ctx: CanvasRenderingContext2D, t: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, COLORS.seaTop);
  grad.addColorStop(1, COLORS.seaBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // 海面波纹网格（缓慢横移）
  ctx.strokeStyle = COLORS.seaGrid;
  ctx.lineWidth = 1;
  const gap = 46;
  const shift = (t / 60) % gap;
  ctx.beginPath();
  for (let x = -gap + shift; x < VIEW_W + gap; x += gap) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, VIEW_H);
  }
  for (let y = 0; y < VIEW_H; y += gap) {
    ctx.moveTo(0, y);
    ctx.lineTo(VIEW_W, y);
  }
  ctx.stroke();
}

function drawMedal(ctx: CanvasRenderingContext2D, x: number, y: number, taken: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = taken ? 0.28 : 1;
  // 绶带
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(-9, -24, 7, 14);
  ctx.fillRect(2, -24, 7, 14);
  // 金牌
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.gold;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#a87b16';
  ctx.stroke();
  // 星
  ctx.fillStyle = '#a87b16';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('★', 0, 1);
  ctx.restore();
}

function drawClock(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  ctx.save();
  ctx.translate(x, y);
  // 底座
  ctx.fillStyle = '#4a6b86';
  ctx.fillRect(-4, 12, 8, 10);
  // 表盘
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.clock;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#2c4a63';
  ctx.stroke();
  // 指针（秒针走动，提示这是潮钟）
  const ang = (t / 500) % (Math.PI * 2);
  ctx.strokeStyle = '#1d3550';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(ang) * 10, Math.sin(ang) * 10);
  ctx.moveTo(0, 0);
  ctx.lineTo(-Math.sin(ang) * 7, Math.cos(ang) * 7);
  ctx.stroke();
  ctx.restore();
}

function ruleText(side: Side, gate: Gate): string {
  const rule = side === 'tide' ? gate.tide : gate.ebb;
  if (!rule) return '封';
  const target = ISLANDS.find((i) => i.id === rule.toIsland);
  return `${SIDE_NAME[side]}→${target ? target.name : rule.toIsland}${rule.flip ? '⇄' : ''}`;
}

function drawGate(
  ctx: CanvasRenderingContext2D,
  gate: Gate,
  activeSide: Side,
  hovered: boolean
): void {
  const v = dirVector(gate.dir);
  ctx.save();
  ctx.translate(gate.x, gate.y);

  // 门柱（两根立柱 + 横梁），沿门朝向排布
  const px = -v.dy;
  const py = v.dx;
  ctx.lineWidth = hovered ? 3 : 2;
  ctx.strokeStyle = gate.sealed ? COLORS.sealedCross : COLORS.gateStoneEdge;
  ctx.fillStyle = gate.sealed ? COLORS.sealed : COLORS.gateStone;

  const postW = 7;
  const postH = 20;
  for (const sgn of [-1, 1]) {
    const ox = px * 13 * sgn;
    const oy = py * 13 * sgn;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.rect(-postW / 2, -postH / 2, postW, postH);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // 横梁
  ctx.save();
  ctx.rotate(Math.atan2(py, px));
  ctx.fillStyle = gate.sealed ? COLORS.sealed : COLORS.gateStone;
  ctx.fillRect(-16, -12, 32, 7);
  ctx.strokeRect(-16, -12, 32, 7);
  ctx.restore();

  // 门内区域
  ctx.save();
  ctx.rotate(Math.atan2(v.dy, v.dx) + Math.PI / 2);
  if (gate.sealed) {
    // 封死：红色交叉栅栏
    ctx.strokeStyle = COLORS.sealedCross;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-11, -8);
    ctx.lineTo(11, 8);
    ctx.moveTo(11, -8);
    ctx.lineTo(-11, 8);
    ctx.stroke();
  } else {
    const ruleNow = activeSide === 'tide' ? gate.tide : gate.ebb;
    ctx.fillStyle = ruleNow ? 'rgba(63,167,214,0.35)' : 'rgba(120,120,120,0.25)';
    ctx.fillRect(-11, -9, 22, 18);
    // 单向门标橙色顺向箭头
    if (gate.oneWay) {
      ctx.fillStyle = COLORS.oneWay;
      ctx.beginPath();
      ctx.moveTo(0, 10);
      ctx.lineTo(-7, -2);
      ctx.lineTo(7, -2);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // 朝向小箭头（门的正面方向）—— 屏幕上辨别正反面
  ctx.fillStyle = gate.sealed ? COLORS.sealedCross : COLORS.gateOpen;
  const ax = v.dx * 22;
  const ay = v.dy * 22;
  ctx.beginPath();
  ctx.moveTo(ax + v.dx * 7, ay + v.dy * 7);
  ctx.lineTo(ax - v.dy * 4 - v.dx * 3, ay + v.dx * 4 - v.dy * 3);
  ctx.lineTo(ax + v.dy * 4 - v.dx * 3, ay - v.dx * 4 - v.dy * 3);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  // 门名与两态规则标签
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 12px sans-serif';
  const labelY = gate.dir === 'N' ? gate.y - 36 : gate.dir === 'S' ? gate.y + 40 : gate.y + 4;
  const labelX = gate.x + (gate.dir === 'E' ? 34 : gate.dir === 'W' ? -34 : 0);
  ctx.fillStyle = 'rgba(10,25,40,0.72)';
  const nameW = ctx.measureText(gate.name).width + 10;
  roundRect(ctx, labelX - nameW / 2, labelY - 9, nameW, 15, 5);
  ctx.fill();
  ctx.fillStyle = COLORS.text;
  ctx.fillText(gate.name, labelX, labelY + 2);

  if (!gate.sealed) {
    ctx.font = '10.5px sans-serif';
    const tText = ruleText('tide', gate);
    const eText = ruleText('ebb', gate);
    const line = `${tText} / ${eText}`;
    const w = ctx.measureText(line).width + 10;
    const ruleY = labelY + 15;
    ctx.fillStyle = 'rgba(10,25,40,0.62)';
    roundRect(ctx, labelX - w / 2, ruleY - 8, w, 13, 4);
    ctx.fill();
    ctx.fillStyle = COLORS.textDim;
    ctx.fillText(line, labelX, ruleY + 1);
  } else {
    ctx.font = '10.5px sans-serif';
    const w = ctx.measureText('封死·背面').width + 10;
    ctx.fillStyle = 'rgba(60,20,20,0.7)';
    roundRect(ctx, labelX - w / 2, labelY + 7, w, 13, 4);
    ctx.fill();
    ctx.fillStyle = '#ff9b9b';
    ctx.fillText('封死·背面', labelX, labelY + 16);
  }
  ctx.restore();
}

function drawIsland(
  ctx: CanvasRenderingContext2D,
  island: Island,
  isCurrent: boolean,
  reachMode: boolean,
  reachable: boolean,
  trap: boolean,
  player: PlayerState,
  hoveredGate: string | null,
  t: number
): void {
  ctx.save();

  // 可达/陷阱外发光
  if (reachMode && reachable) {
    ctx.beginPath();
    ctx.arc(island.cx, island.cy, island.radius + 10, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.reachGlow;
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  if (trap) {
    ctx.beginPath();
    ctx.arc(island.cx, island.cy, island.radius + 14, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.trapRing;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 7]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 岛体
  const g = ctx.createRadialGradient(
    island.cx - 30,
    island.cy - 30,
    20,
    island.cx,
    island.cy,
    island.radius
  );
  g.addColorStop(0, '#e6d8b6');
  g.addColorStop(1, COLORS.land);
  ctx.beginPath();
  ctx.arc(island.cx, island.cy, island.radius, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = isCurrent ? 4 : 2.5;
  ctx.strokeStyle = isCurrent ? COLORS.currentRing : COLORS.landEdge;
  ctx.stroke();

  // 岛名（放在岛体上半部；若岛有北门，再向下让位避开其封门标签）
  const hasNorthGate = island.gates.some((g) => g.dir === 'N');
  const titleOffset = hasNorthGate ? -0.18 : -0.42;
  ctx.fillStyle = '#5a4d33';
  ctx.textAlign = 'center';
  ctx.font = 'bold 19px sans-serif';
  ctx.fillText(island.name, island.cx, island.cy + island.radius * titleOffset);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#7a6b4c';
  ctx.fillText(island.subtitle, island.cx, island.cy + island.radius * titleOffset + 17);

  // 装饰物
  if (island.hasClock) drawClock(ctx, island.cx, island.cy + 8, t);
  if (island.hasMedal) drawMedal(ctx, island.cx + 34, island.cy + 4, player.medalTaken);

  // 门
  for (const gate of island.gates) {
    drawGate(ctx, gate, player.side, hoveredGate === gate.id);
  }

  ctx.restore();
}

function drawPlayer(ctx: CanvasRenderingContext2D, player: PlayerState): void {
  ctx.save();
  ctx.translate(player.x, player.y);
  // 阴影
  ctx.beginPath();
  ctx.ellipse(0, 10, 11, 4.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();
  // 身体
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.player;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = COLORS.playerEdge;
  ctx.stroke();
  // 朝向箭头
  const v = dirVector(player.facing);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(v.dx * 4, v.dy * 4);
  ctx.lineTo(v.dx * 15, v.dy * 15);
  ctx.stroke();
  // 头顶卡面小标
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = player.side === 'tide' ? '#7ecbff' : '#c9a7ff';
  ctx.fillText(SIDE_NAME[player.side], 0, -16);
  ctx.restore();
}

function drawCompass(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(40, 46);
  ctx.beginPath();
  ctx.arc(0, 0, 24, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,25,40,0.7)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('北', 0, -13);
  ctx.fillText('南', 0, 14);
  ctx.fillText('东', 13, 0);
  ctx.fillText('西', -13, 0);
  ctx.restore();
}

export interface RenderOpts {
  player: PlayerState;
  reachMode: boolean;
  reachableIslands: Set<string>;
  trapIslands: Set<string>;
  hoveredGate: string | null;
  time: number;
}

export function render(ctx: CanvasRenderingContext2D, opts: RenderOpts): void {
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  drawSea(ctx, opts.time);
  drawCompass(ctx);

  for (const island of ISLANDS) {
    drawIsland(
      ctx,
      island,
      island.id === opts.player.islandId,
      opts.reachMode,
      opts.reachableIslands.has(island.id),
      opts.trapIslands.has(island.id),
      opts.player,
      opts.hoveredGate,
      opts.time
    );
  }

  drawPlayer(ctx, opts.player);
}
