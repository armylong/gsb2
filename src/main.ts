/**
 * App controller: state, canvas interaction, side panels, export.
 *
 * World coordinates are millimetres (y down), matching the exported SVG. The
 * canvas is the only place that converts to screen pixels, via `ViewTransform`.
 */

import { pickBoundary, type BoundaryPick } from './boundary';
import { colorForPiece, colorForPieceAlpha, type Theme } from './colors';
import { DEMOS, cloneDemo, demoById, type Demo } from './demos';
import { buildSliceZip, downloadBlob, exportColorSvg } from './export';
import { computeLayout, queryPoint, TIE_BAND_MM, totalAreaCheck } from './layout';
import { render, toWorld, type ViewTransform } from './render';
import { pointInRing, pt } from './geometry';
import type { FrameSpec, Layout, LayoutEdge, PointSpec, Pt, QueryResult } from './types';

const MAX_POINTS = 20;
const WEIGHT_MIN = -8000;
const WEIGHT_MAX = 20000;

interface Snapshot {
  label: string;
  layout: Layout;
}

interface AppState {
  demo: Demo;
  frame: FrameSpec;
  points: PointSpec[];
  layout: Layout;
  baseline: Snapshot | null;
  selectedId: number | null;
  hoverId: number | null;
  hoverWorld: Pt | null;
  hoverQuery: QueryResult | null;
  hoverEdge: LayoutEdge | null;
  picked: BoundaryPick | null;
  previewOn: boolean;
  previewDelta: number;
  theme: Theme;
  showLabels: boolean;
  showSeams: boolean;
  showPoints: boolean;
  showGrid: boolean;
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};

const canvas = $<HTMLCanvasElement>('#stage');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D unavailable');

const state: AppState = {
  demo: DEMOS[0]!,
  frame: DEMOS[0]!.frame,
  points: DEMOS[0]!.points,
  layout: computeLayout(DEMOS[0]!.frame, DEMOS[0]!.points),
  baseline: null,
  selectedId: null,
  hoverId: null,
  hoverWorld: null,
  hoverQuery: null,
  hoverEdge: null,
  picked: null,
  previewOn: false,
  previewDelta: 1000,
  theme: 'dark',
  showLabels: true,
  showSeams: true,
  showPoints: true,
  showGrid: false,
};

let view: ViewTransform | null = null;
let dragging: { id: number; pointerId: number; moved: boolean } | null = null;
let rafPending = false;

function recompute(): void {
  state.layout = computeLayout(state.frame, state.points);
  // Keep the selection valid if the layout changed but the point list did not.
  if (state.selectedId !== null && !state.points.some((p) => p.id === state.selectedId)) {
    state.selectedId = null;
  }
  if (state.baseline && state.baseline.layout.points.length !== state.points.length) {
    // Point count changed: the baseline is no longer comparable.
    state.baseline = null;
  }
  // Re-resolve a picked boundary against the new layout so the highlight and the
  // two-side readout never describe a seam that has already moved away.
  if (state.picked) {
    const prev = state.picked;
    state.picked = pickBoundary(
      state.layout,
      prev.point.x,
      prev.point.y,
      8 / (view?.scale ?? 1),
    );
  }
  scheduleRender();
  schedulePanels();
}

async function scheduleRender(): Promise<void> {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    draw();
  });
}

function previewLayout(): Layout | null {
  if (!state.previewOn || state.selectedId === null) return null;
  const site = state.points.find((p) => p.id === state.selectedId);
  if (!site) return null;
  const pts = state.points.map((p) =>
    p.id === site.id ? { ...p, weight: p.weight + state.previewDelta } : { ...p },
  );
  return computeLayout(state.frame, pts);
}

