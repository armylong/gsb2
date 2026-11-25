// Canvas 渲染与命中检测。只负责画和把像素坐标翻译成格子/边,
// 所有"能不能放"的判断仍来自 core 层。
import {
  Board,
  DIR_DELTA,
  DIR_NAME,
  DIRS,
  Dir,
  Placement,
  Tile,
  cellKey,
  edgeKey,
  rotatedEdge,
} from '../core/types.js';
import { Conflict, cellKind, edgeConditionAt, isHole } from '../core/board.js';

export interface RenderInput {
  board: Board;
  tiles: Tile[];
  placements: Placement[];
  preview: {
    tileId: string;
    rot: Dir;
    x: number;
    y: number;
    fromBoard: boolean;
  } | null;
  previewConflicts: Conflict[];
  boardConflicts: Conflict[];
  highlight:
    | { type: 'cell'; x: number; y: number }
    | { type: 'move'; tileId: string; x: number; y: number; rot: Dir }
    | { type: 'conflicts'; conflicts: Conflict[] }
    | null;
  hoverCell: { x: number; y: number } | null;
}

export interface Geometry {
  originX: number;
  originY: number;
  cell: number;
}

// 纹路标签 -> 颜色, 同标签同色, 一眼看出相邻边是否一致
const PALETTE = [
  '#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e8590c',
  '#0c8599', '#c2255c', '#5f3dc4', '#e67700', '#2b8a3e',
  '#1864ab', '#a61e4d', '#087f5b', '#862e9c', '#4c6ef5',
];
const labelColor = new Map<string, string>();
export function colorFor(label: string): string {
  let c = labelColor.get(label);
  if (!c) {
    c = PALETTE[labelColor.size % PALETTE.length];
    labelColor.set(label, c);
  }
  return c;
}

export function computeGeometry(canvas: HTMLCanvasElement, board: Board): Geometry {
  const cell = Math.floor(
    Math.min(
      (canvas.width - 80) / board.width,
      (canvas.height - 80) / board.height,
      96,
    ),
  );
  const gw = cell * board.width;
  const gh = cell * board.height;
  return {
    originX: Math.floor((canvas.width - gw) / 2),
    originY: Math.floor((canvas.height - gh) / 2),
    cell,
  };
}

export function cellAtPixel(
  geo: Geometry,
  board: Board,
  px: number,
  py: number,
): { x: number; y: number } | null {
  const x = Math.floor((px - geo.originX) / geo.cell);
  const y = Math.floor((py - geo.originY) / geo.cell);
  if (x < 0 || y < 0 || x >= board.width || y >= board.height) return null;
  return { x, y };
}

