import { colorName } from '../game/engine';
import type {
  BeadColor,
  BeadState,
  LevelDef,
  SetupState,
  Side,
  SimFrame,
} from '../game/types';

export interface PickResult {
  chuteId: string;
  side: Side;
}

export interface RenderState {
  level: LevelDef;
  setup: SetupState;
  frame?: SimFrame | null;
  nextFrame?: SimFrame | null;
  progress?: number;
  hoverChute?: string | null;
  hoverSlot?: string | null;
}

const COLORS: Record<BeadColor, { main: string; dark: string; light: string }> = {
  red: { main: '#ef4444', dark: '#7f1d1d', light: '#fecaca' },
  blue: { main: '#3b82f6', dark: '#1e3a8a', light: '#bfdbfe' },
};

export function slotPosition(level: LevelDef, slotId: string): { x: number; y: number } {
  const slot = level.slots.find((s) => s.id === slotId);
  if (slot?.at) return slot.at;
  const node = slot ? level.nodes[slot.node] : undefined;
  return { x: node?.x ?? 0, y: (node?.y ?? 0) - 68 };
}

function beadStaticPosition(level: LevelDef, bead: BeadState): { x: number; y: number } {
  if (bead.status === 'exited' && bead.exitNode) {
    const node = level.nodes[bead.exitNode];
    return node ? { x: node.x, y: node.y + 6 } : { x: 0, y: 0 };
  }
  if (bead.node) {
    const node = level.nodes[bead.node];
    if (node) return { x: node.x, y: node.y };
  }
  return slotPosition(level, bead.slotId);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function beadPosition(
  level: LevelDef,
  frame: SimFrame | null | undefined,
  nextFrame: SimFrame | null | undefined,
  progress: number,
  beadId: string,
): { x: number; y: number } {
  const bead = frame?.beads.find((b) => b.id === beadId) ?? nextFrame?.beads.find((b) => b.id === beadId);
  if (!bead) return { x: 0, y: 0 };

  if (frame && nextFrame && progress > 0 && progress < 1) {
    const nextBead = nextFrame.beads.find((b) => b.id === beadId);
    const move = nextFrame.trace?.moves.find((m) => m.beadId === beadId);
    if (move) {
      const fromNode = level.nodes[move.from];
      const toNode = level.nodes[move.to];
      if (fromNode && toNode) {
        const spawned = nextFrame.trace?.spawned.includes(beadId);
        if (spawned) {
          const rack = slotPosition(level, bead.slotId);
          if (progress < 0.18) {
            const q = easeInOut(progress / 0.18);
            return { x: lerp(rack.x, fromNode.x, q), y: lerp(rack.y - 10, fromNode.y, q) };
          }
          const q = easeInOut((progress - 0.18) / 0.82);
          return { x: lerp(fromNode.x, toNode.x, q), y: lerp(fromNode.y, toNode.y, q) };
        }
        const q = easeInOut(progress);
        return { x: lerp(fromNode.x, toNode.x, q), y: lerp(fromNode.y, toNode.y, q) };
      }
    }

    if (nextBead && bead.status === 'queued' && nextBead.node) {
      const rack = slotPosition(level, bead.slotId);
      const node = level.nodes[nextBead.node];
      if (node) {
        const q = easeInOut(progress);
        return { x: lerp(rack.x, node.x, q), y: lerp(rack.y - 10, node.y, q) };
      }
    }
  }

  // Stack exited beads inside their bin by arrival order.
  if (bead.status === 'exited' && bead.exitNode && frame) {
    const node = level.nodes[bead.exitNode];
    const index = frame.arrivals.filter((a) => a.bin === bead.bin).findIndex((a) => a.beadId === bead.id);
    if (node) {
      const count = frame.arrivals.filter((a) => a.bin === bead.bin).length;
      const spacing = 27;
      const startX = node.x - ((count - 1) * spacing) / 2;
      return { x: startX + Math.max(index, 0) * spacing, y: node.y + 10 };
    }
  }

  return beadStaticPosition(level, bead);
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

function sideEndpoint(level: LevelDef, chuteId: string, side: Side): { x: number; y: number } {
  const chute = level.chutes.find((c) => c.id === chuteId)!;
  const outputId = chute.outputs[side];
  if (outputId && level.nodes[outputId]) return level.nodes[outputId];
  const entry = level.nodes[chute.entry];
  return { x: entry.x + (side === 'left' ? -145 : 145), y: entry.y + 158 };
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pickChute(level: LevelDef, x: number, y: number): PickResult | null {
  let best: (PickResult & { distance: number }) | null = null;
  for (const chute of level.chutes) {
    const entry = level.nodes[chute.entry];
    if (!entry) continue;
    for (const side of ['left', 'right'] as Side[]) {
      const end = sideEndpoint(level, chute.id, side);
      const distance = distanceToSegment(x, y, entry.x, entry.y, end.x, end.y);
      if (distance < 26 && (!best || distance < best.distance)) {
        best = { chuteId: chute.id, side, distance };
      }
    }
  }
  return best ? { chuteId: best.chuteId, side: best.side } : null;
}

export function pickSlot(level: LevelDef, x: number, y: number): string | null {
  for (const slot of level.slots) {
    const p = slotPosition(level, slot.id);
    if (Math.hypot(x - p.x, y - p.y) <= 25) return slot.id;
  }
  return null;
}

function drawBackground(ctx: CanvasRenderingContext2D, level: LevelDef): void {
  const bg = ctx.createLinearGradient(0, 0, 0, level.height);
  bg.addColorStop(0, '#fff8e8');
  bg.addColorStop(1, '#f1dfbd');
  roundRect(ctx, 12, 12, level.width - 24, level.height - 24, 28);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = '#c9a96a';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.save();
  for (let x = 42; x < level.width - 30; x += 34) {
    for (let y = 42; y < level.height - 30; y += 34) {
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 83, 35, 0.16)';
      ctx.fill();
    }
  }
  ctx.restore();
}

function currentTilts(state: RenderState): Record<string, Side> {
  const { frame, nextFrame, progress = 0, setup } = state;
  if (frame && nextFrame && progress > 0.55) return nextFrame.tilts;
  if (frame) return frame.tilts;
  return setup.tilts;
}

function drawChutes(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { level, hoverChute } = state;
  const tilts = currentTilts(state);

  for (const chute of level.chutes) {
    const entry = level.nodes[chute.entry];
    if (!entry) continue;
    const activeSide = tilts[chute.id] ?? chute.initial;
    const activeEnd = sideEndpoint(level, chute.id, activeSide);
    const inactiveSide: Side = activeSide === 'left' ? 'right' : 'left';
    const inactiveEnd = sideEndpoint(level, chute.id, inactiveSide);
    const hovered = hoverChute === chute.id;

    // Inactive possible connection.
    ctx.save();
    ctx.setLineDash([10, 12]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = chute.outputs[inactiveSide] ? 'rgba(71, 85, 105, 0.25)' : 'rgba(220, 38, 38, 0.42)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(entry.x, entry.y);
    ctx.lineTo(inactiveEnd.x, inactiveEnd.y);
    ctx.stroke();
    ctx.restore();

    if (!chute.outputs[inactiveSide]) {
      ctx.fillStyle = '#dc2626';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('不通', inactiveEnd.x, inactiveEnd.y + 4);
    }

    // Active wooden trough: dark outside, bright inside.
    ctx.save();
    ctx.lineCap = 'round';
    if (hovered) {
      ctx.shadowColor = 'rgba(14, 165, 233, 0.75)';
      ctx.shadowBlur = 16;
    }
    ctx.strokeStyle = '#6b3f1d';
    ctx.lineWidth = hovered ? 25 : 22;
    ctx.beginPath();
    ctx.moveTo(entry.x, entry.y);
    ctx.lineTo(activeEnd.x, activeEnd.y);
    ctx.stroke();

    ctx.shadowBlur = 0;
    const metal = ctx.createLinearGradient(entry.x, entry.y, activeEnd.x, activeEnd.y);
    metal.addColorStop(0, '#e7b86a');
    metal.addColorStop(0.5, '#c98235');
    metal.addColorStop(1, '#9a5a22');
    ctx.strokeStyle = metal;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(entry.x, entry.y);
    ctx.lineTo(activeEnd.x, activeEnd.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 244, 214, 0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(entry.x - 3, entry.y - 2);
    ctx.lineTo(activeEnd.x - 3, activeEnd.y - 2);
    ctx.stroke();
    ctx.restore();

    if (!chute.outputs[activeSide]) {
      ctx.fillStyle = '#b91c1c';
      ctx.font = '800 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('当前倒向不通侧', activeEnd.x, activeEnd.y + 24);
    }

    // Chute id / control label.
    const mx = (entry.x + activeEnd.x) / 2;
    const my = (entry.y + activeEnd.y) / 2 - 18;
    ctx.font = '800 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    const label = chute.label ? `${chute.id}` : chute.id;
    const width = ctx.measureText(label).width + 14;
    roundRect(ctx, mx - width / 2, my - 13, width, 22, 8);
    ctx.fillStyle = chute.adjustable === false ? 'rgba(71,85,105,.82)' : 'rgba(15,23,42,.86)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my - 2);
    ctx.textBaseline = 'alphabetic';

    if (chute.trigger) {
      const sx = (entry.x + activeEnd.x) / 2 + 25;
      const sy = (entry.y + activeEnd.y) / 2 + 18;
      ctx.beginPath();
      ctx.arc(sx, sy, 13, 0, Math.PI * 2);
      ctx.fillStyle = '#7c3aed';
      ctx.fill();
      ctx.strokeStyle = '#ede9fe';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '900 13px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚡', sx, sy + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }
}

function drawNodes(ctx: CanvasRenderingContext2D, level: LevelDef, state: RenderState): void {
  const conflictNodes = new Set(
    [state.frame?.trace, state.nextFrame?.trace].filter(Boolean).flatMap((t) => t?.conflicts.map((c) => c.node) ?? []),
  );

  for (const node of Object.values(level.nodes)) {
    if (node.kind === 'exit') {
      const x = node.x - 52;
      const y = node.y - 28;
      roundRect(ctx, x, y, 104, 72, 16);
      const grad = ctx.createLinearGradient(x, y, x, y + 72);
      grad.addColorStop(0, node.bin === 'L' ? '#dcfce7' : '#dbeafe');
      grad.addColorStop(1, node.bin === 'L' ? '#86efac' : '#93c5fd');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = conflictNodes.has(node.id) ? '#7c3aed' : '#475569';
      ctx.lineWidth = conflictNodes.has(node.id) ? 4 : 2.5;
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = '900 20px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(node.bin === 'L' ? '左出口' : '右出口', node.x, node.y - 4);
      ctx.font = '700 12px system-ui';
      ctx.fillStyle = '#334155';
      const expected = level.goal.filter((g) => g.bin === node.bin);
      ctx.fillText(expected.map((g) => colorName(g.color)).join(' → ') || '出口', node.x, node.y + 17);
      continue;
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, 21, 0, Math.PI * 2);
    ctx.fillStyle = conflictNodes.has(node.id) ? '#f3e8ff' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = conflictNodes.has(node.id) ? '#7c3aed' : '#94a3b8';
    ctx.lineWidth = conflictNodes.has(node.id) ? 4 : 2.5;
    ctx.stroke();

    if (node.label) {
      ctx.fillStyle = '#475569';
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.label, node.x, node.y + 39);
    }
  }
}

function drawRack(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { level, setup, frame, hoverSlot } = state;
  for (const slot of level.slots) {
    const p = slotPosition(level, slot.id);
    const color = setup.colors[slot.id];
    const isHover = hoverSlot === slot.id;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = isHover ? '#0ea5e9' : '#64748b';
    ctx.lineWidth = isHover ? 3 : 2;
    ctx.stroke();
    ctx.setLineDash([]);

    if (color && !state.frame) {
      const palette = COLORS[color];
      const grad = ctx.createRadialGradient(p.x - 6, p.y - 7, 3, p.x, p.y, 18);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, palette.main);
      grad.addColorStop(1, palette.dark);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (color && state.frame) {
      // While a simulation frame is shown, draw only a small setup-color tick;
      // the real queued/active/exited bead is rendered once by drawBeads().
      ctx.beginPath();
      ctx.arc(p.x + 17, p.y - 17, 6, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[color].main;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = '#64748b';
      ctx.font = '800 18px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', p.x, p.y + 1);
      ctx.textBaseline = 'alphabetic';
    }

    ctx.fillStyle = '#0f172a';
    ctx.font = '800 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(slot.id, p.x, p.y - 31);

    // If simulation frame has a queued bead, draw a small waiting marker.
    const queued = frame?.beads.find((b) => b.slotId === slot.id && b.status === 'queued');
    if (queued) {
      ctx.fillStyle = '#b45309';
      ctx.font = '700 12px system-ui';
      ctx.fillText('等待发射', p.x, p.y + 42);
    }
  }
}

function drawBeadAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: BeadColor,
  label: string,
  radius = 16,
): void {
  const palette = COLORS[color];
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, .35)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  const grad = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.1, x, y, radius);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.28, palette.main);
  grad.addColorStop(1, palette.dark);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,.72)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 0.5);
  ctx.textBaseline = 'alphabetic';
}

