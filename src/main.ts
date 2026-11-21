import { generateScenario, type Scenario } from './core/scenario.ts';
import {
  recordRun,
  Simulation,
  VIEWPORT_H,
  VIEWPORT_W,
} from './core/simulation.ts';
import type { CameraConfig, Snapshot } from './core/types.ts';
import { renderLive, type Trail } from './render/renderer.ts';
import { renderReplay, type ReplayRun } from './render/replay.ts';

// ---------- 默认参数 ----------
const REPLAY_FPS_OPTIONS = [15, 30, 60];

function defaultConfig(): CameraConfig {
  return {
    safeMargin: { x: 0.12, y: 0.12 },
    minZoom: 0.35,
    // 收紧到样例最大需求(约 2.07)之下, 让 A/B 拉开阶段真实触发 MAX_ZOOM
    maxZoom: 1.8,
    panBounds: { x: 0, y: 0, w: 1800, h: 1100 },
    smoothing: 0.25,
    smoothingMode: 'per-tick',
  };
}

// ---------- 应用状态 ----------
const scenario: Scenario = generateScenario(14416);
let config: CameraConfig = defaultConfig();
let liveFps = 30;
let mode: 'live' | 'replay' = 'live';
let playing = false;
let sim: Simulation = new Simulation(scenario, config, liveFps);
let recordings = new Map<number, Snapshot[]>();
let runVisibility: Record<number, boolean> = { 15: true, 30: true, 60: true };
let replayT = 0;
let replayPlaying = false;

const trails = new Map<string, Trail>();
for (const a of scenario.actors) {
  trails.set(a.id, { actorId: a.id, points: [] });
}
const MAX_TRAIL = 240;
let dragId: string | null = null;
let lastFrameMs = 0;
let liveAccumulator = 0;
let replayAccumulator = 0;

// ---------- DOM ----------
const canvas = document.getElementById('stage') as HTMLCanvasElement;
canvas.width = VIEWPORT_W;
canvas.height = VIEWPORT_H;
const ctx = canvas.getContext('2d')!;

const $ = (id: string) => document.getElementById(id)!;

interface SliderSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format?: (v: number) => string;
  onChange?: () => void;
}

function buildSlider(spec: SliderSpec): void {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  wrap.innerHTML = `
    <label>${spec.label}<span class="val" id="${spec.id}-val"></span></label>
    <input type="range" id="${spec.id}" min="${spec.min}" max="${spec.max}" step="${spec.step}">
  `;
  const input = wrap.querySelector('input') as HTMLInputElement;
  const val = wrap.querySelector('.val') as HTMLSpanElement;
  input.value = String(spec.get());
  const show = () => {
    const v = spec.get();
    val.textContent = spec.format ? spec.format(v) : v.toFixed(2);
  };
  show();
  input.addEventListener('input', () => {
    spec.set(parseFloat(input.value));
    show();
    spec.onChange?.();
  });
  $('controls').appendChild(wrap);
}

