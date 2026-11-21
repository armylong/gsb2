import {
  canEmitSignal,
  cellKey,
  gateSymbol,
  inputPortCount,
  nodeById,
  type Edge,
  type GridPos,
  type Level,
  type LogicNode,
  type Signal,
} from '../model';
import { findGateSccs, nodeSources, type TickIntent } from '../sim';

export const CELL = 76;
export const MARGIN = 30;

export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PortPosition {
  nodeId: string;
  side: 'in' | 'out';
  index: number;
  x: number;
  y: number;
}

export type Hit =
  | { type: 'node'; nodeId: string }
  | { type: 'port'; nodeId: string; side: 'in' | 'out'; index: number }
  | { type: 'edge'; edgeId: string }
  | { type: 'character' }
  | { type: 'cell'; pos: GridPos };

export interface SceneInput {
  level: Level;
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  wiringFrom: string | null;
  hover: Hit | null;
  pending: TickIntent;
  conflictNodeIds: Set<string>;
  dragPreview: GridPos | null;
  time: number;
}

const COLORS = {
  bg: '#080d18',
  bgGlow: '#0d1626',
  grid: '#141f33',
  gridStrong: '#1b2a45',
  text: '#e8eefc',
  textDim: '#8695b3',
  box: '#111c30',
  boxBorder: '#2a3a5a',
  boxSelected: '#5ad1ff',
  off: '#3c4b68',
  on: '#ffc857',
  accent: '#5ad1ff',
  danger: '#ff6b6b',
  good: '#67e8a0',
  feedback: '#b794f6',
  character: '#8ef0b4',
  wire: '#33445f',
};

export function sceneSize(level: Level): { width: number; height: number } {
  return {
    width: level.cols * CELL + MARGIN * 2,
    height: level.rows * CELL + MARGIN * 2,
  };
}

export function cellBox(pos: GridPos): Rect {
  return {
    x: MARGIN + pos.x * CELL,
    y: MARGIN + pos.y * CELL,
    w: CELL,
    h: CELL,
  };
}

