/**
 * main.ts —— 应用装配与共享状态。
 * 单一数据源：start/end -> GreatCircle；scrubT/hoverT 是两个视图共享的参数。
 */
import './style.css';
import {
  buildGreatCircle,
  formatKm,
  formatLonLat,
  llToInputs,
  type GreatCircle,
  type LonLat,
} from './geo';
import { LANDMARKS, getLandmark, type Landmark } from './landmarks';
import { GlobeView, type PickMode } from './globeView';
import { FlatMapView, formatRouteTooltip } from './flatMapView';
import { naiveLonLatAccumKm, runSelfTests } from './checks';
import type { ProjectionId } from './projections';

// ---------------- DOM ----------------

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const startLatEl = $<HTMLInputElement>('startLat');
const startLonEl = $<HTMLInputElement>('startLon');
const endLatEl = $<HTMLInputElement>('endLat');
const endLonEl = $<HTMLInputElement>('endLon');
const pickStartBtn = $<HTMLButtonElement>('pickStart');
const pickEndBtn = $<HTMLButtonElement>('pickEnd');
const centerSelect = $<HTMLSelectElement>('centerSelect');
const scrubEl = $<HTMLInputElement>('scrub');
const roCaption = $('roCaption');
const roDistance = $('roDistance');
const roProgress = $('roProgress');
const roCoords = $('roCoords');
const roFromStart = $('roFromStart');
const roRemaining = $('roRemaining');
const roTotal = $('roTotal');
const statusBox = $('statusBox');
const polarNote = $('polarNote');

// ---------------- 状态 ----------------

const SH = LANDMARKS[1].ll; // 上海
const LA = LANDMARKS[3].ll; // 洛杉矶
const BJ = LANDMARKS[0].ll; // 北京
const NY = LANDMARKS[2].ll; // 纽约

const state = {
  start: { ...SH },
  end: { ...LA },
  gc: null as GreatCircle | null,
  scrubT: 0.4,
  hoverT: null as number | null,
  pickMode: null as PickMode,
  projection: 'equirect' as ProjectionId,
  centerId: 'beijing',
};

// ---------------- 视图实例 ----------------

const formatTooltip = (t: number): string =>
  state.gc ? formatRouteTooltip(state.gc, t) : '';

const globe = new GlobeView($('globeStage'), {
  onPickEndpoint: (which, ll) => {
    if (which === 'start') state.start = ll;
    else state.end = ll;
    recompute();
  },
  onScrubStart: (t) => {
    setHover(null);
    setScrub(t);
  },
  onScrubMove: (t) => setScrub(t),
  onScrubEnd: () => {},
  onHover: (t) => setHover(t),
  formatTooltip,
});

const flatMap = new FlatMapView($<HTMLCanvasElement>('flatMap'), {
  onScrubStart: (t) => {
    setHover(null);
    setScrub(t);
  },
  onScrubMove: (t) => setScrub(t),
  onScrubEnd: () => {},
  onHover: (t) => setHover(t),
  formatTooltip,
});

// 中心地标下拉
for (const lm of LANDMARKS) {
  const opt = document.createElement('option');
  opt.value = lm.id;
  opt.textContent = lm.name;
  if (lm.id === state.centerId) opt.selected = true;
  centerSelect.appendChild(opt);
}

// ---------------- 状态 -> 视图 ----------------

function syncInputs(): void {
  const s = llToInputs(state.start);
  const e = llToInputs(state.end);
  if (document.activeElement !== startLatEl) startLatEl.value = s.lat;
  if (document.activeElement !== startLonEl) startLonEl.value = s.lon;
  if (document.activeElement !== endLatEl) endLatEl.value = e.lat;
  if (document.activeElement !== endLonEl) endLonEl.value = e.lon;
}

function recompute(): void {
  state.gc = buildGreatCircle(state.start, state.end);
  // 输入框以 geo 归一化后的经纬度为准
  state.start = state.gc.start;
  state.end = state.gc.end;
  syncInputs();
  globe.setRoute(state.gc);
  flatMap.setRoute(state.gc);
  updateRouteReadout();
  updateStatus();
  updatePolarNote();
  updatePointReadout();
}

