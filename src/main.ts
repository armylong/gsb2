/** 浏览器入口：把纯规则层接到 Canvas 与控制面板上。 */
import { Vec, add, clamp, dist, norm, sub, v } from './math.js';
import { RopeCorner, RopePath } from './rope.js';
import { InputState, RopeSim, SimEvent, SimSnapshot, anchorInsideObstacle } from './sim.js';
import { SCENARIOS, Scenario, getScenario } from './scenarios.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
if (!ctx) throw new Error('canvas 2d unavailable');

const ui = {
  scenario: $<HTMLSelectElement>('scenario'),
  play: $<HTMLButtonElement>('play'),
  step: $<HTMLButtonElement>('step'),
  reset: $<HTMLButtonElement>('reset'),
  speed: $<HTMLSelectElement>('speed'),
  anchorUp: $<HTMLButtonElement>('anchor-up'),
  anchorDown: $<HTMLButtonElement>('anchor-down'),
  trimIn: $<HTMLButtonElement>('trim-in'),
  trimOut: $<HTMLButtonElement>('trim-out'),
  autoWrap: $<HTMLInputElement>('auto-wrap'),
  autoRelease: $<HTMLInputElement>('auto-release'),
  showSweep: $<HTMLInputElement>('show-sweep'),
  hint: $<HTMLElement>('hint'),
  status: $<HTMLElement>('status'),
  reason: $<HTMLElement>('reason'),
  segments: $<HTMLElement>('segments'),
  tension: $<HTMLElement>('tension'),
  events: $<HTMLElement>('events'),
  scrub: $<HTMLInputElement>('scrub'),
  scrubLabel: $<HTMLElement>('scrub-label'),
  stepSize: $<HTMLSelectElement>('step-size'),
  replayCheck: $<HTMLButtonElement>('replay-check'),
  replay: $<HTMLElement>('replay'),
  timeline: $<HTMLCanvasElement>('timeline'),
  readout: $<HTMLElement>('readout'),
  ropeMeter: $<HTMLElement>('rope-meter'),
  scenarioNote: $<HTMLElement>('scenario-note'),
  editStart: $<HTMLInputElement>('edit-start'),
  startVx: $<HTMLInputElement>('start-vx'),
  startVy: $<HTMLInputElement>('start-vy'),
  startSlack: $<HTMLInputElement>('start-slack'),
  applyStart: $<HTMLButtonElement>('apply-start'),
  startReadout: $<HTMLElement>('start-readout'),
};

interface Inputs {
  left: boolean;
  right: boolean;
  in: boolean;
  out: boolean;
}

const inputs: Inputs = { left: false, right: false, in: false, out: false };

/** 渲染坐标变换：世界坐标 → 屏幕像素（等比缩放并居中）。 */
interface View {
  scale: number;
  offset: Vec;
}

let scenario: Scenario = getScenario(SCENARIOS[0].id);
let sim: RopeSim;
let view: View = { scale: 1, offset: v(0, 0) };
let lastTime = 0;
let accumulator = 0;
let playing = true;
let stepSize = Number(ui.stepSize.value) || 1 / 60;
/** 拖拽锚点时的临时位移。 */
let draggingAnchor = false;
let dragOffset = v(0, 0);
let hoverVertex: { obstacleId: string; vertexIndex: number } | null = null;
let selectedEvent: SimEvent | null = null;
/** 历史快照（每秒若干帧），用于时间线回看与复现。 */
let history: { t: number; snap: SimSnapshot }[] = [];
let historyAccum = 0;
let keyMarks: { t: number; kind: 'wrap' | 'release'; label: string }[] = [];
/** 当前的可编辑起点（默认来自场景，应用后固定下来用于重跑）。 */
let startPos: Vec = v(0, 0);
let startVel: Vec = v(0, 0);
let startSlack = 0;
let draggingStart = false;

const MAX_HISTORY = 2400;

function deepCopy<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function createSim(
  scene: Scenario,
  opts: { pos?: Vec; vel?: Vec; slack?: number; ropeLength?: number; anchor?: Vec } = {},
): RopeSim {
  const pos = opts.pos ?? startPos;
  const vel = opts.vel ?? startVel;
  const anchor = opts.anchor ?? scene.anchor;
  const base = opts.ropeLength ?? scene.ropeLength;
  return new RopeSim(
    {
      anchor: { ...anchor },
      radius: scene.radius,
      obstacles: scene.obstacles,
      ropeLength: base + (opts.slack ?? startSlack),
      autoWrap: ui.autoWrap.checked,
      autoRelease: ui.autoRelease.checked,
    },
    { pos: { ...pos }, vel: { ...vel } },
  );
}

