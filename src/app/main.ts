import { type Vec2, dist, headingOf, norm, sub } from '../core/geometry.ts';
import type { TrackSegment } from '../core/geometry.ts';
import {
  ArcSegment,
  arcFromPoseToPoint,
  arcFromStartEndSweep,
  lineFromPose,
} from '../core/geometry.ts';
import type { TrackDoc } from '../core/presets.ts';
import { buildPresets, cloneDoc, docToNetwork, switchesFor } from '../core/presets.ts';
import type { BranchChoice, SwitchState } from '../core/switch.ts';
import { segmentOfPort } from '../core/switch.ts';
import { VehicleSim, DEFAULT_SPEED } from '../core/vehicle.ts';
import {
  addDrawnSegment,
  appendArc,
  appendLine,
  findExtensionAt,
  findNodeAt,
  hitNode,
  hitSegment,
  moveNode,
  removeSegment,
  replaceSegment,
  rotateHandlePos,
  rotateSegmentAbout,
  translateSegment,
} from '../core/edit.ts';
import { type Camera, fitCamera, panBy, screenToWorld, zoomAt } from './viewport.ts';
import { render } from './render.ts';

type Tool = 'select' | 'line' | 'arc';

interface Draft {
  tool: 'line' | 'arc';
  start: Vec2;
  /** 起点可用切线 (来自已连接端口); null 表示从空白起笔。 */
  startTangent: Vec2 | null;
  startNodeId: string | null;
  anchorSegmentId: string | null;
  end: Vec2;
  endNodeId: string | null;
  /** 实时预览折线。 */
  preview: Vec2[];
  valid: boolean;
  hint: string;
}

type DragState =
  | { kind: 'pan'; startScreen: Vec2; startCam: Camera }
  | { kind: 'segment'; id: string; lastWorld: Vec2; moved: boolean }
  | { kind: 'node'; id: string; lastWorld: Vec2; startScreen: Vec2; moved: boolean }
  | { kind: 'rotate'; id: string; pivot: Vec2; startAngle: number; startSeg: TrackSegment }
  | { kind: 'draw'; draft: Draft }
  | null;