function draw(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(rect.width, 1);
  const cssH = Math.max(rect.height, 1);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const preview = previewLayout();
  const metrics = render(
    ctx!,
    {
      layout: state.layout,
      baseline: state.baseline?.layout ?? null,
      theme: state.theme,
      selectedId: state.selectedId,
      showLabels: state.showLabels,
      showSeams: state.showSeams,
      showPoints: state.showPoints,
      showGrid: state.showGrid,
      overlay: state.baseline !== null,
      preview,
      previewDelta: state.previewDelta,
      hoverWorld: state.hoverWorld,
      hoverQueryId: state.hoverQuery?.id ?? null,
      hoverTie: state.hoverQuery?.tie ?? false,
      hoverBoundary: state.hoverEdge,
      pickedBoundary: state.picked,
      cursorScreen: cursorScreen,
    },
    cssW,
    cssH,
    dpr,
    view,
  );
  view = metrics.view;
}

// ----------------------------------------------------------------------------
// Coordinate helpers

let cursorScreen: Pt | null = null;

function screenFromEvent(e: PointerEvent | MouseEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function worldFromScreen(p: Pt): Pt | null {
  return view ? toWorld(p, view) : null;
}

function findPointNear(world: Pt): PointSpec | null {
  if (!view) return null;
  const radiusMm = 11 / view.scale;
  let best: PointSpec | null = null;
  let bestD = radiusMm;
  for (const p of state.points) {
    const d = Math.hypot(p.x - world.x, p.y - world.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function pickEdge(world: Pt): LayoutEdge | null {
  if (!view) return null;
  const maxMm = 7 / view.scale;
  let best: LayoutEdge | null = null;
  let bestD = maxMm;
  for (const e of state.layout.edges) {
    const d = segDist(world, e.a, e.b);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// ----------------------------------------------------------------------------
// Pointer interaction

canvas.addEventListener('pointerdown', (e) => {
  const s = screenFromEvent(e);
  const w = worldFromScreen(s);
  if (!w) return;
  const hit = findPointNear(w);
  if (hit) {
    state.selectedId = hit.id;
    dragging = { id: hit.id, pointerId: e.pointerId, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    schedulePanels();
    scheduleRender();
    return;
  }
  // Boundary pick: click near any seam/frame edge.
  const edge = pickEdge(w);
  if (edge) {
    const pick = pickBoundary(state.layout, w.x, w.y, 7 / (view?.scale ?? 1));
    if (pick) {
      state.picked = pick;
      schedulePanels();
      scheduleRender();
      return;
    }
  }
  state.selectedId = null;
  state.picked = null;
  schedulePanels();
  scheduleRender();
});

canvas.addEventListener('pointermove', (e) => {
  const s = screenFromEvent(e);
  cursorScreen = s;
  const w = worldFromScreen(s);
  if (!w) return;
  state.hoverWorld = w;
  state.hoverQuery = queryPoint(state.layout, w.x, w.y, TIE_BAND_MM);

  if (dragging) {
    const p = state.points.find((q) => q.id === dragging!.id);
    if (p) {
      // Snap to 0.5 mm for stable numbers while dragging; hold Shift for free.
      const snap = e.shiftKey ? 1 : 2;
      p.x = Math.round(w.x * snap) / snap;
      p.y = Math.round(w.y * snap) / snap;
      dragging.moved = true;
      recompute();
    }
    return;
  }

  const hit = findPointNear(w);
  const edge = hit ? null : pickEdge(w);
  state.hoverEdge = edge;
  state.hoverId = hit?.id ?? null;
  canvas.style.cursor = hit ? 'grab' : edge ? 'pointer' : 'crosshair';
  scheduleRender();
});

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  const wasPointDrag = dragging.moved;
  dragging = null;
  canvas.style.cursor = 'grab';
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (wasPointDrag) recompute();
  schedulePanels();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('pointerleave', () => {
  cursorScreen = null;
  state.hoverWorld = null;
  state.hoverQuery = null;
  state.hoverEdge = null;
  scheduleRender();
});

canvas.addEventListener('dblclick', (e) => {
  const s = screenFromEvent(e);
  const w = worldFromScreen(s);
  if (!w) return;
  if (findPointNear(w)) {
    // Double-clicking a handle is a drag gesture, not a request for a new point.
    return;
  }
  if (!pointInRing(w, state.frame.ring)) {
    toast('双击位置在外框外，不能加点。');
    return;
  }
  if (state.points.length >= MAX_POINTS) {
    toast(`最多 ${MAX_POINTS} 个点。`);
    return;
  }
  const id = nextPointId();
  state.points.push({ id, x: roundHalf(w.x), y: roundHalf(w.y), weight: 0 });
  state.selectedId = id;
  recompute();
  toast(`已加 #${id}。`);
});

function roundHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

function nextPointId(): number {
  let id = 1;
  const used = new Set(state.points.map((p) => p.id));
  while (used.has(id)) id++;
  return id;
}

// ----------------------------------------------------------------------------
// Keyboard nudges

window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  if (dragging && state.selectedId !== null) {
    const p = state.points.find((q) => q.id === state.selectedId);
    if (!p) return;
    const step = e.shiftKey ? 100 : 50;
    if (e.key === '[' || e.key === 'ArrowLeft' && e.altKey) {
      p.weight -= step;
      recompute();
    } else if (e.key === ']' || e.key === 'ArrowRight' && e.altKey) {
      p.weight += step;
      recompute();
    }
    return;
  }
  if (e.key === 'Escape') {
    state.selectedId = null;
    state.picked = null;
    schedulePanels();
    scheduleRender();
    return;
  }
  if (state.selectedId !== null) {
    const p = state.points.find((q) => q.id === state.selectedId);
    if (!p) return;
    const step = e.shiftKey ? 0.5 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else if (e.key === '[') p.weight -= e.shiftKey ? 100 : 50;
    else if (e.key === ']') p.weight += e.shiftKey ? 100 : 50;
    else return;
    if (dx || dy) {
      p.x = roundHalf(p.x + dx);
      p.y = roundHalf(p.y + dy);
    }
    e.preventDefault();
    recompute();
  }
});

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

// ----------------------------------------------------------------------------
// Panels

let panelPending = false;
function schedulePanels(): void {
  if (panelPending) return;
  panelPending = true;
  requestAnimationFrame(() => {
    panelPending = false;
    updatePanels();
  });
}

function updatePanels(): void {
  updateDemoPanel();
  updatePointsPanel();
  updateWeightPanel();
  updateBoundaryPanel();
  updateDiagnosticsPanel();
  updateAreasPanel();
  updateAreaChip();
  updateToolbarState();
  $<HTMLElement>('#empty-state').hidden = state.points.length > 0;
}

function updateDemoPanel(): void {
  const demo = state.demo;
  $<HTMLElement>('#demo-name').textContent = demo.name;
  $<HTMLElement>('#demo-tagline').textContent = demo.tagline;
  $<HTMLElement>('#demo-badge').textContent = `${state.points.length} 点 · ${state.layout.stats.partCount} 片`;
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.demo-tab')) {
    tab.setAttribute('aria-selected', tab.dataset.demo === demo.id ? 'true' : 'false');
  }
  $<HTMLButtonElement>('#btn-feature-point').disabled = !state.points.some(
    (p) => p.id === demo.featuredId,
  );
  const note = $<HTMLElement>('#demo-note');
  const check = totalAreaCheck(state.layout);
  note.textContent = `外框 ${check.frame.toFixed(2)} mm² · 全部编号合计 ${check.total.toFixed(2)} mm² · ${
    check.matches ? '逐块核对一致' : '差 ' + check.diff.toFixed(4)
  }。`;
}

function updatePointsPanel(): void {
  const strip = $<HTMLElement>('#points-strip');
  strip.innerHTML = '';
  for (const p of state.points) {
    const piece = state.layout.pieces.find((pc) => pc.id === p.id);
    const btn = document.createElement('button');
    btn.className = 'point-chip';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', state.selectedId === p.id ? 'true' : 'false');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorForPiece(p.id, state.theme);
    const id = document.createElement('span');
    id.textContent = `#${p.id}`;
    const wt = document.createElement('span');
    wt.className = 'wt';
    wt.textContent = `${Math.round(p.weight)}`;
    btn.append(dot, id, wt);
    if (!piece || piece.parts === 0) {
      const dead = document.createElement('span');
      dead.className = 'dead';
      dead.textContent = '空';
      btn.append(dead);
    }
    btn.addEventListener('click', () => {
      state.selectedId = p.id;
      schedulePanels();
      scheduleRender();
    });
    strip.append(btn);
  }
  $<HTMLElement>('#point-count').textContent = `${state.points.length} / ${MAX_POINTS}`;
  $<HTMLButtonElement>('#btn-add-point').disabled = state.points.length >= MAX_POINTS;
  $<HTMLButtonElement>('#btn-del-point').disabled = state.selectedId === null;
  $<HTMLElement>('#point-badge').textContent =
    state.selectedId !== null ? `#${state.selectedId}` : '未选择';
}

function updateWeightPanel(): void {
  const sel = state.points.find((p) => p.id === state.selectedId);
  const slider = $<HTMLInputElement>('#weight-slider');
  const num = $<HTMLInputElement>('#weight-number');
  const val = $<HTMLElement>('#weight-value');
  const note = $<HTMLElement>('#point-empty-note');
  const previewCb = $<HTMLInputElement>('#t-preview');
  previewCb.checked = state.previewOn;
  $<HTMLInputElement>('#preview-delta').value = String(state.previewDelta);
  if (!sel) {
    val.textContent = '—';
    slider.disabled = true;
    num.disabled = true;
    note.hidden = true;
    return;
  }
  slider.disabled = false;
  num.disabled = false;
  val.textContent = `${Math.round(sel.weight)} mm²`;
  slider.min = String(Math.min(WEIGHT_MIN, sel.weight - 1000));
  slider.max = String(Math.max(WEIGHT_MAX, sel.weight + 1000));
  slider.value = String(sel.weight);
  num.value = String(Math.round(sel.weight));
  const piece = state.layout.pieces.find((p) => p.id === sel.id);
  if (!piece || piece.parts === 0) {
    note.hidden = false;
    const diag = state.layout.diagnostics.find(
      (d) => d.code === 'empty-territory' && d.pointIds.includes(sel.id),
    );
    note.textContent = diag
      ? `当前 #${sel.id} 没有地盘：${diag.message.replace(/^点 #\d+ /, '')}。${diag.detail}`
      : `当前 #${sel.id} 没有地盘。提高分量或移开邻点。`;
  } else {
    note.hidden = true;
  }
}

function updateBoundaryPanel(): void {
  const body = $<HTMLElement>('#boundary-body');
  const badge = $<HTMLElement>('#boundary-badge');
  const lead = $<HTMLElement>('#boundary-lead');
  const pick = state.picked;
  if (!pick) {
    body.hidden = true;
    badge.textContent = '未点选';
    badge.className = 'badge';
    lead.hidden = false;
    return;
  }
  lead.hidden = true;
  body.hidden = false;
  const kind = pick.edge.kind;
  badge.textContent = pick.kindLabel;
  badge.className = 'badge ' + (kind === 'shared' ? '' : 'warn');

  const e = pick.edge;
  const site = state.layout.points.find((p) => p.id === e.pieceId);
  const other = e.otherId !== null ? state.layout.points.find((p) => p.id === e.otherId) : null;

  const sideCell = (label: string, id: number | null, extra: string) => `
    <div class="side-cell">
      <span class="side-cell-label">${label}</span>
      <span class="side-cell-value">${
        id === null
          ? '<span class="dot" style="background:var(--ink-3)"></span>外框外'
          : `<span class="dot" style="background:${colorForPiece(id, state.theme)}"></span>#${id} ${extra}`
      }</span>
    </div>`;

  const d = site && other ? Math.hypot(other.x - site.x, other.y - site.y) : 0;
  const seamBlock =
    pick.edge.kind === 'shared' && site && other
      ? `<dl class="seam-grid">
          <dt>点距</dt><dd>${d.toFixed(1)} mm</dd>
          <dt>分量差</dt><dd>${Math.round(site.weight - other.weight)} mm²</dd>
          <dt>接缝偏移</dt><dd>${Math.abs((site.weight - other.weight) / (2 * (d || 1))).toFixed(2)} mm 向 #${
            site.weight >= other.weight ? other.id : site.id
          }</dd>
          <dt>每 +1000</dt><dd>走 ${(1000 / (2 * (d || 1))).toFixed(2)} mm</dd>
        </dl>`
      : '';

  body.innerHTML = `
    <div class="boundary-kinds">
      <span class="kind-pill ${kind}"><span class="kind-swatch ${kind === 'shared' ? 'dashed' : ''}"></span>${pick.kindLabel}</span>
      <span class="kind-pill">长 ${e.length.toFixed(1)} mm</span>
    </div>
    <div class="sides">
      ${sideCell('一侧 (A)', pick.ownerA, '')}
      ${sideCell('另一侧 (B)', pick.ownerB, '')}
    </div>
    ${seamBlock}
    <p class="explain">${escapeHtml(pick.explanation)}</p>
  `;
}

function updateDiagnosticsPanel(): void {
  const list = $<HTMLElement>('#diag-list');
  const badge = $<HTMLElement>('#diag-badge');
  const diags = state.layout.diagnostics;
  badge.textContent = diags.length === 0 ? '无' : String(diags.length);
  badge.className = 'badge ' + (diags.some((d) => d.severity === 'error') ? 'bad' : diags.length ? 'warn' : 'good');
  if (diags.length === 0) {
    list.innerHTML = `<p class="diag-empty">没有发现过近的点、空编号或面积不符。</p>`;
    return;
  }
  list.innerHTML = '';
  for (const d of diags) {
    const item = document.createElement('div');
    item.className = `diag-item ${d.severity}`;
    const icon = d.severity === 'error' ? '!' : d.severity === 'warning' ? '!' : 'i';
    item.innerHTML = `
      <div class="diag-title"><span class="diag-icon">${icon}</span><span>${escapeHtml(d.message)}</span></div>
      <p class="diag-detail">${escapeHtml(d.detail)}</p>
    `;
    if (d.pointIds.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'diag-actions';
      for (const pid of d.pointIds) {
        const b = document.createElement('button');
        b.className = 'btn btn-small btn-ghost';
        b.textContent = `定位 #${pid}`;
        b.addEventListener('click', () => {
          state.selectedId = pid;
          const p = state.points.find((q) => q.id === pid);
          if (p) {
            state.hoverWorld = pt(p.x, p.y);
            state.hoverQuery = queryPoint(state.layout, p.x, p.y, TIE_BAND_MM);
          }
          schedulePanels();
          scheduleRender();
        });
        actions.append(b);
      }
      item.append(actions);
    }
    list.append(item);
  }
}