function loadScenario(id: string): void {
  scenario = getScenario(id);
  startPos = { ...scenario.start.pos };
  startVel = { ...scenario.start.vel };
  startSlack = 0;
  ui.startVx.value = String(startVel.x);
  ui.startVy.value = String(startVel.y);
  ui.startSlack.value = '0';
  ui.editStart.checked = false;
  sim = createSim(scenario);
  playing = true;
  selectedEvent = null;
  history = [];
  historyAccum = 0;
  keyMarks = [];
  lastEventSignature = '';
  accumulator = 0;
  ui.scrub.value = '0';
  ui.scrub.max = '1000';
  ui.scenarioNote.textContent = scenario.summary;
  ui.hint.textContent = scenario.hint ?? '拖动锚点或使用按钮改变锚点高度；左右键发力，W/S 收放绳长。';
  ui.autoWrap.checked = true;
  ui.autoRelease.checked = true;
  resize();
  recordHistory(true);
  updatePlayButton();
  updateStartReadout();
  render();
}

function updateStartReadout(): void {
  ui.startReadout.textContent =
    `起点 (${startPos.x.toFixed(0)}, ${startPos.y.toFixed(0)}) · ` +
    `初速 (${startVel.x.toFixed(0)}, ${startVel.y.toFixed(0)}) · 额外松弛 ${startSlack.toFixed(0)} px`;
}

function updatePlayButton(): void {
  ui.play.textContent = playing ? '暂停' : '继续';
  ui.play.setAttribute('aria-pressed', String(!playing));
}

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const scale = Math.min(rect.width / scenario.world.w, rect.height / scenario.world.h);
  view = {
    scale,
    offset: v((rect.width - scenario.world.w * scale) / 2, (rect.height - scenario.world.h * scale) / 2),
  };
}

function toScreen(p: Vec): Vec {
  return v(view.offset.x + p.x * view.scale, view.offset.y + p.y * view.scale);
}

function toWorld(p: Vec): Vec {
  return v((p.x - view.offset.x) / view.scale, (p.y - view.offset.y) / view.scale);
}

/** 设备像素坐标（相对 canvas 元素）下的鼠标位置。 */
function mouseWorld(ev: MouseEvent | PointerEvent): Vec {
  const rect = canvas.getBoundingClientRect();
  return toWorld(v(ev.clientX - rect.left, ev.clientY - rect.top));
}

function recordHistory(force = false): void {
  const snap = sim.snapshot();
  if (!force && history.length && snap.t - history[history.length - 1].t < 1 / 30) return;
  history.push({ t: snap.t, snap: deepCopy(snap) });
  if (history.length > MAX_HISTORY) history.shift();
}

function currentInput(): InputState {
  const left = inputs.left || pressed.has('ArrowLeft') || pressed.has('a');
  const right = inputs.right || pressed.has('ArrowRight') || pressed.has('d');
  const inRope = inputs.in || pressed.has('w') || pressed.has('ArrowUp');
  const outRope = inputs.out || pressed.has('s') || pressed.has('ArrowDown');
  const swing = (right ? 1 : 0) - (left ? 1 : 0);
  const ropeTrim = (inRope ? 1 : 0) - (outRope ? 1 : 0);
  return { swing, ropeTrim };
}

const pressed = new Set<string>();

function tick(now: number): void {
  const dtReal = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  if (playing && !sim.paused) {
    const speed = Number(ui.speed.value) || 1;
    accumulator += dtReal * speed;
    const stepDt = stepSize;
    let guard = 0;
    while (accumulator >= stepDt && guard < 120) {
      sim.step(stepDt, currentInput());
      accumulator -= stepDt;
      guard++;
      historyAccum += stepDt;
      if (historyAccum > 1 / 30) {
        historyAccum = 0;
        recordHistory();
      }
    }
    syncEvents();
    updateScrub();
  }
  render();
  requestAnimationFrame(tick);
}

