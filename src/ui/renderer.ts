import { DIR_DELTA } from '../game/geometry.js';
import type { Dir, LevelDef, Placement, RuntimePiece, SimulationResult } from '../game/types.js';

export const CELL = 86;
export const MARGIN = 54;

export interface BoardLayout {
  width: number;
  height: number;
  cell: number;
  margin: number;
  center: (x: number, y: number) => { x: number; y: number };
}

export function layoutFor(level: LevelDef): BoardLayout {
  const width = MARGIN * 2 + Math.max(0, level.width - 1) * CELL;
  const height = MARGIN * 2 + Math.max(0, level.height - 1) * CELL;
  return {
    width,
    height,
    cell: CELL,
    margin: MARGIN,
    center: (x, y) => ({ x: MARGIN + x * CELL, y: MARGIN + y * CELL }),
  };
}

export function slotAtPoint(
  level: LevelDef,
  logicalX: number,
  logicalY: number,
): string | null {
  const layout = layoutFor(level);
  let best: string | null = null;
  let bestDistance = 38;
  for (const slot of level.slots) {
    const c = layout.center(slot.x, slot.y);
    const d = Math.hypot(logicalX - c.x, logicalY - c.y);
    if (d <= bestDistance) {
      bestDistance = d;
      best = slot.id;
    }
  }
  return best;
}

export interface RenderArgs {
  ctx: CanvasRenderingContext2D;
  level: LevelDef;
  placement: Placement[];
  toolType: 'thin' | 'wide';
  toolFacing: Dir;
  selectedSlotId: string | null;
  hoverSlotId: string | null;
  pointerInside: boolean;
  result: SimulationResult | null;
  viewMs: number;
  showLabels: boolean;
}

interface PieceView {
  piece: RuntimePiece | null;
  progress: number;
  beat: number;
}

export function renderGame(args: RenderArgs): void {
  const { ctx, level } = args;
  const layout = layoutFor(level);
  ctx.clearRect(0, 0, layout.width, layout.height);

  drawBoard(ctx, layout);
  drawConnections(ctx, args, layout);
  drawSlots(ctx, args, layout);
  drawGhost(ctx, args, layout);
  drawFixedAndPieces(ctx, args, layout);
  drawMapEvents(ctx, args, layout);
}