export function cellCenter(pos: GridPos): Point {
  const box = cellBox(pos);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

export function pointToCell(point: Point, level: Level): GridPos | null {
  const x = Math.floor((point.x - MARGIN) / CELL);
  const y = Math.floor((point.y - MARGIN) / CELL);
  if (x < 0 || y < 0 || x >= level.cols || y >= level.rows) return null;
  return { x, y };
}

export function nodeBox(node: LogicNode): Rect {
  const box = cellBox(node.pos);
  return { x: box.x + 4, y: box.y + 4, w: box.w - 8, h: box.h - 8 };
}

export function nodePorts(node: LogicNode): PortPosition[] {
  const box = cellBox(node.pos);
  const cy = box.y + box.h / 2;
  const ports: PortPosition[] = [];
  const ins = inputPortCount(node);
  if (ins === 1) {
    ports.push({ nodeId: node.id, side: 'in', index: 0, x: box.x + 4, y: cy });
  } else if (ins === 2) {
    ports.push({ nodeId: node.id, side: 'in', index: 0, x: box.x + 4, y: cy - 14 });
    ports.push({ nodeId: node.id, side: 'in', index: 1, x: box.x + 4, y: cy + 14 });
  }
  if (canEmitSignal(node)) {
    ports.push({ nodeId: node.id, side: 'out', index: 0, x: box.x + box.w - 4, y: cy });
  }
  return ports;
}

export function outputPortPoint(level: Level, nodeId: string): Point | null {
  const node = nodeById(level, nodeId);
  if (!node) return null;
  const out = nodePorts(node).find((port) => port.side === 'out');
  return out ? { x: out.x, y: out.y } : null;
}

export function inputPortPoint(level: Level, nodeId: string, index: number): Point | null {
  const node = nodeById(level, nodeId);
  if (!node) return null;
  const port = nodePorts(node).find((candidate) => candidate.side === 'in' && candidate.index === index);
  return port ? { x: port.x, y: port.y } : null;
}

/** 折线路径, 渲染与命中测试共用. */
export function edgePolyline(level: Level, edge: Edge): Point[] {
  const fromNode = nodeById(level, edge.from);
  const toNode = nodeById(level, edge.to);
  if (!fromNode || !toNode) return [];
  const out = outputPortPoint(level, edge.from);
  const inp = inputPortPoint(level, edge.to, edge.toPort);
  if (!out || !inp) return [];

  if (fromNode.id === toNode.id) {
    const box = nodeBox(toNode);
    const loopY = box.y - 26;
    return [
      out,
      { x: out.x + 18, y: out.y },
      { x: out.x + 18, y: loopY },
      { x: box.x - 18, y: loopY },
      { x: box.x - 18, y: inp.y },
      inp,
    ];
  }

  const stub = 16;
  const p1 = { x: out.x + stub, y: out.y };
  const p2 = { x: inp.x - stub, y: inp.y };
  if (p1.x >= p2.x) {
    const midY = (out.y + inp.y) / 2;
    return [out, p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2, inp];
  }
  return [out, p1, p2, inp];
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function polylineDistance(point: Point, points: Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (!a || !b) continue;
    best = Math.min(best, distanceToSegment(point, a, b));
  }
  return best;
}

export function hitTest(level: Level, point: Point): Hit | null {
  for (const node of level.nodes) {
    for (const port of nodePorts(node)) {
      if (Math.hypot(point.x - port.x, point.y - port.y) <= 11) {
        return { type: 'port', nodeId: port.nodeId, side: port.side, index: port.index };
      }
    }
  }

  for (const edge of level.edges) {
    const path = edgePolyline(level, edge);
    if (path.length > 0 && polylineDistance(point, path) <= 6) {
      return { type: 'edge', edgeId: edge.id };
    }
  }

  const character = cellCenter(level.character);
  if (Math.hypot(point.x - character.x, point.y - character.y) <= 17) {
    return { type: 'character' };
  }

  for (const node of level.nodes) {
    const box = cellBox(node.pos);
    if (point.x >= box.x && point.y >= box.y && point.x <= box.x + box.w && point.y <= box.y + box.h) {
      return { type: 'node', nodeId: node.id };
    }
  }

  const cell = pointToCell(point, level);
  if (!cell) return null;
  return { type: 'cell', pos: cell };
}

export function edgeValue(level: Level, edge: Edge): Signal {
  return nodeById(level, edge.from)?.value ?? 'off';
}

function roundedRect(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  const radiusValue = Math.min(radius, rect.w / 2, rect.h / 2);
  ctx.beginPath();
  ctx.moveTo(rect.x + radiusValue, rect.y);
  ctx.lineTo(rect.x + rect.w - radiusValue, rect.y);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + radiusValue);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h - radiusValue);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - radiusValue, rect.y + rect.h);
  ctx.lineTo(rect.x + radiusValue, rect.y + rect.h);
  ctx.quadraticCurveTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - radiusValue);
  ctx.lineTo(rect.x, rect.y + radiusValue);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + radiusValue, rect.y);
  ctx.closePath();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function drawGrid(ctx: CanvasRenderingContext2D, level: Level): void {
  const size = sceneSize(level);
  const gradient = ctx.createRadialGradient(
    size.width / 2,
    size.height / 2,
    40,
    size.width / 2,
    size.height / 2,
    Math.max(size.width, size.height),
  );
  gradient.addColorStop(0, COLORS.bgGlow);
  gradient.addColorStop(1, COLORS.bg);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size.width, size.height);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= level.cols; x += 1) {
    const px = MARGIN + x * CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, MARGIN);
    ctx.lineTo(px, MARGIN + level.rows * CELL);
    ctx.stroke();
  }
  for (let y = 0; y <= level.rows; y += 1) {
    const py = MARGIN + y * CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(MARGIN, py);
    ctx.lineTo(MARGIN + level.cols * CELL, py);
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.gridStrong;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(MARGIN, MARGIN, level.cols * CELL, level.rows * CELL);
}