// ---------- 控件 ----------
buildSlider({
  id: 'marginX',
  label: '安全区 水平边距',
  min: 0,
  max: 0.4,
  step: 0.01,
  get: () => config.safeMargin.x,
  set: (v) => (config.safeMargin.x = v),
  format: (v) => `${(v * 100).toFixed(0)}%`,
  onChange: rebuildRecordings,
});
buildSlider({
  id: 'marginY',
  label: '安全区 垂直边距',
  min: 0,
  max: 0.4,
  step: 0.01,
  get: () => config.safeMargin.y,
  set: (v) => (config.safeMargin.y = v),
  format: (v) => `${(v * 100).toFixed(0)}%`,
  onChange: rebuildRecordings,
});
buildSlider({
  id: 'minZoom',
  label: '最小 zoom (最大放大)',
  min: 0.1,
  max: 1,
  step: 0.01,
  get: () => config.minZoom,
  set: (v) => (config.minZoom = v),
  onChange: rebuildRecordings,
});
buildSlider({
  id: 'maxZoom',
  label: '最大 zoom (最大缩小)',
  min: 1,
  max: 4,
  step: 0.05,
  get: () => config.maxZoom,
  set: (v) => (config.maxZoom = v),
  onChange: rebuildRecordings,
});
buildSlider({
  id: 'panW',
  label: '水平活动范围 宽',
  min: 600,
  max: 1800,
  step: 20,
  get: () => config.panBounds.w,
  set: (v) => (config.panBounds.w = v),
  format: (v) => `${v.toFixed(0)} 单位`,
  onChange: () => {
    config.panBounds.x = (1800 - config.panBounds.w) / 2;
    rebuildRecordings();
  },
});
buildSlider({
  id: 'panH',
  label: '垂直活动范围 高',
  min: 400,
  max: 1100,
  step: 20,
  get: () => config.panBounds.h,
  set: (v) => (config.panBounds.h = v),
  format: (v) => `${v.toFixed(0)} 单位`,
  onChange: () => {
    config.panBounds.y = (1100 - config.panBounds.h) / 2;
    rebuildRecordings();
  },
});
buildSlider({
  id: 'smoothing',
  label: '平滑系数 (1=硬切)',
  min: 0.02,
  max: 1,
  step: 0.01,
  get: () => config.smoothing,
  set: (v) => (config.smoothing = v),
  onChange: rebuildRecordings,
});

// 平滑模式
const modeSel = $('smoothingMode') as HTMLSelectElement;
modeSel.addEventListener('change', () => {
  config.smoothingMode = modeSel.value as CameraConfig['smoothingMode'];
  rebuildRecordings();
});

// 帧率
const fpsSel = $('fps') as HTMLSelectElement;
fpsSel.addEventListener('change', () => {
  liveFps = parseInt(fpsSel.value, 10);
  resetLive();
});

// 跟随名单
function buildRoster(): void {
  const box = $('roster');
  box.innerHTML = '';
  for (const a of scenario.actors) {
    const label = document.createElement('label');
    label.className = 'roster';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = sim.followIds.has(a.id);
    cb.addEventListener('change', () => {
      sim.toggleFollow(a.id);
      rebuildRecordings();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${a.name}`));
    box.appendChild(label);
  }
}
buildRoster();

// 回放帧率可见性
function buildReplayToggles(): void {
  const box = $('replayToggles');
  box.innerHTML = '';
  for (const fps of REPLAY_FPS_OPTIONS) {
    const label = document.createElement('label');
    label.className = 'roster';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = runVisibility[fps];
    cb.addEventListener('change', () => (runVisibility[fps] = cb.checked));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${fps} fps 镜头边框`));
    box.appendChild(label);
  }
}
buildReplayToggles();

// ---------- 录制 / 重置 ----------
function rebuildRecordings(): void {
  recordings.clear();
  for (const fps of REPLAY_FPS_OPTIONS) {
    recordings.set(
      fps,
      recordRun(scenario, config, fps, [...sim.followIds]),
    );
  }
}
rebuildRecordings();

function resetLive(): void {
  playing = false;
  liveAccumulator = 0;
  sim = new Simulation(scenario, config, liveFps);
  for (const t of trails.values()) t.points = [];
  buildRoster();
  rebuildRecordings();
  updateHud();
}

// ---------- 按钮 ----------
$('play').addEventListener('click', () => {
  if (mode === 'live') {
    playing = !playing;
    $('play').textContent = playing ? '暂停' : '播放';
  } else {
    replayPlaying = !replayPlaying;
    $('replayPlay').textContent = replayPlaying ? '暂停回放' : '播放回放';
  }
});
$('step').addEventListener('click', () => {
  if (mode !== 'live') return;
  playing = false;
  $('play').textContent = '播放';
  advanceLive(sim.dt);
});
$('reset').addEventListener('click', resetLive);

