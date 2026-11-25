import './styles.css';
import { AudioEngine } from './audio/AudioEngine';
import { createDemoBuffer, DEMO_CUES } from './audio/demo';
import { computePeaks, type WavePeaks } from './audio/peaks';
import { planScriptedRoute, ScrubPlanner } from './audio/scrubPlanner';
import { renderRouteToBuffer } from './audio/renderRoute';
import { audioBufferToWav, createReversedBuffer, decodeAudioFile, downloadBlob } from './audio/wav';
import { clamp, formatTime, xToTime } from './domain/mapping';
import type { AudioDoc, LogEntry, ScrubRoute } from './domain/types';
import { runSelfTests, type SelfTestResult } from './selftestCore';
import { renderLayout } from './ui/layout';
import { drawMiniWave, drawWaveform } from './ui/waveformView';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app root not found');
const refs = renderLayout(root);
const engine = new AudioEngine();

let doc: AudioDoc | null = null;
let peaks: WavePeaks | null = null;
let routes: ScrubRoute[] = [];
let selectedRouteId: string | null = null;
const renderedCache = new Map<string, AudioBuffer>();
const routePeaksCache = new Map<string, WavePeaks>();

let currentTime = 0;
let normalPlaying = false;
let previewPlaying = false;
let previewStartCtx = 0;
let previewDuration = 0;

let dragging = false;
let dragPointerId: number | null = null;
let dragDirection: 1 | -1 = 1;
let planner: ScrubPlanner | null = null;
let activeRoute: ScrubRoute | null = null;
let pointerSeq = 0;

let logs: LogEntry[] = [];
let logSeq = 0;
let logRenderQueued = false;
let toastTimer = 0;
let dragDepth = 0;

function toast(message: string): void {
  refs.toast.textContent = message;
  refs.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => refs.toast.classList.remove('show'), 2600);
}

function addLog(kind: LogEntry['kind'], message: string): void {
  if (!refs.recordEvents.checked) return;
  logs.push({ id: ++logSeq, at: new Date().toISOString(), kind, message });
  if (logs.length > 1200) logs = logs.slice(-1000);
  if (logRenderQueued) return;
  logRenderQueued = true;
  requestAnimationFrame(() => {
    logRenderQueued = false;
    renderLogs();
  });
}

function renderLogs(): void {
  refs.logBox.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const entry of logs.slice(-260)) {
    const row = document.createElement('div');
    row.className = 'log-entry';
    const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
    row.innerHTML = `<span class="log-time">${time}</span><span class="log-kind ${entry.kind}">${entry.kind}</span>`;
    row.append(document.createTextNode(entry.message));
    fragment.append(row);
  }
  refs.logBox.append(fragment);
  refs.logBox.scrollTop = refs.logBox.scrollHeight;
}

function downloadLogJson(): void {
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `scrub-events-${Date.now()}.json`);
}

function setDocUiEnabled(enabled: boolean): void {
  refs.playButton.disabled = !enabled;
  refs.stopButton.disabled = !enabled;
  refs.audibleRoundTripButton.disabled = !enabled;
  refs.audibleBoundaryButton.disabled = !enabled;
  refs.playReferenceButton.disabled = !enabled;
  refs.exportDemoButton.disabled = !doc?.demo;
  refreshRouteButtons();
}

async function loadAudioBuffer(name: string, buffer: AudioBuffer, demo = false): Promise<void> {
  const context = await engine.ensureContext();
  engine.stopAll();
  normalPlaying = false;
  previewPlaying = false;
  const reversed = createReversedBuffer(context, buffer);
  doc = { id: `doc-${Date.now().toString(36)}`, name, buffer, reversed, demo };
  peaks = computePeaks(buffer);
  routes = [];
  selectedRouteId = null;
  renderedCache.clear();
  routePeaksCache.clear();
  currentTime = 0;
  planner = null;
  activeRoute = null;

  refs.fileName.textContent = name;
  refs.fileMeta.textContent =
    `${buffer.duration.toFixed(3)} 秒 · ${buffer.numberOfChannels === 2 ? '左右双声道' : `${buffer.numberOfChannels} 声道`} · ${buffer.sampleRate} Hz · 峰值已在本地计算`;
  setDocUiEnabled(true);
  refreshRouteSelect();
  addLog('file', `已载入 ${name}（${buffer.duration.toFixed(3)}s, ${buffer.numberOfChannels}ch）`);
  toast(`已载入：${name}`);
  draw();
}