function setScrub(t: number): void {
  state.scrubT = Math.max(0, Math.min(1, t));
  globe.setScrubT(state.scrubT);
  flatMap.setScrubT(state.scrubT);
  scrubEl.value = String(Math.round(state.scrubT * 1000));
  updatePointReadout();
}

function setHover(t: number | null): void {
  state.hoverT = t;
  globe.setHoverT(t);
  flatMap.setHoverT(t);
  updatePointReadout();
}

function currentT(): number {
  return state.hoverT ?? state.scrubT;
}

function updateRouteReadout(): void {
  const gc = state.gc;
  if (!gc) return;
  roTotal.textContent = formatKm(gc.totalKm);
}

function updatePointReadout(): void {
  const gc = state.gc;
  if (!gc) return;
  const t = currentT();
  const p = gc.at(t);
  const hovering = state.hoverT !== null;
  roCaption.textContent =
    gc.kind === 'coincident'
      ? '起终点重合'
      : hovering
        ? '两视图悬停点（同源 t）'
        : '位置指示 · 可沿路径拖动';
  roDistance.textContent = formatKm(p.distanceKm);
  roProgress.textContent = `全程的 ${(t * 100).toFixed(1)}%`;
  roCoords.textContent = formatLonLat(p.ll, 3);
  roFromStart.textContent = `${formatKm(p.distanceKm)} km`;
  roRemaining.textContent = `${formatKm(gc.totalKm - p.distanceKm)} km`;
}

function updateStatus(): void {
  const gc = state.gc;
  if (!gc) return;
  const angleDeg = (gc.omega * 180) / Math.PI;
  statusBox.className = 'status show';

  if (gc.kind === 'coincident') {
    statusBox.classList.add('warn');
    statusBox.innerHTML =
      '<strong>起终点重合：</strong>最短距离唯一，为 0 km；但不存在唯一的大圆路线——任意方向的大圆都经过该点。图中以“同”字标记，不绘制弧线。';
  } else if (gc.kind === 'antipodal') {
    statusBox.classList.add('critical');
    statusBox.innerHTML =
      `<strong>两端互为球面正对侧（对跖点，中心角 180°）：</strong>最短距离唯一，为 ${formatKm(gc.totalKm)} km（半周）；` +
      '但连接二者的大圆半弧有无穷多条，<strong>路线不能唯一确定</strong>。当前蓝线是由确定性参考方向选出的其中一条示意。';
  } else if (gc.nearAntipodal) {
    const gap = 180 - angleDeg;
    statusBox.classList.add('warn');
    statusBox.innerHTML =
      `<strong>接近正对侧（距 180° 仅 ${gap.toFixed(2)}°）：</strong>数学上最短弧仍唯一，全程 ${formatKm(gc.totalKm)} km；` +
      '但大圆平面由几乎反向的两个向量张成，方向对经纬度输入误差非常敏感，且存在许多长度接近的替代路径。';
  } else {
    statusBox.classList.add('ok');
    statusBox.innerHTML =
      `<strong>唯一的大圆最短弧</strong> · 中心角 ${angleDeg.toFixed(2)}° · 全程 ${formatKm(gc.totalKm)} km。` +
      '球面与平面绘制的是同一条弧。';
  }
}

function updatePolarNote(): void {
  const gc = state.gc;
  if (!gc || gc.kind === 'coincident') {
    polarNote.textContent = '';
    return;
  }
  const naive = naiveLonLatAccumKm(gc);
  const ratio = naive / gc.totalKm;
  const overPct = (ratio - 1) * 100;
  if (overPct > 8) {
    polarNote.innerHTML =
      `⚠ 极地计量对照：若错误地把经纬度当平面、逐段累加 √(Δlat²+Δlon²)·R，会得到 ` +
      `<span class="bad">${formatKm(naive)} km（多算 ${overPct.toFixed(0)}%）</span>；` +
      `本页距离始终取地心角 × R = <strong>${formatKm(gc.totalKm)} km</strong>，极区横向坐标变化再大也不多算。`;
  } else {
    polarNote.innerHTML =
      `计量自检：平面经纬度硬累加 ${formatKm(naive)} km 与大圆距离 ` +
      `<strong>${formatKm(gc.totalKm)} km</strong> 接近（本航线纬度不高，差异 ${overPct.toFixed(1)}%）。`;
  }
}

// ---------------- 输入框 ----------------