interface AppState {
  doc: TrackDoc;
  network: ReturnType<typeof docToNetwork>;
  switches: Map<string, SwitchState>;
  vehicle: VehicleSim;
  camera: Camera;
  selectedSegmentId: string | null;
  hoveredSegmentId: string | null;
  hoveredNodeId: string | null;
  drag: DragState;
  tool: Tool;
  snap: boolean;
  /** 圆弧工具的转向 (屏幕方向): -1 = 左弯 (逆时针), +1 = 右弯 (顺时针)。 */
  arcSide: 1 | -1;
  draft: Draft | null;
  trail: Array<{ pos: Vec2 }>;
  lastTrailOdo: number;
  presetId: string | null;
  /** UI 主动提示 (道岔切换解释等)。 */
  note: string;
  playing: boolean;
  dirtyPanel?: boolean;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const el = {
  hud: document.getElementById('hud')!,
  toolbar: document.getElementById('toolbar')!,
  snap: document.getElementById('snap') as HTMLInputElement,
  arcSide: document.getElementById('arc-side')!,
  presets: document.getElementById('presets')!,
  presetDesc: document.getElementById('preset-desc')!,
  vehicle: document.getElementById('vehicle')!,
  switches: document.getElementById('switches')!,
  switchNote: document.getElementById('switch-note')!,
  validation: document.getElementById('validation')!,
  travel: document.getElementById('travel')!,
  events: document.getElementById('events')!,
  speed: document.getElementById('speed') as HTMLInputElement,
  speedOut: document.getElementById('speed-out')!,
  btnStart: document.getElementById('btn-start') as HTMLButtonElement,
  btnReset: document.getElementById('btn-reset') as HTMLButtonElement,
  btnAddLine: document.getElementById('btn-add-line') as HTMLButtonElement,
  btnAddArcLeft: document.getElementById('btn-add-arc-left') as HTMLButtonElement,
  btnAddArcRight: document.getElementById('btn-add-arc-right') as HTMLButtonElement,
  btnDelete: document.getElementById('btn-delete') as HTMLButtonElement,
  btnSnapback: document.getElementById('btn-snapback') as HTMLButtonElement,
  selectionInfo: document.getElementById('selection-info')!,
  newLineLen: document.getElementById('new-line-len') as HTMLInputElement,
  newArcRadius: document.getElementById('new-arc-radius') as HTMLInputElement,
};

const presets = buildPresets();

function initialState(presetId: string | null = 'fork'): AppState {
  const preset = presets.find((p) => p.id === presetId);
  if (!preset) {
    const blank: TrackDoc = {
      title: '空白画布',
      segments: [],
      nodes: [],
      links: {},
      start: { segmentId: '', s: 0 },
    };
    const network = docToNetwork(blank);
    return {
      doc: blank,
      network,
      switches: new Map(),
      vehicle: new VehicleSim(network, new Map(), { speed: DEFAULT_SPEED, brakeDecel: 320 }),
      camera: { scale: 1, tx: 60, ty: 60 },
      selectedSegmentId: null,
      hoveredSegmentId: null,
      hoveredNodeId: null,
      drag: null,
      tool: 'select',
      snap: el.snap.checked,
      arcSide: -1,
      draft: null,
      trail: [],
      lastTrailOdo: -1,
      presetId: null,
      note: '空白画布: 用「直线 / 圆弧」工具画第一段, 之后从端点继续画。',
      playing: false,
    };
  }
  const doc = cloneDoc(preset.doc);
  const network = docToNetwork(doc);
  const switches = switchesFor(doc, network);
  const vehicle = new VehicleSim(network, switches, { speed: DEFAULT_SPEED, brakeDecel: 320 });
  const bounds = network.bounds();
  const rect = canvas.getBoundingClientRect();
  return {
    doc,
    network,
    switches,
    vehicle,
    camera: fitCamera(bounds, Math.max(320, rect.width), Math.max(320, rect.height)),
    selectedSegmentId: null,
    hoveredSegmentId: null,
    hoveredNodeId: null,
    drag: null,
    tool: 'select',
    snap: el.snap.checked,
    arcSide: -1,
    draft: null,
    trail: [],
    lastTrailOdo: -1,
    presetId: preset.id,
    note: '',
    playing: false,
  };
}

let state = initialState();

// ---------------------------------------------------------------------------
// 画布尺寸 / 渲染循环
// ---------------------------------------------------------------------------

let dpr = Math.min(2.5, window.devicePixelRatio || 1);
let cssW = 800;
let cssH = 600;

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  cssW = Math.max(200, rect.width);
  cssH = Math.max(200, rect.height);
  dpr = Math.min(2.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}

new ResizeObserver(resize).observe(canvas);
resize();

let lastFrame = performance.now();
let panelClock = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  const active = state.vehicle.status === 'running' || state.vehicle.status === 'braking';
  if (active) {
    // 固定子步长, 保证高速下车不会跳过节点。
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const sub = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      state.vehicle.step(sub);
      sampleTrail();
      if (state.vehicle.status === 'stopped' || state.vehicle.status === 'finished') break;
    }
    if (state.vehicle.status === 'stopped' || state.vehicle.status === 'finished') {
      state.playing = false;
      state.dirtyPanel = true;
    }
  }
  // 侧栏在运行中周期刷新 (不需要 60Hz)。
  if (active || state.dirtyPanel === true) {
    panelClock += dt;
    if (panelClock >= 0.12 || state.dirtyPanel === true) {
      panelClock = 0;
      state.dirtyPanel = false;
      renderPanel();
    }
  }

  render(ctx, {
    doc: state.doc,
    network: state.network,
    switches: state.switches,
    vehicle: state.vehicle,
    camera: state.camera,
    width: cssW,
    height: cssH,
    selectedSegmentId: state.selectedSegmentId,
    hoveredSegmentId: state.hoveredSegmentId,
    hoveredNodeId: state.hoveredNodeId,
    dragging: state.drag && state.drag.kind !== 'pan' && state.drag.kind !== 'draw'
      ? { kind: state.drag.kind, id: state.drag.id }
      : null,
    trail: state.trail,
    draft: state.draft,
    dpr,
  });

  updateHud();
  requestAnimationFrame(frame);
}

function sampleTrail(): void {
  const v = state.vehicle;
  if (v.odometer - state.lastTrailOdo >= 6 || v.odometer < state.lastTrailOdo) {
    const p = v.pose.pos;
    const last = state.trail[state.trail.length - 1];
    if (!last || dist(last.pos, p) > 2) state.trail.push({ pos: { ...p } });
    if (state.trail.length > 1400) state.trail.splice(0, state.trail.length - 1400);
    state.lastTrailOdo = v.odometer;
  }
  if (v.odometer === 0 && state.lastTrailOdo !== 0) {
    state.trail = [];
    state.lastTrailOdo = 0;
  }
}

// ---------------------------------------------------------------------------
// 网络重建 (编辑后)
// ---------------------------------------------------------------------------

function rebuild(): void {
  state.network = docToNetwork(state.doc);
  const previousSwitch = new Map(state.switches);
  state.switches = switchesFor(state.doc, state.network);
  // 保留用户此前的道岔选择
  for (const [nodeId, sw] of state.switches) {
    const prev = previousSwitch.get(nodeId);
    if (prev) sw.choice = prev.choice;
  }
  // 车辆挂到新网络并做故障安全处理
  state.vehicle.rebind(state.network, state.switches);
  if (state.vehicle.status === 'running' || state.vehicle.status === 'braking') {
    state.playing = true;
  }
  state.note = state.network.errors.length > 0 ? '编辑后校验未通过, 车辆已进入故障安全流程。' : '';
  state.dirtyPanel = true;
  renderPanel();
}

