import { edgeTime } from './graph';
import type {
  ActorDef,
  Level,
  Plan,
  PlanAction,
  SimulationResult,
  StageNode,
} from './types';

export const STAGE_W = 960;
export const STAGE_H = 600;

interface Point {
  x: number;
  y: number;
}

export function nodePoint(level: Level, id: string): Point {
  const node = level.nodes.find((n) => n.id === id);
  return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
}

function positionAlongPath(level: Level, path: string[], elapsed: number): Point {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return nodePoint(level, path[0]);
  let remaining = elapsed;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = nodePoint(level, path[i]);
    const b = nodePoint(level, path[i + 1]);
    const duration = edgeTime(level, path[i] as any, path[i + 1] as any) ?? 1;
    if (remaining <= duration || i === path.length - 2) {
      const p = Math.max(0, Math.min(1, remaining / duration));
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    }
    remaining -= duration;
  }
  return nodePoint(level, path[path.length - 1]);
}

function activeMoveAction(
  sim: SimulationResult,
  plan: Plan,
  beat: number,
  actorId: string,
): Extract<PlanAction, { type: 'move' }> | null {
  const snap = sim.snapshots[Math.max(0, Math.min(beat, sim.horizon))];
  const actor = snap.actors.find((a) => a.id === actorId);
  if (!actor?.currentActionId) return null;
  const action = plan.actions.find((a) => a.id === actor.currentActionId);
  if (action?.type !== 'move') return null;
  if (sim.statusById[action.id] === 'rejected') return null;
  return action;
}

export function actorPositionAtTime(
  level: Level,
  sim: SimulationResult,
  plan: Plan,
  time: number,
  actor: ActorDef,
): Point {
  const safeTime = Math.max(0, Math.min(time, sim.horizon));
  const beat = Math.floor(safeTime);
  const snap = sim.snapshots[beat];
  const state = snap.actors.find((a) => a.id === actor.id);
  const base = nodePoint(level, state?.location ?? actor.start);
  const move = activeMoveAction(sim, plan, beat, actor.id);
  if (move) {
    return positionAlongPath(level, move.path, safeTime - move.start);
  }
  return base;
}

export function hitActor(
  level: Level,
  sim: SimulationResult,
  plan: Plan,
  time: number,
  x: number,
  y: number,
): string | null {
  for (const actor of level.actors) {
    const p = actorPositionAtTime(level, sim, plan, time, actor);
    if (Math.hypot(x - p.x, y - p.y) <= 24) return actor.id;
  }
  return null;
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
  ctx.arcTo(x, y + h, x, y + h, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawEdge(ctx: CanvasRenderingContext2D, level: Level, edge: Level['edges'][number]): void {
  const a = nodePoint(level, edge.a);
  const b = nodePoint(level, edge.b);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 7]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  ctx.font = '600 13px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  const label = `${edge.name} · ${edge.beats}拍`;
  const width = ctx.measureText(label).width + 14;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
  roundRect(ctx, mx - width / 2, my - 13, width, 24, 12);
  ctx.fill();
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, mx, my);
  ctx.restore();
}

