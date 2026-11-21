import { DIR_VEC, GameState, Pos, TickEvent, key } from '../engine/types';

export const CELL = 64;

const COLORS = {
  grid: '#22304d',
  floor: '#121a2b',
  wall: '#4a5b80',
  wallTop: '#6b7fb0',
  player: '#5aa2ff',
  belt: '#2a3f66',
  beltArrow: '#7fb0ff',
  teleIn: '#b18cff',
  teleOut: '#6ee0d0',
  blockByWeight: ['#4fd08b', '#ffb454', '#ff7a7a'] as const,
};

/** 本拍高亮：subject -> 事件分类，用于给方块/玩家/格位描边 */
export interface Highlight {
  subject: string;
  tone: 'move' | 'cancel' | 'tele' | 'blocked';
}

export function eventsToHighlights(events: TickEvent[]): Highlight[] {
  const toneOf = (k: TickEvent['kind']): Highlight['tone'] => {
    if (k === 'belt-cancel' || k === 'push-blocked') return k === 'belt-cancel' ? 'cancel' : 'blocked';
    if (k === 'teleport' || k === 'teleport-blocked') return k === 'teleport' ? 'tele' : 'blocked';
    if (k === 'player-blocked') return 'blocked';
    return 'move';
  };
  // 同一对象多事件时，严重程度 cancel > blocked > tele > move
  const rank: Record<Highlight['tone'], number> = { move: 0, tele: 1, blocked: 2, cancel: 3 };
  const merged = new Map<string, Highlight['tone']>();
  for (const e of events) {
    const t = toneOf(e.kind);
    const old = merged.get(e.subject);
    if (old === undefined || rank[t] > rank[old]) merged.set(e.subject, t);
  }
  return [...merged.entries()].map(([subject, tone]) => ({ subject, tone }));
}

const toneColor: Record<Highlight['tone'], string> = {
  move: '#4fd08b',
  cancel: '#ff6b6b',
  tele: '#b18cff',
  blocked: '#ffb454',
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: keyof typeof DIR_VEC, size: number, color: string): void {
  const v = DIR_VEC[dir];
  const tip = { x: cx + v.x * size, y: cy + v.y * size };
  const base = { x: cx - v.x * size * 0.5, y: cy - v.y * size * 0.5 };
  const perp = { x: -v.y, y: v.x };
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(base.x + perp.x * size * 0.45, base.y + perp.y * size * 0.45);
  ctx.lineTo(base.x - perp.x * size * 0.45, base.y - perp.y * size * 0.45);
  ctx.closePath();
  ctx.fill();
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  highlights: Highlight[],
  hover: Pos | null,
): void {
  const { map } = state;
  const W = map.w * CELL;
  const H = map.h * CELL;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, W, H);

  const hlBySubject = new Map(highlights.map((h) => [h.subject, h.tone]));
  const hlAt = (x: number, y: number): Highlight['tone'] | undefined =>
    hlBySubject.get(`cell:${key(x, y)}`);

  // 网格
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= map.w; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL + 0.5, 0);
    ctx.lineTo(x * CELL + 0.5, H);
    ctx.stroke();
  }
  for (let y = 0; y <= map.h; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL + 0.5);
    ctx.lineTo(W, y * CELL + 0.5);
    ctx.stroke();
  }

  // 悬停格
  if (hover) {
    ctx.fillStyle = 'rgba(90,162,255,0.12)';
    ctx.fillRect(hover.x * CELL, hover.y * CELL, CELL, CELL);
  }

  // 输送带
  for (const [k, dir] of Object.entries(map.belts)) {
    const [x, y] = k.split(',').map(Number);
    ctx.fillStyle = COLORS.belt;
    ctx.fillRect(x * CELL + 3, y * CELL + 3, CELL - 6, CELL - 6);
    drawArrow(ctx, x * CELL + CELL / 2, y * CELL + CELL / 2, dir, CELL * 0.26, COLORS.beltArrow);
    const t = hlAt(x, y);
    if (t) {
      ctx.strokeStyle = toneColor[t];
      ctx.lineWidth = 3;
      ctx.strokeRect(x * CELL + 3, y * CELL + 3, CELL - 6, CELL - 6);
    }
  }

  // 墙
  for (const k of Object.keys(map.walls)) {
    const [x, y] = k.split(',').map(Number);
    ctx.fillStyle = COLORS.wall;
    roundRect(ctx, x * CELL + 4, y * CELL + 4, CELL - 8, CELL - 8, 8);
    ctx.fill();
    ctx.fillStyle = COLORS.wallTop;
    roundRect(ctx, x * CELL + 8, y * CELL + 8, CELL - 16, 10, 4);
    ctx.fill();
  }

  // 传送门
  for (const t of map.teles) {
    const cx = t.x * CELL + CELL / 2;
    const cy = t.y * CELL + CELL / 2;
    const color = t.kind === 'in' ? COLORS.teleIn : COLORS.teleOut;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${t.pairId}${t.kind === 'in' ? '入' : '出'}`, cx, cy);
  }

  // 方块（按重量配色，显示重量数字；本拍有事件则描边）
  for (const b of map.blocks) {
    const tone = hlBySubject.get(`block:${b.id}`);
    const px = b.x * CELL;
    const py = b.y * CELL;
    ctx.fillStyle = COLORS.blockByWeight[b.weight - 1];
    roundRect(ctx, px + 7, py + 7, CELL - 14, CELL - 14, 10);
    ctx.fill();
    ctx.fillStyle = '#101828';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(b.weight), px + CELL / 2, py + CELL / 2 - 6);
    ctx.font = '10px sans-serif';
    ctx.fillText(b.id, px + CELL / 2, py + CELL - 14);
    if (tone) {
      ctx.strokeStyle = toneColor[tone];
      ctx.lineWidth = 4;
      roundRect(ctx, px + 5, py + 5, CELL - 10, CELL - 10, 12);
      ctx.stroke();
    }
  }

  // 玩家
  {
    const tone = hlBySubject.get('player');
    const cx = map.player.x * CELL + CELL / 2;
    const cy = map.player.y * CELL + CELL / 2;
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0d1626';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', cx, cy);
    if (tone) {
      ctx.strokeStyle = toneColor[tone];
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
