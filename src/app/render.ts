// Canvas 渲染层。全部绘制走「场景坐标 + 相机变换」，
// 线宽按 scale 反比补偿，缩放后屏幕宽度恒定，场景坐标绝不随视图漂移。
import { Camera } from './camera.js';
import {
  Vec2,
  VelocityField,
  TraceResult,
  Seed,
  StopZone,
  StopReason,
  len,
  REASON_TEXT
} from '../core/types.js';

export interface RenderOptions {
  showArrowGrid: boolean;
  showStreamArrows: boolean;
  showZones: boolean;
  showReference: boolean;
}

export interface ProbeInfo {
  p: Vec2;
  velocity: Vec2;
  speed: number;
  angle: number;
  blocked: boolean;
}

export interface RenderState {
  field: VelocityField;
  traces: TraceResult[];
  seeds: Seed[];
  camera: Camera;
  options: RenderOptions;
  probe: ProbeInfo | null;
  selectedSeedId: number | null;
}

// 深色技术画布配色（参考 dataviz 暗色板）
const COLORS = {
  surface: '#141412',
  grid: '#232321',
  border: '#3d3d3a',
  arrowGrid: '#7d7c76',
  streamline: '#5aa0ee',
  streamlineBlocked: '#6b6a64',
  select: '#fab219',
  seed: '#9ec5f4',
  seedManual: '#e87ba4',
  blocked: '#e36363',
  zoneFill: 'rgba(255,255,255,0.055)',
  zoneStroke: '#8a8982',
  probe: '#e87ba4',
  reference: 'rgba(250,178,25,0.85)',
  text: '#f0efec',
  textMuted: '#a5a49c'
};

const REASON_COLOR: Record<StopReason, string> = {
  boundary: '#898781',
  'zero-speed': '#fab219',
  zone: '#ec835a',
  closed: '#199e70',
  'max-length': '#e36363'
};

const ARROW_GRID_STEP = 70; // 场景单位
const STREAM_ARROW_GAP = 150; // 流线上箭头间距（场景单位）

export function reasonColor(r: StopReason): string {
  return REASON_COLOR[r];
}
export function reasonText(r: StopReason): string {
  return REASON_TEXT[r];
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  tip: Vec2,
  dir: Vec2,
  size: number,
  color: string
): void {
  const d = len(dir);
  if (d === 0) return;
  const ux = dir.x / d;
  const uy = dir.y / d;
  const nx = -uy;
  const ny = ux;
  const base = { x: tip.x - ux * size, y: tip.y - uy * size };
  const left = { x: base.x + nx * size * 0.45, y: base.y + ny * size * 0.45 };
  const right = { x: base.x - nx * size * 0.45, y: base.y - ny * size * 0.45 };
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fill();
}