function updateAreasPanel(): void {
  const list = $<HTMLElement>('#areas-list');
  const lead = $<HTMLElement>('#areas-lead');
  const total = $<HTMLElement>('#areas-total');
  const base = state.baseline;
  const baseAreas = new Map<number, number>();
  if (base) for (const p of base.layout.pieces) baseAreas.set(p.id, p.area);
  const maxArea = Math.max(
    1,
    ...state.layout.pieces.map((p) => Math.max(p.area, baseAreas.get(p.id) ?? 0)),
  );

  lead.textContent = base
    ? `基准：${base.label}。虚线是基准面积，数字右侧是当前相对基准的增减。`
    : '拖动分量时这里是实时值；点「叠图对比」锁定基准后看每块玻璃的面积增减。';
  $<HTMLButtonElement>('#btn-baseline-clear').disabled = !base;
  $<HTMLButtonElement>('#btn-baseline-update').disabled = !base;

  list.innerHTML = '';
  for (const piece of state.layout.pieces) {
    const row = document.createElement('div');
    row.className = 'area-row' + (piece.parts === 0 ? ' is-empty' : '');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorForPiece(piece.id, state.theme);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${(piece.area / maxArea) * 100}%`;
    fill.style.background = colorForAlpha(piece.id, state.theme);
    track.append(fill);
    if (base) {
      const b = baseAreas.get(piece.id);
      if (b !== undefined) {
        const ghost = document.createElement('div');
        ghost.className = 'bar-ghost';
        ghost.style.left = `${Math.min(100, (b / maxArea) * 100)}%`;
        ghost.title = `基准面积 ${b.toFixed(1)} mm²`;
        track.append(ghost);
      }
    }
    const num = document.createElement('span');
    num.className = 'num';
    if (piece.parts === 0) {
      num.textContent = '空 · 0';
    } else {
      const value = piece.area.toFixed(1);
      let html = `${value}`;
      if (base) {
        const b = baseAreas.get(piece.id);
        if (b !== undefined) {
          const d = piece.area - b;
          if (Math.abs(d) >= 0.5) {
            html += `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d.toFixed(1)}</span>`;
          }
        }
      }
      num.innerHTML = html;
    }
    row.append(swatch, track, num);
    list.append(row);
  }

  const check = totalAreaCheck(state.layout);
  const badge = $<HTMLElement>('#areas-badge');
  badge.textContent = check.matches ? '面积相符' : '有残差';
  badge.className = 'badge ' + (check.matches ? 'good' : 'bad');
  total.innerHTML = `
    <span>外框 <strong>${check.frame.toFixed(2)}</strong> mm²</span>
    <span>分件合计 <strong>${check.total.toFixed(2)}</strong> mm²</span>
    <span class="${check.matches ? 'ok' : 'bad'}">${check.matches ? '✓ 相符' : 'Δ ' + check.diff.toFixed(4)}</span>
  `;
}

function colorForAlpha(id: number, theme: Theme): string {
  return colorForPieceAlpha(id, 0.85, theme);
}

function updateAreaChip(): void {
  const chip = $<HTMLElement>('#area-chip');
  const value = $<HTMLElement>('#area-chip-value');
  const detail = $<HTMLElement>('#area-chip-detail');
  const check = totalAreaCheck(state.layout);
  value.textContent = `${check.total.toFixed(2)} / ${check.frame.toFixed(2)} mm²`;
  detail.textContent = check.matches ? '相符' : `差 ${check.diff.toFixed(3)}`;
  chip.classList.toggle('is-good', check.matches);
  chip.classList.toggle('is-bad', !check.matches);
}

function updateToolbarState(): void {
  $<HTMLInputElement>('#t-labels').checked = state.showLabels;
  $<HTMLInputElement>('#t-seams').checked = state.showSeams;
  $<HTMLInputElement>('#t-points').checked = state.showPoints;
  $<HTMLInputElement>('#t-grid').checked = state.showGrid;
  const hint = $<HTMLElement>('#cursor-hint');
  if (state.previewOn && state.selectedId !== null) {
    hint.textContent = `预演：#${state.selectedId} +${state.previewDelta} mm² · 橙色虚线为预测接缝`;
  } else {
    hint.textContent = '拖动点 · 点接缝看两侧 · 双击空白加点';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----------------------------------------------------------------------------
// Weights and points

function setWeight(id: number, w: number, silent = false): void {
  const p = state.points.find((q) => q.id === id);
  if (!p) return;
  p.weight = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round(w)));
  recompute();
  if (!silent) setFooter(`#${id} 分量 ${p.weight} mm²`);
}