// ---------------------------------------------------------------------------
// UI 更新
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  idle: '待发车',
  running: '运行中',
  braking: '制动中',
  stopped: '已停车',
  finished: '已到终点',
};

function updateHud(): void {
  const v = state.vehicle;
  const next = v.previewExit();
  const chips: string[] = [];
  chips.push(`<span class="chip status-${v.status}"><b>${STATUS_TEXT[v.status] ?? v.status}</b></span>`);
  if (v.segment) {
    chips.push(
      `<span class="chip">段 <b>${v.segmentId}</b> · s ${v.s.toFixed(1)}/${v.segment.length.toFixed(1)}</span>`,
    );
  }
  chips.push(`<span class="chip">里程 <b>${v.odometer.toFixed(1)}</b> · v ${v.speed.toFixed(0)}</span>`);
  if (next && v.status !== 'finished') {
    const label = next.ok
      ? `下一段 <b>${next.segmentId}</b>${next.isBranch ? ` (${next.choice === 'alternate' ? '备选' : '主'})` : ''}`
      : '无后续轨段';
    chips.push(`<span class="chip">${label}</span>`);
  }
  if (v.faultReason) chips.push(`<span class="chip status-stopped">故障: ${escapeHtml(v.faultReason)}</span>`);
  if (state.draft) chips.push(`<span class="chip">${escapeHtml(state.draft.hint)}</span>`);
  el.hud.innerHTML = chips.join('');
}

function renderPanel(): void {
  renderPresets();
  renderVehicle();
  renderSwitches();
  renderValidation();
  renderTravel();
  renderEvents();
  renderSelection();
}

function renderPresets(): void {
  el.presets.innerHTML = '';
  for (const p of presets) {
    const b = document.createElement('button');
    b.textContent = p.title;
    b.className = state.presetId === p.id ? 'active' : '';
    b.addEventListener('click', () => loadPreset(p.id));
    el.presets.appendChild(b);
  }
  const blankBtn = document.createElement('button');
  blankBtn.textContent = '空白';
  blankBtn.className = state.presetId === null ? 'active' : '';
  blankBtn.addEventListener('click', () => loadPreset(null));
  el.presets.appendChild(blankBtn);

  const cur = presets.find((p) => p.id === state.presetId);
  el.presetDesc.textContent = cur?.description ?? '空白画布 — 用画布上的直线/圆弧工具自己铺线。';
}

function renderVehicle(): void {
  const s = state.vehicle.summary();
  const rows: Array<[string, string, string?]> = [
    [
      '状态',
      STATUS_TEXT[s.status] ?? s.status,
      s.status === 'running' ? 'ok' : s.status === 'braking' || s.status === 'stopped' ? 'warn' : '',
    ],
    ['所在轨段', s.segmentId || '—', ''],
    ['段内进度', `${s.s.toFixed(1)} / ${s.segmentLength.toFixed(1)}`, ''],
    ['累计行程', s.odometer.toFixed(1), ''],
    ['当前速度', s.speed.toFixed(1), ''],
    ['行驶时间', `${s.elapsed.toFixed(2)} s`, ''],
    [
      '下一段',
      s.next
        ? s.next.ok
          ? `${s.next.segmentId}${s.next.isBranch ? ` · ${s.next.choice === 'alternate' ? '备选' : '主'}` : ''}`
          : '无 (终点)'
        : '—',
      '',
    ],
  ];
  if (s.fault) rows.push(['故障', s.fault, 'bad']);
  if (state.note) rows.push(['提示', state.note, 'warn']);
  el.vehicle.innerHTML = rows
    .map(
      ([k, v, cls]) =>
        `<dt>${escapeHtml(k)}</dt><dd class="${cls ?? ''}" title="${escapeHtml(v)}">${escapeHtml(v)}</dd>`,
    )
    .join('');
}