function drawBoard(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
  ctx.save();
  roundedRect(ctx, 8, 8, layout.width - 16, layout.height - 16, 28);
  const g = ctx.createLinearGradient(0, 0, layout.width, layout.height);
  g.addColorStop(0, '#f8edd6');
  g.addColorStop(1, '#ecd6ad');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#c6a66f';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(122, 84, 36, 0.10)';
  ctx.lineWidth = 1;
  for (let x = layout.margin; x < layout.width - layout.margin + 1; x += layout.cell) {
    ctx.beginPath();
    ctx.moveTo(x, layout.margin - 28);
    ctx.lineTo(x, layout.height - layout.margin + 28);
    ctx.stroke();
  }
  for (let y = layout.margin; y < layout.height - layout.margin + 1; y += layout.cell) {
    ctx.beginPath();
    ctx.moveTo(layout.margin - 28, y);
    ctx.lineTo(layout.width - layout.margin + 28, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawConnections(ctx: CanvasRenderingContext2D, args: RenderArgs, layout: BoardLayout): void {
  const placementMap = new Map(args.placement.map((p) => [p.slotId, p]));
  const fixedMap = new Map(args.level.fixed.map((f) => [f.slotId, f]));
  const edit = !args.result;

  for (const slot of args.level.slots) {
    const p = placementMap.get(slot.id);
    const f = fixedMap.get(slot.id);
    if (!p && (!f || (f.kind !== 'launcher' && f.kind !== 'gate'))) continue;
    const facing = p?.facing ?? f?.facing;
    if (!facing) continue;
    const dirs: Dir[] = p?.type === 'wide' ? [facing, rotateCW(facing)] : [facing];
    const from = layout.center(slot.x, slot.y);

    dirs.forEach((dir, i) => {
      const d = DIR_DELTA[dir];
      const end = { x: from.x + d.dx * 42, y: from.y + d.dy * 42 };
      ctx.save();
      ctx.globalAlpha = edit ? 0.58 : 0.22;
      ctx.strokeStyle = p?.type === 'wide' ? '#2563eb' : '#8a5a2b';
      ctx.lineWidth = i === 0 ? 4 : 3;
      ctx.setLineDash([8, 7]);
      ctx.beginPath();
      ctx.moveTo(from.x + d.dx * 20, from.y + d.dy * 20);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawArrowHead(ctx, end.x + d.dx * 8, end.y + d.dy * 8, dirAngle(dir), p?.type === 'wide' ? '#2563eb' : '#8a5a2b', 9);
      ctx.restore();
    });
  }
}

function drawSlots(ctx: CanvasRenderingContext2D, args: RenderArgs, layout: BoardLayout): void {
  const placementMap = new Map(args.placement.map((p) => [p.slotId, p]));
  const fixedSlots = new Set(args.level.fixed.map((f) => f.slotId));

  for (const slot of args.level.slots) {
    const c = layout.center(slot.x, slot.y);
    ctx.save();

    if (slot.forbidden) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.10)';
      roundedRect(ctx, c.x - 31, c.y - 31, 62, 62, 14);
      ctx.fill();
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#dc2626';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#b91c1c';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('禁碰', c.x, c.y + 48);
    } else if (slot.wideBase) {
      ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
      roundedRect(ctx, c.x - 31, c.y - 31, 62, 62, 14);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#60a5fa';
      ctx.stroke();
      ctx.fillStyle = '#1d4ed8';
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('宽槽', c.x, c.y + 48);
    } else {
      ctx.fillStyle = fixedSlots.has(slot.id) ? 'rgba(120, 90, 45, 0.10)' : '#e8d2a8';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c3a16b';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (args.selectedSlotId === slot.id) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 35, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (args.hoverSlotId === slot.id && args.pointerInside && !placementMap.has(slot.id) && !fixedSlots.has(slot.id)) {
      ctx.strokeStyle = 'rgba(202, 138, 4, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawGhost(ctx: CanvasRenderingContext2D, args: RenderArgs, layout: BoardLayout): void {
  if (args.result || !args.hoverSlotId || !args.pointerInside) return;
  const slot = args.level.slots.find((s) => s.id === args.hoverSlotId);
  if (!slot) return;
  const occupied = args.placement.some((p) => p.slotId === slot.id) || args.level.fixed.some((f) => f.slotId === slot.id);
  if (occupied) return;
  const c = layout.center(slot.x, slot.y);
  const invalid = args.toolType === 'wide' && !slot.wideBase;
  ctx.save();
  ctx.globalAlpha = 0.48;
  drawChip(ctx, c.x, c.y, args.toolType, args.toolFacing, invalid ? 0 : 0, { ghostInvalid: invalid });
  if (invalid) {
    ctx.fillStyle = '#b91c1c';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('宽片只能放宽槽', c.x, c.y - 42);
  }
  ctx.restore();
}

function drawFixedAndPieces(ctx: CanvasRenderingContext2D, args: RenderArgs, layout: BoardLayout): void {
  for (const fixed of args.level.fixed) {
    const slot = args.level.slots.find((s) => s.id === fixed.slotId);
    if (!slot) continue;
    const c = layout.center(slot.x, slot.y);
    const view = getPieceView(args.result, fixed.slotId, args.viewMs);
    const progress = view?.progress ?? 0;

    if (fixed.kind === 'post') drawPost(ctx, c.x, c.y);
    if (fixed.kind === 'launcher') {
      drawChip(ctx, c.x, c.y, 'launcher', fixed.facing ?? 'E', progress, {});
      drawName(ctx, c.x, c.y - 43, '启动', '#991b1b');
    }
    if (fixed.kind === 'gate') {
      drawGate(ctx, c.x, c.y, fixed.acceptDir ?? fixed.facing ?? 'E', progress);
      drawName(ctx, c.x, c.y - 43, '单向', '#6b21a8');
    }
    if (fixed.kind === 'flag') {
      const incoming = view?.piece?.incomingDir ?? 'E';
      drawFlag(ctx, c.x, c.y, fixed.flagId === 'flag-a' ? 'A' : 'B', fixed.flagId === 'flag-a' ? '#2563eb' : '#f97316', progress, incoming);
    }

    if (view?.piece?.status === 'falling') drawTimingBar(ctx, c.x, c.y + 42, view.piece, args.result?.beatMs ?? 100, view.progress);
  }

  for (const p of args.placement) {
    const slot = args.level.slots.find((s) => s.id === p.slotId);
    if (!slot) continue;
    const c = layout.center(slot.x, slot.y);
    const view = getPieceView(args.result, p.slotId, args.viewMs);
    const progress = args.result ? view?.progress ?? 0 : 0;
    drawChip(ctx, c.x, c.y, p.type, p.facing, progress, {});
    if (args.showLabels && view?.piece?.status === 'falling') {
      drawTimingBar(ctx, c.x, c.y + 43, view.piece, args.result?.beatMs ?? 100, view.progress);
    }
  }
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: 'thin' | 'wide' | 'launcher',
  facing: Dir,
  progress: number,
  opts: { ghostInvalid?: boolean },
): void {
  const p = easeIn(progress);
  const baseLength = kind === 'wide' ? 42 : 38;
  const fallenLength = kind === 'wide' ? 76 : 72;
  const length = baseLength + (fallenLength - baseLength) * p;
  const width = kind === 'wide' ? 38 : kind === 'launcher' ? 27 : 22;
  const shift = p * 13;
  const angle = dirAngle(facing);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.translate(shift, 0);
  ctx.shadowColor = 'rgba(74, 45, 18, 0.28)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;

  const fill = opts.ghostInvalid
    ? '#fca5a5'
    : kind === 'launcher'
      ? '#dc2626'
      : kind === 'wide'
        ? '#a8642e'
        : '#cf8f4e';
  roundedRect(ctx, -length / 2, -width / 2, length, width, 8);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = kind === 'launcher' ? '#7f1d1d' : '#6f421f';
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  roundedRect(ctx, -length / 2 + 5, -width / 2 + 4, length - 10, 5, 3);
  ctx.fill();

  // 前端碰撞指示
  ctx.fillStyle = kind === 'launcher' ? '#fee2e2' : '#fff7ed';
  ctx.beginPath();
  ctx.moveTo(length / 2 - 5, 0);
  ctx.lineTo(length / 2 - 15, -6);
  ctx.lineTo(length / 2 - 15, 6);
  ctx.closePath();
  ctx.fill();

  if (kind === 'wide') {
    ctx.strokeStyle = '#bfdbfe';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-8, width / 2 - 3);
    ctx.lineTo(-8, width / 2 + 10);
    ctx.stroke();
    drawArrowHead(ctx, -8, width / 2 + 15, Math.PI / 2, '#bfdbfe', 7);
    ctx.fillStyle = '#dbeafe';
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('宽', -4, 4);
  }
  ctx.restore();

  if (progress >= 1) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#5b3416';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawPost(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.25)';
  ctx.shadowBlur = 7;
  ctx.fillStyle = '#7b8494';
  ctx.beginPath();
  ctx.arc(x, y + 3, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const g = ctx.createRadialGradient(x - 6, y - 8, 3, x, y, 20);
  g.addColorStop(0, '#d1d5db');
  g.addColorStop(1, '#6b7280');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#374151';
  ctx.font = '800 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('柱', x, y + 4);
  ctx.restore();
}

function drawGate(ctx: CanvasRenderingContext2D, x: number, y: number, acceptDir: Dir, progress: number): void {
  const p = easeIn(progress);
  ctx.save();
  ctx.translate(x, y);
  if (p > 0) ctx.rotate(dirAngle(acceptDir) * p * 0.7);
  ctx.fillStyle = '#f3e8ff';
  roundedRect(ctx, -25, -25, 50, 50, 12);
  ctx.fill();
  ctx.strokeStyle = '#7e22ce';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.save();
  ctx.rotate(dirAngle(acceptDir));
  ctx.strokeStyle = '#7e22ce';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-12, 0);
  ctx.lineTo(12, 0);
  ctx.stroke();
  drawArrowHead(ctx, 17, 0, 0, '#7e22ce', 10);
  ctx.restore();

  ctx.fillStyle = '#6b21a8';
  ctx.font = '800 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('单向', 0, 39);
  ctx.restore();
}

function drawFlag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  color: string,
  progress: number,
  fallDir: Dir,
): void {
  const p = easeIn(progress);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(dirAngle(fallDir) * p * 0.85);
  ctx.strokeStyle = '#5b4636';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 24);
  ctx.lineTo(0, -27);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -27);
  ctx.lineTo(30, -19);
  ctx.lineTo(0, -10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = '900 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, 11, -16);
  ctx.restore();

  if (progress >= 1) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '800 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${label} 已落地`, x, y + 48);
    ctx.restore();
  }
}

