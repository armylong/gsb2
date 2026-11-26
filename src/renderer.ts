import type { GameState } from './types.ts';
import { boxSeated } from './physics.ts';

const COLORS = {
  bg: '#14181f',
  wall: '#3a4456',
  wallEdge: '#5a6a86',
  slot: '#1f3d33',
  slotEdge: '#43c98c',
  slotFill: '#2b6b4f',
  box: '#d8a24a',
  boxEdge: '#f2c674',
  player: '#5fb4f0',
  playerEdge: '#bfe6ff',
  text: '#dfe7f2',
  danger: '#ff6b6b',
  accent: '#ffd166',
};

function roundRect(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 4);
}

export function render(ctx: CanvasRenderingContext2D, state: GameState, debug: boolean): void {
  const { room, player, box, gravity } = state;

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, room.width, room.height);

  // 检验槽
  for (const slot of room.slots) {
    // 对齐引导：把槽的 x 范围投影到对侧，方便在地面推箱时对准
    ctx.strokeStyle = 'rgba(67,201,140,0.35)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    const guideTop = slot.gravity === 'up' ? slot.y + slot.h : slot.y;
    const guideBottom = slot.gravity === 'up' ? room.height - room.wallThickness : room.wallThickness;
    for (const gx of [slot.x, slot.x + slot.w]) {
      ctx.beginPath();
      ctx.moveTo(gx, guideTop);
      ctx.lineTo(gx, guideBottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = COLORS.slot;
    ctx.strokeStyle = COLORS.slotEdge;
    ctx.lineWidth = 2;
    roundRect(ctx, slot);
    ctx.fill();
    ctx.stroke();
    // 槽内刻度线，表达“完整占据才算数”
    ctx.strokeStyle = 'rgba(67,201,140,0.45)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(slot.x + 4, slot.y + 4, slot.w - 8, slot.h - 8);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.slotEdge;
    ctx.font = '12px monospace';
    ctx.fillText(slot.gravity === 'up' ? '检验槽(上)' : '检验槽(下)', slot.x, slot.y - 6);
  }

  // 墙
  for (const wall of room.walls) {
    ctx.fillStyle = COLORS.wall;
    ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
    ctx.strokeStyle = COLORS.wallEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(wall.x + 0.5, wall.y + 0.5, wall.w - 1, wall.h - 1);
    if (debug) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '10px monospace';
      ctx.fillText(wall.tag, wall.x + 2, wall.y + 12);
    }
  }

  const seated = boxSeated(state);

  // 标本箱
  ctx.fillStyle = seated ? COLORS.slotFill : COLORS.box;
  ctx.strokeStyle = seated ? COLORS.slotEdge : COLORS.boxEdge;
  ctx.lineWidth = 2;
  roundRect(ctx, box);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(box.x + 6, box.y + box.h - 6);
  ctx.lineTo(box.x + box.w - 6, box.y + 6);
  ctx.moveTo(box.x + 6, box.y + 6);
  ctx.lineTo(box.x + box.w - 6, box.y + box.h - 6);
  ctx.stroke();

  // 玩家（朝向重力画小三角眼睛面）
  ctx.fillStyle = COLORS.player;
  ctx.strokeStyle = COLORS.playerEdge;
  ctx.lineWidth = 2;
  roundRect(ctx, player);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0d2233';
  const eyeY = gravity === 1 ? player.y + 12 : player.y + player.h - 12;
  ctx.fillRect(player.x + 7, eyeY - 2, 4, 4);
  ctx.fillRect(player.x + player.w - 11, eyeY - 2, 4, 4);

  // 重力指示：沿房间内侧整列箭头
  drawGravityArrows(ctx, state);

  // 调试层：接触点 / grounded / 速度
  if (debug) drawDebug(ctx, state);

  // 状态遮罩
  if (state.status === 'won') overlay(ctx, room, '✔ 标本已检验完成', '按 R 重开本关，或切换房间', COLORS.slotEdge);
  if (state.status === 'failed') overlay(ctx, room, '✘ 失败：发生挤压或穿透', '按 R 重开（也可点下方按钮）', COLORS.danger);
}

function drawGravityArrows(ctx: CanvasRenderingContext2D, state: GameState): void {
  const g = state.gravity;
  const x = state.room.width - 18;
  const span = state.room.height - 2 * state.room.wallThickness;
  const n = 5;
  ctx.fillStyle = state.flipPhase === 'flipping' ? COLORS.accent : 'rgba(223,231,242,0.55)';
  for (let i = 0; i < n; i += 1) {
    const cy = state.room.wallThickness + (span / (n - 1)) * i;
    ctx.beginPath();
    if (g === 1) {
      ctx.moveTo(x, cy + 7);
      ctx.lineTo(x - 6, cy - 3);
      ctx.lineTo(x + 6, cy - 3);
    } else {
      ctx.moveTo(x, cy - 7);
      ctx.lineTo(x - 6, cy + 3);
      ctx.lineTo(x + 6, cy + 3);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = COLORS.accent;
  ctx.textAlign = 'center';
  ctx.fillText(g === 1 ? 'GRAV ↓' : 'GRAV ↑', x, g === 1 ? state.room.height - 14 : 26);
  ctx.textAlign = 'left';
}

function drawDebug(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const b of [state.player, state.box]) {
    ctx.strokeStyle = b.grounded ? '#43c98c' : 'rgba(255,107,107,0.8)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px monospace';
    ctx.fillText(
      `${b.id} v=${b.vx.toFixed(0)},${b.vy.toFixed(0)} ${b.grounded ? 'grounded' : 'air'} [${[...b.contacts].join('|') || '-'}]`,
      b.x,
      b.y - 4,
    );
  }
}

function overlay(ctx: CanvasRenderingContext2D, room: GameState['room'], title: string, sub: string, color: string): void {
  ctx.fillStyle = 'rgba(10,14,20,0.72)';
  ctx.fillRect(0, 0, room.width, room.height);
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(title, room.width / 2, room.height / 2 - 8);
  ctx.fillStyle = COLORS.text;
  ctx.font = '16px sans-serif';
  ctx.fillText(sub, room.width / 2, room.height / 2 + 26);
  ctx.textAlign = 'left';
}