async function loadFile(file: File): Promise<void> {
  try {
    const context = await engine.ensureContext();
    const buffer = await decodeAudioFile(context, file);
    await loadAudioBuffer(file.name, buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog('error', `打开 WAV 失败：${message}`);
    toast(`打开失败：${message}`);
  }
}

function eventToSourceTime(event: PointerEvent): { time: number; x: number; width: number } {
  const rect = refs.waveform.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const duration = doc?.buffer.duration ?? 0;
  return { time: xToTime(x, rect.width, duration), x, width: rect.width };
}

function currentOptions() {
  return {
    observationSec: Number.parseFloat(refs.observation.value),
    sensitivity: Number.parseFloat(refs.sensitivity.value),
  };
}

function executeCommands(commands: ReturnType<ScrubPlanner['ingest']>): void {
  if (!doc) return;
  for (const command of commands) {
    if (command.type === 'start') {
      engine.startAtom(command.atom, doc.buffer, doc.reversed);
      addLog(
        'audio',
        `start ${command.atom.direction === 1 ? '▶' : '◀'} t=${command.atom.sourceTime.toFixed(3)}s ` +
        `rate=${command.atom.rate.toFixed(2)} dur=${command.atom.duration.toFixed(3)}` +
        `${command.atom.jumped ? ' jump' : ''}`,
      );
    } else {
      engine.stopAtom(command.id, command.fadeOut);
      addLog('audio', `stop ${command.id} fade=${command.fadeOut.toFixed(3)}s`);
    }
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!doc) {
    toast('请先打开 WAV 或载入内置示例');
    return;
  }
  event.preventDefault();
  refs.waveform.setPointerCapture(event.pointerId);
  dragging = true;
  dragPointerId = event.pointerId;
  dragDirection = 1;
  engine.stopNormal();
  engine.stopPreview();
  normalPlaying = false;
  previewPlaying = false;

  const { time, x } = eventToSourceTime(event);
  currentTime = time;
  pointerSeq = 0;
  const now = engine.currentTime + 0.012;
  planner = new ScrubPlanner(now, time, {
    durationSec: doc.buffer.duration,
    ...currentOptions(),
  }, {
    docId: doc.id,
    name: `拖听 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    pointerEvents: [],
  });
  activeRoute = planner.route;
  if (refs.recordEvents.checked) {
    planner.route.pointerEvents.push({
      seq: ++pointerSeq,
      atMs: performance.now(),
      phase: 'down',
      x,
      sourceTime: time,
    });
  }
  addLog('pointer', `down @ ${time.toFixed(3)}s`);
  draw();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging || event.pointerId !== dragPointerId || !planner) return;
  event.preventDefault();
  const { time, x } = eventToSourceTime(event);
  if (time > currentTime + 1e-7) dragDirection = 1;
  else if (time < currentTime - 1e-7) dragDirection = -1;
  currentTime = time;
  if (refs.recordEvents.checked) {
    planner.route.pointerEvents.push({
      seq: ++pointerSeq,
      atMs: performance.now(),
      phase: 'move',
      x,
      sourceTime: time,
    });
    addLog('pointer', `move ${dragDirection === -1 ? '◀' : '▶'} @ ${time.toFixed(3)}s x=${x.toFixed(1)}px`);
  }
  const commands = planner.ingest(engine.currentTime + 0.012, time);
  executeCommands(commands);
}

function finishPointer(event: PointerEvent, cancelled: boolean): void {
  if (!dragging || event.pointerId !== dragPointerId) return;
  const pointerPosition = eventToSourceTime(event);
  const time = doc ? clamp(currentTime, 0, doc.buffer.duration) : currentTime;
  if (refs.recordEvents.checked) {
    planner?.route.pointerEvents.push({
      seq: ++pointerSeq,
      atMs: performance.now(),
      phase: cancelled ? 'cancel' : 'up',
      x: pointerPosition.x,
      sourceTime: time,
    });
  }

  if (planner && doc) {
    const commands = cancelled ? planner.release(engine.currentTime + 0.012) : planner.release(engine.currentTime + 0.012);
    executeCommands(commands);
    const route = planner.route;
    if (route.atoms.length > 0) {
      routes.unshift(route);
      routes = routes.slice(0, 30);
      selectedRouteId = route.id;
      refreshRouteSelect();
      addLog('route', `已录制路线 ${route.name}：${route.atoms.length} atoms / ${route.duration.toFixed(2)}s`);
    }
  }

  dragging = false;
  dragPointerId = null;
  planner = null;
  window.setTimeout(() => { activeRoute = null; }, 1200);

  if (!cancelled && refs.autoPlay.checked && doc) {
    engine.playNormal(doc.buffer, time, 0.11);
    normalPlaying = true;
    addLog('audio', `release → normal play @ ${time.toFixed(3)}s`);
  } else {
    addLog('pointer', cancelled ? 'cancel' : 'up（不自动播放）');
  }
  draw();
}

function selectedRoute(): ScrubRoute | null {
  return routes.find((route) => route.id === selectedRouteId) ?? null;
}

function refreshRouteSelect(): void {
  refs.routeSelect.replaceChildren();
  for (const route of routes) {
    const option = document.createElement('option');
    option.value = route.id;
    option.textContent = `${route.name} · ${route.atoms.length} 段 · ${route.duration.toFixed(2)}s`;
    option.selected = route.id === selectedRouteId;
    refs.routeSelect.append(option);
  }
  if (selectedRouteId && !routes.some((route) => route.id === selectedRouteId)) selectedRouteId = routes[0]?.id ?? null;
  refs.routeSelect.value = selectedRouteId ?? '';
  refreshRouteButtons();
  updateRouteMeta();
  drawRouteMini();
}

function refreshRouteButtons(): void {
  const hasRoute = selectedRoute() !== null;
  refs.previewRouteButton.disabled = !hasRoute;
  refs.exportRouteButton.disabled = !hasRoute;
  refs.deleteRouteButton.disabled = !hasRoute;
  refs.clearRoutesButton.disabled = routes.length === 0;
  refs.stopRouteButton.disabled = !previewPlaying;
}

function updateRouteMeta(): void {
  const route = selectedRoute();
  if (!route) {
    refs.routeMeta.textContent = '拖动一次波形后，这里会出现该路线；试听和导出都由同一条 ScrubRoute 离线渲染。';
    return;
  }
  const forward = route.atoms.filter((atom) => atom.direction === 1).length;
  const reverse = route.atoms.length - forward;
  refs.routeMeta.textContent =
    `${route.name}：输出路线 ${route.duration.toFixed(3)}s，正向 ${forward} 段 / 反向 ${reverse} 段，` +
    `指针事件 ${route.pointerEvents.length} 条。试听与导出共用同一个离线渲染 AudioBuffer。`;
}

async function ensureRenderedRoute(route: ScrubRoute): Promise<AudioBuffer> {
  if (!doc) throw new Error('请先载入音频');
  const existing = renderedCache.get(route.id);
  if (existing) return existing;
  const rendered = await renderRouteToBuffer(route, doc.buffer, doc.reversed);
  renderedCache.set(route.id, rendered);
  routePeaksCache.set(route.id, computePeaks(rendered, 1200));
  drawRouteMini();
  return rendered;
}

async function previewSelectedRoute(): Promise<void> {
  const route = selectedRoute();
  if (!route) return;
  try {
    await engine.unlock();
    const rendered = await ensureRenderedRoute(route);
    normalPlaying = false;
    engine.playRenderedBuffer(rendered);
    previewPlaying = true;
    previewDuration = rendered.duration;
    previewStartCtx = engine.currentTime;
    refreshRouteButtons();
    addLog('route', `试听路线 ${route.name}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

async function exportSelectedRoute(): Promise<void> {
  const route = selectedRoute();
  if (!route) return;
  try {
    const rendered = await ensureRenderedRoute(route);
    const wav = audioBufferToWav(rendered);
    downloadBlob(wav, `${route.name.replace(/[\\/:*?"<>|\s]+/g, '_')}.wav`);
    addLog('route', `导出路线 WAV：${route.name}`);
    toast('已使用当前试听渲染结果导出 WAV');
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

function drawRouteMini(progress = 0): void {
  const route = selectedRoute();
  const routePeaks = route ? routePeaksCache.get(route.id) ?? null : null;
  drawMiniWave(refs.routeWave, routePeaks, progress);
}

function draw(): void {
  const duration = doc?.buffer.duration ?? 0;
  const routeForOverlay = dragging ? activeRoute : selectedRoute();
  drawWaveform(refs.waveform, {
    durationSec: duration,
    currentTime,
    peaks,
    route: routeForOverlay,
    cues: doc?.demo ? DEMO_CUES : undefined,
    playing: normalPlaying,
  });
  refs.timeReadout.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

  const position = engine.getNormalPosition();
  if (position !== null && doc) currentTime = clamp(position, 0, doc.buffer.duration);

  if (dragging) {
    refs.statusPill.textContent = dragDirection === -1 ? '◀ 反向拖听' : '▶ 正向拖听';
    refs.statusPill.className = `status-pill ${dragDirection === -1 ? 'reverse' : 'live'}`;
  } else if (normalPlaying) {
    refs.statusPill.textContent = '● 正常播放';
    refs.statusPill.className = 'status-pill play';
  } else if (previewPlaying) {
    refs.statusPill.textContent = '◫ 路线试听';
    refs.statusPill.className = 'status-pill live';
  } else {
    refs.statusPill.textContent = doc ? '已就绪' : '待载入';
    refs.statusPill.className = 'status-pill';
  }
  refs.playButton.textContent = normalPlaying ? '暂停' : '播放';

  if (previewPlaying && previewDuration > 0) {
    const progress = clamp((engine.currentTime - previewStartCtx) / previewDuration, 0, 1);
    drawRouteMini(progress);
  }
}

function renderSelfTestResults(results: SelfTestResult[]): void {
  refs.testList.replaceChildren();
  for (const result of results) {
    const row = document.createElement('div');
    row.className = `test-row ${result.ok ? 'ok' : 'fail'}`;
    row.innerHTML = `<span class="test-icon">${result.ok ? '✓' : '×'}</span><div><div></div><div class="test-detail"></div></div>`;
    row.querySelector('div > div:first-child')!.textContent = result.name;
    row.querySelector('.test-detail')!.textContent = result.detail;
    refs.testList.append(row);
  }
}

async function runTests(): Promise<void> {
  refs.runTestsButton.disabled = true;
  refs.runTestsButton.textContent = '自检运行中…';
  try {
    const results = await runSelfTests();
    renderSelfTestResults(results);
    const failed = results.filter((result) => !result.ok).length;
    addLog('test', `逻辑自检完成：${results.length - failed}/${results.length} 通过`);
    toast(failed === 0 ? '全部本地逻辑自检通过' : `${failed} 项自检失败`);
  } finally {
    refs.runTestsButton.disabled = false;
    refs.runTestsButton.textContent = '运行逻辑自检';
  }
}

function addValidationRoute(route: ScrubRoute): void {
  routes.unshift(route);
  selectedRouteId = route.id;
  refreshRouteSelect();
  void previewSelectedRoute();
}

function createRoundTripValidation(): void {
  if (!doc) return;
  const points = [{ atSec: 0, time: 1 }];
  for (let i = 1; i <= 12; i += 1) points.push({ atSec: i * 0.1, time: 1 + (2 * i) / 12 });
  for (let i = 1; i <= 12; i += 1) points.push({ atSec: 1.2 + i * 0.1, time: 3 - (2 * i) / 12 });
  const route = planScriptedRoute(doc.id, `自检-往返-${Date.now().toString(36)}`, doc.buffer.duration, points, {
    observationSec: Number.parseFloat(refs.observation.value),
    sensitivity: Number.parseFloat(refs.sensitivity.value),
  });
  addValidationRoute(route);
  addLog('test', '生成往返定位验证路线 1s → 3s → 1s');
}

function createBoundaryValidation(): void {
  if (!doc) return;
  const d = doc.buffer.duration;
  const points = [
    { atSec: 0, time: 0.15 },
    { atSec: 0.58, time: d - 0.15 },
    { atSec: 1.16, time: d + 999 },
    { atSec: 1.74, time: -999 },
    { atSec: 2.32, time: 0.15 },
  ];
  const route = planScriptedRoute(doc.id, `自检-边界跳跃-${Date.now().toString(36)}`, d, points, {
    observationSec: Number.parseFloat(refs.observation.value),
    sensitivity: Number.parseFloat(refs.sensitivity.value),
  });
  addValidationRoute(route);
  addLog('test', '生成文件首尾/越界跳跃验证路线');
}

async function togglePlayback(): Promise<void> {
  if (!doc) return;
  await engine.unlock();
  if (normalPlaying) {
    currentTime = engine.pauseNormal();
    normalPlaying = false;
  } else {
    if (currentTime >= doc.buffer.duration - 0.03) currentTime = 0;
    previewPlaying = false;
    engine.playNormal(doc.buffer, currentTime);
    normalPlaying = true;
  }
}

function bindEvents(): void {
  refs.fileInput.addEventListener('change', () => {
    const file = refs.fileInput.files?.[0];
    if (file) void loadFile(file);
    refs.fileInput.value = '';
  });

  refs.demoButton.addEventListener('click', async () => {
    try {
      const context = await engine.ensureContext();
      const buffer = createDemoBuffer(context);
      await loadAudioBuffer('内置示例：16 拍节拍与念拍替代音（8s stereo WAV）', buffer, true);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  });

  refs.exportDemoButton.addEventListener('click', () => {
    if (!doc) return;
    downloadBlob(audioBufferToWav(doc.buffer), 'built-in-count-beat-demo.wav');
    addLog('file', '下载程序生成示例 WAV');
  });

  refs.waveform.addEventListener('pointerdown', onPointerDown);
  refs.waveform.addEventListener('pointermove', onPointerMove);
  refs.waveform.addEventListener('pointerup', (event) => finishPointer(event, false));
  refs.waveform.addEventListener('pointercancel', (event) => finishPointer(event, true));

  refs.playButton.addEventListener('click', () => void togglePlayback());
  refs.stopButton.addEventListener('click', () => {
    engine.stopAll();
    normalPlaying = false;
    previewPlaying = false;
    currentTime = 0;
    drawRouteMini(0);
    addLog('audio', 'stop all');
  });

  refs.observation.addEventListener('input', () => {
    refs.observationValue.textContent = `${Number.parseFloat(refs.observation.value).toFixed(2)} s`;
  });
  refs.sensitivity.addEventListener('input', () => {
    refs.sensitivityValue.textContent = `${Number.parseFloat(refs.sensitivity.value).toFixed(2)}×`;
  });

  refs.routeSelect.addEventListener('change', () => {
    selectedRouteId = refs.routeSelect.value || null;
    updateRouteMeta();
    drawRouteMini();
    refreshRouteButtons();
  });
  refs.previewRouteButton.addEventListener('click', () => void previewSelectedRoute());
  refs.stopRouteButton.addEventListener('click', () => {
    engine.stopPreview();
    previewPlaying = false;
    refreshRouteButtons();
    drawRouteMini(0);
  });
  refs.exportRouteButton.addEventListener('click', () => void exportSelectedRoute());
  refs.deleteRouteButton.addEventListener('click', () => {
    if (!selectedRouteId) return;
    routes = routes.filter((route) => route.id !== selectedRouteId);
    renderedCache.delete(selectedRouteId);
    routePeaksCache.delete(selectedRouteId);
    selectedRouteId = routes[0]?.id ?? null;
    refreshRouteSelect();
  });
  refs.clearRoutesButton.addEventListener('click', () => {
    routes = [];
    selectedRouteId = null;
    renderedCache.clear();
    routePeaksCache.clear();
    engine.stopPreview();
    previewPlaying = false;
    refreshRouteSelect();
  });

  refs.clearLogButton.addEventListener('click', () => { logs = []; renderLogs(); });
  refs.downloadLogButton.addEventListener('click', downloadLogJson);
  refs.runTestsButton.addEventListener('click', () => void runTests());
  refs.audibleRoundTripButton.addEventListener('click', createRoundTripValidation);
  refs.audibleBoundaryButton.addEventListener('click', createBoundaryValidation);
  refs.playReferenceButton.addEventListener('click', async () => {
    if (!doc) return;
    await engine.unlock();
    currentTime = 0;
    engine.stopPreview();
    previewPlaying = false;
    engine.playNormal(doc.buffer, 0);
    normalPlaying = true;
    addLog('test', '播放内置顺序基准音');
  });

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (event.code === 'Space' && tag !== 'INPUT' && tag !== 'BUTTON' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      event.preventDefault();
      void togglePlayback();
    }
  });

  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    refs.dropOverlay.classList.add('show');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || event.relatedTarget === null) refs.dropOverlay.classList.remove('show');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    refs.dropOverlay.classList.remove('show');
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });

  engine.onNormalEnded = () => {
    normalPlaying = false;
    if (doc) currentTime = doc.buffer.duration;
    addLog('audio', 'normal playback ended naturally');
  };
  engine.onPreviewEnded = () => {
    previewPlaying = false;
    refreshRouteButtons();
    drawRouteMini(1);
  };
}

bindEvents();
refreshRouteSelect();
void runTests();
function animationFrame(): void {
  draw();
  requestAnimationFrame(animationFrame);
}
requestAnimationFrame(animationFrame);
