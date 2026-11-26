import { FRAME_LENGTH, FRAME_WIDTH, PORTER_RADIUS, VIEW_H, VIEW_W } from './types';
import type { Level } from './types';
import type { GameState } from './engine';
import { frameOBB, type BlockInfo, type Vec } from './geom';

export interface RenderOptions {
  level: Level;
  state: GameState;
  ghost?: GameState | null;
  block?: (BlockInfo & { atTime: number }) | null;
  now: number;
  dragging?: boolean;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawFloor(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#f6f1e7';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.fillStyle = 'rgba(100, 116, 139, 0.10)';
  for (let x = 30; x < VIEW_W; x += 34) {
    for (let y = 30; y < VIEW_H; y += 34) {
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWalls(ctx: CanvasRenderingContext2D, level: Level): void {
  for (const w of level.walls) {
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.22)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 4;
    roundRectPath(ctx, w.x, w.y, w.w, w.h, Math.min(10, w.w / 3, w.h / 3));
    const grad = ctx.createLinearGradient(w.x, w.y, w.x, w.y + w.h);
    grad.addColorStop(0, '#64748b');
    grad.addColorStop(1, '#334155');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    roundRectPath(ctx, w.x + 3, w.y + 3, Math.max(0, w.w - 6), Math.max(0, Math.min(8, w.h - 6)), 5);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill();

    if (w.w < 60 || w.h < 60) {
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const horizontal = w.w >= w.h;
      ctx.save();
      ctx.translate(w.x + w.w / 2, w.y + w.h / 2);
      if (!horizontal) ctx.rotate(-Math.PI / 2);
      ctx.fillText(w.name ?? '', 0, 0);
      ctx.restore();
    }
  }
}

function drawPad(ctx: CanvasRenderingContext2D, pad: Level['pads'][number], active: boolean): void {
  ctx.save();
  roundRectPath(ctx, pad.x, pad.y, pad.w, pad.h, 18);
  ctx.fillStyle = active ? 'rgba(34,197,94,0.20)' : 'rgba(34,197,94,0.10)';
  ctx.fill();
  ctx.setLineDash([12, 9]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = active ? '#15803d' : 'rgba(22,163,74,0.75)';
  ctx.stroke();
  ctx.setLineDash([]);

  const compact = pad.w < 140;
  ctx.fillStyle = '#166534';
  ctx.font = `800 ${compact ? 15 : 16}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(pad.label, pad.x + 12, pad.y + 12);
  ctx.font = '500 13px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(22,101,52,0.78)';
  ctx.fillText(compact ? '可落地换手' : '可落地 / 换把手', pad.x + 12, pad.y + 34);
  ctx.restore();
}

function drawGoal(ctx: CanvasRenderingContext2D, goal: Level['goal']): void {
  ctx.save();
  const cx = goal.x + goal.w / 2;
  const cy = goal.y + goal.h / 2;
  ctx.translate(cx, cy);
  ctx.rotate(goal.angle);
  // After rotating, draw a horizontal rack; dimensions swap for vertical goals.
  const horizontal = Math.abs(Math.cos(goal.angle)) > 0.5;
  const rw = horizontal ? goal.w : goal.h;
  const rh = horizontal ? goal.h : goal.w;

  roundRectPath(ctx, -rw / 2, -rh / 2, rw, rh, 12);
  ctx.fillStyle = 'rgba(99,102,241,0.10)';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.setLineDash([16, 10]);
  ctx.strokeStyle = '#4f46e5';
  ctx.stroke();
  ctx.setLineDash([]);

  // Direction marker: three arrows along the rack's long axis.
  ctx.strokeStyle = 'rgba(79,70,229,0.75)';
  ctx.fillStyle = 'rgba(79,70,229,0.75)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const x of [-rw * 0.28, 0, rw * 0.28]) {
    ctx.beginPath();
    ctx.moveTo(x - 10, -rh * 0.28);
    ctx.lineTo(x, -rh * 0.12);
    ctx.lineTo(x + 10, -rh * 0.28);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = '#3730a3';
  ctx.font = '800 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(goal.label, cx, goal.y - 8);
}

function drawFrameAt(
  ctx: CanvasRenderingContext2D,
  h: [Vec, Vec],
  options: { alpha?: number; ghost?: boolean; label?: boolean } = {},
): void {
  const obb = frameOBB(h[0]!, h[1]!, FRAME_LENGTH, FRAME_WIDTH);
  const alpha = options.alpha ?? 1;
  ctx.save();
  ctx.globalAlpha = alpha;

  // Shadow
  if (!options.ghost) {
    ctx.save();
    ctx.translate(obb.cx + 4, obb.cy + 7);
    ctx.rotate(obb.angle);
    roundRectPath(ctx, -FRAME_LENGTH / 2, -FRAME_WIDTH / 2, FRAME_LENGTH, FRAME_WIDTH, 7);
    ctx.fillStyle = 'rgba(15,23,42,0.22)';
    ctx.fill();
    ctx.restore();
  }

  ctx.translate(obb.cx, obb.cy);
  ctx.rotate(obb.angle);

  // Rods from the actual frame to the two rigid handles.
  ctx.strokeStyle = options.ghost ? 'rgba(22,163,74,0.55)' : '#78350f';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  const handleOffset = 90;
  const frameEnd = FRAME_LENGTH / 2;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sign * frameEnd, 0);
    ctx.lineTo(sign * handleOffset, 0);
    ctx.stroke();
  }

  roundRectPath(ctx, -FRAME_LENGTH / 2, -FRAME_WIDTH / 2, FRAME_LENGTH, FRAME_WIDTH, 7);
  if (options.ghost) {
    ctx.fillStyle = 'rgba(34,197,94,0.16)';
    ctx.strokeStyle = 'rgba(22,163,74,0.85)';
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 7]);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    const grad = ctx.createLinearGradient(0, -FRAME_WIDTH / 2, 0, FRAME_WIDTH / 2);
    grad.addColorStop(0, '#d97706');
    grad.addColorStop(0.45, '#92400e');
    grad.addColorStop(1, '#78350f');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#451a03';
    ctx.stroke();

    roundRectPath(ctx, -FRAME_LENGTH / 2 + 10, -FRAME_WIDTH / 2 + 6, FRAME_LENGTH - 20, FRAME_WIDTH - 12, 4);
    ctx.fillStyle = '#fde68a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,53,15,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Abstract painting stripe.
    ctx.strokeStyle = 'rgba(37,99,235,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-42, 2);
    ctx.bezierCurveTo(-20, -10, 8, 12, 38, -3);
    ctx.stroke();
  }

  // Handle bars in local coordinates.
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(sign * handleOffset, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = options.ghost ? 'rgba(22,163,74,0.5)' : '#111827';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e5e7eb';
    ctx.stroke();
  }
  ctx.restore();
}

function drawPorter(
  ctx: CanvasRenderingContext2D,
  p: Vec,
  index: 0 | 1,
  held: boolean,
  now: number,
  ghost = false,
): void {
  const color = index === 0 ? '#2563eb' : '#f97316';
  ctx.save();
  ctx.globalAlpha = ghost ? 0.35 : 1;

  if (held) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PORTER_RADIUS + 7 + Math.sin(now / 260 + index) * 1.2, 0, Math.PI * 2);
    ctx.strokeStyle = index === 0 ? 'rgba(37,99,235,0.35)' : 'rgba(249,115,22,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(p.x + 2, p.y + 4, PORTER_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15,23,42,0.20)';
  ctx.fill();

  const grad = ctx.createRadialGradient(p.x - 5, p.y - 6, 3, p.x, p.y, PORTER_RADIUS);
  grad.addColorStop(0, index === 0 ? '#93c5fd' : '#fed7aa');
  grad.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(p.x, p.y, PORTER_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(index === 0 ? '蓝' : '橙', p.x, p.y + 0.5);
  ctx.restore();
}

function drawBlockMarker(ctx: CanvasRenderingContext2D, block: BlockInfo & { atTime: number }, now: number): void {
  const age = now - block.atTime;
  if (age > 2600) return;
  const pulse = 1 + Math.sin(now / 90) * 0.12;
  ctx.save();
  ctx.translate(block.at.x, block.at.y);
  ctx.scale(pulse, pulse);
  ctx.beginPath();
  ctx.arc(0, 0, 24, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(220,38,38,0.18)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#dc2626';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-9, -9);
  ctx.lineTo(9, 9);
  ctx.moveTo(9, -9);
  ctx.lineTo(-9, 9);
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

export function renderGame(ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const { level, state, ghost, block, now } = opts;
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  drawFloor(ctx);

  for (const pad of level.pads) {
    const active = state.mode === 'ground' && state.groundedPad === pad.id;
    drawPad(ctx, pad, active);
  }

  drawGoal(ctx, level.goal);
  drawWalls(ctx, level);

  if (ghost) {
    drawFrameAt(ctx, ghost.h, { alpha: 0.55, ghost: true });
    drawPorter(ctx, ghost.people[0]!, 0, false, now, true);
    drawPorter(ctx, ghost.people[1]!, 1, false, now, true);
  }

  // Connect detached people to handles with faint reach guides.
  if (state.mode === 'ground') {
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.lineWidth = 2;
    for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
      for (const h of state.h) {
        ctx.beginPath();
        ctx.moveTo(state.people[i]!.x, state.people[i]!.y);
        ctx.lineTo(h.x, h.y);
        ctx.strokeStyle = 'rgba(71,85,105,0.22)';
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawFrameAt(ctx, state.h);
  drawPorter(ctx, state.people[0]!, 0, state.mode === 'carry', now);
  drawPorter(ctx, state.people[1]!, 1, state.mode === 'carry', now);

  if (block) drawBlockMarker(ctx, block, now);

  // Subtle canvas border.
  ctx.strokeStyle = 'rgba(15,23,42,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, VIEW_W - 2, VIEW_H - 2);
}