function drawPlate(ctx: CanvasRenderingContext2D, node: LogicNode, time: number): void {
  const box = cellBox(node.pos);
  ctx.save();
  ctx.strokeStyle = node.value === 'on' ? COLORS.on : '#2a3a56';
  ctx.lineWidth = node.value === 'on' ? 2 : 1.2;
  ctx.setLineDash([7, 6]);
  ctx.strokeRect(box.x + 7, box.y + 7, box.w - 14, box.h - 14);
  ctx.setLineDash([]);
  if (node.value === 'on') {
    const pulse = 0.28 + 0.16 * Math.sin(time / 260);
    ctx.fillStyle = `rgba(255, 200, 87, ${pulse})`;
    ctx.fillRect(box.x + 7, box.y + 7, box.w - 14, box.h - 14);
  }
  ctx.fillStyle = node.value === 'on' ? COLORS.on : COLORS.textDim;
  ctx.font = '600 10px "PingFang SC", "Noto Sans SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(truncate(ctx, node.name, 52), box.x + box.w / 2, box.y + box.h - 10);
  ctx.restore();
}

function drawBaseBox(
  ctx: CanvasRenderingContext2D,
  node: LogicNode,
  selected: boolean,
  inFeedback: boolean,
  conflict: boolean,
): void {
  const box = nodeBox(node);
  roundedRect(ctx, box, 11);
  ctx.fillStyle = COLORS.box;
  ctx.fill();
  ctx.lineWidth = selected ? 2.4 : 1.3;
  ctx.strokeStyle = conflict
    ? COLORS.danger
    : selected
      ? COLORS.boxSelected
      : inFeedback
        ? COLORS.feedback
        : COLORS.boxBorder;
  ctx.stroke();

  if (inFeedback) {
    ctx.save();
    ctx.strokeStyle = conflict ? COLORS.danger : COLORS.feedback;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    roundedRect(ctx, { x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 }, 14);
    ctx.stroke();
    ctx.restore();
  }
}

function drawName(ctx: CanvasRenderingContext2D, node: LogicNode, reserveRight = 0): void {
  const box = nodeBox(node);
  ctx.fillStyle = COLORS.text;
  ctx.font = '600 10px "PingFang SC", "Noto Sans SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    truncate(ctx, node.name, box.w - 14 - reserveRight),
    box.x + (box.w - reserveRight) / 2,
    box.y + 13,
  );
  ctx.textBaseline = 'alphabetic';
}