function addPointAtCenter(): void {
  if (state.points.length >= MAX_POINTS) {
    toast(`最多 ${MAX_POINTS} 个点。`);
    return;
  }
  const b = state.layout.bbox;
  let x = (b.minX + b.maxX) / 2;
  let y = (b.minY + b.maxY) / 2;
  // Nudge into the frame if the centre lands in the notch or outside.
  if (!pointInRing(pt(x, y), state.frame.ring)) {
    const w = state.frame.width;
    const h = state.frame.height;
    for (let k = 1; k < 20 && !pointInRing(pt(x, y), state.frame.ring); k++) {
      x = b.minX + ((b.maxX - b.minX) * (k + 1)) / 22;
      y = b.minY + ((b.maxY - b.minY) * (k + 1)) / 22;
      void w;
      void h;
    }
  }
  const id = nextPointId();
  state.points.push({ id, x: roundHalf(x), y: roundHalf(y), weight: 0 });
  state.selectedId = id;
  recompute();
}

function deleteSelected(): void {
  if (state.selectedId === null) return;
  state.points = state.points.filter((p) => p.id !== state.selectedId);
  state.selectedId = null;
  state.picked = null;
  recompute();
}

function loadDemo(demo: Demo, keepBaseline = false): void {
  const copy = cloneDemo(demo);
  state.demo = demo;
  state.frame = copy.frame;
  state.points = copy.points;
  state.selectedId = null;
  state.picked = null;
  state.baseline = keepBaseline ? state.baseline : null;
  if (state.baseline && !keepBaseline) state.baseline = null;
  view = null; // reframe on the new window size
  recompute();
  setFooter(`已载入「${demo.name}」`);
}