function drawBeads(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { level, frame, nextFrame, progress = 0 } = state;
  if (!frame) return;

  for (const bead of frame.beads) {
    // During interpolation, next frame owns the moving/exited endpoint; draw all ids once.
    const pos = beadPosition(level, frame, nextFrame, progress, bead.id);
    if (bead.status === 'exited' && !(nextFrame && progress > 0 && progress < 1)) {
      drawBeadAt(ctx, pos.x, pos.y, bead.color, bead.slotId.replace('S', ''), 12);
    } else {
      const label = bead.slotId.replace('S', '').slice(0, 2);
      const radius = bead.status === 'queued' ? 15 : 16;
      drawBeadAt(ctx, pos.x, pos.y, bead.color, label, radius);
    }
  }

  // Block / wait markers from the completed trace currently displayed.
  const trace = frame.trace;
  if (trace) {
    for (const block of trace.blocks) {
      if (block.kind === 'launch-blocked') continue;
      const bead = frame.beads.find((b) => b.id === block.beadId);
      if (!bead?.node) continue;
      const p = level.nodes[bead.node];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x + 17, p.y - 17, 12, 0, Math.PI * 2);
      ctx.fillStyle = block.kind === 'lost-priority' || block.kind === 'occupied' ? '#f59e0b' : '#dc2626';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '900 13px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(block.kind === 'occupied' ? '等' : '!', p.x + 17, p.y - 16);
      ctx.textBaseline = 'alphabetic';
    }
  }
}

export function renderBoard(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { level } = state;
  ctx.clearRect(0, 0, level.width, level.height);
  drawBackground(ctx, level);
  drawChutes(ctx, state);
  drawNodes(ctx, level, state);
  drawRack(ctx, state);
  drawBeads(ctx, state);
}