const modeTabs = document.querySelectorAll('.tab');
modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = (tab as HTMLElement).dataset.mode as 'live' | 'replay';
    modeTabs.forEach((t) => t.classList.toggle('active', t === tab));
    $('livePanel').classList.toggle('hidden', mode !== 'live');
    $('replayPanel').classList.toggle('hidden', mode !== 'replay');
    replayT = 0;
    replayPlaying = false;
    $('replayPlay').textContent = '播放回放';
    ($('replayTime') as HTMLInputElement).value = '0';
  });
});

const replaySlider = $('replayTime') as HTMLInputElement;
replaySlider.max = String(scenario.duration);
replaySlider.addEventListener('input', () => {
  replayT = parseFloat(replaySlider.value);
});

// ---------- 拖动 ----------
function eventWorld(e: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  const sx = ((e.clientX - rect.left) / rect.width) * VIEWPORT_W;
  const sy = ((e.clientY - rect.top) / rect.height) * VIEWPORT_H;
  return sim.camera.screenToWorld({ x: sx, y: sy });
}

canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'live') return;
  const id = sim.pick(eventWorld(e));
  if (!id) return;
  dragId = id;
  sim.beginDrag(id);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragId) return;
  sim.setDragPosition(dragId, eventWorld(e));
});
const endDrag = (e: PointerEvent) => {
  if (!dragId) return;
  sim.endDrag(dragId);
  dragId = null;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- 推进 ----------
function advanceLive(dt: number): void {
  // 固定步长: 累积器只允许按 sim.dt 整步推进, 保证暂停单步可重复
  liveAccumulator = dt;
  while (liveAccumulator + 1e-9 >= sim.dt) {
    sim.step();
    liveAccumulator -= sim.dt;
    if (sim.t >= scenario.duration) {
      playing = false;
      $('play').textContent = '播放';
      break;
    }
  }
  for (const snap of sim.current().actors) {
    const trail = trails.get(snap.id)!;
    trail.points.push({ x: snap.x, y: snap.y });
    if (trail.points.length > MAX_TRAIL) trail.points.shift();
  }
  updateHud();
}

function updateHud(): void {
  const snap = sim.current();
  const c = snap.camera;
  $('hud').textContent =
    `t=${snap.t.toFixed(2)}s  tick=${sim.tick}  fps=${liveFps}  ` +
    `zoom=${c.zoom.toFixed(3)} (期望 ${c.desiredZoom.toFixed(3)})  ` +
    `中心=(${c.cx.toFixed(0)},${c.cy.toFixed(0)})  ` +
    `跟随=[${c.followIds.join(',') || '空'}]  ` +
    `裁切=${c.clips.map((x) => x.actorId).join(',') || '无'}  ` +
    `限制=[${c.limits.join(',') || '无'}]`;
}

// ---------- 主循环: 墙钟只负责驱动, 仿真按固定步长消费 ----------
function frame(now: number): void {
  const elapsed = Math.min(0.1, (now - lastFrameMs) / 1000 || 0);
  lastFrameMs = now;

  if (mode === 'live') {
    if (playing && !dragId) advanceLive(elapsed);
    renderLive(ctx, {
      camera: sim.camera,
      scenario,
      trails: [...trails.values()],
      snapshot: sim.current(),
      dragId,
    });
  } else {
    if (replayPlaying) {
      replayAccumulator += elapsed;
      replayT = Math.min(scenario.duration, replayT + replayAccumulator);
      replayAccumulator = 0;
      replaySlider.value = replayT.toFixed(2);
      if (replayT >= scenario.duration) {
        replayPlaying = false;
        $('replayPlay').textContent = '播放回放';
      }
    }
    const runs: ReplayRun[] = REPLAY_FPS_OPTIONS.map((fps) => ({
      fps,
      snapshots: recordings.get(fps)!,
      visible: runVisibility[fps],
    }));
    renderReplay(ctx, { scenario, runs, t: replayT });
  }
  requestAnimationFrame(frame);
}

$('replayPlay').addEventListener('click', () => {
  replayPlaying = !replayPlaying;
  $('replayPlay').textContent = replayPlaying ? '暂停回放' : '播放回放';
});

updateHud();
requestAnimationFrame((t) => {
  lastFrameMs = t;
  requestAnimationFrame(frame);
});
