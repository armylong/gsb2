import { RESOURCE_META } from '../engine/recipes';
import type { NodeStatus, NodeType, ResourceId, SimState } from '../engine/types';

export const CANVAS_W = 1080;
export const CANVAS_H = 640;
export const NODE_W = 132;
export const NODE_H = 84;

export const STATUS_COLORS: Record<NodeStatus, string> = {
  idle: '#64748b',
  processing: '#16a34a',
  starved: '#dc2626',
  blocked: '#d97706',
  paused: '#7c3aed',
  warehouse: '#0e7490',
};

export const STATUS_LABELS: Record<NodeStatus, string> = {
  idle: '空闲',
  processing: '加工中',
  starved: '缺料',
  blocked: '等待输出空间',
  paused: '手动暂停',
  warehouse: '仓库',
};

const NODE_FILL: Record<NodeType, string> = {
  miner: '#1f2937',
  smelter: '#2a1f1d',
  assembler: '#1d2630',
  warehouse: '#10242e',
};

export interface Point {
  x: number;
  y: number;
}

export function nodeCenter(x: number, y: number): Point {
  return { x: x + NODE_W / 2, y: y + NODE_H / 2 };
}

/** 节点矩形命中测试。 */
export function hitNode(state: SimState, px: number, py: number): string | null {
  for (const n of state.config.nodes) {
    if (px >= n.x && px <= n.x + NODE_W && py >= n.y && py <= n.y + NODE_H) {
      return n.id;
    }
  }
  return null;
}

/** 连线命中测试：点到线段距离 ≤ 8。 */
export function hitConnection(state: SimState, px: number, py: number): string | null {
  for (const c of state.config.connections) {
    const a = state.config.nodes.find((n) => n.id === c.from)!;
    const b = state.config.nodes.find((n) => n.id === c.to)!;
    const p1 = nodeCenter(a.x, a.y);
    const p2 = nodeCenter(b.x, b.y);
    if (distToSegment(px, py, p1.x, p1.y, p2.x, p2.y) <= 8) return c.id;
  }
  return null;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawMinerIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  // 三角支架 + 钻头
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy + 10);
  ctx.lineTo(cx, cy - 8);
  ctx.lineTo(cx + 10, cy + 10);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#b08968';
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy + 10);
  ctx.lineTo(cx + 5, cy + 10);
  ctx.lineTo(cx, cy + 18);
  ctx.closePath();
  ctx.fill();
}

function drawSmelterIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  // 炉身 + 火焰
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - 10, cy - 8, 20, 20);
  ctx.fillStyle = '#f97316';
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy + 8);
  ctx.quadraticCurveTo(cx - 8, cy, cx - 2, cy - 4);
  ctx.quadraticCurveTo(cx, cy + 2, cx + 4, cy - 6);
  ctx.quadraticCurveTo(cx + 8, cy + 2, cx + 5, cy + 8);
  ctx.closePath();
  ctx.fill();
}

function drawAssemblerIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  // 齿轮
  ctx.fillStyle = '#cbd5e1';
  const teeth = 8;
  ctx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? 12 : 8.5;
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1d2630';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawWarehouseIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  // 屋身 + 屋顶
  ctx.fillStyle = '#67e8f9';
  ctx.beginPath();
  ctx.moveTo(cx - 13, cy - 2);
  ctx.lineTo(cx, cy - 12);
  ctx.lineTo(cx + 13, cy - 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - 11, cy - 2, 22, 15);
}

export function drawNodeIcon(ctx: CanvasRenderingContext2D, type: NodeType, cx: number, cy: number) {
  if (type === 'miner') drawMinerIcon(ctx, cx, cy);
  else if (type === 'smelter') drawSmelterIcon(ctx, cx, cy);
  else if (type === 'assembler') drawAssemblerIcon(ctx, cx, cy);
  else drawWarehouseIcon(ctx, cx, cy);
}

function drawCargoDot(ctx: CanvasRenderingContext2D, x: number, y: number, res: ResourceId) {
  ctx.fillStyle = RESOURCE_META[res].color;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

export interface DrawOptions {
  selectedNodeId: string | null;
  selectedConnectionId: string | null;
  /** 0..1，当前 tick 内的插值比例，仅用于货物位置平滑。 */
  interp: number;
}

export function drawScene(ctx: CanvasRenderingContext2D, state: SimState, opts: DrawOptions) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  // 背景网格
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = 'rgba(148,163,184,0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= CANVAS_W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_H);
    ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
    ctx.stroke();
  }

  drawConnections(ctx, state, opts);
  drawShipments(ctx, state, opts.interp);
  for (const cfg of state.config.nodes) drawNode(ctx, state, cfg.id, opts);
}