function drawMapEvents(ctx: CanvasRenderingContext2D, args: RenderArgs, layout: BoardLayout): void {
  const result = args.result;
  if (!result) return;
  const visibleBeat = Math.floor(args.viewMs / result.beatMs);
  const recentGroups = new Map<string, { x: number; y: number; text: string; color: string }>();

  for (const collision of result.collisions) {
    if (collision.beat > visibleBeat) continue;
    const targetSlot = collision.targetSlotId ? args.level.slots.find((s) => s.id === collision.targetSlotId) : undefined;
    if (!targetSlot) continue;
    const c = layout.center(targetSlot.x, targetSlot.y);
    const ageMs = args.viewMs - collision.beat * result.beatMs;

    if (ageMs >= 0 && ageMs < 650 && (collision.outcome === 'triggered' || collision.outcome === 'merged-same-beat')) {
      const t = ageMs / 650;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = collision.outcome === 'triggered' ? '#16a34a' : '#7c3aed';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 24 + t * 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (collision.outcome === 'blocked-post') {
      recentGroups.set(`block-${collision.targetSlotId}`, {
        x: c.x,
        y: c.y - 55,
        text: '挡柱挡住',
        color: '#b91c1c',
      });
    }
    if (collision.outcome === 'blocked-wrong-side') {
      recentGroups.set(`gate-${collision.targetSlotId}`, {
        x: c.x,
        y: c.y - 58,
        text: '单向片：入射侧不对',
        color: '#7e22ce',
      });
    }
    if (collision.simultaneous && collision.outcome === 'merged-same-beat') {
      recentGroups.set(`same-${collision.groupId}`, {
        x: c.x + 42,
        y: c.y - 34,
        text: '同拍×2 合并',
        color: '#6d28d9',
      });
    }
    if (collision.outcome === 'already-fallen') {
      recentGroups.set(`fallen-${collision.targetSlotId}-${collision.beat}`, {
        x: c.x + 44,
        y: c.y + 35,
        text: '已躺下，不重复触发',
        color: '#4b5563',
      });
    }
  }

  if (args.showLabels !== false) {
    for (const item of recentGroups.values()) drawPill(ctx, item.x, item.y, item.text, item.color);
  }
}

function drawTimingBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  piece: RuntimePiece,
  beatMs: number,
  progress: number,
): void {
  if (piece.touchedBeat === null || piece.landBeat === null) return;
  const totalMs = (piece.landBeat - piece.touchedBeat) * beatMs;
  const width = 68;
  ctx.save();
  ctx.fillStyle = 'rgba(31, 41, 55, .82)';
  roundedRect(ctx, x - width / 2, y - 10, width, 19, 9);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  roundedRect(ctx, x - width / 2 + 3, y - 7, width - 6, 5, 3);
  ctx.fill();
  ctx.fillStyle = '#fbbf24';
  roundedRect(ctx, x - width / 2 + 3, y - 7, (width - 6) * clamp(progress, 0, 1), 5, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '800 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${(totalMs / 1000).toFixed(1)}s`, x, y + 7);
  ctx.restore();
}

function getPieceView(result: SimulationResult | null, slotId: string, viewMs: number): PieceView | null {
  if (!result) return null;
  const beatMs = result.beatMs;
  const beat = Math.max(0, Math.min(result.lastBeat, Math.floor(viewMs / beatMs)));
  const snap = result.snapshots[beat] ?? result.snapshots[result.snapshots.length - 1];
  const piece = snap?.pieces.find((p) => p.slotId === slotId) ?? null;
  if (!piece) return { piece: null, progress: 0, beat };
  if (piece.status === 'fallen') return { piece, progress: 1, beat };
  if (piece.status === 'falling' && piece.touchedBeat !== null && piece.landBeat !== null) {
    const start = piece.touchedBeat * beatMs;
    const end = piece.landBeat * beatMs;
    return { piece, progress: clamp((viewMs - start) / Math.max(1, end - start), 0, 1), beat };
  }
  return { piece, progress: 0, beat };
}

function drawName(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.save();
  ctx.font = '800 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.save();
  ctx.font = '800 12px system-ui, sans-serif';
  const width = ctx.measureText(text).width + 18;
  roundedRect(ctx, x - width / 2, y - 15, width, 24, 12);
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y + 2);
  ctx.restore();
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 1.7, -size * 0.75);
  ctx.lineTo(-size * 1.7, size * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function dirAngle(dir: Dir): number {
  return { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 }[dir];
}

function rotateCW(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'E', E: 'S', S: 'W', W: 'N' };
  return map[dir];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function easeIn(t: number): number {
  return t * t;
}
