// Canvas 渲染器：只负责把 GameState 画出来，不修改状态。

import {
  computeWalkableEdges,
  cellCenter,
  runtimePorts,
  type WalkableEdge,
} from './engine.js';
import { platformCorners, key } from './geometry.js';
import type { GameState, Platform, RotationPreview, Vec2 } from './types.js';

export const TILE = 56;

const COLORS = {
  bg: '#14171c',
  floor: '#2b313b',
  floorAlt: '#272c35',
  pit: '#101216',
  wall: '#4a5160',
  wallTop: '#5c6577',
  rail: '#d98c3f',
  platform: '#3f6f8f',
  platformEdge: '#7fc4e8',
  platformA: '#3f6f8f',
  platformB: '#5a5f8f',
  port: '#ffe08a',
  player: '#ff5d73',
  lever: '#8be28b',
  exit: '#46d369',
  edge: '#7CFC9A',
  previewOk: 'rgba(255, 224, 138, 0.16)',
  previewBlock: 'rgba(255, 93, 115, 0.22)',
  blocker: 'rgba(255, 93, 115, 0.55)',
  text: '#e8ecf3',
};

export interface RenderOptions {
  hoverLever: 'A' | 'B' | null;
  mouseDir: 'cw' | 'ccw';
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  opts: RenderOptions,
): void {
  const { cols, rows } = state;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cols * TILE, rows * TILE);

  drawGround(ctx, state);
  if (state.showEdges) drawWalkableEdges(ctx, state);
  drawExit(ctx, state);
  drawLevers(ctx, state, opts);
  for (const platform of state.platforms) {
    drawPlatform(ctx, platform);
  }
  drawPlayer(ctx, state);
  drawPreviewOverlay(ctx, state);
}

function drawGround(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const cell = { x, y };
      const kind = state.grid.get(key(cell)) ?? 'floor';
      const px = x * TILE;
      const py = y * TILE;
      if (kind === 'wall') {
        ctx.fillStyle = COLORS.wall;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = COLORS.wallTop;
        ctx.fillRect(px, py, TILE, 6);
      } else if (kind === 'pit') {
        ctx.fillStyle = COLORS.pit;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      } else if (kind === 'rail') {
        ctx.fillStyle = COLORS.floor;
        ctx.fillRect(px, py, TILE, TILE);
        drawRail(ctx, cell);
      } else {
        ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.floor : COLORS.floorAlt;
        ctx.fillRect(px, py, TILE, TILE);
      }
    }
  }
}

function drawRail(ctx: CanvasRenderingContext2D, cell: Vec2): void {
  const px = cell.x * TILE;
  const py = cell.y * TILE;
  ctx.save();
  ctx.strokeStyle = COLORS.rail;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  // 固定栏杆：格内两道横杆 + 立柱，视觉上明显是“挡路的栏杆”
  ctx.beginPath();
  ctx.moveTo(px + 8, py + 16);
  ctx.lineTo(px + TILE - 8, py + 16);
  ctx.moveTo(px + 8, py + TILE - 16);
  ctx.lineTo(px + TILE - 8, py + TILE - 16);
  ctx.stroke();
  ctx.fillStyle = COLORS.rail;
  for (const dx of [10, TILE - 14]) {
    ctx.fillRect(px + dx, py + 10, 4, TILE - 20);
  }
  ctx.restore();
}

function drawExit(ctx: CanvasRenderingContext2D, state: GameState): void {
  const { x, y } = state.exit;
  const px = x * TILE;
  const py = y * TILE;
  ctx.fillStyle = COLORS.exit;
  ctx.fillRect(px + 6, py + 6, TILE - 12, TILE - 12);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('出口', px + TILE / 2, py + TILE / 2);
}

