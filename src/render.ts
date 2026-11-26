import {
  DIR_ARROW,
  DIRS,
  physicalCol,
  localColForPhysical,
  posKey,
  SIDES,
  type Dir,
  type GameState,
  type Level,
  type SideId,
  type StepInfo,
} from './engine.js';

export const VIEW_W = 1200;
export const VIEW_H = 748;

const CELL = 60;
const GRID_W = 7 * CELL;
const GRID_H = 7 * CELL;
const GRID_Y = 214;

const PANEL = { w: 530, h: 560, y: 112, radius: 26 };
const GRID_X: Record<SideId, number> = {
  inside: 90,
  outside: 690,
};
const PANEL_X: Record<SideId, number> = {
  inside: 35,
  outside: 635,
};

export type VisualPositions = Record<SideId, { r: number; c: number }>;

export interface DrawOptions {
  level: Level;
  state: GameState;
  visual: VisualPositions;
  now: number;
  hintDir: Dir | null;
  lastInfo: StepInfo | null;
  lastActionAt: number;
  replaying: boolean;
}

function cellCenter(side: SideId, r: number, c: number): { x: number; y: number } {
  return {
    x: GRID_X[side] + c * CELL + CELL / 2,
    y: GRID_Y + r * CELL + CELL / 2,
  };
}

function roundedRect(
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

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const bg = ctx.createLinearGradient(0, 0, VIEW_W, VIEW_H);
  bg.addColorStop(0, '#07111f');
  bg.addColorStop(0.55, '#101d36');
  bg.addColorStop(1, '#0b1628');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 26; i += 1) {
    const x = (i * 173) % VIEW_W;
    const y = (i * 97) % VIEW_H;
    ctx.fillStyle = i % 2 ? '#1d4ed8' : '#0891b2';
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.font = '700 30px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText('两只清洁甲虫的镜像玻璃窗', VIEW_W / 2, 48);
  ctx.font = '500 16px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = '#a5b4fc';
  ctx.fillText('同一枚方向键 · 两张各自读数的视图 · 横向物理坐标镜像', VIEW_W / 2, 76);
}

function drawPanel(ctx: CanvasRenderingContext2D, side: SideId, level: Level): void {
  const x = PANEL_X[side];
  const title = side === 'inside' ? '玻璃内侧视图' : '玻璃外侧视图 · 水平镜像';
  const accent = side === 'inside' ? '#f59e0b' : '#22d3ee';

  ctx.save();
  roundedRect(ctx, x, PANEL.y, PANEL.w, PANEL.h, PANEL.radius);
  const glass = ctx.createLinearGradient(x, PANEL.y, x + PANEL.w, PANEL.y + PANEL.h);
  glass.addColorStop(0, 'rgba(255,255,255,0.10)');
  glass.addColorStop(1, 'rgba(255,255,255,0.035)');
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.strokeStyle = 'rgba(226,232,240,0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.font = '700 22px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(title, x + 28, PANEL.y + 42);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + 30, PANEL.y + 66, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '500 14px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(side === 'inside' ? '琥珀甲虫 A' : '青蓝甲虫 B', x + 44, PANEL.y + 71);

  // Grid backing.
  ctx.fillStyle = 'rgba(2,6,23,0.42)';
  roundedRect(ctx, GRID_X[side] - 8, GRID_Y - 8, GRID_W + 16, GRID_H + 16, 18);
  ctx.fill();
  ctx.restore();

  drawColumnHeaders(ctx, side, level);
}

function drawColumnHeaders(ctx: CanvasRenderingContext2D, side: SideId, level: Level): void {
  const guideLocal = localColForPhysical(side, level.guidePhysicalCol, level.cols);
  ctx.textAlign = 'center';
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  for (let c = 0; c < level.cols; c += 1) {
    const x = GRID_X[side] + c * CELL + CELL / 2;
    const phys = physicalCol(side, c, level.cols);
    const isGuide = c === guideLocal;
    ctx.fillStyle = isGuide ? '#fde68a' : '#7c8da8';
    ctx.fillText(`P${phys}`, x, GRID_Y - 18);
  }
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  for (let c = 0; c < level.cols; c += 1) {
    const x = GRID_X[side] + c * CELL + CELL / 2;
    ctx.fillStyle = c === guideLocal ? '#fde68a' : '#64748b';
    ctx.fillText(`视图列 ${c + 1}`, x, GRID_Y + GRID_H + 24);
  }
}