// ----------------------------------------------------------------------------
// Wiring

function wireUi(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.demo-tab')) {
    tab.addEventListener('click', () => {
      const id = tab.dataset.demo as Demo['id'] | undefined;
      if (!id) return;
      loadDemo(demoById(id));
    });
  }

  $<HTMLButtonElement>('#btn-reset').addEventListener('click', () => loadDemo(state.demo));
  $<HTMLButtonElement>('#btn-feature-point').addEventListener('click', () => {
    const site = state.points.find((p) => p.id === state.demo.featuredId);
    if (!site) return;
    state.selectedId = site.id;
    setWeight(site.id, site.weight + 1500);
    toast(`#${site.id} 分量 +1500 mm²，看接缝往邻点一侧移动。`);
  });

  $<HTMLButtonElement>('#btn-add-point').addEventListener('click', addPointAtCenter);
  $<HTMLButtonElement>('#btn-del-point').addEventListener('click', deleteSelected);

  const slider = $<HTMLInputElement>('#weight-slider');
  slider.addEventListener('input', () => {
    if (state.selectedId === null) return;
    setWeight(state.selectedId, Number(slider.value), true);
  });
  slider.addEventListener('change', () => {
    if (state.selectedId !== null) {
      const p = state.points.find((q) => q.id === state.selectedId);
      if (p) setFooter(`#${p.id} 分量 ${p.weight} mm²`);
    }
  });
  const num = $<HTMLInputElement>('#weight-number');
  num.addEventListener('change', () => {
    if (state.selectedId === null) return;
    const v = Number(num.value);
    if (Number.isFinite(v)) setWeight(state.selectedId, v);
  });
  $<HTMLButtonElement>('#btn-weight-zero').addEventListener('click', () => {
    if (state.selectedId !== null) setWeight(state.selectedId, 0);
  });

  $<HTMLInputElement>('#t-preview').addEventListener('change', (e) => {
    state.previewOn = (e.target as HTMLInputElement).checked;
    scheduleRender();
    schedulePanels();
  });
  $<HTMLInputElement>('#preview-delta').addEventListener('change', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    state.previewDelta = Number.isFinite(v) ? v : 1000;
    scheduleRender();
    schedulePanels();
  });

  $<HTMLInputElement>('#t-labels').addEventListener('change', (e) => {
    state.showLabels = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });
  $<HTMLInputElement>('#t-seams').addEventListener('change', (e) => {
    state.showSeams = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });
  $<HTMLInputElement>('#t-points').addEventListener('change', (e) => {
    state.showPoints = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });
  $<HTMLInputElement>('#t-grid').addEventListener('change', (e) => {
    state.showGrid = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });

  $<HTMLButtonElement>('#btn-baseline').addEventListener('click', () => {
    state.baseline = {
      label: `${state.demo.name} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      layout: state.layout,
    };
    scheduleRender();
    schedulePanels();
    toast('已锁定当前为叠图基准。现在调分量就能看到面积增减。');
  });
  $<HTMLButtonElement>('#btn-baseline-update').addEventListener('click', () => {
    if (!state.baseline) return;
    state.baseline = { label: '更新于 ' + shortTime(), layout: state.layout };
    scheduleRender();
    schedulePanels();
  });
  $<HTMLButtonElement>('#btn-baseline-clear').addEventListener('click', () => {
    state.baseline = null;
    scheduleRender();
    schedulePanels();
  });

  $<HTMLButtonElement>('#btn-theme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    recompute();
  });

  const doColor = () => {
    downloadBlob(
      `window-color-${state.demo.id}.svg`,
      exportColorSvg(state.layout, {
        theme: state.theme,
        labels: $<HTMLInputElement>('#t-export-labels').checked,
        seams: $<HTMLInputElement>('#t-export-seams').checked,
        paper: false,
      }),
      'image/svg+xml',
    );
    toast('已导出彩色 SVG（坐标：mm，原点在外框左上角）。');
  };
  const doSlices = () => {
    const zip = buildSliceZip(state.layout, {
      theme: state.theme,
      labels: $<HTMLInputElement>('#t-export-labels').checked,
      seams: $<HTMLInputElement>('#t-export-seams').checked,
      paper: false,
    });
    downloadBlob(`window-slices-${state.demo.id}.zip`, zip, 'application/zip');
    toast('已导出切片 ZIP：彩色图 + 每编号切片 + manifest.json。');
  };
  $<HTMLButtonElement>('#btn-export-svg').addEventListener('click', doColor);
  $<HTMLButtonElement>('#btn-export-slices').addEventListener('click', doSlices);
  $<HTMLButtonElement>('#btn-export-svg-2').addEventListener('click', doColor);
  $<HTMLButtonElement>('#btn-export-slices-2').addEventListener('click', doSlices);

  window.addEventListener('resize', () => {
    view = null;
    scheduleRender();
  });
}

function setFooter(text: string): void {
  $<HTMLElement>('#footer-status').textContent = text;
}

function shortTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

let toastTimer = 0;
function toast(message: string): void {
  const el = $<HTMLElement>('#toast');
  el.textContent = message;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

// ----------------------------------------------------------------------------
// Boot

function boot(): void {
  document.documentElement.dataset.theme = state.theme;
  wireUi();
  // Warm the caches once; requestAnimationFrame drives the first paint.
  updatePanels();
  scheduleRender();
  setFooter('准备就绪');
  // Expose a tiny debug surface for the screenshot/test harness.
  (window as unknown as { __glass?: unknown }).__glass = {
    state,
    get view() {
      return view;
    },
    computeLayout,
    queryPoint,
    setPoints(frame: FrameSpec, points: PointSpec[]): void {
      state.frame = frame;
      state.points = points;
      state.selectedId = null;
      state.picked = null;
      state.baseline = null;
      view = null;
      recompute();
    },
  };
}

boot();