function renderSwitches(): void {
  const v = state.vehicle;
  el.switches.innerHTML = '';
  const switches = [...state.switches.values()].filter((s) => s.switchable);
  if (switches.length === 0) {
    el.switches.innerHTML = '<div class="muted">当前场景没有分叉节点。</div>';
    el.switchNote.textContent = '';
    return;
  }
  for (const sw of switches) {
    const status = v.branchStatus(sw.nodeId);
    const committed = status.committedPort;

    const wrap = document.createElement('div');
    wrap.className = 'switch';
    const primaryLabel = sw.primarySegmentId ?? '—';
    const altLabel = sw.alternateSegmentId ?? '—';

    wrap.innerHTML = `
      <div class="head">
        <span class="name">${escapeHtml(sw.nodeId)}</span>
        <span class="muted" style="font-size:11px">${
          committed
            ? '本次已锁定'
            : status.approaching
              ? `车距此 ${status.remaining.toFixed(1)}`
              : '车未在接近'
        }</span>
      </div>
      <div class="seg-btn">
        <button data-choice="primary" class="${sw.choice === 'primary' ? 'active' : ''} ${
          committed && sw.primaryPort === committed ? 'locked' : ''
        }">主 · ${escapeHtml(primaryLabel)}</button>
        <button data-choice="alternate" class="${sw.choice === 'alternate' ? 'active' : ''} ${
          committed && sw.alternatePort === committed ? 'locked' : ''
        }">备选 · ${escapeHtml(altLabel)}</button>
      </div>
      <div class="meta">${escapeHtml(describeSwitch(sw, status))}</div>
    `;
    const [btnPrimary, btnAlt] = wrap.querySelectorAll('button');
    btnPrimary?.addEventListener('click', () => flipSwitch(sw.nodeId, 'primary'));
    btnAlt?.addEventListener('click', () => flipSwitch(sw.nodeId, 'alternate'));
    el.switches.appendChild(wrap);
  }
  el.switchNote.textContent =
    '切换道岔: 车尚未进入节点 -> 本次立即改走新方向; 车已驶出该节点 -> 本次方向已锁定, 只影响下一次到达。';
}

function describeSwitch(sw: SwitchState, status: ReturnType<VehicleSim['branchStatus']>): string {
  const target = sw.choice === 'alternate' ? sw.alternateSegmentId : sw.primarySegmentId;
  if (status.committedPort && status.lastPass) {
    return `本次已驶出 ${status.committedPort} (${segmentOfPort(status.committedPort)}), 方向锁定; 再切换只影响下一次到达。`;
  }
  if (status.committedPort) {
    return `本次已驶出 ${status.committedPort} (${segmentOfPort(status.committedPort)}), 方向锁定; 再切换只影响下一次到达。`;
  }
  if (status.approaching) {
    return `车辆尚未进入节点, 还差 ${status.remaining.toFixed(1)}; 现在切换会影响本次通行。当前将走 ${target ?? '—'}。`;
  }
  return `车辆不在驶向该节点的段上; 当前道岔位: ${sw.choice === 'alternate' ? '备选' : '主'} (${target ?? '—'})。`;
}

function renderValidation(): void {
  const issues = state.network.issues;
  const errors = state.network.errors;
  const warnings = state.network.warnings;
  if (issues.length === 0) {
    el.validation.innerHTML =
      state.doc.segments.length === 0
        ? '<div class="issue ok">画布为空。用「直线 / 圆弧」工具开始铺轨。</div>'
        : '<div class="issue ok">所有端点均已连接, 转角在容差内。</div>';
    return;
  }
  el.validation.innerHTML = issues
    .map(
      (i) =>
        `<div class="issue ${i.level}">${i.level === 'error' ? '错误' : '警告'}: ${escapeHtml(i.message)}</div>`,
    )
    .join('');
  if (errors.length > 0) {
    el.validation.insertAdjacentHTML(
      'afterbegin',
      `<div class="issue error">共 ${errors.length} 个错误: 车辆不会发车 / 正在制动。</div>`,
    );
  } else if (warnings.length > 0) {
    el.validation.insertAdjacentHTML(
      'afterbegin',
      `<div class="issue warning">共 ${warnings.length} 条警告, 仍可通行。</div>`,
    );
  }
}

function renderTravel(): void {
  const v = state.vehicle;
  const legs = v.legs;
  el.travel.innerHTML = '';
  if (legs.length === 0) {
    el.travel.innerHTML = '<div class="muted">尚未发车。</div>';
    return;
  }

  // 路线摘要: 已走过的段 + 正在走的段, 分叉处标注主/备
  const seq = legs.map((l) => l.segmentId).join(' → ');
  const completed = v.completedRoute();
  const completedLen = completed.reduce((sum, l) => sum + l.length, 0);
  const summary = document.createElement('div');
  summary.className = 'route-summary';
  summary.innerHTML = `
    <div>实际行程: <b>${escapeHtml(seq)}</b></div>
    <div class="muted">已完成 ${completed.length} 段 · ${completedLen.toFixed(1)} 单位 · 总里程 ${v.odometer.toFixed(1)}</div>
  `;
  el.travel.appendChild(summary);
  const recent = legs.slice(-14).reverse();
  for (const leg of recent) {
    const isCurrent = !leg.completed;
    const progress = leg.length > 0 ? Math.min(1, (leg.endOdo - leg.startOdo) / leg.length) : 0;
    const tag =
      leg.viaNodeId === null
        ? isCurrent
          ? '当前'
          : ''
        : `经 ${leg.viaNodeId}${leg.viaChoice ? ` · ${leg.viaChoice === 'alternate' ? '备选' : '主'}` : ''}`;
    const row = document.createElement('div');
    row.className = `leg${isCurrent ? ' current' : ''}`;
    row.innerHTML = `
      <span class="id">${escapeHtml(leg.segmentId)}</span>
      <span class="bar"><i style="width:${(progress * 100).toFixed(1)}%"></i></span>
      <span class="tag ${leg.viaChoice === 'alternate' ? 'alt' : ''}">${escapeHtml(tag)}</span>
    `;
    el.travel.appendChild(row);
  }
}