function syncEvents(): void {
  const evs = sim.events;
  for (const e of evs) {
    if (e.kind === 'wrap' || e.kind === 'release') {
      const label = e.cornerKey ?? e.text;
      const last = keyMarks[keyMarks.length - 1];
      if (!last || last.t !== e.t || last.label !== label || last.kind !== e.kind) {
        keyMarks.push({ t: e.t, kind: e.kind, label });
      }
    }
  }
  renderEventList();
}

function updateScrub(): void {
  const maxT = Math.max(6, sim.t);
  ui.scrub.max = String(Math.round(maxT * 1000));
  ui.scrub.value = String(Math.round(sim.t * 1000));
  ui.scrubLabel.textContent = `t = ${sim.t.toFixed(2)} s`;
}

function seekTo(t: number): void {
  // 从历史快照恢复；快照间隔内的少量误差用于展示足够。
  let best: { t: number; snap: SimSnapshot } | null = null;
  for (const h of history) {
    const d = Math.abs(h.t - t);
    if (!best || d < Math.abs(best.t - t)) best = h;
  }
  if (!best) return;
  playing = false;
  restoreSnapshot(best.snap);
  sim.paused = true;
  sim.lastStepSamples = [];
  selectedEvent = null;
  updatePlayButton();
  render();
}

function restoreSnapshot(snap: SimSnapshot): void {
  sim.restoreState({
    t: snap.t,
    frame: snap.frame,
    anchor: snap.anchor,
    ropeLength: snap.ropeLength,
    body: snap.body,
    path: snap.path,
    wraps: snap.wraps,
    events: deepCopy(snap.events),
    takeup: snap.takeup,
    blockedReason: snap.blockedReason,
    paused: true,
  });
  ui.scrub.value = String(Math.round(snap.t * 1000));
  ui.scrubLabel.textContent = `t = ${snap.t.toFixed(2)} s`;
}

function render(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, rect.width);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  drawBackground(rect.width, rect.height);
  const snap = selectedEvent ? eventSnapshot(selectedEvent) : sim.snapshot();
  drawObstacles();
  drawRope(snap.path);
  drawAnchor(snap.anchor);
  drawSamples();
  drawCharacter(snap.body.pos, scenario.radius, snap.taut);
  drawTension(snap);
  drawHover();
  if (selectedEvent) drawEventOverlay(selectedEvent);
  updatePanel(snap);
  drawTimeline();
}

function cornerLabelFromKey(key: string): string | null {
  const [obId, idxStr] = key.split('#');
  const ob = scenario.obstacles.find((o) => o.id === obId);
  const idx = Number(idxStr);
  if (!ob || !Number.isFinite(idx)) return null;
  const named = ob.vertexLabels?.[idx];
  return `${ob.label}·${named ?? `角${idx + 1}`}`;
}

function eventSnapshot(e: SimEvent): SimSnapshot {
  const path: RopePath = {
    points: e.pathPoints.map((p) => ({ ...p })),
    corners: [] as RopeCorner[],
    segments: [],
    totalLength: 0,
  };
  for (let i = 0; i + 1 < path.points.length; i++) {
    path.segments.push({
      from: path.points[i],
      to: path.points[i + 1],
      length: dist(path.points[i], path.points[i + 1]),
      index: i,
    });
    path.totalLength += path.segments[i].length;
  }
  path.corners = path.points.slice(1, -1).map((p, i) => {
    const key = e.cornerKeys?.[i] ?? `event-${i}`;
    const obId = key.split('#')[0];
    const idx = Number(key.split('#')[1]);
    return {
      key,
      obstacleId: obId,
      vertexIndex: Number.isFinite(idx) ? idx : -1,
      point: p,
      label: cornerLabelFromKey(key) ?? `拐点 ${i + 1}`,
    };
  });
  return {
    t: e.t,
    frame: e.frame,
    anchor: { ...e.anchor },
    ropeLength: e.ropeLength,
    body: { pos: { ...e.bodyPos }, vel: v(0, 0), sinceContact: 0, contact: true },
    path,
    wraps: path.corners,
    taut: e.taut,
    tensionDir: path.points.length >= 2
      ? norm(sub(path.points[path.points.length - 2], e.bodyPos))
      : v(0, -1),
    ropeSlack: Math.max(0, e.ropeLength - path.totalLength),
    takeup: { active: false, requested: 0, allowed: 0, reason: '', minLength: e.ropeLength },
    blockedReason: null,
    events: [],
    sweptClean: true,
  };
}