function drawSwitch(ctx: CanvasRenderingContext2D, node: LogicNode): void {
  drawName(ctx, node);
  const box = nodeBox(node);
  const cy = box.y + box.h / 2 + 4;
  const track: Rect = { x: box.x + 13, y: cy - 8, w: 50, h: 16 };
  roundedRect(ctx, track, 8);
  ctx.fillStyle = '#0a1322';
  ctx.fill();
  ctx.strokeStyle = node.value === 'on' ? COLORS.on : COLORS.off;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const knobX = node.value === 'on' ? track.x + track.w - 7 : track.x + 7;
  ctx.beginPath();
  ctx.arc(knobX, cy, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = node.value === 'on' ? COLORS.on : COLORS.off;
  ctx.fill();
  ctx.fillStyle = node.value === 'on' ? COLORS.on : COLORS.textDim;
  ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(node.value === 'on' ? 'ON' : 'OFF', box.x + box.w / 2, box.y + box.h - 9);
}

function drawGate(ctx: CanvasRenderingContext2D, node: LogicNode): void {
  drawName(ctx, node);
  if (node.kind !== 'gate') return;
  const box = nodeBox(node);
  const cy = box.y + box.h / 2 + 3;
  ctx.fillStyle = COLORS.text;
  ctx.font = '800 16px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(gateSymbol(node.op), box.x + box.w / 2 - 3, cy);

  ctx.font = '700 8px "JetBrains Mono", ui-monospace, monospace';
  const count = inputPortCount(node);
  ctx.fillStyle = '#9fb6d8';
  ctx.textAlign = 'left';
  ctx.fillText('A', box.x + 6, box.y + box.h / 2 - 14);
  if (count > 1) ctx.fillText('B', box.x + 6, box.y + box.h / 2 + 22);
  ctx.textAlign = 'right';
  ctx.fillStyle = node.value === 'on' ? COLORS.on : '#9fb6d8';
  ctx.fillText(`→${node.value === 'on' ? '1' : '0'}`, box.x + box.w - 5, box.y + box.h / 2 + 3);
  ctx.textBaseline = 'alphabetic';
}

function drawDelay(ctx: CanvasRenderingContext2D, node: LogicNode): void {
  drawName(ctx, node);
  if (node.kind !== 'delay') return;
  const box = nodeBox(node);
  const slots = Math.max(node.steps, node.queue.length);
  const pipWidth = Math.min(11, (box.w - 24) / Math.max(1, slots) - 2);
  const total = slots * (pipWidth + 2) - 2;
  const startX = box.x + box.w / 2 - total / 2;
  const pipsY = box.y + box.h / 2 - 8;
  for (let index = 0; index < slots; index += 1) {
    const value = node.queue[index];
    const px = startX + index * (pipWidth + 2);
    ctx.fillStyle = value === 'on' ? COLORS.on : COLORS.off;
    ctx.fillRect(px, pipsY, pipWidth, 9);
    ctx.strokeStyle = '#0a1322';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, pipsY + 0.5, pipWidth - 1, 8);
  }
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '600 9px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${node.steps} 步队列`, box.x + box.w / 2, box.y + box.h / 2 + 14);
  ctx.fillStyle = node.value === 'on' ? COLORS.on : COLORS.textDim;
  ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`OUT ${node.value === 'on' ? '1' : '0'}`, box.x + box.w / 2, box.y + box.h - 10);
}

