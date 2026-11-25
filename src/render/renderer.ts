import {
  adjacencyOfColor,
  detectCrossings,
  resolveTop,
} from '../game/board';
import { edgeKey, parseEdge, sameVertex, vKey } from '../game/geometry';
import { diagnose } from '../game/diagnosis';
import type { GameState, Puzzle, Vertex } from '../game/types';
import { THEME, colorDef } from './palette';

export interface BoardGeometry {
  marginX: number;
  marginY: number;
  cell: number;
  width: number;
  height: number;
}

export function computeGeometry(
  canvasWidth: number,
  canvasHeight: number,
  puzzle: Puzzle,
): BoardGeometry {
  const marginX = 70;
  const marginY = 64;
  const usableW = canvasWidth - marginX * 2;
  const usableH = canvasHeight - marginY * 2;
  const cell = Math.max(
    36,
    Math.min(usableW / puzzle.width, usableH / puzzle.height),
  );
  return {
    marginX,
    marginY,
    cell,
    width: puzzle.width,
    height: puzzle.height,
  };
}

export function vertexToPixel(v: Vertex, geo: BoardGeometry): { px: number; py: number } {
  return {
    px: geo.marginX + v.x * geo.cell,
    py: geo.marginY + v.y * geo.cell,
  };
}

export function pixelToVertex(
  px: number,
  py: number,
  geo: BoardGeometry,
): Vertex | null {
  const x = Math.round((px - geo.marginX) / geo.cell);
  const y = Math.round((py - geo.marginY) / geo.cell);
  if (x < 0 || x > geo.width || y < 0 || y > geo.height) return null;
  const { px: gx, py: gy } = vertexToPixel({ x, y }, geo);
  const hitRadius = geo.cell * 0.42;
  if (Math.hypot(px - gx, py - gy) > hitRadius) return null;
  return { x, y };
}