function drawBackground(w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0d1621');
  g.addColorStop(1, '#101d2b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // 世界边界
  const tl = toScreen(v(0, 0));
  const br = toScreen(v(scenario.world.w, scenario.world.h));
  ctx.strokeStyle = 'rgba(120, 165, 200, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // 网格
  ctx.save();
  ctx.beginPath();
  ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.clip();
  ctx.strokeStyle = 'rgba(110, 150, 185, 0.08)';
  const step = 80;
  for (let x = 0; x <= scenario.world.w; x += step) {
    const a = toScreen(v(x, 0));
    const b = toScreen(v(x, scenario.world.h));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let y = 0; y <= scenario.world.h; y += step) {
    const a = toScreen(v(0, y));
    const b = toScreen(v(scenario.world.w, y));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawObstacles(): void {
  for (const ob of scenario.obstacles) {
    const pts = ob.points.map(toScreen);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = ob.tint ?? '#2f3d4a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 200, 230, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 顶点小标记
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const isHover = hoverVertex?.obstacleId === ob.id && hoverVertex.vertexIndex === i;
      const isActive = sim.path.corners.some((c) => c.obstacleId === ob.id && c.vertexIndex === i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, isActive ? 5 : isHover ? 5.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#ffd166' : isHover ? '#8ecbff' : 'rgba(180, 210, 235, 0.55)';
      ctx.fill();
    }
    // 标签
    const c = v(
      ob.points.reduce((s, p) => s + p.x, 0) / ob.points.length,
      ob.points.reduce((s, p) => s + p.y, 0) / ob.points.length,
    );
    const label = toScreen(c);
    ctx.fillStyle = 'rgba(200, 225, 245, 0.55)';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ob.label, label.x, label.y);
  }
}

function drawRope(path: RopePath): void {
  const pts = path.points.map(toScreen);
  if (pts.length < 2) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 外发光
  ctx.strokeStyle = 'rgba(255, 196, 120, 0.16)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  // 主体
  ctx.strokeStyle = sim.taut ? '#ffb454' : 'rgba(255, 203, 146, 0.75)';
  ctx.lineWidth = 2.4;
  ctx.setLineDash(sim.taut ? [] : [7, 5]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 分段编号
  ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const seg of path.segments) {
    const a = toScreen(seg.from);
    const b = toScreen(seg.to);
    const mid = v((a.x + b.x) / 2, (a.y + b.y) / 2);
    const d = sub(b, a);
    const n = norm(v(-d.y, d.x));
    const off = v(mid.x + n.x * 12, mid.y + n.y * 12);
    ctx.fillStyle = 'rgba(12, 20, 30, 0.75)';
    ctx.beginPath();
    ctx.roundRect(off.x - 16, off.y - 8, 32, 16, 5);
    ctx.fill();
    ctx.fillStyle = '#ffd9a8';
    ctx.fillText(`${seg.length.toFixed(0)}`, off.x, off.y);
  }

  // 拐点
  for (const c of path.corners) {
    const p = toScreen(c.point);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 209, 102, 0.28)';
    ctx.fill();
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = '#ffe4a3';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(c.label, p.x + 10, p.y - 8);
  }
}

function drawAnchor(anchor: Vec): void {
  const p = toScreen(anchor);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#67e8f9';
  ctx.fill();
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.4)';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#d7fbff';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('锚点', p.x + 14, p.y);
}