function drawLevers(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  opts: RenderOptions,
): void {
  for (const lever of state.levers) {
    const platform = nearestPlatform(state, lever);
    if (!platform) continue;
    const c = cellCenter(lever);
    const cx = c.x * TILE;
    const cy = c.y * TILE;
    const hovered = opts.hoverLever === platform.id;
    ctx.save();
    ctx.translate(cx, cy);
    // 底座
    ctx.fillStyle = '#3a4150';
    ctx.beginPath();
    ctx.arc(0, 0, TILE * 0.26, 0, Math.PI * 2);
    ctx.fill();
    // 手柄（按平台当前朝向偏转，停稳时竖直）
    ctx.strokeStyle = hovered ? '#d8ffd8' : COLORS.lever;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 8);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.fillStyle = hovered ? '#d8ffd8' : COLORS.lever;
    ctx.beginPath();
    ctx.arc(0, -13, 5, 0, Math.PI * 2);
    ctx.fill();
    // 平台编号
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(platform.id, 0, TILE * 0.4);
    if (hovered) {
      ctx.strokeStyle =
        opts.mouseDir === 'cw'
          ? 'rgba(255,224,138,0.9)'
          : 'rgba(127,196,232,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, TILE * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function nearestPlatform(
  state: GameState,
  cell: Vec2,
): Platform | undefined {
  let best: Platform | undefined;
  let bestDist = Infinity;
  for (const p of state.platforms) {
    const center = {
      x: p.origin.x + p.size / 2,
      y: p.origin.y + p.size / 2,
    };
    const d =
      Math.abs(center.x - (cell.x + 0.5)) + Math.abs(center.y - (cell.y + 0.5));
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function drawPlatform(
  ctx: CanvasRenderingContext2D,
  platform: Platform,
): void {
  const corners = platformCorners(
    platform.origin,
    platform.size,
    platform.animAngle,
  ).map((p) => ({ x: p.x * TILE, y: p.y * TILE }));

  ctx.save();
  ctx.beginPath();
  corners.forEach((c, i) => {
    if (i === 0) ctx.moveTo(c.x, c.y);
    else ctx.lineTo(c.x, c.y);
  });
  ctx.closePath();
  ctx.fillStyle = platform.id === 'A' ? COLORS.platformA : COLORS.platformB;
  ctx.fill();
  ctx.strokeStyle = COLORS.platformEdge;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 板上格纹（随板旋转）
  ctx.clip();
  const pivot = {
    x: (platform.origin.x + platform.size / 2) * TILE,
    y: (platform.origin.y + platform.size / 2) * TILE,
  };
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate(platform.animAngle);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  const half = (platform.size * TILE) / 2;
  for (let i = -half + TILE; i < half; i += TILE) {
    ctx.beginPath();
    ctx.moveTo(i, -half);
    ctx.lineTo(i, half);
    ctx.moveTo(-half, i);
    ctx.lineTo(half, i);
    ctx.stroke();
  }
  ctx.restore();

  // 端口标记（停稳时才画，与可走边口径一致）
  if (platform.animDir === null) {
    for (const port of runtimePorts(platform)) {
      const c = cellCenter(port.cell);
      const cx = c.x * TILE;
      const cy = c.y * TILE;
      ctx.save();
      ctx.fillStyle = COLORS.port;
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.12, 0, Math.PI * 2);
      ctx.fill();
      // 朝外的小三角，明确“朝向”
      const dirVec = dirUnit(port.dir);
      ctx.translate(cx + dirVec.x * TILE * 0.2, cy + dirVec.y * TILE * 0.2);
      ctx.rotate(Math.atan2(dirVec.y, dirVec.x) + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(5, 4);
      ctx.lineTo(-5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

function dirUnit(dir: string): Vec2 {
  switch (dir) {
    case 'N':
      return { x: 0, y: -1 };
    case 'S':
      return { x: 0, y: 1 };
    case 'E':
      return { x: 1, y: 0 };
    default:
      return { x: -1, y: 0 };
  }
}

function drawWalkableEdges(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  // 只高亮“机关相关”的可走边：涉及步道的边与隔坑对口边；
  // 静态地板之间的普通边不画，避免整屏噪点。
  const edges = computeWalkableEdges(state).filter((edge) => {
    const onPlatform = (cell: { x: number; y: number }) =>
      state.platforms.some(
        (p) =>
          cell.x >= p.origin.x &&
          cell.x < p.origin.x + p.size &&
          cell.y >= p.origin.y &&
          cell.y < p.origin.y + p.size,
      );
    const gap =
      Math.abs(edge.to.x - edge.from.x) + Math.abs(edge.to.y - edge.from.y) >
      1;
    return onPlatform(edge.from) || onPlatform(edge.to) || gap;
  });
  ctx.save();
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.85;
  ctx.lineCap = 'round';
  for (const edge of edges) {
    drawEdgeMark(ctx, edge);
  }
  ctx.restore();
}

function drawEdgeMark(ctx: CanvasRenderingContext2D, edge: WalkableEdge): void {
  const a = cellCenter(edge.from);
  const b = cellCenter(edge.to);
  const dist =
    Math.abs(edge.to.x - edge.from.x) + Math.abs(edge.to.y - edge.from.y);

  // 隔坑对口边：在两块板的端口之间画一条跨坑虚线
  if (dist > 1) {
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.edge;
    ctx.beginPath();
    ctx.moveTo(a.x * TILE, a.y * TILE);
    ctx.lineTo(b.x * TILE, b.y * TILE);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 普通相邻边：在两格共享边的中点画短亮线
  const mx = ((a.x + b.x) / 2) * TILE;
  const my = ((a.y + b.y) / 2) * TILE;
  const horizontal = edge.dir === 'E' || edge.dir === 'W';
  const len = TILE * 0.28;
  ctx.beginPath();
  if (horizontal) {
    ctx.moveTo(mx, my - len);
    ctx.lineTo(mx, my + len);
  } else {
    ctx.moveTo(mx - len, my);
    ctx.lineTo(mx + len, my);
  }
  ctx.stroke();
}

function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState): void {
  const { pos, aboard } = state.player;
  const cx = pos.x * TILE;
  const cy = pos.y * TILE;
  ctx.save();
  // 乘坐平台时加一圈描边提示“会跟着转”
  if (aboard) {
    ctx.strokeStyle = COLORS.platformEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.player;
  ctx.beginPath();
  ctx.arc(cx, cy, TILE * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx - TILE * 0.07, cy - TILE * 0.07, TILE * 0.05, 0, Math.PI * 2);
  ctx.arc(cx + TILE * 0.07, cy - TILE * 0.07, TILE * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPreviewOverlay(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  const preview = state.preview;
  if (!preview || state.phase === 'rotating') return;
  drawSweptCells(ctx, preview);
  if (!preview.ok && preview.blocker) {
    drawBlocker(ctx, preview);
  }
}

function drawSweptCells(
  ctx: CanvasRenderingContext2D,
  preview: RotationPreview,
): void {
  ctx.save();
  ctx.fillStyle = preview.ok ? COLORS.previewOk : COLORS.previewBlock;
  for (const cell of preview.sweptCells) {
    ctx.fillRect(cell.x * TILE, cell.y * TILE, TILE, TILE);
  }
  ctx.restore();
}

function drawBlocker(
  ctx: CanvasRenderingContext2D,
  preview: RotationPreview,
): void {
  const b = preview.blocker!;
  ctx.save();
  if (b.kind === 'player') {
    ctx.strokeStyle = COLORS.blocker;
    ctx.lineWidth = 3;
    const c = cellCenter(b.cell);
    ctx.beginPath();
    ctx.arc(c.x * TILE, c.y * TILE, TILE * 0.34, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeStyle = COLORS.blocker;
    ctx.lineWidth = 3;
    ctx.strokeRect(b.cell.x * TILE + 2, b.cell.y * TILE + 2, TILE - 4, TILE - 4);
  }
  // 碰撞角度标注
  const c = cellCenter(b.cell);
  const deg = Math.round((b.atAngle * 180) / Math.PI);
  ctx.fillStyle = '#ffb3bd';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${deg}°`, c.x * TILE, b.cell.y * TILE - 4);
  ctx.restore();
}

export function leverAtPixel(
  state: GameState,
  px: number,
  py: number,
): { platformId: 'A' | 'B'; cell: Vec2 } | null {
  const cell = { x: Math.floor(px / TILE), y: Math.floor(py / TILE) };
  const hit = state.levers.find((l) => l.x === cell.x && l.y === cell.y);
  if (!hit) return null;
  const platform = nearestPlatform(state, hit);
  return platform ? { platformId: platform.id, cell: hit } : null;
}
