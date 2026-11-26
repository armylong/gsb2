import { cellWindowIndex } from '../game/engine';
import { norm360, phaseAt, polar } from '../game/geometry';
import type { BeatReport, GameState, LevelDef, ScopeId, SimulationResult } from '../game/types';

export const STAGE_W = 1000;
export const STAGE_H = 680;

const CX = 500;
const CY = 338;
const SKY_R = 276;
const CELL_R = 92;

export interface ScopeScreenPos {
  x: number;
  y: number;
  r: number;
}

export function getScopePositions(level: LevelDef): Record<ScopeId, ScopeScreenPos> {
  const w0 = polar(CX, CY, CELL_R, level.windows[0].centre);
  const w1 = polar(CX, CY, CELL_R, level.windows[1].centre);
  const walk = { x: (w0.x + w1.x) / 2, y: (w0.y + w1.y) / 2 };
  return {
    0: { ...(level.scopes[0].startCell === 'w0' ? w0 : level.scopes[0].startCell === 'w1' ? w1 : walk), r: 25 },
    1: { ...(level.scopes[1].startCell === 'w0' ? w0 : level.scopes[1].startCell === 'w1' ? w1 : walk), r: 25 },
  };
}

function currentScopePos(level: LevelDef, state: GameState, id: ScopeId) {
  const w0 = polar(CX, CY, CELL_R, level.windows[0].centre);
  const w1 = polar(CX, CY, CELL_R, level.windows[1].centre);
  const walk = { x: (w0.x + w1.x) / 2, y: (w0.y + w1.y) / 2 };
  const cell = state.scopes[id].cell;
  return cell === 'w0' ? w0 : cell === 'w1' ? w1 : walk;
}