function drawSamples(): void {
  if (!ui.showSweep.checked) return;
  const samples = sim.lastStepSamples;
  if (samples.length < 2) return;
  ctx.fillStyle = 'rgba(126, 231, 189, 0.5)';
  for (const s of samples) {
    const p = toScreen(s);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCharacter(pos: Vec, radius: number, taut: boolean): void {
  const p = toScreen(pos);
  const r = Math.max(3, radius * view.scale);
  const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
  g.addColorStop(0, taut ? '#ffe3b0' : '#b8e6ff');
  g.addColorStop(1, taut ? '#e08a24' : '#3b82c4');
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = taut ? '#ffcf87' : 'rgba(160, 210, 245, 0.8)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 速度方向
  const vel = sim.body.vel;
  const sp = Math.hypot(vel.x, vel.y);
  if (sp > 1) {
    const d = norm(vel);
    const tip = v(p.x + d.x * (r + 16), p.y + d.y * (r + 16));
    const left = v(p.x + d.x * (r + 6) - d.y * 4, p.y + d.y * (r + 6) + d.x * 4);
    const right = v(p.x + d.x * (r + 6) + d.y * 4, p.y + d.y * (r + 6) - d.x * 4);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(170, 220, 255, 0.8)';
    ctx.fill();
  }
}

function drawTension(snap: SimSnapshot): void {
  if (!snap.taut) return;
  const p = toScreen(snap.body.pos);
  const d = snap.tensionDir;
  if (Math.hypot(d.x, d.y) < 1e-6) return;
  const len = 56;
  const tip = v(p.x + d.x * len, p.y + d.y * len);
  ctx.strokeStyle = '#ff7b7b';
  ctx.fillStyle = '#ff7b7b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  const left = v(tip.x - d.x * 8 - d.y * 4, tip.y - d.y * 8 + d.x * 4);
  const right = v(tip.x - d.x * 8 + d.y * 4, tip.y - d.y * 8 - d.x * 4);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 160, 160, 0.9)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('张力', tip.x + 6, tip.y + 8);
}

function drawHover(): void {
  if (!hoverVertex) return;
  const ob = scenario.obstacles.find((o) => o.id === hoverVertex!.obstacleId);
  if (!ob) return;
  const pt = ob.points[hoverVertex.vertexIndex];
  const p = toScreen(pt);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  ctx.strokeStyle = '#8ecbff';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function drawEventOverlay(e: SimEvent): void {
  const p = toScreen(e.bodyPos);
  ctx.beginPath();
  ctx.arc(p.x, p.y, scenario.radius * view.scale + 6, 0, Math.PI * 2);
  ctx.strokeStyle = e.kind === 'wrap' ? '#ffd166' : e.kind === 'release' ? '#7ee7bd' : '#ff9b9b';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(10, 18, 26, 0.82)';
  const kindLabel = e.kind === 'wrap' ? '绕上' : e.kind === 'release' ? '解开' : e.kind === 'takeup-limit' ? '受限' : '事件';
  const corner = e.cornerKey ? cornerLabelFromKey(e.cornerKey) : null;
  const text = `${kindLabel}${corner ? ' ' + corner : ''} @ ${e.t.toFixed(2)}s`;
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.beginPath();
  ctx.roundRect(p.x - w / 2, p.y - scenario.radius * view.scale - 34, w, 22, 6);
  ctx.fill();
  ctx.fillStyle = '#f3f8fc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x, p.y - scenario.radius * view.scale - 23);
}

function updatePanel(snap: SimSnapshot): void {
  const reason = sim.lastBlockedReason || (snap.takeup.active ? snap.takeup.reason : '');
  ui.reason.textContent = reason || '—';
  ui.reason.classList.toggle('warn', Boolean(reason));
  updateStartReadout();

  const taut = snap.taut ? '绷紧' : '松弛';
  const slack = Math.max(0, snap.ropeLength - snap.path.totalLength);
  ui.status.innerHTML = `
    <span class="pill ${snap.taut ? 'hot' : 'cool'}">${taut}</span>
    <span class="num">t <b>${snap.t.toFixed(2)}</b> s</span>
    <span class="num">可用绳长 <b>${snap.ropeLength.toFixed(1)}</b> px</span>
    <span class="num">实际折线 <b>${snap.path.totalLength.toFixed(1)}</b> px</span>
    <span class="num">松弛 <b>${slack.toFixed(1)}</b> px</span>
    <span class="num">拐点 <b>${snap.path.corners.length}</b></span>`;

  const rows: string[] = [];
  rows.push(`<div class="segh"><span>段</span><span>长度</span><span>累计</span></div>`);
  let acc = 0;
  for (const seg of snap.path.segments) {
    acc += seg.length;
    const fromLabel = seg.index === 0 ? '锚点' : snap.path.corners[seg.index - 1]?.label ?? `拐点${seg.index}`;
    const toLabel = seg.index === snap.path.segments.length - 1 ? '角色' : snap.path.corners[seg.index]?.label ?? `拐点${seg.index + 1}`;
    rows.push(
      `<div class="seg"><span>${seg.index + 1}. ${fromLabel} → ${toLabel}</span><span>${seg.length.toFixed(1)}</span><span>${acc.toFixed(1)}</span></div>`,
    );
  }
  const straight = dist(snap.anchor, snap.body.pos);
  rows.push(
    `<div class="seg dim"><span>1'. 锚点 → 角色（直线，仅对照）</span><span>${straight.toFixed(1)}</span><span>${(snap.path.totalLength - straight).toFixed(1)} 差</span></div>`,
  );
  ui.segments.innerHTML = rows.join('');

  const dir = snap.tensionDir;
  const ang = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  const hasT = Math.hypot(dir.x, dir.y) > 1e-6;
  ui.tension.innerHTML = hasT
    ? `方向 (${dir.x.toFixed(2)}, ${dir.y.toFixed(2)})<br><span class="dim">屏幕角度 ${ang.toFixed(0)}° ${snap.taut ? '· 绳在拉角色' : '· 松弛，无张力'}</span>`
    : '—';

  const ratio = clamp(snap.ropeLength / Math.max(1, snap.path.totalLength), 0, 2);
  ui.ropeMeter.style.setProperty('--fill', `${Math.min(100, ratio * 50)}%`);

  const samples = sim.lastStepSamples?.length ?? 0;
  ui.readout.textContent =
    `位置 (${snap.body.pos.x.toFixed(1)}, ${snap.body.pos.y.toFixed(1)})  ` +
    `速度 (${snap.body.vel.x.toFixed(0)}, ${snap.body.vel.y.toFixed(0)})  ` +
    `帧 ${snap.frame} · 子步采样 ${samples} · ${snap.blockedReason ? '受限' : '正常'}`;
}

let lastEventSignature = '';
function renderEventList(): void {
  const items = sim.events.filter((e) => e.kind === 'wrap' || e.kind === 'release' || e.kind === 'takeup-limit' || e.kind === 'anchor-move');
  const signature = `${items.length}:${items.length ? items[items.length - 1].frame : -1}:${items.length ? items[items.length - 1].kind : ''}`;
  if (signature === lastEventSignature) return;
  lastEventSignature = signature;
  const recent = items.slice(-160).reverse();
  ui.events.innerHTML = recent
    .map((e, idx) => {
      const cls = e.kind === 'wrap' ? 'wrap' : e.kind === 'release' ? 'release' : e.kind === 'anchor-move' ? 'anchor' : 'limit';
      const icon = e.kind === 'wrap' ? '＋' : e.kind === 'release' ? '－' : e.kind === 'anchor-move' ? '◆' : '!';
      const target = e.cornerKey ? `<span class="mono">${e.cornerKey}</span>` : '';
      return `<li data-idx="${items.length - 1 - idx}" class="${cls}"><span class="t">${e.t.toFixed(2)}s</span><span class="ic">${icon}</span><span class="tx">${e.text}</span>${target}</li>`;
    })
    .join('');
  ui.events.querySelectorAll('li').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number((el as HTMLElement).dataset.idx);
      const ev = items[idx];
      if (!ev) return;
      selectedEvent = ev;
      playing = false;
      sim.paused = true;
      ui.scrub.value = String(Math.round(ev.t * 1000));
      ui.scrubLabel.textContent = `t = ${ev.t.toFixed(2)} s（事件回看）`;
      updatePlayButton();
      render();
    });
  });
}