function drawConnections(ctx: CanvasRenderingContext2D, state: SimState, opts: DrawOptions) {
  for (const c of state.config.connections) {
    const a = state.config.nodes.find((n) => n.id === c.from)!;
    const b = state.config.nodes.find((n) => n.id === c.to)!;
    const p1 = nodeCenter(a.x, a.y);
    const p2 = nodeCenter(b.x, b.y);
    const selected = opts.selectedConnectionId === c.id;
    const inFlight = state.shipments.filter((s) => s.connectionId === c.id).length;

    ctx.strokeStyle = !c.enabled
      ? 'rgba(100,116,139,0.35)'
      : selected
        ? '#38bdf8'
        : 'rgba(148,163,184,0.65)';
    ctx.lineWidth = selected ? 3 : 2;
    ctx.setLineDash(!c.enabled ? [6, 6] : []);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 箭头
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const gap = NODE_W / 2 + 6;
    const tipX = p2.x - ux * gap;
    const tipY = p2.y - uy * gap;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * 10 + uy * 5, tipY - uy * 10 - ux * 5);
    ctx.lineTo(tipX - ux * 10 - uy * 5, tipY - uy * 10 + ux * 5);
    ctx.closePath();
    ctx.fill();

    // 在途批次 x/max 标签
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2 - 8;
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = c.enabled ? '#7dd3fc' : '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(`在途 ${inFlight}/${c.maxInFlight} · ${c.transportTicks}t`, mx, my);
  }
}

function drawShipments(ctx: CanvasRenderingContext2D, state: SimState, interp: number) {
  for (const ship of state.shipments) {
    const a = state.config.nodes.find((n) => n.id === ship.from)!;
    const b = state.config.nodes.find((n) => n.id === ship.to)!;
    const p1 = nodeCenter(a.x, a.y);
    const p2 = nodeCenter(b.x, b.y);
    const elapsed = state.tick - ship.departAt + interp;
    const t = Math.min(Math.max(elapsed / ship.transportTicks, 0), 1);
    const x = p1.x + (p2.x - p1.x) * t;
    const y = p1.y + (p2.y - p1.y) * t;
    const resources = Object.keys(ship.cargo) as ResourceId[];
    // 批内每种资源画一个并排圆点，让多资源批次在画面上可区分。
    resources.forEach((res, i) => {
      const offset = (i - (resources.length - 1) / 2) * 12;
      drawCargoDot(ctx, x + offset, y, res);
    });
    const total = resources.reduce((sum, r) => sum + (ship.cargo[r] ?? 0), 0);
    if (total > 1) {
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.fillText(String(total), x, y - 10);
    }
  }
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  nodeId: string,
  opts: DrawOptions,
) {
  const cfg = state.config.nodes.find((n) => n.id === nodeId)!;
  const rt = state.nodes[nodeId];
  const c = nodeCenter(cfg.x, cfg.y);
  const selected = opts.selectedNodeId === nodeId;

  // 卡片
  ctx.fillStyle = NODE_FILL[cfg.type];
  roundRect(ctx, cfg.x, cfg.y, NODE_W, NODE_H, 10);
  ctx.fill();
  ctx.strokeStyle = selected ? '#38bdf8' : STATUS_COLORS[rt.status];
  ctx.lineWidth = selected ? 3 : 2;
  ctx.stroke();

  // 状态色条
  ctx.fillStyle = STATUS_COLORS[rt.status];
  roundRect(ctx, cfg.x, cfg.y, NODE_W, 6, 3);
  ctx.fill();

  // 图标
  drawNodeIcon(ctx, cfg.type, cfg.x + 24, c.y + 4);

  // 名称
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(truncate(cfg.name, 9), cfg.x + 44, cfg.y + 24);

  // 状态文字
  ctx.fillStyle = STATUS_COLORS[rt.status];
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(
    `${STATUS_LABELS[rt.status]}${cfg.paused ? '' : ''}`,
    cfg.x + 44,
    cfg.y + 40,
  );

  // 库存 / 容量（含待出库提示）
  const used = stockCount(rt.stock);
  const held = stockCount(rt.heldOutput);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(
    `库存 ${used}/${cfg.capacity}${held ? ` 待出${held}` : ''}`,
    cfg.x + 10,
    cfg.y + NODE_H - 10,
  );

  // 加工进度环
  if (rt.active) {
    const pct = 1 - rt.active.remainingTicks / rt.active.totalTicks;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cfg.x + NODE_W - 16, cfg.y + 20, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(cfg.x + NODE_W - 16, cfg.y + 20, 9, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
    ctx.stroke();
  }

  // 暂停遮罩图标
  if (cfg.paused) {
    ctx.fillStyle = 'rgba(124,58,237,0.25)';
    roundRect(ctx, cfg.x, cfg.y, NODE_W, NODE_H, 10);
    ctx.fill();
    ctx.fillStyle = '#c4b5fd';
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('⏸ 已暂停', c.x, cfg.y + NODE_H - 10);
  }
}

function stockCount(stock: Record<string, number | undefined>): number {
  return Object.values(stock).reduce<number>((s, v) => s + (v ?? 0), 0);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