function renderEvents(): void {
  const events = state.vehicle.events.slice(-40);
  el.events.innerHTML = events
    .map(
      (e) =>
        `<div class="ev ${e.kind}"><span class="t">${e.t.toFixed(2)}s</span>${escapeHtml(e.message)}</div>`,
    )
    .join('');
}

function renderSelection(): void {
  const has = state.selectedSegmentId !== null;
  el.btnAddLine.disabled = !has;
  el.btnAddArcLeft.disabled = !has;
  el.btnAddArcRight.disabled = !has;
  el.btnDelete.disabled = !has;
  el.btnSnapback.disabled = !has;
  const braking = state.vehicle.status === 'braking';
  el.btnStart.disabled = state.doc.segments.length === 0 || braking;
  el.btnStart.textContent = braking ? '制动中' : state.vehicle.status === 'running' ? '暂停' : '发车';

  const seg = state.doc.segments.find((s) => s.id === state.selectedSegmentId);
  if (!seg) {
    el.selectionInfo.textContent = '未选中轨段。点击画布上的轨道可选中。';
    return;
  }
  const kind = seg.kind === 'line' ? '直线' : '圆弧';
  const parts = [`${seg.id} · ${kind} · 长 ${seg.length.toFixed(1)}`];
  if (seg instanceof ArcSegment) {
    parts.push(`R ${seg.radius.toFixed(1)} · 扫角 ${((seg.sweep * 180) / Math.PI).toFixed(1)}°`);
  }
  const portIssues = state.network.issues.filter((i) => i.port?.startsWith(`${seg.id}:`));
  if (portIssues.length === 0) {
    parts.push('两端连接正常');
  } else {
    parts.push(`${portIssues.filter((i) => i.level === 'error').length} 个连接问题`);
  }
  el.selectionInfo.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// 绘制草稿
// ---------------------------------------------------------------------------

function buildDraft(
  tool: 'line' | 'arc',
  start: Vec2,
  startTan: Vec2 | null,
  startNodeId: string | null,
  anchorSegmentId: string | null,
  end: Vec2,
  endNodeId: string | null,
  arcSide: 1 | -1,
): Draft {
  const chord = dist(start, end);
  const valid = chord >= 6;
  let preview: Vec2[] = [];
  let hint = '';
  let ok = valid;

  if (tool === 'line') {
    if (valid) {
      const seg = lineFromPose('preview', { pos: start, tangent: norm(sub(end, start)) }, chord);
      preview = seg.sample(20);
      hint = `直线 · ${chord.toFixed(0)}`;
    } else {
      hint = '直线: 拖出至少 6 单位';
    }
  } else if (valid) {
    // 从已连接端点起笔: 用相切约束 (起点切线 = 上一段出射方向), 拖到哪就弯到哪。
    // 从空白起笔: 用固定 90° 扫角, 转向由左/右弯按钮决定。
    const tangentArc = startTan ? arcFromPoseToPoint('preview', { pos: start, tangent: startTan }, end) : null;
    const arc = tangentArc ?? arcFromStartEndSweep('preview', start, end, (Math.PI / 2) * arcSide);
    if (arc) {
      preview = arc.sample(32);
      const sweepDeg = (arc.sweep * 180) / Math.PI;
      hint = `圆弧 · R ${arc.radius.toFixed(0)} · 扫角 ${sweepDeg.toFixed(0)}°${
        tangentArc ? ' · 与上一段相切' : startTan ? ' · 终点不可相切, 用 90° 弧' : ' · 固定 90° 弧'
      }`;
    } else {
      ok = false;
      hint = '圆弧: 起点与终点太近';
    }
  } else {
    hint = '圆弧: 拖出至少 6 单位';
  }

  return {
    tool,
    start,
    startTangent: startTan,
    startNodeId,
    anchorSegmentId,
    end,
    endNodeId,
    preview,
    valid: ok,
    hint,
  };
}

function commitDraft(draft: Draft): void {
  if (!draft.valid) return;
  const id = `U${Date.now().toString(36).slice(-5)}`;
  let seg: TrackSegment | null = null;
  if (draft.tool === 'line') {
    const len = dist(draft.start, draft.end);
    if (len < 6) return;
    seg = lineFromPose(id, { pos: draft.start, tangent: norm(sub(draft.end, draft.start)) }, len);
  } else {
    const tangentArc = draft.startTangent
      ? arcFromPoseToPoint(id, { pos: draft.start, tangent: draft.startTangent }, draft.end)
      : null;
    seg = tangentArc ?? arcFromStartEndSweep(id, draft.start, draft.end, (Math.PI / 2) * state.arcSide);
    if (!seg) {
      state.note = '圆弧起点与终点太近, 未创建。';
      return;
    }
    if (draft.startTangent && !tangentArc) {
      state.note = '终点不在相切可达范围内, 已改用固定 90° 圆弧 (此接头可能有转角)。';
    }
  }
  if (!seg) {
    state.note = '无法生成该圆弧: 终点与起点切线不共面或超过半圆, 请调整终点。';
    return;
  }
  const { doc, segmentId } = addDrawnSegment(state.doc, seg, {
    startNodeId: draft.startNodeId,
    endNodeId: draft.endNodeId,
    snapRadius: state.snap ? 14 : 0,
  });
  state.doc = doc;
  state.selectedSegmentId = segmentId;
  state.presetId = null;
  rebuild();
}

/** 计算落笔点的吸附信息。 */
function snapAt(world: Vec2): { point: Vec2; tangent: Vec2 | null; nodeId: string | null; segmentId: string | null } {
  if (!state.snap) return { point: world, tangent: null, nodeId: null, segmentId: null };
  const radius = 14 / state.camera.scale;
  const extension = findExtensionAt(state.doc, world, radius);
  if (extension) {
    return {
      point: extension.point,
      tangent: extension.tangent,
      nodeId: extension.nodeId,
      segmentId: extension.segmentId,
    };
  }
  const nodeId = findNodeAt(state.doc, world, radius);
  if (nodeId) {
    const node = state.doc.nodes.find((n) => n.id === nodeId)!;
    return { point: { ...node.pos }, tangent: null, nodeId, segmentId: null };
  }
  return { point: world, tangent: null, nodeId: null, segmentId: null };
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const screen = eventScreen(e);
  const world = screenToWorld(state.camera, screen);
  const tolerance = 12 / state.camera.scale;

  // 绘制工具优先
  if (state.tool !== 'select') {
    const snap = snapAt(world);
    const draft = buildDraft(
      state.tool,
      snap.point,
      snap.tangent,
      snap.nodeId,
      snap.segmentId,
      snap.point,
      snap.nodeId,
      state.arcSide,
    );
    state.drag = { kind: 'draw', draft };
    state.draft = draft;
    canvas.classList.add('dragging');
    return;
  }

  // 1) 旋转手柄
  if (state.selectedSegmentId) {
    const seg = state.doc.segments.find((s) => s.id === state.selectedSegmentId);
    if (seg) {
      const handle = rotateHandlePos(seg, 34 / state.camera.scale);
      if (dist(handle, world) <= 12 / state.camera.scale) {
        state.drag = {
          kind: 'rotate',
          id: seg.id,
          pivot: seg.poseAt(0).pos,
          startAngle: headingOf(sub(world, seg.poseAt(0).pos)),
          startSeg: seg,
        };
        canvas.classList.add('dragging');
        return;
      }
    }
  }

  // 2) 节点
  const nodeId = hitNode(state.doc, world, tolerance);
  if (nodeId) {
    state.drag = { kind: 'node', id: nodeId, lastWorld: world, startScreen: screen, moved: false };
    state.selectedSegmentId = null;
    state.hoveredNodeId = nodeId;
    canvas.classList.add('dragging');
    renderPanel();
    return;
  }

  // 3) 轨段
  const hit = hitSegment(state.doc, world, tolerance);
  if (hit) {
    state.selectedSegmentId = hit.segmentId;
    state.drag = { kind: 'segment', id: hit.segmentId, lastWorld: world, moved: false };
    canvas.classList.add('dragging');
    renderPanel();
    return;
  }

  // 4) 空白: 平移
  state.drag = { kind: 'pan', startScreen: screen, startCam: state.camera };
  state.selectedSegmentId = null;
  canvas.classList.add('dragging');
  renderPanel();
});