/** 命中格子某条边(用于点选设置固定边条件), 返回距点击点最近的边 */
export function edgeAtPixel(
  geo: Geometry,
  x: number,
  y: number,
  px: number,
  py: number,
): Dir {
  const cx = geo.originX + x * geo.cell + geo.cell / 2;
  const cy = geo.originY + y * geo.cell + geo.cell / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
  return dy > 0 ? 2 : 0;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawTileBody(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  tile: Tile,
  rot: Dir,
  x: number,
  y: number,
  opts: { ghost?: boolean; locked?: boolean; conflictEdges?: Set<number>; hint?: boolean },
) {
  const px = geo.originX + x * geo.cell;
  const py = geo.originY + y * geo.cell;
  const s = geo.cell;
  ctx.save();
  if (opts.ghost) ctx.globalAlpha = 0.55;

  // 木片底
  roundRect(ctx, px + 3, py + 3, s - 6, s - 6, 8);
  ctx.fillStyle = opts.hint ? '#fff3bf' : '#f3e9d2';
  ctx.fill();
  ctx.lineWidth = opts.locked ? 3 : 1.5;
  ctx.strokeStyle = opts.locked ? '#e67700' : '#8c7b5f';
  ctx.stroke();

  // 四条边纹: 沿边画一条色带 + 纹路字母
  for (const dir of DIRS) {
    const label = rotatedEdge(tile, rot, dir);
    const color = colorFor(label);
    ctx.save();
    ctx.translate(px + s / 2, py + s / 2);
    ctx.rotate((dir * Math.PI) / 2);
    // 方向 0(上): 色带画在顶边
    ctx.fillStyle = color;
    ctx.globalAlpha = (opts.ghost ? 0.55 : 1) * 0.85;
    ctx.fillRect(-s / 2 + 6, -s / 2 + 6, s - 12, 9);
    ctx.globalAlpha = opts.ghost ? 0.55 : 1;
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(10, s * 0.13)}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, -s / 2 + 10.5);
    ctx.restore();

    if (opts.conflictEdges?.has(dir)) {
      ctx.save();
      ctx.translate(px + s / 2, py + s / 2);
      ctx.rotate((dir * Math.PI) / 2);
      ctx.strokeStyle = '#e03131';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-s / 2 + 5, -s / 2 + 4);
      ctx.lineTo(s / 2 - 5, -s / 2 + 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 片 id 与锁标记
  ctx.fillStyle = '#5c4d36';
  ctx.font = `bold ${Math.max(11, s * 0.16)}px ui-sans-serif, system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tile.id + (opts.locked ? ' 🔒' : ''), px + s / 2, py + s / 2 + s * 0.12);
  ctx.restore();
}

function drawEdgeCondition(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  x: number,
  y: number,
  dir: Dir,
  label: string,
) {
  const px = geo.originX + x * geo.cell;
  const py = geo.originY + y * geo.cell;
  const s = geo.cell;
  ctx.save();
  ctx.translate(px + s / 2, py + s / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.fillStyle = colorFor(label);
  roundRect(ctx, -14, -s / 2 - 12, 28, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, -s / 2 - 4);
  ctx.restore();
}

export function render(ctx: CanvasRenderingContext2D, geo: Geometry, input: RenderInput): void {
  const { board, placements, tiles } = input;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = '#faf8f3';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const tileById = new Map(tiles.map((t) => [t.id, t]));
  const placementMap = new Map(placements.map((p) => [cellKey(p.x, p.y), p]));

  // 收集冲突边(按 cellKey+dir)
  const conflictEdges = new Set<string>();
  const conflictCells = new Set<string>();
  for (const c of [...input.boardConflicts, ...input.previewConflicts]) {
    c.cells.forEach((cc) => conflictCells.add(cellKey(cc.x, cc.y)));
    if (c.edge) conflictEdges.add(edgeKey(c.edge.x, c.edge.y, c.edge.dir));
  }
  if (input.highlight?.type === 'conflicts') {
    for (const c of input.highlight.conflicts) {
      c.cells.forEach((cc) => conflictCells.add(cellKey(cc.x, cc.y)));
      if (c.edge) conflictEdges.add(edgeKey(c.edge.x, c.edge.y, c.edge.dir));
    }
  }

  // 1. 格子与洞
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const px = geo.originX + x * geo.cell;
      const py = geo.originY + y * geo.cell;
      const hole = isHole(board, x, y);
      roundRect(ctx, px + 2, py + 2, geo.cell - 4, geo.cell - 4, 8);
      if (hole) {
        ctx.fillStyle = '#d8d2c4';
        ctx.fill();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = '#9a8f7a';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#8a7f6a';
        ctx.font = `${Math.max(11, geo.cell * 0.15)}px ui-sans-serif, system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('留空', px + geo.cell / 2, py + geo.cell / 2);
      } else {
        ctx.fillStyle = conflictCells.has(cellKey(x, y)) ? '#fff0f0' : '#fffdf8';
        ctx.fill();
        ctx.strokeStyle = '#c9bfab';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // 悬停高亮
      if (input.hoverCell && input.hoverCell.x === x && input.hoverCell.y === y && !hole) {
        ctx.fillStyle = 'rgba(77, 171, 247, 0.18)';
        ctx.fillRect(px + 2, py + 2, geo.cell - 4, geo.cell - 4);
      }
    }
  }

  // 2. 固定边条件(外边/洞边)
  for (const key of Object.keys(board.edgeConditions)) {
    const [xs, ys, ds] = key.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const dir = Number(ds) as Dir;
    const label = board.edgeConditions[key];
    if (label) drawEdgeCondition(ctx, geo, x, y, dir, label);
  }

  // 3. 已放置的木片(预览从盘面拖起时, 原片画成占位虚线)
  for (const p of placements) {
    const tile = tileById.get(p.tileId);
    if (!tile) continue;
    if (input.preview?.fromBoard && input.preview.tileId === p.tileId) {
      const px = geo.originX + p.x * geo.cell;
      const py = geo.originY + p.y * geo.cell;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#74c0fc';
      ctx.lineWidth = 2;
      roundRect(ctx, px + 4, py + 4, geo.cell - 8, geo.cell - 8, 8);
      ctx.stroke();
      ctx.restore();
      continue;
    }
    const edges = new Set<number>();
    for (const dir of DIRS) {
      if (conflictEdges.has(edgeKey(p.x, p.y, dir))) edges.add(dir);
    }
    const isHint =
      input.highlight?.type === 'move' &&
      input.highlight.tileId === p.tileId &&
      input.highlight.x === p.x &&
      input.highlight.y === p.y;
    drawTileBody(ctx, geo, tile, p.rot, p.x, p.y, {
      locked: p.locked,
      conflictEdges: edges,
      hint: isHint,
    });
  }

  // 4. 提示的目标空格高亮
  if (input.highlight?.type === 'cell') {
    const { x, y } = input.highlight;
    const px = geo.originX + x * geo.cell;
    const py = geo.originY + y * geo.cell;
    ctx.save();
    ctx.strokeStyle = '#f08c00';
    ctx.lineWidth = 4;
    roundRect(ctx, px + 3, py + 3, geo.cell - 6, geo.cell - 6, 8);
    ctx.stroke();
    ctx.restore();
  }
  if (input.highlight?.type === 'move') {
    const h = input.highlight;
    if (!placementMap.has(cellKey(h.x, h.y))) {
      const px = geo.originX + h.x * geo.cell;
      const py = geo.originY + h.y * geo.cell;
      ctx.save();
      ctx.strokeStyle = '#f08c00';
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 5]);
      roundRect(ctx, px + 3, py + 3, geo.cell - 6, geo.cell - 6, 8);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 5. 拖动预览
  if (input.preview) {
    const tile = tileById.get(input.preview.tileId);
    if (tile) {
      const badEdges = new Set<number>(
        input.previewConflicts
          .filter((c) => c.edge && c.edge.x === input.preview!.x && c.edge.y === input.preview!.y)
          .map((c) => c.edge!.dir),
      );
      const anyConflict = input.previewConflicts.length > 0;
      drawTileBody(ctx, geo, tile, input.preview.rot, input.preview.x, input.preview.y, {
        ghost: true,
        conflictEdges: badEdges,
      });
      // 整体红/绿框, 立即看出这一格能不能放
      const px = geo.originX + input.preview.x * geo.cell;
      const py = geo.originY + input.preview.y * geo.cell;
      ctx.save();
      ctx.strokeStyle = anyConflict ? '#e03131' : '#2f9e44';
      ctx.lineWidth = 4;
      roundRect(ctx, px + 2, py + 2, geo.cell - 4, geo.cell - 4, 8);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** 托盘单片绘制(侧栏 canvas 之外的 DOM 也可复用颜色逻辑) */
export function drawTrayTile(
  ctx: CanvasRenderingContext2D,
  tile: Tile,
  x: number,
  y: number,
  size: number,
  selected: boolean,
): void {
  const fakeGeo: Geometry = { originX: x - size / 2, originY: y - size / 2, cell: size };
  drawTileBody(ctx, fakeGeo, tile, 0, 0, 0, { hint: selected });
}

export { DIR_DELTA, DIR_NAME, cellKind, edgeConditionAt };