function drawGuideColumn(ctx: CanvasRenderingContext2D, side: SideId, level: Level, now: number): void {
  const c = localColForPhysical(side, level.guidePhysicalCol, level.cols);
  const x = GRID_X[side] + c * CELL + 3;
  const pulse = 0.08 + 0.05 * (0.5 + 0.5 * Math.sin(now / 420));
  ctx.save();
  roundedRect(ctx, x, GRID_Y + 3, CELL - 6, GRID_H - 6, 12);
  ctx.fillStyle = `rgba(250, 204, 21, ${pulse})`;
  ctx.fill();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.82)';
  ctx.stroke();
  ctx.restore();
}

function drawCells(ctx: CanvasRenderingContext2D, side: SideId, level: Level): void {
  for (let r = 0; r < level.rows; r += 1) {
    for (let c = 0; c < level.cols; c += 1) {
      const x = GRID_X[side] + c * CELL;
      const y = GRID_Y + r * CELL;
      ctx.fillStyle = (r + c) % 2 === 0 ? 'rgba(255,255,255,0.052)' : 'rgba(255,255,255,0.025)';
      roundedRect(ctx, x + 1.5, y + 1.5, CELL - 3, CELL - 3, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(226,232,240,0.07)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawWalls(ctx: CanvasRenderingContext2D, side: SideId, level: Level): void {
  for (const wall of level.walls[side]) {
    const x = GRID_X[side] + wall.c * CELL + 5;
    const y = GRID_Y + wall.r * CELL + 5;
    const size = CELL - 10;
    const grad = ctx.createLinearGradient(x, y, x, y + size);
    grad.addColorStop(0, '#475569');
    grad.addColorStop(1, '#1e293b');
    roundedRect(ctx, x, y, size, size, 11);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = 'rgba(226,232,240,0.16)';
    const speckles: Array<[number, number, number]> = [
      [x + size * 0.28, y + size * 0.3, 3],
      [x + size * 0.68, y + size * 0.62, 4],
      [x + size * 0.42, y + size * 0.72, 2.5],
    ];
    for (const [sx, sy, radius] of speckles) {
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawTargets(ctx: CanvasRenderingContext2D, side: SideId, level: Level, now: number): void {
  for (const target of level.targets.filter((t) => t.side === side)) {
    const { x, y } = cellCenter(side, target.pos.r, target.pos.c);
    const pulse = 1 + 0.06 * Math.sin(now / 360);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = `${target.color}22`;
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = target.color;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = target.color;
    ctx.font = '800 20px "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('目', 0, 1);
    ctx.restore();
  }
}

function drawDoors(ctx: CanvasRenderingContext2D, side: SideId, level: Level, state: GameState): void {
  for (const door of level.doors) {
    const p = door.at[side];
    const x = GRID_X[side] + p.c * CELL + 5;
    const y = GRID_Y + p.r * CELL + 5;
    const w = CELL - 10;
    const open = Boolean(state.doors[door.id]);

    ctx.save();
    if (open) {
      roundedRect(ctx, x, y, w, w, 10);
      ctx.fillStyle = 'rgba(16,185,129,0.13)';
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(52,211,153,0.9)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#6ee7b7';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + 13, y + w / 2);
      ctx.lineTo(x + 23, y + w / 2 - 8);
      ctx.moveTo(x + 23, y + w / 2);
      ctx.lineTo(x + 13, y + w / 2 + 8);
      ctx.moveTo(x + w - 13, y + w / 2);
      ctx.lineTo(x + w - 23, y + w / 2 - 8);
      ctx.moveTo(x + w - 23, y + w / 2);
      ctx.lineTo(x + w - 13, y + w / 2 + 8);
      ctx.stroke();
    } else {
      const grad = ctx.createLinearGradient(x, y, x + w, y + w);
      grad.addColorStop(0, 'rgba(196,181,253,0.42)');
      grad.addColorStop(1, 'rgba(124,58,237,0.42)');
      roundedRect(ctx, x, y, w, w, 10);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(237,233,254,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + 8);
      ctx.lineTo(x + w / 2, y + w - 8);
      ctx.stroke();
      ctx.fillStyle = '#ede9fe';
      for (const offset of [-5, 5]) {
        ctx.beginPath();
        ctx.arc(x + w / 2 + offset, y + w / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  side: SideId,
  level: Level,
  state: GameState,
  now: number,
): void {
  for (const marker of level.markers) {
    const p = marker.at[side];
    const { x, y } = cellCenter(side, p.r, p.c);
    const used = marker.kind === 'once' && Boolean(state.used[marker.id]);
    const together =
      posKey(state.pos.inside) === posKey(marker.at.inside) &&
      posKey(state.pos.outside) === posKey(marker.at.outside);
    const color = used ? '#64748b' : marker.kind === 'once' ? '#fbbf24' : '#f472b6';

    ctx.save();
    ctx.translate(x, y);

    if (!used) {
      const ringRadius = 22 + 4 * Math.sin(now / 300 + (together ? 1 : 0));
      ctx.strokeStyle = `${color}88`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.rotate(Math.PI / 4);
    roundedRect(ctx, -14, -14, 28, 28, 7);
    ctx.fillStyle = used ? 'rgba(100,116,139,0.28)' : `${color}33`;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.rotate(-Math.PI / 4);

    ctx.fillStyle = color;
    ctx.font = '900 17px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(marker.kind === 'once' ? 'K' : 'S', 0, 1);

    if (used) {
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(9, -10);
      ctx.lineTo(15, -4);
      ctx.lineTo(24, -15);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawBeetle(
  ctx: CanvasRenderingContext2D,
  side: SideId,
  visual: { r: number; c: number },
  dir: Dir | null,
  now: number,
): void {
  const { x, y } = cellCenter(side, visual.r, visual.c);
  const base = side === 'inside' ? '#f59e0b' : '#22d3ee';
  const dark = side === 'inside' ? '#b45309' : '#0e7490';
  const wobble = Math.sin(now / 130 + (side === 'inside' ? 0 : 1.7)) * 1.5;

  ctx.save();
  ctx.translate(x, y + wobble * 0.25);

  // Legs.
  ctx.strokeStyle = 'rgba(15,23,42,0.72)';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  for (const yy of [-9, 0, 9]) {
    ctx.beginPath();
    ctx.moveTo(-13, yy);
    ctx.lineTo(-22, yy - 5);
    ctx.moveTo(13, yy);
    ctx.lineTo(22, yy - 5);
    ctx.stroke();
  }

  // Shadow.
  ctx.fillStyle = 'rgba(2,6,23,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 18, 19, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body.
  const body = ctx.createRadialGradient(-7, -10, 4, 0, 0, 25);
  body.addColorStop(0, '#fef3c7');
  body.addColorStop(0.25, base);
  body.addColorStop(1, dark);
  ctx.fillStyle = body;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 2, 18, 23, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Wing split and spots.
  ctx.strokeStyle = 'rgba(69,26,3,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -17);
  ctx.quadraticCurveTo(-2, 2, 0, 22);
  ctx.stroke();
  ctx.fillStyle = 'rgba(120,53,15,0.42)';
  for (const [sx, sy] of [[-8, -2], [8, 3], [-7, 11], [7, 14]] as const) {
    ctx.beginPath();
    ctx.arc(sx, sy, 2.7, 0, Math.PI * 2);
    ctx.fill();
  }

  // Head and antennae.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(0, -19, 10, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-5, -25);
  ctx.quadraticCurveTo(-12, -33, -16, -29);
  ctx.moveTo(5, -25);
  ctx.quadraticCurveTo(12, -33, 16, -29);
  ctx.stroke();

  // Eyes look toward the latest direction.
  const look = dir ? DIRS[dir] : { r: 0, c: 0 };
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-3.5 + look.c * 1.6, -20 + look.r * 1.2, 2.4, 0, Math.PI * 2);
  ctx.arc(3.5 + look.c * 1.6, -20 + look.r * 1.2, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(-3 + look.c * 2.2, -20 + look.r * 1.7, 1.1, 0, Math.PI * 2);
  ctx.arc(4 + look.c * 2.2, -20 + look.r * 1.7, 1.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawBlockedFeedback(ctx: CanvasRenderingContext2D, opts: DrawOptions, side: SideId): void {
  const info = opts.lastInfo;
  if (!info || opts.now - opts.lastActionAt > 650) return;
  const reason = info.blockedReason[side];
  if (!reason) return;
  const p = opts.state.pos[side];
  const { x, y } = cellCenter(side, p.r, p.c);
  const alpha = Math.max(0, 1 - (opts.now - opts.lastActionAt) / 650);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#fb7185';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x, y, 27 + 5 * (1 - alpha), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#fecdd3';
  ctx.font = '800 15px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  const text = reason === 'wall' ? '被墙拦住' : reason === 'closed-door' ? '门未开' : '边界';
  ctx.fillText(text, x, y - 34);
  ctx.restore();
}

function drawHintArrows(ctx: CanvasRenderingContext2D, opts: DrawOptions, side: SideId): void {
  const dir = opts.hintDir;
  if (!dir) return;
  const visual = opts.visual[side];
  const { x, y } = cellCenter(side, visual.r, visual.c);
  const bob = Math.sin(opts.now / 220) * 4;
  ctx.save();
  ctx.translate(x, y - 48 + bob);
  ctx.fillStyle = 'rgba(74,222,128,0.95)';
  ctx.strokeStyle = 'rgba(5,46,22,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#052e16';
  ctx.font = '900 20px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(DIR_ARROW[dir], 0, 1);
  ctx.restore();
}

function drawMirrorConnector(ctx: CanvasRenderingContext2D, level: Level, now: number): void {
  const insideC = localColForPhysical('inside', level.guidePhysicalCol, level.cols);
  const outsideC = localColForPhysical('outside', level.guidePhysicalCol, level.cols);
  const a = cellCenter('inside', 0, insideC);
  const b = cellCenter('outside', 0, outsideC);
  const chipY = 98;
  const anchorY = GRID_Y - 27;
  const pulse = 0.55 + 0.25 * Math.sin(now / 500);

  ctx.save();
  ctx.setLineDash([7, 7]);
  ctx.lineDashOffset = -now / 40;
  ctx.strokeStyle = `rgba(250,204,21,${pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a.x, anchorY);
  ctx.quadraticCurveTo(a.x, 132, 600, chipY + 16);
  ctx.quadraticCurveTo(b.x, 132, b.x, anchorY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Small pins make it obvious which two column headers are connected.
  for (const x of [a.x, b.x]) {
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(x, anchorY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const label = `同一物理列 P${level.guidePhysicalCol}`;
  ctx.font = '800 14px "PingFang SC", system-ui, sans-serif';
  const width = ctx.measureText(label).width + 28;
  roundedRect(ctx, 600 - width / 2, chipY - 17, width, 30, 15);
  ctx.fillStyle = 'rgba(113,63,18,0.96)';
  ctx.fill();
  ctx.strokeStyle = '#facc15';
  ctx.stroke();
  ctx.fillStyle = '#fef3c7';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 600, chipY - 1);
  ctx.restore();
}

function drawWinBanner(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = 'rgba(6,78,59,0.88)';
  roundedRect(ctx, 390, 318, 420, 92, 24);
  ctx.fill();
  ctx.strokeStyle = '#6ee7b7';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ecfdf5';
  ctx.textAlign = 'center';
  ctx.font = '900 34px "PingFang SC", system-ui, sans-serif';
  ctx.fillText('两只甲虫都到齐了！', 600, 356);
  ctx.font = '600 16px "PingFang SC", system-ui, sans-serif';
  ctx.fillStyle = '#a7f3d0';
  ctx.fillText('颜色对应，同时停在各自目标格', 600, 386);
  ctx.restore();
}

export function drawScene(ctx: CanvasRenderingContext2D, opts: DrawOptions): void {
  const { level, state } = opts;
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  drawBackground(ctx);

  for (const side of SIDES) {
    drawPanel(ctx, side, level);
    drawGuideColumn(ctx, side, level, opts.now);
    drawCells(ctx, side, level);
    drawWalls(ctx, side, level);
    drawTargets(ctx, side, level, opts.now);
    drawDoors(ctx, side, level, state);
    drawMarker(ctx, side, level, state, opts.now);
  }

  drawMirrorConnector(ctx, level, opts.now);

  for (const side of SIDES) {
    drawBeetle(ctx, side, opts.visual[side], opts.lastInfo?.dir ?? null, opts.now);
    drawBlockedFeedback(ctx, opts, side);
    drawHintArrows(ctx, opts, side);
  }

  // Subtle center gutter direction explanation.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '700 13px "PingFang SC", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(199,210,254,0.86)';
  ctx.fillText('两张图都按自己的屏幕方向读键', 600, 430);
  ctx.fillStyle = 'rgba(148,163,184,0.9)';
  ctx.font = '500 12px ui-monospace, monospace';
  ctx.fillText('local ←/→ same key', 600, 452);
  ctx.restore();

  // Replay badge.
  if (opts.replaying) {
    ctx.save();
    roundedRect(ctx, 510, 690, 180, 34, 17);
    ctx.fillStyle = 'rgba(30,64,175,0.88)';
    ctx.fill();
    ctx.fillStyle = '#dbeafe';
    ctx.font = '700 14px "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('自动回放中…', 600, 707);
    ctx.restore();
  }

  // Recompute win from state to avoid a stale event banner.
  const won = level.targets.every((t) => {
    const p = state.pos[t.side];
    return p.r === t.pos.r && p.c === t.pos.c;
  });
  if (won) drawWinBanner(ctx);
}