function drawTimeline(): void {
  const c = ui.timeline;
  const rect = c.getBoundingClientRect();
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(rect.width * dpr));
  c.height = Math.max(1, Math.round(rect.height * dpr));
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(10, 18, 27, 0.9)';
  g.fillRect(0, 0, w, h);

  // 时间轴用固定视野（至少 12s），避免早期事件被不断压缩。
  const maxT = Math.max(6, sim.t);
  const xOf = (t: number): number => 8 + (t / maxT) * (w - 16);

  // 拐点数量曲线
  g.strokeStyle = 'rgba(140, 190, 230, 0.35)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(8, h - 8);
  g.lineTo(w - 8, h - 8);
  g.stroke();

  const rows = [0.3, 0.55, 0.8];
  for (const m of keyMarks) {
    const x = xOf(m.t);
    const row = m.kind === 'wrap' ? rows[1] : rows[0];
    g.fillStyle = m.kind === 'wrap' ? '#ffd166' : '#7ee7bd';
    g.fillRect(x - 1, h * (1 - row), 2, h * row - 8);
    g.beginPath();
    g.arc(x, h * (1 - row), 3, 0, Math.PI * 2);
    g.fill();
  }

  // 当前时刻
  const cur = xOf(sim.t);
  g.strokeStyle = '#67e8f9';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cur, 4);
  g.lineTo(cur, h - 6);
  g.stroke();

  // 限制事件
  for (const e of sim.events) {
    if (e.kind !== 'takeup-limit') continue;
    const x = xOf(e.t);
    g.fillStyle = 'rgba(255, 120, 120, 0.85)';
    g.fillRect(x - 1, h - 10, 2, 6);
  }

  g.font = '10px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'right';
  g.fillStyle = 'rgba(255, 209, 102, 0.7)';
  g.fillText('绕上', w - 10, h * 0.46);
  g.fillStyle = 'rgba(126, 231, 189, 0.7)';
  g.fillText('解开', w - 10, h * 0.74);
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