canvas.addEventListener('pointermove', (e) => {
  const screen = eventScreen(e);
  const world = screenToWorld(state.camera, screen);
  const drag = state.drag;

  if (!drag) {
    const tolerance = 12 / state.camera.scale;
    state.hoveredNodeId = hitNode(state.doc, world, tolerance);
    state.hoveredSegmentId = state.hoveredNodeId ? null : hitSegment(state.doc, world, tolerance)?.segmentId ?? null;
    const drawing = state.tool !== 'select';
    canvas.style.cursor = drawing
      ? 'crosshair'
      : state.hoveredNodeId
        ? 'move'
        : state.hoveredSegmentId
          ? 'grab'
          : 'default';
    return;
  }

  if (drag.kind === 'pan') {
    state.camera = panBy(drag.startCam, screen.x - drag.startScreen.x, screen.y - drag.startScreen.y);
    return;
  }

  if (drag.kind === 'draw') {
    const snap = snapAt(world);
    drag.draft = buildDraft(
      drag.draft.tool,
      drag.draft.start,
      drag.draft.startTangent,
      drag.draft.startNodeId,
      drag.draft.anchorSegmentId,
      snap.point,
      snap.nodeId,
      state.arcSide,
    );
    state.draft = drag.draft;
    return;
  }

  if (drag.kind === 'segment') {
    const delta = sub(world, drag.lastWorld);
    if (Math.abs(delta.x) + Math.abs(delta.y) < 1e-6) return;
    drag.moved = true;
    const seg = state.doc.segments.find((s) => s.id === drag.id);
    if (!seg) return;
    const moved = translateSegment(seg, delta);
    state.doc = replaceSegment(state.doc, moved);
    drag.lastWorld = world;
    rebuild();
    return;
  }

  if (drag.kind === 'node') {
    const delta = sub(world, drag.lastWorld);
    if (Math.abs(delta.x) + Math.abs(delta.y) < 1e-6) return;
    if (!drag.moved && dist(screen, drag.startScreen) < 4) return;
    drag.moved = true;
    state.doc = moveNode(state.doc, drag.id, delta);
    drag.lastWorld = world;
    rebuild();
    return;
  }

  if (drag.kind === 'rotate') {
    const angleNow = headingOf(sub(world, drag.pivot));
    let delta = angleNow - drag.startAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // shift 键: 15° 吸附
    if (e.shiftKey) {
      const snap = Math.PI / 12;
      delta = Math.round(delta / snap) * snap;
    }
    const rotated = rotateSegmentAbout(drag.startSeg, drag.pivot, delta);
    state.doc = replaceSegment(state.doc, rotated);
    rebuild();
    return;
  }
});