function drawBackground(ctx: CanvasRenderingContext2D, cam: Camera): void {
  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(0, 0, cam.width, cam.height);

  const view = cam.viewRect();
  const step = 50;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = cam.worldLineWidth(1);
  ctx.beginPath();
  for (let x = Math.ceil(view.xmin / step) * step; x <= view.xmax; x += step) {
    const a = cam.worldToScreen({ x, y: view.ymin });
    const b = cam.worldToScreen({ x, y: view.ymax });
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (let y = Math.ceil(view.ymin / step) * step; y <= view.ymax; y += step) {
    const a = cam.worldToScreen({ x: view.xmin, y });
    const b = cam.worldToScreen({ x: view.xmax, y });
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // 坐标轴
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = cam.worldLineWidth(1.2);
  ctx.beginPath();
  const ox1 = cam.worldToScreen({ x: view.xmin, y: 0 });
  const ox2 = cam.worldToScreen({ x: view.xmax, y: 0 });
  const oy1 = cam.worldToScreen({ x: 0, y: view.ymin });
  const oy2 = cam.worldToScreen({ x: 0, y: view.ymax });
  ctx.moveTo(ox1.x, ox1.y);
  ctx.lineTo(ox2.x, ox2.y);
  ctx.moveTo(oy1.x, oy1.y);
  ctx.lineTo(oy2.x, oy2.y);
  ctx.stroke();
}

function drawDomainBorder(ctx: CanvasRenderingContext2D, cam: Camera, field: VelocityField): void {
  const d = field.domain;
  const corners = [
    cam.worldToScreen({ x: d.xmin, y: d.ymin }),
    cam.worldToScreen({ x: d.xmax, y: d.ymin }),
    cam.worldToScreen({ x: d.xmax, y: d.ymax }),
    cam.worldToScreen({ x: d.xmin, y: d.ymax })
  ];
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = cam.worldLineWidth(1.5);
  ctx.setLineDash([cam.worldLineWidth(6), cam.worldLineWidth(4)]);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawZones(ctx: CanvasRenderingContext2D, cam: Camera, zones: StopZone[]): void {
  for (const z of zones) {
    ctx.fillStyle = COLORS.zoneFill;
    ctx.strokeStyle = COLORS.zoneStroke;
    ctx.lineWidth = cam.worldLineWidth(1.4);
    ctx.setLineDash([cam.worldLineWidth(5), cam.worldLineWidth(4)]);
    if (z.kind === 'circle') {
      const c = cam.worldToScreen({ x: z.x, y: z.y });
      ctx.beginPath();
      ctx.arc(c.x, c.y, (z.r ?? 0) * cam.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      const w = (z.w ?? 0) * cam.scale;
      const h = (z.h ?? 0) * cam.scale;
      const c = cam.worldToScreen({ x: z.x, y: z.y });
      ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h);
      ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
    }
    ctx.setLineDash([]);
  }
}

function drawArrowGrid(ctx: CanvasRenderingContext2D, cam: Camera, field: VelocityField): void {
  const view = cam.viewRect();
  const arrowScreen = 9;
  const arrowWorld = arrowScreen / cam.scale;
  ctx.fillStyle = COLORS.arrowGrid;
  ctx.strokeStyle = COLORS.arrowGrid;
  ctx.lineWidth = cam.worldLineWidth(1.1);

  for (let x = Math.ceil(view.xmin / ARROW_GRID_STEP) * ARROW_GRID_STEP; x <= view.xmax; x += ARROW_GRID_STEP) {
    for (let y = Math.ceil(view.ymin / ARROW_GRID_STEP) * ARROW_GRID_STEP; y <= view.ymax; y += ARROW_GRID_STEP) {
      const p = { x, y };
      if (!field.isPlaceable(p)) continue;
      const v = field.velocity(p);
      if (len(v) < field.speedFloor) continue;
      const s = cam.worldToScreen(p);
      // 短线段 + 箭头，规则排布
      const ux = v.x / len(v);
      const uy = v.y / len(v);
      const half = arrowWorld * 0.9;
      const a = cam.worldToScreen({ x: p.x - ux * half, y: p.y - uy * half });
      const b = cam.worldToScreen({ x: p.x + ux * half, y: p.y + uy * half });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      drawArrowhead(ctx, b, v, arrowWorld * 0.9, COLORS.arrowGrid);
    }
  }
}

function drawStreamline(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  trace: TraceResult,
  selected: boolean,
  withArrows: boolean
): void {
  const pts = trace.points;
  if (pts.length < 2) return;
  const color = trace.blocked ? COLORS.streamlineBlocked : selected ? COLORS.select : COLORS.streamline;
  ctx.strokeStyle = color;
  ctx.lineWidth = cam.worldLineWidth(selected ? 2.4 : 1.4);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  const s0 = cam.worldToScreen(pts[0]);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < pts.length; i++) {
    const s = cam.worldToScreen(pts[i]);
    ctx.lineTo(s.x, s.y);
  }
  ctx.stroke();

  if (withArrows) {
    // 按弧长间隔放流向箭头（间隔与尺寸均为场景单位，缩放后屏幕表现一致）
    let acc = 0;
    let nextAt = STREAM_ARROW_GAP;
    for (let i = 1; i < pts.length; i++) {
      const segLen = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      acc += segLen;
      if (acc >= nextAt) {
        const dir = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
        const tip = cam.worldToScreen(pts[i]);
        drawArrowhead(ctx, tip, dir, 10 / cam.scale, color);
        nextAt += STREAM_ARROW_GAP;
      }
    }
  }

  // 两端停止点：颜色 = 停止原因
  const endR = 3.2 / cam.scale;
  for (const end of [trace.forward, trace.backward]) {
    const s = cam.worldToScreen(end.point);
    ctx.fillStyle = REASON_COLOR[end.reason];
    ctx.beginPath();
    ctx.arc(s.x, s.y, endR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.surface;
    ctx.lineWidth = cam.worldLineWidth(0.8);
    ctx.stroke();
  }

  if (selected) {
    // 选中线在停止点旁标注原因（字号按缩放补偿，屏幕上保持可读）
    ctx.font = `${12 / cam.scale}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const label = (end: TraceResult['forward'], tag: string) => {
      const s = cam.worldToScreen(end.point);
      const text = `${tag}：${REASON_TEXT[end.reason]}`;
      ctx.fillStyle = REASON_COLOR[end.reason];
      ctx.fillText(text, s.x + 10 / cam.scale, s.y);
    };
    label(trace.forward, '顺流端');
    label(trace.backward, '逆流端');
  }
}

function drawReference(ctx: CanvasRenderingContext2D, cam: Camera, field: VelocityField, traces: TraceResult[]): void {
  if (field.id !== 'uniform' && field.id !== 'rigid') return;
  ctx.strokeStyle = COLORS.reference;
  ctx.lineWidth = cam.worldLineWidth(1.2);
  ctx.setLineDash([cam.worldLineWidth(7), cam.worldLineWidth(5)]);
  for (const t of traces) {
    if (t.blocked) continue;
    if (field.id === 'uniform') {
      // 解析路径：过起点的水平线
      const a = cam.worldToScreen({ x: field.domain.xmin, y: t.seed.y });
      const b = cam.worldToScreen({ x: field.domain.xmax, y: t.seed.y });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else {
      // 解析路径：以原点为心、半径 = 起点模长 的圆
      const c = cam.worldToScreen({ x: 0, y: 0 });
      const r = Math.hypot(t.seed.x, t.seed.y) * cam.scale;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function drawSeeds(ctx: CanvasRenderingContext2D, cam: Camera, state: RenderState): void {
  const blockedIds = new Set(
    state.traces.filter((t) => t.blocked).map((t) => `${t.seed.x.toFixed(3)},${t.seed.y.toFixed(3)}`)
  );
  for (const seed of state.seeds) {
    const s = cam.worldToScreen(seed.p);
    const blocked = blockedIds.has(`${seed.p.x.toFixed(3)},${seed.p.y.toFixed(3)}`);
    const selected = seed.id === state.selectedSeedId;
    const radius = selected ? 7 : 5;
    let color = seed.manual ? COLORS.seedManual : COLORS.seed;
    if (blocked) color = COLORS.blocked;
    if (selected) color = COLORS.select;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.surface;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    if (blocked) {
      // 被挡住的旧起点：警示三角环 + 叉
      ctx.strokeStyle = COLORS.blocked;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x - 3.5, s.y - 3.5);
      ctx.lineTo(s.x + 3.5, s.y + 3.5);
      ctx.moveTo(s.x + 3.5, s.y - 3.5);
      ctx.lineTo(s.x - 3.5, s.y + 3.5);
      ctx.stroke();
    }

    if (seed.locked) {
      // 锁定标记：小方块徽章
      ctx.fillStyle = COLORS.select;
      ctx.fillRect(s.x + radius - 2, s.y - radius - 6, 7, 7);
      ctx.strokeStyle = COLORS.surface;
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + radius - 2, s.y - radius - 6, 7, 7);
    }
  }
}

function drawProbe(ctx: CanvasRenderingContext2D, cam: Camera, probe: ProbeInfo): void {
  const s = cam.worldToScreen(probe.p);
  ctx.strokeStyle = COLORS.probe;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x - 12, s.y);
  ctx.lineTo(s.x + 12, s.y);
  ctx.moveTo(s.x, s.y - 12);
  ctx.lineTo(s.x, s.y + 12);
  ctx.stroke();

  const lines = probe.blocked
    ? ['该点在无流速 / 静止区内']
    : [
        `方向 ${probe.angle.toFixed(1)}°`,
        `速度 ${probe.speed.toFixed(2)}`,
        `(${probe.p.x.toFixed(1)}, ${probe.p.y.toFixed(1)})`
      ];
  // 探测浮层是屏幕空间 UI，固定像素字号
  ctx.font = '12px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  const pad = 6;
  const lineH = 16;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const boxH = lines.length * lineH + pad * 2;
  let bx = s.x + 12;
  let by = s.y + 12;
  if (bx + boxW > cam.width) bx = s.x - boxW - 12;
  if (by + boxH > cam.height) by = s.y - boxH - 12;
  ctx.fillStyle = 'rgba(20,20,18,0.92)';
  ctx.strokeStyle = COLORS.probe;
  ctx.lineWidth = 1;
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeRect(bx, by, boxW, boxH);
  ctx.fillStyle = COLORS.text;
  lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * lineH));
}

export function drawScene(ctx: CanvasRenderingContext2D, state: RenderState): void {
  drawBackground(ctx, state.camera);
  drawDomainBorder(ctx, state.camera, state.field);
  if (state.options.showZones) drawZones(ctx, state.camera, state.field.zones);
  if (state.options.showReference) drawReference(ctx, state.camera, state.field, state.traces);
  if (state.options.showArrowGrid) drawArrowGrid(ctx, state.camera, state.field);

  for (const trace of state.traces) {
    if (trace.blocked) continue; // 被挡住的起点只画警示标记，不画流线
    const seed = state.seeds.find(
      (s) => Math.abs(s.p.x - trace.seed.x) < 1e-9 && Math.abs(s.p.y - trace.seed.y) < 1e-9
    );
    const selected = seed !== undefined && seed.id === state.selectedSeedId;
    drawStreamline(ctx, state.camera, trace, selected, state.options.showStreamArrows);
  }
  drawSeeds(ctx, state.camera, state);
  if (state.probe) drawProbe(ctx, state.camera, state.probe);
}
