import {
  type Pose,
  type TrackSegment,
  type Vec2,
  add,
  deg,
  dist,
  headingOf,
  len,
  norm,
  scale,
  sub,
} from '../core/geometry.ts';
import type { PortId, TrackNetwork } from '../core/network.ts';
import { portA, portB, splitPort } from '../core/network.ts';
import type { TrackDoc } from '../core/presets.ts';
import type { SwitchState } from '../core/switch.ts';
import { segmentOfPort } from '../core/switch.ts';
import type { VehicleSim } from '../core/vehicle.ts';
import { type Camera, worldToScreen } from './viewport.ts';

export interface DraftRender {
  tool: 'line' | 'arc';
  start: Vec2;
  end: Vec2;
  preview: Vec2[];
  valid: boolean;
  startNodeId: string | null;
  endNodeId: string | null;
  hint: string;
}

export interface RenderInput {
  doc: TrackDoc;
  network: TrackNetwork;
  switches: Map<string, SwitchState>;
  vehicle: VehicleSim;
  camera: Camera;
  width: number;
  height: number;
  selectedSegmentId: string | null;
  hoveredSegmentId: string | null;
  hoveredNodeId: string | null;
  /** 正在拖动的对象, 用于高亮。 */
  dragging: { kind: 'segment' | 'node' | 'rotate'; id: string } | null;
  /** 车辆已完成的行程 (段 id 序列), 用于画轨迹。 */
  trail: Array<{ pos: Vec2 }>;
  draft: DraftRender | null;
  dpr: number;
}

const COLORS = {
  bg: '#0b1020',
  grid: 'rgba(78, 110, 170, 0.10)',
  gridMajor: 'rgba(78, 110, 170, 0.18)',
  rail: '#cfd8ea',
  railInner: '#8e9db9',
  sleeper: 'rgba(160, 180, 214, 0.28)',
  railFault: '#ff5c72',
  railWarn: '#ffb547',
  node: '#7d8cab',
  nodeOk: '#3fce8f',
  nodeBad: '#ff5c72',
  nodeWarn: '#ffb547',
  sel: '#4ea8ff',
  hover: 'rgba(78, 168, 255, 0.45)',
  text: '#e7ecf7',
  muted: '#8c9ab5',
  car: '#4ea8ff',
  carDark: '#1d5f9e',
  trail: 'rgba(78, 168, 255, 0.55)',
  primary: '#4ea8ff',
  alternate: '#b48cff',
  danger: '#ff5c72',
};

export function render(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { doc, camera, width, height, dpr } = input;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  drawBackground(ctx, camera, width, height);

  const routeSegs = currentRouteSegments(input);

  for (const seg of doc.segments) {
    drawSegment(ctx, input, seg, routeSegs.has(seg.id));
  }

  // 轨迹画在轨道之上, 方便看清实际走过哪一条。
  drawTrail(ctx, input);

  drawNodes(ctx, input);
  drawSwitchMarkers(ctx, input);
  drawSelectionHandles(ctx, input);
  drawVehicle(ctx, input);
  drawDraft(ctx, input);

  ctx.restore();
}

function drawBackground(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  // 世界坐标网格, 间距随缩放自适应。
  const targetPx = 44;
  const raw = targetPx / cam.scale;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 5, 10].map((m) => m * pow);
  const stepWorld = candidates.find((c) => c * cam.scale >= 30) ?? candidates[candidates.length - 1]!;
  const stepPx = stepWorld * cam.scale;

  const x0 = ((cam.tx % stepPx) + stepPx) % stepPx;
  const y0 = ((cam.ty % stepPx) + stepPx) % stepPx;

  ctx.lineWidth = 1;
  for (let x = x0; x < w; x += stepPx) {
    const worldX = (x - cam.tx) / cam.scale;
    const major = Math.abs(worldX % (stepWorld * 5)) < stepWorld * 0.01;
    ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
  }
  for (let y = y0; y < h; y += stepPx) {
    const worldY = (y - cam.ty) / cam.scale;
    const major = Math.abs(worldY % (stepWorld * 5)) < stepWorld * 0.01;
    ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
}