function endDrag(): void {
  const drag = state.drag;
  if (drag?.kind === 'node' && !drag.moved) {
    // 单击节点: 若它是分叉, 直接切道岔。
    const sw = state.switches.get(drag.id);
    if (sw?.switchable) {
      flipSwitch(drag.id, sw.choice === 'primary' ? 'alternate' : 'primary');
    }
    state.drag = null;
    canvas.classList.remove('dragging');
    return;
  }
  if (drag?.kind === 'draw') {
    commitDraft(drag.draft);
    state.draft = null;
    state.drag = null;
    canvas.classList.remove('dragging');
    renderPanel();
    return;
  }
  const wasEditing = drag && drag.kind !== 'pan';
  state.drag = null;
  canvas.classList.remove('dragging');
  if (wasEditing) renderPanel();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (!state.drag) {
    state.hoveredNodeId = null;
    state.hoveredSegmentId = null;
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const screen = eventScreen(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.camera = zoomAt(state.camera, screen, factor);
  },
  { passive: false },
);

function eventScreen(e: PointerEvent | WheelEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

function loadPreset(id: string | null): void {
  state = initialState(id);
  syncToolbar();
  resize();
  renderPanel();
}

function setTool(tool: Tool): void {
  state.tool = tool;
  state.draft = null;
  syncToolbar();
  canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

function syncToolbar(): void {
  for (const btn of el.toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
    btn.classList.toggle('active', btn.dataset.tool === state.tool);
  }
  for (const btn of el.arcSide.querySelectorAll<HTMLButtonElement>('button[data-side]')) {
    btn.classList.toggle('active', Number(btn.dataset.side) === state.arcSide);
  }
  el.arcSide.style.opacity = state.tool === 'arc' ? '1' : '0.45';
}

function toggleStart(): void {
  const v = state.vehicle;
  if (state.playing && v.status === 'running') {
    v.pause();
    state.playing = false;
  } else if (v.status === 'finished') {
    state.note = '已到终点, 请按复位 (R) 后重新发车。';
  } else {
    const ok = v.start();
    state.playing = ok;
    if (!ok) state.note = v.faultReason ?? '无法发车';
  }
  renderPanel();
}

function resetSim(): void {
  state.vehicle.reset();
  state.playing = false;
  state.trail = [];
  state.lastTrailOdo = 0;
  state.note = '';
  renderPanel();
}

function flipSwitch(nodeId: string, choice: BranchChoice): void {
  const result = state.vehicle.setSwitch(nodeId, choice);
  state.note = result.message;
  renderPanel();
  el.switchNote.textContent = result.message;
}

function addLine(): void {
  if (!state.selectedSegmentId) return;
  const len = clampNumber(el.newLineLen.valueAsNumber, 20, 600, 160);
  try {
    const { doc, segmentId } = appendLine(state.doc, state.selectedSegmentId, len);
    state.doc = doc;
    state.selectedSegmentId = segmentId;
    state.presetId = null;
    rebuild();
  } catch (err) {
    state.note = String(err);
  }
}

function addArc(direction: 1 | -1): void {
  if (!state.selectedSegmentId) return;
  const radius = clampNumber(el.newArcRadius.valueAsNumber, 10, 300, 90);
  try {
    const { doc, segmentId } = appendArc(state.doc, state.selectedSegmentId, radius, 90 * direction);
    state.doc = doc;
    state.selectedSegmentId = segmentId;
    state.presetId = null;
    rebuild();
  } catch (err) {
    state.note = String(err);
  }
}

function deleteSelected(): void {
  if (!state.selectedSegmentId) return;
  state.doc = removeSegment(state.doc, state.selectedSegmentId);
  state.selectedSegmentId = null;
  state.presetId = null;
  rebuild();
}

/**
 * 把选中段的端点吸附回节点: 每个端口在其端点附近找最近节点并挪过去;
 * 找不到就新建节点。适合拖动后 "把线接回去"。
 */
function snapSelectedBack(): void {
  if (!state.selectedSegmentId) return;
  const seg = state.doc.segments.find((s) => s.id === state.selectedSegmentId);
  if (!seg) return;
  const doc = cloneDoc(state.doc);
  for (const [port, nodeId] of Object.entries(doc.links)) {
    if (!port.startsWith(`${seg.id}:`)) continue;
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const end = port.endsWith(':A') ? seg.poseAt(0).pos : seg.poseAt(1).pos;
    node.pos = { ...end };
  }
  state.doc = doc;
  state.presetId = null;
  rebuild();
  state.note = '已把该段两端的节点移到端点位置, 请检查转角是否仍被接受。';
}

function clampNumber(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

el.btnStart.addEventListener('click', toggleStart);
el.btnReset.addEventListener('click', resetSim);
el.btnAddLine.addEventListener('click', addLine);
el.btnAddArcLeft.addEventListener('click', () => addArc(-1));
el.btnAddArcRight.addEventListener('click', () => addArc(1));
el.btnDelete.addEventListener('click', deleteSelected);
el.btnSnapback.addEventListener('click', snapSelectedBack);

for (const btn of el.toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
}
el.snap.addEventListener('change', () => {
  state.snap = el.snap.checked;
});

for (const btn of el.arcSide.querySelectorAll<HTMLButtonElement>('button[data-side]')) {
  btn.addEventListener('click', () => {
    state.arcSide = Number(btn.dataset.side) === 1 ? 1 : -1;
    syncToolbar();
  });
}

el.speed.addEventListener('input', () => {
  const v = clampNumber(el.speed.valueAsNumber, 30, 400, 150);
  el.speedOut.textContent = String(v);
  state.vehicle.setSpeed(v);
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    toggleStart();
  } else if (e.key === 'r' || e.key === 'R') {
    resetSim();
  } else if (e.key === 't' || e.key === 'T') {
    const first = [...state.switches.values()].find((s) => s.switchable);
    if (first) {
      const next: BranchChoice = first.choice === 'primary' ? 'alternate' : 'primary';
      flipSwitch(first.nodeId, next);
    }
  } else if (e.key === 'v' || e.key === 'V') {
    setTool('select');
  } else if (e.key === 'l' || e.key === 'L') {
    setTool('line');
  } else if (e.key === 'a' || e.key === 'A') {
    setTool('arc');
  } else if (e.key === 'Escape') {
    setTool('select');
    state.selectedSegmentId = null;
    renderPanel();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// 启动
syncToolbar();
renderPanel();
requestAnimationFrame(frame);

// 暴露给浏览器控制台 / 冒烟测试
declare global {
  interface Window {
    __railSandbox?: {
      state: () => AppState;
      flip: (nodeId: string, choice: BranchChoice) => void;
      loadPreset: (id: string | null) => void;
      setTool: (tool: Tool) => void;
      select: (segmentId: string | null) => void;
      deleteSegment: (segmentId: string) => void;
    };
  }
}
window.__railSandbox = {
  state: () => state,
  flip: (nodeId, choice) => flipSwitch(nodeId, choice),
  loadPreset: (id) => loadPreset(id),
  setTool: (tool) => setTool(tool),
  select: (segmentId) => {
    state.selectedSegmentId = segmentId;
    renderPanel();
  },
  deleteSegment: (segmentId) => {
    state.doc = removeSegment(state.doc, segmentId);
    if (state.selectedSegmentId === segmentId) state.selectedSegmentId = null;
    state.presetId = null;
    rebuild();
  },
};