function drawLamp(ctx: CanvasRenderingContext2D, node: LogicNode): void {
  const box = nodeBox(node);
  roundedRect(ctx, box, 20);
  ctx.fillStyle = COLORS.box;
  ctx.fill();
  ctx.strokeStyle = node.value === 'on' ? COLORS.on : COLORS.boxBorder;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2 + 4;
  if (node.value === 'on') {
    ctx.beginPath();
    ctx.arc(cx, cy, 23, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 200, 87, 0.14)';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 13, 0, Math.PI * 2);
  ctx.fillStyle = node.value === 'on' ? COLORS.on : '#1d2a42';
  ctx.fill();
  ctx.fillStyle = COLORS.text;
  ctx.font = '600 10px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, node.name, box.w - 12), cx, box.y + 12);
  ctx.textBaseline = 'alphabetic';
}

function drawDoor(ctx: CanvasRenderingContext2D, node: LogicNode): void {
  const box = cellBox(node.pos);
  roundedRect(ctx, { x: box.x + 2, y: box.y + 2, w: box.w - 4, h: box.h - 4 }, 10);
  ctx.fillStyle = node.value === 'on' ? '#123227' : '#1a1320';
  ctx.fill();
  ctx.strokeStyle = node.value === 'on' ? COLORS.good : '#5b2b3a';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  if (node.value === 'off') {
    ctx.fillStyle = '#2a1b28';
    for (let index = 0; index < 3; index += 1) {
      ctx.fillRect(box.x + 14, box.y + 18 + index * 14, box.w - 28, 7);
    }
  } else {
    ctx.strokeStyle = 'rgba(103, 232, 160, 0.5)';
    ctx.strokeRect(box.x + 12, box.y + 24, box.w - 24, box.h - 36);
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = '600 11px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(truncate(ctx, node.name, box.w - 12), box.x + box.w / 2, box.y + 15);
  ctx.font = '700 10px "PingFang SC", system-ui, sans-serif';
  ctx.fillStyle = node.value === 'on' ? COLORS.good : COLORS.danger;
  ctx.fillText(node.value === 'on' ? '可通行' : '关闭', box.x + box.w / 2, box.y + box.h - 10);
  if (node.kind === 'door' && node.openedAt !== null) {
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '600 8px "PingFang SC", system-ui, sans-serif';
    ctx.fillText(`自第 ${node.openedAt} 步打开`, box.x + box.w / 2, box.y + box.h - 23);
  }
}

function drawPort(ctx: CanvasRenderingContext2D, port: PortPosition, active: boolean, value: Signal): void {
  ctx.beginPath();
  ctx.arc(port.x, port.y, active ? 7 : 4.5, 0, Math.PI * 2);
  ctx.fillStyle = active ? COLORS.accent : value === 'on' ? COLORS.on : COLORS.off;
  ctx.fill();
  ctx.strokeStyle = active ? '#dff6ff' : '#0a1322';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  value: Signal,
  selected: boolean,
  dimmed: boolean,
): void {
  if (path.length === 0) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = selected ? COLORS.accent : value === 'on' ? COLORS.on : COLORS.wire;
  ctx.lineWidth = selected ? 4 : value === 'on' ? 3.2 : 2.4;
  ctx.globalAlpha = dimmed ? 0.3 : 1;
  ctx.beginPath();
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index];
    if (!point) continue;
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  if (selected) {
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 9;
    ctx.stroke();
  }
  ctx.restore();
}

function drawCharacter(ctx: CanvasRenderingContext2D, level: Level, time: number): void {
  const center = cellCenter(level.character);
  const bob = Math.sin(time / 320) * 1.2;
  ctx.save();
  ctx.translate(center.x, center.y + bob);
  ctx.beginPath();
  ctx.ellipse(0, 16, 12, 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.character;
  ctx.fill();
  ctx.strokeStyle = '#0b3d25';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-4.5, -3, 2.2, 0, Math.PI * 2);
  ctx.arc(4.5, -3, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = '#0b3d25';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 3, 4, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.strokeStyle = '#0b3d25';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
}

const MOVE_DELTA: Record<string, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function drawPendingMove(ctx: CanvasRenderingContext2D, level: Level, pending: TickIntent, time: number): void {
  const move = pending.move;
  if (!move) return;
  const start = cellCenter(level.character);
  const delta = MOVE_DELTA[move] ?? { x: 0, y: 0 };
  const target = { x: start.x + delta.x * CELL, y: start.y + delta.y * CELL };
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineDashOffset = -time / 40;
  ctx.strokeStyle = COLORS.accent;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(target.x, target.y, 11, 0, Math.PI * 2);
  ctx.strokeStyle = COLORS.accent;
  ctx.stroke();
  ctx.restore();
}

function drawPendingToggle(ctx: CanvasRenderingContext2D, node: LogicNode, time: number): void {
  const box = nodeBox(node);
  ctx.save();
  ctx.strokeStyle = COLORS.accent;
  ctx.globalAlpha = 0.55 + 0.25 * Math.sin(time / 220);
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  roundedRect(ctx, { x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6 }, 13);
  ctx.stroke();
  ctx.restore();
}

function drawGhost(ctx: CanvasRenderingContext2D, pos: GridPos): void {
  const box = cellBox(pos);
  roundedRect(ctx, { x: box.x + 6, y: box.y + 6, w: box.w - 12, h: box.h - 12 }, 10);
  ctx.fillStyle = 'rgba(90, 209, 255, 0.12)';
  ctx.fill();
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawWiringPreview(
  ctx: CanvasRenderingContext2D,
  level: Level,
  fromId: string,
  hover: Hit | null,
  pointer: Point | null,
): void {
  const start = outputPortPoint(level, fromId);
  if (!start) return;
  let end = pointer;
  if (hover?.type === 'port' && hover.side === 'in') {
    end = inputPortPoint(level, hover.nodeId, hover.index);
  } else if (hover?.type === 'node') {
    const node = nodeById(level, hover.nodeId);
    end = node ? nodePorts(node).find((port) => port.side === 'in') ?? null : null;
  }
  if (!end) return;
  ctx.save();
  ctx.setLineDash([7, 6]);
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
}

export function draw(ctx: CanvasRenderingContext2D, input: SceneInput, pointer: Point | null): void {
  ctx.setTransform(input.dpr, 0, 0, input.dpr, 0, 0);
  ctx.clearRect(0, 0, input.width, input.height);
  ctx.save();
  ctx.translate(input.viewport.offsetX, input.viewport.offsetY);
  ctx.scale(input.viewport.scale, input.viewport.scale);

  drawGrid(ctx, input.level);

  const feedbackNodes = new Set<string>();
  for (const scc of findGateSccs(input.level)) {
    if (!scc.cyclic) continue;
    for (const id of scc.nodes) feedbackNodes.add(id);
  }

  for (const node of input.level.nodes) {
    if (node.kind === 'plate') drawPlate(ctx, node, input.time);
  }

  for (const edge of input.level.edges) {
    const path = edgePolyline(input.level, edge);
    drawEdge(
      ctx,
      path,
      edgeValue(input.level, edge),
      input.selectedEdgeId === edge.id,
      Boolean(input.wiringFrom),
    );
  }

  for (const node of input.level.nodes) {
    if (node.kind === 'plate') continue;
    drawBaseBox(
      ctx,
      node,
      input.selectedNodeId === node.id,
      feedbackNodes.has(node.id),
      input.conflictNodeIds.has(node.id),
    );
    switch (node.kind) {
      case 'switch':
        drawSwitch(ctx, node);
        break;
      case 'gate':
        drawGate(ctx, node);
        break;
      case 'delay':
        drawDelay(ctx, node);
        break;
      case 'door':
        drawDoor(ctx, node);
        break;
      case 'lamp':
        drawLamp(ctx, node);
        break;
    }
  }

  const hoverPort = input.hover?.type === 'port' ? input.hover : null;
  for (const node of input.level.nodes) {
    for (const port of nodePorts(node)) {
      const active =
        (hoverPort !== null &&
          hoverPort.nodeId === port.nodeId &&
          hoverPort.side === port.side &&
          hoverPort.index === port.index) ||
        (input.wiringFrom === port.nodeId && port.side === 'out');
      drawPort(ctx, port, Boolean(active), port.side === 'out' ? node.value : 'off');
    }
  }

  drawCharacter(ctx, input.level, input.time);
  drawPendingMove(ctx, input.level, input.pending, input.time);
  for (const id of input.pending.toggleSwitchIds) {
    const node = nodeById(input.level, id);
    if (node) drawPendingToggle(ctx, node, input.time);
  }

  if (input.dragPreview) drawGhost(ctx, input.dragPreview);
  if (input.wiringFrom) drawWiringPreview(ctx, input.level, input.wiringFrom, input.hover, pointer);

  ctx.restore();

  ctx.save();
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '600 11px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${input.level.cols} × ${input.level.rows}`, input.width / input.dpr - 12, input.height / input.dpr - 10);
  ctx.restore();
}

export function describeHit(level: Level, hit: Hit | null): string {
  if (!hit) return '';
  switch (hit.type) {
    case 'node':
      return nodeById(level, hit.nodeId)?.name ?? '未知节点';
    case 'port': {
      const node = nodeById(level, hit.nodeId);
      return node ? `${node.name} ${hit.side === 'in' ? `IN ${hit.index === 1 ? 'B' : 'A'}` : 'OUT'}` : '端口';
    }
    case 'edge': {
      const edge = level.edges.find((candidate) => candidate.id === hit.edgeId);
      if (!edge) return '接线';
      return `${nodeById(level, edge.from)?.name ?? edge.from} → ${nodeById(level, edge.to)?.name ?? edge.to}`;
    }
    case 'character':
      return '角色';
    case 'cell':
      return `格子 ${cellKey(hit.pos)}`;
  }
}

export function portValue(level: Level, nodeId: string, side: 'in' | 'out', index: number): Signal {
  const node = nodeById(level, nodeId);
  if (!node) return 'off';
  if (side === 'out') return node.value;
  const source = nodeSources(level, node)[index];
  return source?.value ?? 'off';
}