function currentRouteSegments(input: RenderInput): Set<string> {
  const set = new Set<string>();
  for (const leg of input.vehicle.legs) set.add(leg.segmentId);
  return set;
}

function drawTrail(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { trail, camera } = input;
  if (trail.length < 2) return;
  ctx.save();
  ctx.strokeStyle = COLORS.trail;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([1, 5]);
  ctx.beginPath();
  trail.forEach((p, i) => {
    const s = worldToScreen(camera, p.pos);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.stroke();
  ctx.restore();
}

/** 轨段在画布上的采样点 (世界坐标)。 */
function sampleWorld(seg: TrackSegment, count: number): Vec2[] {
  return seg.sample(count);
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  seg: TrackSegment,
  inRoute: boolean,
): void {
  const { camera, network, selectedSegmentId, hoveredSegmentId } = input;
  const isSelected = selectedSegmentId === seg.id;
  const isHovered = hoveredSegmentId === seg.id;
  const issues = network.issues.filter((i) => i.port?.startsWith(`${seg.id}:`));
  const hasError = issues.some((i) => i.level === 'error');
  const hasWarn = issues.some((i) => i.level === 'warning');

  const pts = sampleWorld(seg, 64);
  const screen = pts.map((p) => worldToScreen(camera, p));
  if (screen.length < 2) return;

  const railWidth = 8 * camera.scale;
  const width = Math.max(2.2, Math.min(16, railWidth * 0.55));

  // 选中/悬停晕圈
  if (isSelected || isHovered) {
    ctx.save();
    ctx.strokeStyle = isSelected ? 'rgba(78, 168, 255, 0.35)' : COLORS.hover;
    ctx.lineWidth = width + 11;
    ctx.lineCap = 'round';
    strokePolyline(ctx, screen);
    ctx.restore();
  }

  // 枕木
  if (camera.scale > 0.35) {
    ctx.save();
    ctx.strokeStyle = COLORS.sleeper;
    ctx.lineWidth = 1;
    const sleeperGapWorld = 16;
    const stepU = Math.max(0.02, sleeperGapWorld / Math.max(1, seg.length));
    for (let u = 0.02; u < 0.99; u += stepU) {
      const pose = seg.poseAt(u);
      const n = norm({ x: -pose.tangent.y, y: pose.tangent.x });
      const half = Math.max(4, Math.min(11, 4.6 * camera.scale));
      const a = worldToScreen(camera, add(pose.pos, scale(n, half / camera.scale)));
      const b = worldToScreen(camera, add(pose.pos, scale(n, -half / camera.scale)));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 道床
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(46, 60, 92, 0.85)';
  ctx.lineWidth = width + 5;
  strokePolyline(ctx, screen);

  // 双轨
  const railOffset = Math.max(1.6, width * 0.34);
  const railColor = hasError ? COLORS.railFault : hasWarn ? COLORS.railWarn : COLORS.rail;
  for (const side of [-1, 1]) {
    const offsetPts = offsetPolyline(pts, side * railOffset / camera.scale);
    ctx.strokeStyle = railColor;
    ctx.lineWidth = Math.max(1.4, Math.min(3.2, width * 0.22));
    ctx.globalAlpha = inRoute ? 1 : 0.88;
    strokePolyline(ctx, offsetPts.map((p) => worldToScreen(camera, p)));
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 段标签
  const mid = seg.poseAt(0.5).pos;
  const midScreen = worldToScreen(camera, mid);
  if (camera.scale > 0.28) {
    ctx.save();
    ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = seg.id;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(11, 16, 32, 0.82)';
    roundRect(ctx, midScreen.x - w / 2, midScreen.y - 8, w, 16, 5);
    ctx.fill();
    ctx.fillStyle = hasError ? COLORS.railFault : hasWarn ? COLORS.railWarn : '#93a5c4';
    ctx.fillText(label, midScreen.x, midScreen.y + 0.5);
    ctx.restore();
  }
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.stroke();
}

/** 对折线做近似法向偏移。 */
function offsetPolyline(pts: Vec2[], offset: number): Vec2[] {
  return pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    const t = norm(sub(next, prev));
    if (len(t) < 1e-9) return p;
    return { x: p.x - t.y * offset, y: p.y + t.x * offset };
  });
}

function drawNodes(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { camera, network, hoveredNodeId } = input;
  for (const [id, junction] of network.junctions) {
    const issues = network.issues.filter((i) => i.nodeId === id);
    const hasError = issues.some((i) => i.level === 'error');
    const hasWarn = issues.some((i) => i.level === 'warning');
    const p = worldToScreen(camera, junction.node.pos);
    const isHover = hoveredNodeId === id;
    const r = Math.max(4, Math.min(9, 5.5 * camera.scale)) + (isHover ? 2 : 0);

    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = hasError
      ? 'rgba(255, 92, 114, 0.2)'
      : hasWarn
        ? 'rgba(255, 181, 71, 0.18)'
        : 'rgba(63, 206, 143, 0.12)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hasError ? COLORS.nodeBad : hasWarn ? COLORS.nodeWarn : COLORS.nodeOk;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(11, 16, 32, 0.9)';
    ctx.stroke();

    if (camera.scale > 0.4) {
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hasError ? '#ff9fae' : hasWarn ? '#ffd79a' : '#a8dcc2';
      ctx.fillText(id, p.x + r + 5, p.y - r - 3);
    }
    ctx.restore();

    // 分叉节点画一个额外的道岔指示
    if (junction.isBranch) {
      const sw = input.switches.get(id);
      const committed = input.vehicle.branchStatus(id).committedPort;
      ctx.save();
      const activePort = committed ?? (sw?.choice === 'alternate' ? sw?.alternatePort : sw?.primaryPort);
      const color = committed
        ? COLORS.nodeWarn
        : sw?.choice === 'alternate'
          ? COLORS.alternate
          : COLORS.primary;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(activePort ? [] : [3, 3]);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawSwitchMarkers(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { camera, switches, network, vehicle } = input;
  for (const [nodeId, sw] of switches) {
    if (!sw.switchable) continue;
    const junction = network.junctions.get(nodeId);
    if (!junction) continue;
    const committed = vehicle.branchStatus(nodeId).committedPort;
    const activePort = committed ?? (sw.choice === 'alternate' ? sw.alternatePort : sw.primaryPort);
    const activeSeg = activePort ? segmentOfPort(activePort) : null;
    const seg = activeSeg ? network.segments.get(activeSeg) : undefined;
    if (!seg) continue;

    // 在出射段上画一小段高亮, 表示当前道岔朝向。
    const pts = seg.sample(10).slice(0, 4);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = committed
      ? COLORS.nodeWarn
      : sw.choice === 'alternate'
        ? COLORS.alternate
        : COLORS.primary;
    ctx.globalAlpha = committed ? 0.55 : 0.9;
    ctx.lineWidth = Math.max(2.5, Math.min(7, 10 * camera.scale * 0.55));
    strokePolyline(ctx, pts.map((p) => worldToScreen(camera, p)));
    ctx.restore();

    // 节点旁边的 "P/A" 小标
    const nodePos = worldToScreen(camera, junction.node.pos);
    if (camera.scale > 0.45) {
      ctx.save();
      ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const txt = committed ? 'LOCK' : sw.choice === 'alternate' ? 'ALT' : 'MAIN';
      const w = ctx.measureText(txt).width + 9;
      ctx.fillStyle = committed
        ? 'rgba(255, 181, 71, 0.9)'
        : sw.choice === 'alternate'
          ? 'rgba(124, 92, 255, 0.9)'
          : 'rgba(47, 127, 224, 0.9)';
      roundRect(ctx, nodePos.x - w / 2, nodePos.y + 11, w, 14, 4);
      ctx.fill();
      ctx.fillStyle = '#0b1020';
      ctx.fillText(txt, nodePos.x, nodePos.y + 18.2);
      ctx.restore();
    }
  }
}

function drawSelectionHandles(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { doc, selectedSegmentId, camera } = input;
  if (!selectedSegmentId) return;
  const seg = doc.segments.find((s) => s.id === selectedSegmentId);
  if (!seg) return;

  const a = worldToScreen(camera, seg.poseAt(0).pos);
  const b = worldToScreen(camera, seg.poseAt(1).pos);

  ctx.save();
  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0b1020';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.sel;
    ctx.stroke();
  }

  // 旋转手柄: 从中点沿法线外侧
  const mid = seg.poseAt(0.5);
  const n = norm({ x: -mid.tangent.y, y: mid.tangent.x });
  const handleWorld = add(mid.pos, scale(n, 34 / camera.scale));
  const hp = worldToScreen(camera, handleWorld);
  const mp = worldToScreen(camera, mid.pos);
  ctx.beginPath();
  ctx.moveTo(mp.x, mp.y);
  ctx.lineTo(hp.x, hp.y);
  ctx.strokeStyle = 'rgba(78, 168, 255, 0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(hp.x, hp.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.sel;
  ctx.fill();
  ctx.restore();
}

function drawVehicle(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { vehicle, camera } = input;
  const pose = vehicle.pose;
  const p = worldToScreen(camera, pose.pos);
  const heading = headingOf(pose.tangent);
  const s = Math.max(0.55, Math.min(2.2, camera.scale));

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(heading);

  const L = 26 * s;
  const W = 15 * s;

  // 阴影
  ctx.save();
  ctx.translate(1.5, 2.5);
  roundRect(ctx, -L / 2, -W / 2, L, W, 4 * s);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fill();
  ctx.restore();

  // 车身
  const grad = ctx.createLinearGradient(-L / 2, -W / 2, L / 2, W / 2);
  if (vehicle.status === 'braking') {
    grad.addColorStop(0, '#ffb547');
    grad.addColorStop(1, '#c97b12');
  } else if (vehicle.status === 'stopped' || vehicle.status === 'finished') {
    grad.addColorStop(0, '#9aa6bd');
    grad.addColorStop(1, '#5c6880');
  } else {
    grad.addColorStop(0, '#6fc0ff');
    grad.addColorStop(1, '#2f6fd0');
  }
  roundRect(ctx, -L / 2, -W / 2, L, W, 4 * s);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.4 * s);
  ctx.strokeStyle = 'rgba(8, 12, 24, 0.85)';
  ctx.stroke();

  // 前挡风 / 方向
  ctx.beginPath();
  ctx.moveTo(L * 0.22, -W * 0.32);
  ctx.lineTo(L * 0.42, 0);
  ctx.lineTo(L * 0.22, W * 0.32);
  ctx.closePath();
  ctx.fillStyle = 'rgba(230, 245, 255, 0.85)';
  ctx.fill();

  // 车轮
  ctx.fillStyle = '#1a2236';
  for (const dx of [-L * 0.29, L * 0.29]) {
    for (const dy of [-W * 0.5, W * 0.5]) {
      roundRect(ctx, dx - 3.2 * s, dy - 1.6 * s, 6.4 * s, 3.2 * s, 1.2 * s);
      ctx.fill();
    }
  }

  // 方向灯
  if (vehicle.status === 'running') {
    ctx.beginPath();
    ctx.arc(L * 0.46, 0, 1.8 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#eafff2';
    ctx.fill();
  }
  ctx.restore();

  // 速度矢量箭头
  if (vehicle.status === 'running' && camera.scale > 0.3) {
    const dirScreen = { x: Math.cos(heading), y: Math.sin(heading) };
    const arrowLen = 22 + (vehicle.speed / 400) * 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(78, 168, 255, 0.75)';
    ctx.fillStyle = 'rgba(78, 168, 255, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x + dirScreen.x * 22, p.y + dirScreen.y * 22);
    ctx.lineTo(p.x + dirScreen.x * arrowLen, p.y + dirScreen.y * arrowLen);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x + dirScreen.x * (arrowLen + 7), p.y + dirScreen.y * (arrowLen + 7));
    ctx.lineTo(p.x + dirScreen.x * arrowLen - dirScreen.y * 5, p.y + dirScreen.y * arrowLen + dirScreen.x * 5);
    ctx.lineTo(p.x + dirScreen.x * arrowLen + dirScreen.y * 5, p.y + dirScreen.y * arrowLen - dirScreen.x * 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 下一段预览: 在驶向的节点处画 "即将走哪条"
  const next = vehicle.previewExit();
  if (next && next.ok && vehicle.status !== 'finished') {
    const junction = input.network.junctions.get(next.nodeId);
    if (junction) {
      const exitPose = junction.node.pos;
      const target = input.network.segments.get(next.segmentId);
      if (target) {
        const t0 = worldToScreen(camera, exitPose);
        const t1 = worldToScreen(camera, target.poseAt(0.28).pos);
        ctx.save();
        ctx.strokeStyle = next.isBranch ? COLORS.alternate : 'rgba(63, 206, 143, 0.7)';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(t0.x, t0.y);
        ctx.lineTo(t1.x, t1.y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/** 正在绘制的草稿轨段: 蓝色虚线 + 端点吸附提示。 */
function drawDraft(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const draft = input.draft;
  if (!draft) return;
  const { camera } = input;
  const pts = draft.preview.map((p) => worldToScreen(camera, p));
  const color = draft.valid ? '#4ea8ff' : '#ff5c72';

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length >= 2) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 6]);
    strokePolyline(ctx, pts);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;

  // 起点
  const s = worldToScreen(camera, draft.start);
  ctx.beginPath();
  ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = draft.startNodeId ? '#3fce8f' : '#0b1020';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();

  // 终点
  const e = worldToScreen(camera, draft.end);
  ctx.beginPath();
  ctx.arc(e.x, e.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = draft.endNodeId ? '#3fce8f' : '#0b1020';
  ctx.fill();
  ctx.stroke();

  // 距离/参数标注
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = color;
  ctx.fillText(draft.hint, e.x + 10, e.y - 8);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 供 UI 使用: 段两端的屏幕坐标。 */
export function segEndpointsScreen(seg: TrackSegment, cam: Camera): { a: Vec2; b: Vec2 } {
  return { a: worldToScreen(cam, seg.poseAt(0).pos), b: worldToScreen(cam, seg.poseAt(1).pos) };
}

export function poseLabel(pose: Pose): string {
  return `${pose.pos.x.toFixed(1)}, ${pose.pos.y.toFixed(1)} · ${deg(headingOf(pose.tangent)).toFixed(0)}°`;
}

export function describePortAngle(network: TrackNetwork, nodeId: string, port: PortId): string {
  const j = network.junctions.get(nodeId);
  const inc = j?.incoming[0];
  const out = j?.outgoing.find((c) => c.port === port);
  if (!inc || !out) return '';
  const a = Math.atan2(inc.pose.tangent.y, inc.pose.tangent.x);
  const b = Math.atan2(out.pose.tangent.y, out.pose.tangent.x);
  let d = ((b - a) % (Math.PI * 2)) * (180 / Math.PI);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}°`;
}

export function nodePorts(network: TrackNetwork, nodeId: string): { outgoing: PortId[]; incoming: PortId[] } {
  const j = network.junctions.get(nodeId);
  if (!j) return { outgoing: [], incoming: [] };
  return {
    outgoing: j.outgoing.map((c) => c.port),
    incoming: j.incoming.map((c) => c.port),
  };
}

export const segmentPorts = (id: string): [PortId, PortId] => [portA(id), portB(id)];
export const portEnd = (p: PortId): 'A' | 'B' => splitPort(p).end;
export const distanceToSegment = (seg: TrackSegment, p: Vec2): number => {
  let best = Infinity;
  for (const q of seg.sample(48)) best = Math.min(best, dist(q, p));
  return best;
};