function readInputs(): void {
  const read = (
    latEl: HTMLInputElement,
    lonEl: HTMLInputElement,
    prev: LonLat,
  ): LonLat => {
    const lat = Number.parseFloat(latEl.value);
    const lon = Number.parseFloat(lonEl.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      // 非法输入：还原
      const p = llToInputs(prev);
      latEl.value = p.lat;
      lonEl.value = p.lon;
      return prev;
    }
    return {
      lat: Math.max(-90, Math.min(90, lat)),
      lon: Math.max(-180, Math.min(180, lon)),
    };
  };
  state.start = read(startLatEl, startLonEl, state.start);
  state.end = read(endLatEl, endLonEl, state.end);
  recompute();
}

for (const el of [startLatEl, startLonEl, endLatEl, endLonEl]) {
  el.addEventListener('change', readInputs);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  });
}

// ---------------- 点选模式 ----------------

function setPickMode(mode: PickMode): void {
  state.pickMode = mode;
  globe.setPickMode(mode);
  pickStartBtn.setAttribute('aria-pressed', String(mode === 'start'));
  pickEndBtn.setAttribute('aria-pressed', String(mode === 'end'));
  pickStartBtn.textContent = mode === 'start' ? '点击中…（再点取消）' : '在球上点选';
  pickEndBtn.textContent = mode === 'end' ? '点击中…（再点取消）' : '在球上点选';
}

pickStartBtn.addEventListener('click', () =>
  setPickMode(state.pickMode === 'start' ? null : 'start'),
);
pickEndBtn.addEventListener('click', () =>
  setPickMode(state.pickMode === 'end' ? null : 'end'),
);

// ---------------- 预设 ----------------

const ANTIPODE_BJ: LonLat = { lat: -BJ.lat, lon: -63.5926 };
const NEAR_ANTI: LonLat = { lat: -38.6, lon: -62.4 };

const PRESETS: Record<string, { start: LonLat; end: LonLat }> = {
  antimeridian: { start: { ...SH }, end: { ...LA } },
  polar: { start: { ...BJ }, end: { ...NY } },
  same: { start: { ...BJ }, end: { ...BJ } },
  nearanti: { start: { ...BJ }, end: { ...NEAR_ANTI } },
  antipodal: { start: { ...BJ }, end: { ...ANTIPODE_BJ } },
};

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.preset as keyof typeof PRESETS;
    const preset = PRESETS[key];
    if (!preset) return;
    state.start = { ...preset.start };
    state.end = { ...preset.end };
    setScrub(0.4);
    recompute();
    globe.frameRoute();
  });
});

$('resetView').addEventListener('click', () => globe.frameRoute());

// ---------------- 投影 ----------------

function currentCenter(): Landmark {
  return getLandmark(state.centerId) ?? LANDMARKS[0];
}

function applyProjection(): void {
  flatMap.setProjection(state.projection, currentCenter());
  globe.setCenter(state.projection === 'azimuthal' ? currentCenter().ll : null);
}

document.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.projection = btn.dataset.proj as ProjectionId;
    document.querySelectorAll('[data-proj]').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
    });
    applyProjection();
  });
});

centerSelect.addEventListener('change', () => {
  state.centerId = centerSelect.value;
  applyProjection();
});

// ---------------- slider ----------------

scrubEl.addEventListener('input', () => {
  setHover(null);
  setScrub(Number(scrubEl.value) / 1000);
});

// ---------------- 自检渲染 ----------------

function renderSelfTest(): void {
  const results = runSelfTests();
  const list = $('selfTestList');
  const passed = results.filter((r) => r.pass).length;
  $('selfTestSummary').textContent = `（${passed}/${results.length} 通过）`;
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.pass ? 'st-pass' : 'st-fail';
    const name = document.createElement('span');
    name.className = 'st-name';
    name.textContent = r.name;
    const detail = document.createElement('span');
    detail.className = 'st-detail';
    detail.textContent = r.detail;
    li.append(name, detail);
    list.appendChild(li);
  }
}

// ---------------- 启动 ----------------

centerSelect.value = state.centerId;
applyProjection();
recompute();
setScrub(0.4);
renderSelfTest();
// 等首帧布局完成后把默认航线完整框入视野
requestAnimationFrame(() => globe.frameRoute());