/** 找到离点击位置最近的格边，返回两个端点；距离过远返回 null。 */
export function pixelToEdge(
  px: number,
  py: number,
  geo: BoardGeometry,
): [Vertex, Vertex] | null {
  let best: [Vertex, Vertex] | null = null;
  let bestDist = geo.cell * 0.3;
  const consider = (a: Vertex, b: Vertex) => {
    const p1 = vertexToPixel(a, geo);
    const p2 = vertexToPixel(b, geo);
    const d = distanceToSegment(px, py, p1.px, p1.py, p2.px, p2.py);
    if (d < bestDist) {
      bestDist = d;
      best = [a, b];
    }
  };
  for (let x = 0; x <= geo.width; x++) {
    for (let y = 0; y <= geo.height; y++) {
      if (x < geo.width) consider({ x, y }, { x: x + 1, y });
      if (y < geo.height) consider({ x, y }, { x, y: y + 1 });
    }
  }
  return best;
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export interface RenderOptions {
  selectedVertices: Vertex[];
  candidateEdges: Array<[Vertex, Vertex]>;
  hoverVertex: Vertex | null;
  activeColor: string;
  showDiagnosis: boolean;
}

export function renderBoard(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  state: GameState,
  geo: BoardGeometry,
  options: RenderOptions,
): void {
  const { width, height } = puzzle;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // 织框底板
  const topLeft = vertexToPixel({ x: 0, y: 0 }, geo);
  const bottomRight = vertexToPixel({ x: width, y: height }, geo);
  ctx.fillStyle = THEME.boardBg;
  ctx.fillRect(
    topLeft.px - 24,
    topLeft.py - 24,
    bottomRight.px - topLeft.px + 48,
    bottomRight.py - topLeft.py + 48,
  );
  ctx.strokeStyle = THEME.boardBorder;
  ctx.lineWidth = 3;
  ctx.strokeRect(
    topLeft.px - 24,
    topLeft.py - 24,
    bottomRight.px - topLeft.px + 48,
    bottomRight.py - topLeft.py + 48,
  );

  drawGrid(ctx, puzzle, geo);
  drawHoles(ctx, puzzle, geo);
  drawTargets(ctx, puzzle, state, geo, options.showDiagnosis);
  drawRibbons(ctx, puzzle, state, geo);
  drawConflictEdges(ctx, puzzle, state, geo, options.showDiagnosis);
  drawPorts(ctx, puzzle, geo);
  drawOverlay(ctx, geo, options);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  geo: BoardGeometry,
): void {
  ctx.strokeStyle = THEME.gridLine;
  ctx.lineWidth = 1;
  for (let x = 0; x <= puzzle.width; x++) {
    const a = vertexToPixel({ x, y: 0 }, geo);
    const b = vertexToPixel({ x, y: puzzle.height }, geo);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.stroke();
  }
  for (let y = 0; y <= puzzle.height; y++) {
    const a = vertexToPixel({ x: 0, y }, geo);
    const b = vertexToPixel({ x: puzzle.width, y }, geo);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.stroke();
  }
  // 格点小圆点
  ctx.fillStyle = '#b9af9c';
  for (let x = 0; x <= puzzle.width; x++) {
    for (let y = 0; y <= puzzle.height; y++) {
      const { px, py } = vertexToPixel({ x, y }, geo);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawHoles(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  geo: BoardGeometry,
): void {
  for (const h of puzzle.holes) {
    const { px, py } = vertexToPixel(h, geo);
    const r = geo.cell * 0.32;
    ctx.fillStyle = THEME.hole;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = THEME.holeInner;
    ctx.beginPath();
    ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px - r * 0.6, py - r * 0.6);
    ctx.lineTo(px + r * 0.6, py + r * 0.6);
    ctx.moveTo(px + r * 0.6, py - r * 0.6);
    ctx.lineTo(px - r * 0.6, py + r * 0.6);
    ctx.stroke();
  }
}

function drawTargets(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  state: GameState,
  geo: BoardGeometry,
  showDiagnosis: boolean,
): void {
  const d = diagnose(puzzle, state);
  const targetMap = new Map(d.targets.map((t) => [vKey(t.vertex), t]));
  for (const t of puzzle.targets) {
    const check = targetMap.get(vKey(t.vertex));
    const { px, py } = vertexToPixel(t.vertex, geo);
    const r = geo.cell * 0.36;
    const def = colorDef(t.color);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle =
      showDiagnosis && check?.state === 'ok'
        ? THEME.targetRingOk
        : THEME.targetRing;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 环上一小段实色提示要求哪种颜色在顶层
    ctx.strokeStyle = def.main;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(px, py, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 0.7);
    ctx.stroke();
    ctx.restore();
  }
}

function drawRibbons(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  state: GameState,
  geo: BoardGeometry,
): void {
  const crossings = detectCrossings(state);
  const crossingMap = new Map(crossings.map((c) => [vKey(c.vertex), c]));
  const ribbonWidth = THEME.ribbonWidth;

  // 第一层：先画所有「底层」段（交叉点处被压的色带先画）
  const drawSegment = (
    edgeKeyStr: string,
    color: string,
    layer: 'bottom' | 'top',
  ) => {
    const [a, b] = parseEdge(edgeKeyStr);
    const p1 = vertexToPixel(a, geo);
    const p2 = vertexToPixel(b, geo);
    const def = colorDef(color);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = ribbonWidth;
    if (layer === 'bottom') {
      ctx.strokeStyle = def.dark;
      ctx.globalAlpha = 0.55;
    } else {
      const grad = ctx.createLinearGradient(p1.px, p1.py, p2.px, p2.py);
      grad.addColorStop(0, def.light);
      grad.addColorStop(0.5, def.main);
      grad.addColorStop(1, def.dark);
      ctx.strokeStyle = grad;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1;
    }
    ctx.beginPath();
    ctx.moveTo(p1.px, p1.py);
    ctx.lineTo(p2.px, p2.py);
    ctx.stroke();
    ctx.restore();
  };

  // 决定每条边在每个端点处是否属于底层
  const edgeIsBottom = (edgeKeyStr: string, color: string): boolean => {
    const [a, b] = parseEdge(edgeKeyStr);
    for (const v of [a, b]) {
      const info = crossingMap.get(vKey(v));
      if (!info || !info.valid) continue;
      const top = resolveTop(puzzle, state, v, info.colors);
      if (top && top !== color) return true;
    }
    return false;
  };

  // 底层段
  for (const [k, color] of Object.entries(state.edges)) {
    if (edgeIsBottom(k, color)) drawSegment(k, color, 'bottom');
  }
  // 交叉点处画压顶覆盖的小圆垫，强化上下观感
  for (const info of crossings) {
    if (!info.valid) continue;
    const top = resolveTop(puzzle, state, info.vertex, info.colors);
    if (!top) continue;
    const { px, py } = vertexToPixel(info.vertex, geo);
    const def = colorDef(top);
    ctx.save();
    ctx.fillStyle = def.main;
    ctx.strokeStyle = def.dark;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, ribbonWidth * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // 顶层段
  for (const [k, color] of Object.entries(state.edges)) {
    if (!edgeIsBottom(k, color)) drawSegment(k, color, 'top');
  }

  // 非法交叉画警示叉
  for (const info of crossings) {
    if (info.valid) continue;
    const { px, py } = vertexToPixel(info.vertex, geo);
    const r = geo.cell * 0.3;
    ctx.save();
    ctx.strokeStyle = THEME.conflict;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px - r, py - r);
    ctx.lineTo(px + r, py + r);
    ctx.moveTo(px + r, py - r);
    ctx.lineTo(px - r, py + r);
    ctx.stroke();
    ctx.restore();
  }

  // 手动指定过上下的交叉点画一个小三角标记
  for (const [key, color] of Object.entries(state.tops)) {
    const [x, y] = key.split(',').map(Number);
    const { px, py } = vertexToPixel({ x, y }, geo);
    const def = colorDef(color);
    ctx.save();
    ctx.fillStyle = def.light;
    ctx.strokeStyle = def.dark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py - 4);
    ctx.lineTo(px + 4, py + 3);
    ctx.lineTo(px - 4, py + 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawConflictEdges(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  state: GameState,
  geo: BoardGeometry,
  showDiagnosis: boolean,
): void {
  if (!showDiagnosis) return;
  const d = diagnose(puzzle, state);
  if (d.conflicts.length === 0) return;
  const set = new Set(d.conflictEdges);
  ctx.save();
  ctx.lineCap = 'round';
  for (const key of set) {
    if (!state.edges[key]) continue;
    const [a, b] = parseEdge(key);
    const p1 = vertexToPixel(a, geo);
    const p2 = vertexToPixel(b, geo);
    ctx.strokeStyle = THEME.conflictGlow;
    ctx.lineWidth = THEME.ribbonWidth + 10;
    ctx.beginPath();
    ctx.moveTo(p1.px, p1.py);
    ctx.lineTo(p2.px, p2.py);
    ctx.stroke();
    ctx.strokeStyle = THEME.conflict;
    ctx.lineWidth = 3.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(p1.px, p1.py);
    ctx.lineTo(p2.px, p2.py);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // 冲突交叉点外框
  const marked = new Set<string>();
  for (const seg of d.conflicts) {
    for (const v of [seg.from, seg.to]) {
      const k = vKey(v);
      if (marked.has(k)) continue;
      marked.add(k);
      const { px, py } = vertexToPixel(v, geo);
      ctx.strokeStyle = THEME.conflict;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(px, py, geo.cell * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawPorts(
  ctx: CanvasRenderingContext2D,
  puzzle: Puzzle,
  geo: BoardGeometry,
): void {
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const port of puzzle.ports) {
    const { px, py } = vertexToPixel(port.vertex, geo);
    const def = colorDef(port.color);
    // 端口方块
    const s = geo.cell * 0.42;
    ctx.fillStyle = def.main;
    ctx.strokeStyle = def.dark;
    ctx.lineWidth = 2;
    roundRect(ctx, px - s, py - s, s * 2, s * 2, 5);
    ctx.fill();
    ctx.stroke();
    // 入口画实心三角，出口画空心圆，强化「进出」语义
    ctx.fillStyle = '#ffffff';
    if (port.kind === 'entry') {
      ctx.beginPath();
      ctx.moveTo(px, py - s * 0.55);
      ctx.lineTo(px + s * 0.5, py + s * 0.4);
      ctx.lineTo(px - s * 0.5, py + s * 0.4);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(px, py, s * 0.45, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    // 标签放在织框外侧
    const labelOffset = 38;
    let lx = px;
    let ly = py;
    if (port.vertex.x === 0) lx -= labelOffset;
    else if (port.vertex.x === puzzle.width) lx += labelOffset;
    else if (port.vertex.y === 0) ly -= labelOffset;
    else if (port.vertex.y === puzzle.height) ly += labelOffset;
    ctx.fillStyle = THEME.portLabel;
    ctx.fillText(port.label, lx, ly);
  }
  ctx.restore();
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  geo: BoardGeometry,
  options: RenderOptions,
): void {
  // 改道选择的格点
  for (const v of options.selectedVertices) {
    const { px, py } = vertexToPixel(v, geo);
    ctx.save();
    ctx.fillStyle = THEME.selectFill;
    ctx.strokeStyle = THEME.selectStroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, geo.cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // 候选格边（画带/收带预览）
  for (const [a, b] of options.candidateEdges) {
    const p1 = vertexToPixel(a, geo);
    const p2 = vertexToPixel(b, geo);
    ctx.save();
    ctx.strokeStyle = THEME.selectStroke;
    ctx.lineWidth = 4;
    ctx.setLineDash([6, 5]);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(p1.px, p1.py);
    ctx.lineTo(p2.px, p2.py);
    ctx.stroke();
    ctx.restore();
  }
  // 悬停格点
  if (options.hoverVertex) {
    const { px, py } = vertexToPixel(options.hoverVertex, geo);
    ctx.save();
    ctx.fillStyle = THEME.hoverFill;
    ctx.beginPath();
    ctx.arc(px, py, geo.cell * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 让外部模块可复用同色带邻接查询。 */
export function ribbonNeighbors(
  state: GameState,
  color: string,
  v: Vertex,
): Vertex[] {
  return adjacencyOfColor(state, color).get(vKey(v)) ?? [];
}

export { edgeKey, sameVertex };