ui.scenario.addEventListener('change', () => loadScenario(ui.scenario.value));
ui.play.addEventListener('click', () => {
  playing = !playing;
  if (playing) {
    sim.paused = false;
    selectedEvent = null; // 从事件回看回到实时
  } else {
    sim.paused = true;
  }
  updatePlayButton();
});
ui.step.addEventListener('click', () => {
  playing = false;
  selectedEvent = null;
  updatePlayButton();
  sim.paused = false;
  sim.step(stepSize, currentInput());
  sim.paused = true;
  recordHistory(true);
  syncEvents();
  updateScrub();
  render();
});
ui.reset.addEventListener('click', () => {
  loadScenario(scenario.id);
});
ui.speed.addEventListener('change', () => {
  // 只影响推进速率；固定步长由 stepSize 控制。
});
ui.stepSize.addEventListener('change', () => {
  stepSize = Number(ui.stepSize.value) || 1 / 60;
});
ui.replayCheck.addEventListener('click', () => {
  // 用完全相同初始状态独立跑两遍，比较关键拐点事件序列。
  const run = (): string[] => {
    const probe = createSim(scenario);
    const log: string[] = [];
    const seen = new Set<SimEvent>();
    for (let i = 0; i < 1200; i++) {
      probe.step(1 / 60, { swing: 0, ropeTrim: 0 });
      for (const e of probe.events) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (e.kind === 'wrap' || e.kind === 'release') {
          log.push(`${e.kind}@${e.t.toFixed(4)}:${e.cornerKey ?? ''}`);
        }
      }
    }
    return log;
  };
  const a = run();
  const b = run();
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  const first = a.slice(0, 3).join(' → ') || '无拐点事件';
  ui.replay.innerHTML = same
    ? `<span class="ok">✓ 复现一致</span> · ${a.length} 个关键事件 · 首次：${escapeHtml(first)}`
    : `<span class="bad">✗ 两次结果不同</span> · ${a.length} vs ${b.length}`;
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

for (const [el, key] of [
  [ui.anchorUp, 'anchorUp'],
  [ui.anchorDown, 'anchorDown'],
] as const) {
  el.addEventListener('click', () => {
    const dy = key === 'anchorUp' ? -24 : 24;
    // 尽量移动；若目标位置会撞进障碍，就逐级减小步幅，最后停在最小可行处。
    for (const scale of [1, 0.6, 0.3, 0.1]) {
      const next = v(sim.anchor.x, clamp(sim.anchor.y + dy * scale, 0, scenario.world.h));
      if (anchorInsideObstacle(next, scenario.obstacles)) continue;
      const evs = sim.moveAnchor(next);
      if (!evs.some((e) => e.text.includes('拒绝') || e.text.includes('不能进入'))) {
        recordHistory(true);
        syncEvents();
        updateScrub();
        render();
        return;
      }
    }
  });
}

ui.trimIn.addEventListener('click', () => {});
// 按住按钮收放绳
ui.trimIn.addEventListener('pointerdown', () => (inputs.in = true));
ui.trimIn.addEventListener('pointerup', () => (inputs.in = false));
ui.trimIn.addEventListener('pointerleave', () => (inputs.in = false));
ui.trimOut.addEventListener('pointerdown', () => (inputs.out = true));
ui.trimOut.addEventListener('pointerup', () => (inputs.out = false));
ui.trimOut.addEventListener('pointerleave', () => (inputs.out = false));

ui.autoWrap.addEventListener('change', () => (sim.config.autoWrap = ui.autoWrap.checked));
ui.autoRelease.addEventListener('change', () => (sim.config.autoRelease = ui.autoRelease.checked));

ui.scrub.addEventListener('input', () => {
  const t = Number(ui.scrub.value) / 1000;
  seekTo(t);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  pressed.add(e.key);
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  if (e.key === ' ') {
    playing = !playing;
    if (playing) {
      sim.paused = false;
      selectedEvent = null;
    } else {
      sim.paused = true;
    }
    updatePlayButton();
  }
  if (e.key === '.') {
    playing = false;
    selectedEvent = null;
    updatePlayButton();
    sim.paused = false;
    sim.step(stepSize, currentInput());
    sim.paused = true;
    recordHistory(true);
    syncEvents();
    updateScrub();
    render();
  }
});
window.addEventListener('keyup', (e) => pressed.delete(e.key));

canvas.addEventListener('pointerdown', (e) => {
  const w = mouseWorld(e);
  if (dist(w, sim.anchor) * view.scale < 16) {
    draggingAnchor = true;
    dragOffset = sub(sim.anchor, w);
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (ui.editStart.checked && !playing) {
    draggingStart = true;
    startPos = v(clamp(w.x, 0, scenario.world.w), clamp(w.y, 0, scenario.world.h));
    canvas.setPointerCapture(e.pointerId);
    applyStartFromFields(false);
    return;
  }
});
canvas.addEventListener('pointermove', (e) => {
  const w = mouseWorld(e);
  if (draggingStart) {
    startPos = v(clamp(w.x, 0, scenario.world.w), clamp(w.y, 0, scenario.world.h));
    updateStartReadout();
    return;
  }
  if (draggingAnchor) {
    const next = add(w, dragOffset);
    const target = v(clamp(next.x, 0, scenario.world.w), clamp(next.y, 0, scenario.world.h));
    // 拖拽时跳过会进入障碍的位置，保持锚点合法。
    if (!anchorInsideObstacle(target, scenario.obstacles)) {
      sim.moveAnchor(target);
      recordHistory(true);
      syncEvents();
      updateScrub();
      render();
    }
    return;
  }
  // 顶点悬停
  let best: { obstacleId: string; vertexIndex: number } | null = null;
  let bestD = 12;
  for (const ob of scenario.obstacles) {
    for (let i = 0; i < ob.points.length; i++) {
      const d = dist(w, ob.points[i]) * view.scale;
      if (d < bestD) {
        bestD = d;
        best = { obstacleId: ob.id, vertexIndex: i };
      }
    }
  }
  hoverVertex = best;
});
canvas.addEventListener('pointerup', (e) => {
  draggingAnchor = false;
  draggingStart = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* noop */
  }
});

window.addEventListener('resize', () => {
  resize();
  render();
});

ui.applyStart.addEventListener('click', () => applyStartFromFields(true));
ui.editStart.addEventListener('change', () => {
  if (ui.editStart.checked) {
    playing = false;
    updatePlayButton();
  }
  render();
});
for (const el of [ui.startVx, ui.startVy, ui.startSlack]) {
  el.addEventListener('change', () => applyStartFromFields(false));
}

function applyStartFromFields(resetTime: boolean): void {
  startVel = v(Number(ui.startVx.value) || 0, Number(ui.startVy.value) || 0);
  startSlack = Math.max(0, Number(ui.startSlack.value) || 0);
  startPos = v(
    clamp(startPos.x, 0, scenario.world.w),
    clamp(startPos.y, 0, scenario.world.h),
  );
  sim = createSim(scenario, {
    pos: startPos,
    vel: startVel,
    slack: startSlack,
    anchor: sim ? sim.anchor : scenario.anchor,
    ropeLength: scenario.ropeLength,
  });
  history = [];
  keyMarks = [];
  lastEventSignature = '';
  selectedEvent = null;
  historyAccum = 0;
  if (resetTime) {
    playing = false;
    accumulator = 0;
  }
  recordHistory(true);
  updatePlayButton();
  updateStartReadout();
  updateScrub();
  render();
}

// 时间线点击定位
ui.timeline.addEventListener('click', (e) => {
  const rect = ui.timeline.getBoundingClientRect();
  const frac = clamp((e.clientX - rect.left - 8) / Math.max(1, rect.width - 16), 0, 1);
  seekTo(frac * Math.max(1, sim.t));
  syncEvents();
});

// 初始化下拉框
for (const s of SCENARIOS) {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.name;
  ui.scenario.appendChild(opt);
}
ui.scenario.value = scenario.id;
loadScenario(scenario.id);
requestAnimationFrame((t) => {
  lastTime = t;
  requestAnimationFrame(tick);
});