function traceArc(
  ctx: CanvasRenderingContext2D,
  centre: number,
  halfWidth: number,
  radius: number,
  steps = 48,
): void {
  for (let i = 0; i <= steps; i += 1) {
    const a = centre - halfWidth + (2 * halfWidth * i) / steps;
    const p = polar(CX, CY, radius, a);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
}

function drawStarShape(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  outer: number,
  inner: number,
  points = 5,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundedRect(
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

export interface RenderStageOptions {
  level: LevelDef;
  state: GameState;
  result: SimulationResult;
  playhead: number;
  selectedScope: ScopeId;
  report: BeatReport | null;
}

export function renderStage(ctx: CanvasRenderingContext2D, opts: RenderStageOptions): void {
  const { level, state, playhead, selectedScope, report } = opts;
  const nextBeat = Math.min(playhead, level.totalBeats - 1);
  const phase = phaseAt(level, nextBeat);

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, STAGE_H);
  if (phase === 'day') {
    bg.addColorStop(0, '#173a5e');
    bg.addColorStop(0.55, '#102a47');
    bg.addColorStop(1, '#081827');
  } else {
    bg.addColorStop(0, '#07111f');
    bg.addColorStop(0.6, '#0a1729');
    bg.addColorStop(1, '#050b14');
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);

  // Deterministic faint background stars.
  for (let i = 0; i < 90; i += 1) {
    const x = (i * 137.508) % STAGE_W;
    const y = (i * 71.37) % STAGE_H;
    const a = 0.12 + ((i * 17) % 30) / 100;
    ctx.fillStyle = `rgba(226,232,240,${a})`;
    ctx.fillRect(x, y, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1);
  }

  // Sky field
  const sky = ctx.createRadialGradient(CX, CY, 20, CX, CY, SKY_R + 30);
  sky.addColorStop(0, phase === 'day' ? 'rgba(56,189,248,0.16)' : 'rgba(30,64,175,0.18)');
  sky.addColorStop(0.72, 'rgba(15,23,42,0.72)');
  sky.addColorStop(1, 'rgba(2,6,23,0.96)');
  ctx.fillStyle = sky;
  ctx.beginPath();
  ctx.arc(CX, CY, SKY_R + 26, 0, Math.PI * 2);
  ctx.fill();

  // Orbit rings
  for (const body of level.bodies) {
    ctx.beginPath();
    ctx.arc(CX, CY, body.orbitRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(148,163,184,0.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Window fields and frames
  level.windows.forEach((win, wi) => {
    const color = wi === 0 ? '56,189,248' : '251,191,36';
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    traceArc(ctx, win.centre, win.halfWidth, SKY_R);
    ctx.closePath();
    ctx.fillStyle = `rgba(${color},0.075)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${color},0.22)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Boundary rays
    for (const edge of [win.centre - win.halfWidth, win.centre + win.halfWidth]) {
      const p = polar(CX, CY, SKY_R, edge);
      ctx.setLineDash([6, 7]);
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = `rgba(${color},0.42)`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Outer frame / window opening
    ctx.beginPath();
    traceArc(ctx, win.centre, win.halfWidth, SKY_R + 8, 64);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 25;
    ctx.lineCap = 'butt';
    ctx.stroke();

    ctx.beginPath();
    traceArc(ctx, win.centre, win.halfWidth, SKY_R + 8, 64);
    ctx.strokeStyle = `rgba(${color},0.55)`;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Eave segment
    ctx.beginPath();
    const eaveStart = win.centre + win.eave.from;
    const eaveEnd = win.centre + win.eave.to;
    for (let i = 0; i <= 16; i += 1) {
      const a = eaveStart + ((eaveEnd - eaveStart) * i) / 16;
      const p = polar(CX, CY, SKY_R + 8, a);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = '#1c1917';
    ctx.lineWidth = 27;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(251,146,60,0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const labelP = polar(CX, CY, SKY_R + 48, win.centre);
    ctx.textAlign = 'center';
    ctx.font = '700 18px system-ui, sans-serif';
    ctx.fillStyle = wi === 0 ? '#7dd3fc' : '#fcd34d';
    ctx.fillText(win.name, labelP.x, labelP.y - 4);
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`FOV ${win.halfWidth * 2}° · 中心 ${norm360(win.centre)}°`, labelP.x, labelP.y + 15);

    const eaveP = polar(CX, CY, SKY_R + 31, (eaveStart + eaveEnd) / 2);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#fdba74';
    ctx.fillText('檐', eaveP.x, eaveP.y + 4);
  });

  // Direction arrows on orbits
  for (const body of level.bodies) {
    const a = body.initialAngle + body.dir * body.speed * 2;
    const p = polar(CX, CY, body.orbitRadius + 13, a);
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(226,232,240,0.45)';
    ctx.fillText(body.dir === 1 ? '↥' : '↧', p.x, p.y);
  }

  // Future short forecast ghosts (next 1..3 beats)
  for (const bodyDef of level.bodies) {
    for (let ahead = 3; ahead >= 1; ahead -= 1) {
      const futureElapsed = playhead + ahead;
      if (futureElapsed > level.totalBeats) continue;
      const angle = norm360(bodyDef.initialAngle + bodyDef.dir * bodyDef.speed * futureElapsed);
      const p = polar(CX, CY, bodyDef.orbitRadius, angle);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ahead === 1 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = bodyDef.color + (ahead === 1 ? '66' : '33');
      ctx.fill();
      if (ahead === 1) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(226,232,240,0.7)';
        ctx.fillText('下拍', p.x, p.y - 10);
      }
    }
  }

  // Bodies
  for (const body of state.bodies) {
    const def = level.bodies.find((b) => b.id === body.id)!;
    const p = polar(CX, CY, def.orbitRadius, body.angle);
    const gradient = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, 24);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.25, def.color);
    gradient.addColorStop(1, def.color + '00');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = def.color;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    if (def.shape === 'star') {
      drawStarShape(ctx, p.x, p.y, 11, 5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 15, 4, -0.35, 0, Math.PI * 2);
      ctx.strokeStyle = def.color + 'aa';
      ctx.stroke();
    }

    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(def.name, p.x + 15, p.y - 8);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${body.angle.toFixed(0)}° · ${def.filter === 'clear' ? '白光' : def.filter === 'red' ? '红片' : '蓝片'} · 需${def.requiredBeats}连`, p.x + 15, p.y + 9);
  }

  // Inspected beat loss highlights
  if (report) {
    for (const loss of report.losses) {
      if (!loss.targetId) continue;
      const body = state.bodies.find((b) => b.id === loss.targetId);
      const def = level.bodies.find((b) => b.id === loss.targetId);
      if (!body || !def) continue;
      const p = polar(CX, CY, def.orbitRadius, body.angle);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 22 + (report.beat % 2) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = loss.code === 'eave' ? '#fb923c' : '#f87171';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = '800 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fecaca';
      ctx.fillText('!', p.x, p.y - 27);
    }
  }

  // Catwalk
  const w0 = polar(CX, CY, CELL_R, level.windows[0].centre);
  const w1 = polar(CX, CY, CELL_R, level.windows[1].centre);
  const walk = { x: (w0.x + w1.x) / 2, y: (w0.y + w1.y) / 2 };

  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(w0.x, w0.y);
  ctx.lineTo(w1.x, w1.y);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 25;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w0.x, w0.y);
  ctx.lineTo(w1.x, w1.y);
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 13;
  ctx.stroke();

  // Shared central segment
  const q0 = { x: w0.x * 0.55 + w1.x * 0.45, y: w0.y * 0.55 + w1.y * 0.45 };
  const q1 = { x: w0.x * 0.45 + w1.x * 0.55, y: w0.y * 0.45 + w1.y * 0.55 };
  ctx.beginPath();
  ctx.moveTo(q0.x, q0.y);
  ctx.lineTo(q1.x, q1.y);
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 9;
  ctx.stroke();

  for (const [pos, label, windowIndex] of [
    [w0, '窗位 A', 0],
    [w1, '窗位 B', 1],
  ] as const) {
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 27, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15,23,42,0.92)';
    ctx.fill();
    ctx.strokeStyle = windowIndex === 0 ? '#38bdf8' : '#fbbf24';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(label, pos.x, pos.y + 43);
  }

  roundedRect(ctx, walk.x - 42, walk.y - 17, 84, 34, 10);
  ctx.fillStyle = 'rgba(120,53,15,0.92)';
  ctx.fill();
  ctx.strokeStyle = '#fde68a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fef3c7';
  ctx.fillText('共用走台', walk.x, walk.y + 4);

  // Heading rays from central bearing reference
  state.scopes.forEach((s) => {
    const color = s.id === 0 ? '#22d3ee' : '#fbbf24';
    const end = polar(CX, CY, SKY_R - 4, s.heading);
    ctx.setLineDash(s.observing ? [] : [8, 7]);
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = color + (s.observing ? 'aa' : '55');
    ctx.lineWidth = s.observing ? 2.2 : 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    const hp = polar(CX, CY, SKY_R - 18, s.heading);
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(`${s.id === 0 ? '①' : '②'} ${s.heading.toFixed(0)}°`, hp.x, hp.y);
  });

  // Scopes
  state.scopes.forEach((s) => {
    const pos = currentScopePos(level, state, s.id);
    const color = s.id === 0 ? '#22d3ee' : '#fbbf24';
    const selected = selectedScope === s.id;

    if (selected) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 32, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 23, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate((-s.heading * Math.PI) / 180);
    roundedRect(ctx, -5, -7, 34, 14, 5);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(24, -5, 7, 10);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();

    ctx.font = '800 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0f172a';
    ctx.fillText(s.id === 0 ? '1' : '2', pos.x, pos.y + 5);

    const filterText = s.filter === 'clear' ? '白' : s.filter === 'red' ? '红' : '蓝';
    ctx.beginPath();
    ctx.arc(pos.x + 20, pos.y - 20, 11, 0, Math.PI * 2);
    ctx.fillStyle = s.filter === 'clear' ? '#e2e8f0' : s.filter === 'red' ? '#ef4444' : '#3b82f6';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.fillStyle = s.filter === 'clear' ? '#0f172a' : '#ffffff';
    ctx.fillText(filterText, pos.x + 20, pos.y - 16);

    if (s.observing) {
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = '#bbf7d0';
      const target = level.bodies.find((b) => b.id === s.targetId);
      ctx.fillText(`观测中 ${s.streak}${target ? `/${target.requiredBeats}` : ''}`, pos.x, pos.y + 43);
    } else if (s.cell === 'walk') {
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = '#fde68a';
      ctx.fillText('走台中', pos.x, pos.y + 43);
    }
  });

  // Records chips top-left inside canvas
  ctx.textAlign = 'left';
  roundedRect(ctx, 18, 18, 286, 40, 14);
  ctx.fillStyle = 'rgba(2,6,23,0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,222,128,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = '800 15px system-ui, sans-serif';
  ctx.fillStyle = '#bbf7d0';
  ctx.fillText(`已提交观测记录：${state.records.length}`, 34, 44);

  // Pass/fail watermark only at final playhead
  if (playhead >= level.totalBeats) {
    const passed = level.bodies
      .filter((b) => b.designated)
      .every((b) => state.records.some((r) => r.targetId === b.id));
    roundedRect(ctx, CX - 286, 68, 572, 68, 18);
    ctx.fillStyle = 'rgba(2,6,23,0.76)';
    ctx.fill();
    ctx.strokeStyle = passed ? 'rgba(74,222,128,0.45)' : 'rgba(248,113,113,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = '900 40px system-ui, sans-serif';
    ctx.fillStyle = passed ? 'rgba(74,222,128,0.96)' : 'rgba(248,113,113,0.96)';
    ctx.fillText(passed ? '通关：记录齐全' : '尚未交齐记录', CX, 105);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText('通关只看已交到的合格记录；损失拍可在右侧时间线复查。', CX, 128);
  }
}

export function scopeAtPoint(level: LevelDef, state: GameState, x: number, y: number): ScopeId | null {
  for (const id of [0, 1] as ScopeId[]) {
    const p = currentScopePos(level, state, id);
    if (Math.hypot(x - p.x, y - p.y) <= 30) return id;
  }
  return null;
}

export function windowIndexAtBearing(level: LevelDef, angle: number): 0 | 1 | null {
  for (let i = 0; i < 2; i += 1) {
    const w = level.windows[i as 0 | 1];
    if (Math.abs(((angle - w.centre + 540) % 360) - 180) <= w.halfWidth) return i as 0 | 1;
  }
  return null;
}

export { cellWindowIndex };