function drawNode(ctx: CanvasRenderingContext2D, node: StageNode, beat: number, sim: SimulationResult): void {
  ctx.save();
  const isEntrance = node.kind === 'entrance';
  const isRoom = node.kind === 'room';
  const isRelay = node.kind === 'relay';

  if (isEntrance) {
    ctx.fillStyle = node.id === 'L' ? 'rgba(34,211,238,.16)' : 'rgba(244,114,182,.16)';
    ctx.strokeStyle = node.id === 'L' ? '#22d3ee' : '#f472b6';
    ctx.lineWidth = 3;
    roundRect(ctx, node.x - 74, node.y - 34, 148, 68, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 18px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name, node.x, node.y - 4);
    ctx.font = '600 12px ui-sans-serif, system-ui';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(node.id === 'L' ? 'Stage Left Door' : 'Stage Right Door', node.x, node.y + 18);
  } else if (isRoom) {
    const usage = sim.snapshots[beat].roomUsage.find((u) => u.room === node.id);
    ctx.fillStyle = usage
      ? usage.accepted
        ? 'rgba(251,191,36,.18)'
        : 'rgba(248,113,113,.20)'
      : 'rgba(30,41,59,.92)';
    ctx.strokeStyle = usage ? (usage.accepted ? '#fbbf24' : '#f87171') : '#64748b';
    ctx.lineWidth = 3;
    roundRect(ctx, node.x - 78, node.y - 42, 156, 84, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 18px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(node.name, node.x, node.y - 12);
    ctx.font = '600 12px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.fillStyle = usage ? '#fde68a' : '#94a3b8';
    ctx.fillText(
      usage ? `${usage.actorId}：${usage.label}` : node.note ?? '空',
      node.x,
      node.y + 14,
      140,
    );
  } else if (isRelay) {
    ctx.fillStyle = 'rgba(74,222,128,.14)';
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(node.x, node.y - 38);
    ctx.lineTo(node.x + 86, node.y);
    ctx.lineTo(node.x, node.y + 38);
    ctx.lineTo(node.x - 86, node.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#dcfce7';
    ctx.font = '800 17px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name, node.x, node.y - 4);
    ctx.font = '600 11px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.fillStyle = '#86efac';
    ctx.fillText('外套交接', node.x, node.y + 16);

    const items = sim.snapshots[beat].garments.filter((g) => g.location === 'T' && !g.wornBy && !g.carriedBy);
    items.forEach((g, i) => {
      const x = node.x - 54 + i * 38;
      const y = node.y - 58;
      ctx.fillStyle = g.color;
      roundRect(ctx, x - 15, y - 12, 30, 24, 8);
      ctx.fill();
      ctx.strokeStyle = '#052e16';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  } else {
    ctx.fillStyle = 'rgba(100,116,139,.22)';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(node.x, node.y, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '800 15px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('后台', node.x, node.y - 6);
    ctx.font = '600 11px ui-sans-serif, system-ui';
    ctx.fillText('汇点', node.x, node.y + 12);
  }
  ctx.restore();
}

function drawQueues(ctx: CanvasRenderingContext2D, level: Level, beat: number, sim: SimulationResult): void {
  const snap = sim.snapshots[beat];
  for (const entrance of ['L', 'R'] as const) {
    const node = nodePoint(level, entrance);
    const queue = snap.queues[entrance];
    if (queue.length === 0) continue;
    ctx.save();
    ctx.font = '700 12px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = entrance === 'L' ? '#67e8f9' : '#f9a8d4';
    const labelY = node.y + 58;
    roundRect(ctx, node.x - 58, labelY - 13, 116, 24, 12);
    ctx.fillStyle = 'rgba(15,23,42,.82)';
    ctx.fill();
    ctx.fillStyle = entrance === 'L' ? '#67e8f9' : '#f9a8d4';
    ctx.fillText(`入口队列 ${queue.length}`, node.x, labelY);
    queue.forEach((actorId, i) => {
      ctx.fillStyle = 'rgba(15,23,42,.9)';
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      const x = node.x - 34 + i * 24;
      const y = labelY + 24;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 10px ui-sans-serif, system-ui';
      const def = level.actors.find((a) => a.id === actorId);
      ctx.fillText(def?.short ?? actorId.slice(0, 1), x, y + 0.5);
    });
    ctx.restore();
  }
}

function drawActor(
  ctx: CanvasRenderingContext2D,
  level: Level,
  sim: SimulationResult,
  plan: Plan,
  time: number,
  actor: ActorDef,
  _index: number,
  positions: Map<string, Point>,
  selectedActorId?: string | null,
): void {
  const p = positions.get(actor.id) ?? actorPositionAtTime(level, sim, plan, time, actor);
  const beat = Math.floor(Math.max(0, Math.min(time, sim.horizon)));
  const snap = sim.snapshots[beat];
  const state = snap.actors.find((a) => a.id === actor.id);
  const outer = state?.worn.outer ? level.garments.find((g) => g.id === state.worn.outer) : null;
  const action = state?.currentActionId ? plan.actions.find((a) => a.id === state.currentActionId) : null;
  const rejected = action ? sim.statusById[action.id] === 'rejected' : false;
  const beatIssues = sim.violations.filter((v) => v.actorId === actor.id && v.beat === beat);

  ctx.save();
  ctx.translate(p.x, p.y - 8);
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 5;

  if (selectedActorId === actor.id) {
    ctx.beginPath();
    ctx.arc(0, 0, 27, 0, Math.PI * 2);
    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(0, 0, 21, 0, Math.PI * 2);
  ctx.fillStyle = actor.color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = outer ? 6 : 3;
  ctx.strokeStyle = outer?.color ?? 'rgba(255,255,255,.88)';
  ctx.stroke();

  ctx.fillStyle = '#0f172a';
  ctx.font = '900 17px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(actor.short, 0, 1);

  if (action) {
    const text = action.type === 'move' ? '走' : action.type === 'change' ? '换' : action.type === 'leave' ? '留' : '取';
    ctx.fillStyle = rejected ? '#ef4444' : '#0f172a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(17, -17, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '800 11px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    ctx.fillText(text, 17, -16);
  }

  if (beatIssues.length > 0) {
    ctx.beginPath();
    ctx.arc(-18, -18, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#dc2626';
    ctx.fill();
    ctx.strokeStyle = '#fecaca';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '900 13px ui-sans-serif';
    ctx.fillText('!', -18, -17);
  }

  ctx.font = '700 13px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  const name = actor.name;
  const w = ctx.measureText(name).width + 14;
  ctx.fillStyle = 'rgba(15,23,42,.86)';
  roundRect(ctx, -w / 2, 25, w, 22, 11);
  ctx.fill();
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(name, 0, 36);
  ctx.restore();
}

export function renderStage(
  ctx: CanvasRenderingContext2D,
  level: Level,
  sim: SimulationResult,
  plan: Plan,
  time: number,
  selectedActorId?: string | null,
): Map<string, Point> {
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);

  const bg = ctx.createLinearGradient(0, 0, 0, STAGE_H);
  bg.addColorStop(0, '#111827');
  bg.addColorStop(0.55, '#0f172a');
  bg.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, STAGE_W, STAGE_H, 24);
  ctx.fill();

  // Stage board.
  ctx.save();
  ctx.fillStyle = 'rgba(251, 191, 36, 0.08)';
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.28)';
  ctx.lineWidth = 2;
  roundRect(ctx, 54, 42, 852, 150, 22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(253, 230, 138, .55)';
  ctx.font = '800 22px ui-serif, Georgia, "Songti SC", serif';
  ctx.textAlign = 'center';
  ctx.fillText('舞  台', STAGE_W / 2, 78);
  ctx.restore();

  for (const edge of level.edges) drawEdge(ctx, level, edge);
  const beat = Math.floor(Math.max(0, Math.min(time, sim.horizon)));
  for (const node of level.nodes) drawNode(ctx, node, beat, sim);
  drawQueues(ctx, level, beat, sim);

  // Separate actors sharing a node; moving actors stay on their interpolated edge.
  const rawPositions = new Map<string, Point>();
  for (const actor of level.actors) {
    rawPositions.set(actor.id, actorPositionAtTime(level, sim, plan, time, actor));
  }
  const groups = new Map<string, string[]>();
  for (const actor of level.actors) {
    const state = sim.snapshots[beat].actors.find((a) => a.id === actor.id);
    const isMoving = !!activeMoveAction(sim, plan, beat, actor.id);
    if (isMoving) continue;
    const key = state?.location ?? actor.start;
    groups.set(key, [...(groups.get(key) ?? []), actor.id]);
  }
  const positions = new Map(rawPositions);
  const offsets: Point[] = [
    { x: 0, y: -4 },
    { x: -30, y: 12 },
    { x: 30, y: 12 },
    { x: -22, y: -28 },
    { x: 22, y: -28 },
  ];
  for (const ids of groups.values()) {
    ids.forEach((id, i) => {
      const raw = rawPositions.get(id)!;
      const o = offsets[i % offsets.length];
      positions.set(id, { x: raw.x + o.x, y: raw.y + o.y });
    });
  }

  level.actors.forEach((actor, index) => {
    drawActor(ctx, level, sim, plan, time, actor, index, positions, selectedActorId);
  });

  // Beat scrub line / legend.
  ctx.save();
  ctx.fillStyle = 'rgba(15,23,42,.72)';
  roundRect(ctx, 24, STAGE_H - 44, 430, 28, 14);
  ctx.fill();
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '600 12px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('圆边颜色=外套  ·  走/换/留/取=当前计划块  ·  红 !=本拍诊断', 38, STAGE_H - 30);
  ctx.restore();

  return positions;
}
