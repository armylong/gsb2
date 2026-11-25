import './styles.css';
import {
  createHandImage,
  createLeafTexture,
  type HandImageId,
  type RGBAImage,
} from './core/image.ts';
import {
  buildComparison,
  clampCutoff,
  formatPercent,
  formatSignedPercent,
  type MipComparison,
} from './core/mips.ts';
import {
  DOLLY_SAMPLES,
  getSample,
  lodAtElapsed,
  progressAtElapsed,
  type Arrangement,
  type SampleId,
} from './core/samples.ts';
import { LeafRenderer, type RenderInfo, type TextureSet } from './webgl/renderer.ts';
import { highlightCurrentLevel, renderChainPanel } from './ui/metricsPanel.ts';
import { renderAtlasPanel } from './ui/atlasPanel.ts';
import {
  eventToRoi,
  paintZoomPair,
  roiTopLeft,
  ROI_SIZE,
  type Roi,
} from './ui/zoom.ts';

type SourceId = 'procedural' | HandImageId;

const parameter = new URLSearchParams(window.location.search);

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

function validSourceId(value: string | null): value is SourceId {
  return value === 'procedural' || value === 'hand4' || value === 'hand8';
}

function validSampleId(value: string | null): value is SampleId {
  return value === 'front-uniform' || value === 'cross-dwell';
}

const sampleParameter = parameter.get('sample');
const sampleId: SampleId = validSampleId(sampleParameter) ? sampleParameter : 'front-uniform';
const initialSample = getSample(sampleId);
const arrangementParam = parameter.get('arrangement');
const arrangement: Arrangement = arrangementParam === 'front' || arrangementParam === 'cross'
  ? arrangementParam
  : initialSample.arrangement;
const sourceParameter = parameter.get('source');
const sourceId: SourceId = validSourceId(sourceParameter) ? sourceParameter : 'procedural';
const cutoff = clampCutoff(Number(parameter.get('cutoff') ?? '128'));
const lodParameter = parameter.get('lod');
const initialLodLock: number | 'auto' =
  lodParameter === null || lodParameter === 'auto' || !Number.isFinite(Number(lodParameter))
    ? 'auto'
    : Math.max(0, Math.round(Number(lodParameter)));

let initialElapsed = 0;
const progressParameter = Number(parameter.get('progress'));
if (Number.isFinite(progressParameter)) {
  initialElapsed = Math.max(0, Math.min(1, progressParameter)) * initialSample.durationMs;
} else {
  const elapsedParameter = Number(parameter.get('elapsed'));
  if (Number.isFinite(elapsedParameter)) initialElapsed = Math.max(0, elapsedParameter);
}

let initialRoi: Roi | null = null;
const roiParameter = parameter.get('roi');
if (roiParameter) {
  const [nx, ny] = roiParameter.split(',').map(Number);
  if (Number.isFinite(nx) && Number.isFinite(ny)) {
    initialRoi = { nx: Math.max(0, Math.min(1, nx)), ny: Math.max(0, Math.min(1, ny)) };
  }
}

const sourceImages: Record<SourceId, RGBAImage> = {
  procedural: createLeafTexture(),
  hand4: createHandImage('hand4'),
  hand8: createHandImage('hand8'),
};

const sampleSelect = requiredElement<HTMLSelectElement>('sampleSelect');
const sourceSelect = requiredElement<HTMLSelectElement>('sourceSelect');
const cutoffRange = requiredElement<HTMLInputElement>('cutoffRange');
const cutoffValue = requiredElement<HTMLOutputElement>('cutoffValue');
const lodLockSelect = requiredElement<HTMLSelectElement>('lodLockSelect');
const playPauseButton = requiredElement<HTMLButtonElement>('playPause');
const replayButton = requiredElement<HTMLButtonElement>('replay');
const progressRange = requiredElement<HTMLInputElement>('progressRange');
const cameraStats = requiredElement<HTMLElement>('cameraStats');
const canvas = requiredElement<HTMLCanvasElement>('glCanvas');
const canvasHint = requiredElement<HTMLElement>('canvasHint');
const ordinaryPanel = requiredElement<HTMLElement>('ordinaryPanel');
const areaPanel = requiredElement<HTMLElement>('areaPanel');
const roiBox0 = requiredElement<HTMLElement>('roiBox0');
const roiBox1 = requiredElement<HTMLElement>('roiBox1');
const zoomOrdinary = requiredElement<HTMLCanvasElement>('zoomOrdinary');
const zoomArea = requiredElement<HTMLCanvasElement>('zoomArea');
const zoomOrdinaryReadout = requiredElement<HTMLElement>('zoomOrdinaryReadout');
const zoomAreaReadout = requiredElement<HTMLElement>('zoomAreaReadout');
const zoomReading = requiredElement<HTMLElement>('zoomReading');
const zoomStatus = requiredElement<HTMLElement>('zoomStatus');
const outlineToggle = requiredElement<HTMLInputElement>('outlineToggle');
const backgroundSelect = requiredElement<HTMLSelectElement>('backgroundSelect');
const clearRoiButton = requiredElement<HTMLButtonElement>('clearRoi');
const errorBanner = requiredElement<HTMLElement>('errorBanner');
const verdictBar = requiredElement<HTMLElement>('verdictBar');

sampleSelect.value = sampleId;
sourceSelect.value = sourceId;
cutoffRange.value = String(cutoff);
cutoffValue.textContent = String(cutoff);
outlineToggle.checked = parameter.get('outline') !== '0';
backgroundSelect.value = parameter.get('bg') === 'dark' ? 'dark' : 'checker';

const state = {
  sampleId,
  arrangement,
  sourceId,
  cutoff,
  lodLock: initialLodLock,
  playing: parameter.get('pause') !== '1',
  elapsedMs: initialElapsed,
  roi: initialRoi,
  showOutline: outlineToggle.checked,
  background: backgroundSelect.value === 'dark' ? 'dark' as const : 'checker' as const,
  generation: 0,
};

let comparison: MipComparison = buildComparison(sourceImages[state.sourceId], state.cutoff);
let renderer: LeafRenderer | null = null;
let ordinarySet: TextureSet | null = null;
let areaSet: TextureSet | null = null;
let lastInfo: RenderInfo | null = null;

function showError(message: string, error?: unknown): void {
  errorBanner.hidden = false;
  errorBanner.textContent = message;
  console.error(error ?? message);
}

function updateArrangementButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-arrangement]')) {
    button.classList.toggle('is-active', button.dataset.arrangement === state.arrangement);
  }
}

function updatePlayButton(): void {
  playPauseButton.textContent = state.playing ? '暂停' : '播放';
  playPauseButton.setAttribute('aria-pressed', String(!state.playing));
  canvasHint.textContent = state.playing
    ? '播放中：点“暂停”后，再点击画面框选要放大的块。'
    : '已暂停：在任意一侧点击要放大的 48×48 显示块；左右会取同一归一化区域。';
}

function populateLodOptions(): void {
  const maxLevel = comparison.ordinary.images.length - 1;
  if (typeof state.lodLock === 'number') state.lodLock = Math.max(0, Math.min(maxLevel, state.lodLock));
  const options = ['<option value="auto">自动（跟随镜头）</option>'];
  for (const level of comparison.ordinary.levels) {
    options.push(`<option value="${level.level}">L${level.level} · ${level.width}×${level.height}</option>`);
  }
  lodLockSelect.innerHTML = options.join('');
  lodLockSelect.value = state.lodLock === 'auto' ? 'auto' : String(state.lodLock);
}

function renderPanels(): void {
  const selected = typeof state.lodLock === 'number' ? state.lodLock : -1;
  const current = lastInfo?.level ?? (typeof state.lodLock === 'number' ? state.lodLock : 0);
  renderChainPanel(ordinaryPanel, comparison.ordinary, selected, current);
  renderChainPanel(areaPanel, comparison.area, selected, current);
}

function renderVerdict(): void {
  const sourceRatio = formatPercent(comparison.ordinary.sourcePassRatio, 2);
  const firstLoss = comparison.ordinary.firstLossLevel;
  const severeLoss = comparison.ordinary.severeLossLevel;
  verdictBar.classList.toggle('verdict-bar--loss', firstLoss !== null);
  if (firstLoss === null) {
    verdictBar.innerHTML =
      `<strong>判读：</strong>原图 α≥${state.cutoff} 的通过密度是 <strong>${sourceRatio}</strong>；` +
      '当前阈值下普通链没有低于“最近整数面积目标”的层级。若仍觉得树冠稀，先核对这个原图基线密度和当前 LOD。';
    return;
  }

  const level = comparison.ordinary.levels[firstLoss];
  const severeText = severeLoss !== null && severeLoss !== firstLoss
    ? ` 最早的轻微缺口在 L${firstLoss}，而肉眼常见的“突然稀一圈”对应 <strong>L${severeLoss}</strong>：该级保留量已不到面积目标的一半。`
    : severeLoss === firstLoss
      ? ` 该级同时已经丢失至少一半目标面积，是可手算/肉眼可见的起始稀叶级。`
      : '';
  verdictBar.innerHTML =
    `<strong>判读：</strong>原图 α≥${state.cutoff} 本来只有 <strong>${sourceRatio}</strong> 像素通过——这是底图/孔隙基线。` +
    `普通缩小链在 <strong>L${firstLoss}</strong>（${level.width}×${level.height}）首次少于最近整数面积目标：` +
    `实际 ${level.passCount} px、目标 ${level.targetCount} px。${severeText}` +
    '保面积再生链在同一镜头下给出目标面积对照；细叶尖被 2×2 平均稀释后未过裁切阈值，是相对原图基线之外的重要损失来源。' +
    '极小层的整数比例差仍会单独列出，不能把 1 个末级像素伪装成原始密度。';
}

function uploadTextures(): void {
  if (!renderer) return;
  const nextOrdinary = renderer.uploadChain(comparison.ordinary.images);
  const nextArea = renderer.uploadChain(comparison.area.images);
  renderer.deleteTextureSet(ordinarySet);
  renderer.deleteTextureSet(areaSet);
  ordinarySet = nextOrdinary;
  areaSet = nextArea;
}

function clearZoomCanvases(): void {
  for (const target of [zoomOrdinary, zoomArea]) {
    const ctx = target.getContext('2d');
    ctx?.clearRect(0, 0, target.width, target.height);
  }
  zoomOrdinaryReadout.textContent = '';
  zoomAreaReadout.textContent = '';
  zoomReading.textContent = '';
  zoomStatus.textContent = state.roi ? '正在绘制放大块…' : '尚未框选。暂停后可在画面上点击。';
}

function updateRoiBoxes(): void {
  if (!state.roi) {
    roiBox0.style.display = 'none';
    roiBox1.style.display = 'none';
    return;
  }
  const { x, y } = roiTopLeft(state.roi);
  for (const box of [roiBox0, roiBox1]) {
    box.style.display = 'block';
    box.style.left = `${(x / 640) * 100}%`;
    box.style.top = `${(y / 640) * 100}%`;
    box.style.width = `${(ROI_SIZE / 640) * 100}%`;
  }
}

function paintZoom(info: RenderInfo): void {
  if (!state.roi) return;
  const generation = state.generation;
  const result = paintZoomPair({
    source: canvas,
    roi: state.roi,
    showOutline: state.showOutline,
    background: state.background,
    ordinary: zoomOrdinary,
    area: zoomArea,
  });
  if (generation !== state.generation) return;

  const ordinaryLevel = comparison.ordinary.levels[info.level];
  const areaLevel = comparison.area.levels[info.level];
  if (!ordinaryLevel || !areaLevel) return;

  zoomOrdinaryReadout.textContent =
    `ROI 不透明帧像素 ${result.ordinaryDrawn}/${ROI_SIZE * ROI_SIZE}\n` +
    `采样 L${info.level} · mip ${ordinaryLevel.width}×${ordinaryLevel.height}\n` +
    `该层通过 ${ordinaryLevel.passCount}/${ordinaryLevel.texels} = ${formatPercent(ordinaryLevel.passRatio, 2)}`;
  zoomAreaReadout.textContent =
    `ROI 不透明帧像素 ${result.areaDrawn}/${ROI_SIZE * ROI_SIZE}\n` +
    `采样 L${info.level} · mip ${areaLevel.width}×${areaLevel.height}\n` +
    `该层通过 ${areaLevel.passCount}/${areaLevel.texels} = ${formatPercent(areaLevel.passRatio, 2)}`;

  zoomReading.textContent = [
    `镜头 LOD ${cameraLodForStats().toFixed(2)} → NEAREST 选层 L${info.level}`,
    `视野高 ${info.viewHeight.toFixed(2)}；等效透视距离 ${info.nominalDistance.toFixed(1)}`,
    `原图 α≥${state.cutoff} 通过 ${comparison.ordinary.sourcePassCount} px（${formatPercent(comparison.ordinary.sourcePassRatio, 2)}）`,
    `普通层实际差 ${formatSignedPercent(ordinaryLevel.deltaRatio, 2)}；裁切缺口 ${ordinaryLevel.clippedVsTarget} px`,
    `再生层实际差 ${formatSignedPercent(areaLevel.deltaRatio, 2)}；整数量化残差 ${areaLevel.quantizationResidual.toFixed(2)} px`,
    `ROI 轮廓数差：${result.areaDrawn - result.ordinaryDrawn >= 0 ? '+' : ''}${result.areaDrawn - result.ordinaryDrawn} 个显示缓冲像素`,
    '放大只复制已绘制的 WebGL 缓冲（最近邻），没有推进镜头、改变 u_lod 或重采样 mip。',
    `结果代号 gen-${state.generation}；切换阈值会递增代号并同步替换全部读数。`,
  ].join('\n');
  zoomStatus.textContent = `已固定同一归一化区域；放大倍数 ×6，源块 ${ROI_SIZE}×${ROI_SIZE}。`;
}

function cameraLodForStats(): number {
  return lodAtElapsed(getSample(state.sampleId), state.elapsedMs, true);
}

function renderFrame(): void {
  if (!renderer || !ordinarySet || !areaSet) return;
  const sample = getSample(state.sampleId);
  const cameraLod = cameraLodForStats();
  const info = renderer.render({
    ordinary: ordinarySet,
    area: areaSet,
    cutoff: state.cutoff,
    arrangement: state.arrangement,
    cameraLod,
    lodLock: state.lodLock,
    sourceWidth: sourceImages[state.sourceId].width,
    sourceHeight: sourceImages[state.sourceId].height,
  });
  lastInfo = info;
  highlightCurrentLevel(ordinaryPanel, info.level);
  highlightCurrentLevel(areaPanel, info.level);

  const progress = progressAtElapsed(sample, state.elapsedMs, true);
  if (state.playing) progressRange.value = String(Math.round(progress * 1000));
  cameraStats.textContent =
    `${sample.label} | ${(progress * 100).toFixed(1)}% | 几何 LOD ${cameraLod.toFixed(2)} | ` +
    `实际采样 L${info.level}${state.lodLock === 'auto' ? '（自动）' : '（锁定）'} | ` +
    `pull=${info.pull.toFixed(2)} | 摆法=${state.arrangement === 'front' ? '正面' : '交叉'}`;

  updateRoiBoxes();
  if (state.roi) paintZoom(info);
}

function rebuildDataAndTextures(): void {
  state.generation++;
  comparison = buildComparison(sourceImages[state.sourceId], state.cutoff);
  populateLodOptions();
  renderVerdict();
  renderPanels();
  uploadTextures();
  updateRoiBoxes();
  clearZoomCanvases();
  renderFrame();
}

function toggleLevelLock(level: number): void {
  state.lodLock = state.lodLock === level ? 'auto' : level;
  lodLockSelect.value = String(state.lodLock);
  renderPanels();
  renderFrame();
}

function renderHandMatrix(): void {
  const hand4 = createHandImage('hand4');
  const target = requiredElement<HTMLPreElement>('handMatrix');
  const rows: string[] = [];
  for (let y = 0; y < hand4.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < hand4.width; x++) {
      const a = hand4.data[(y * hand4.width + x) * 4 + 3];
      row.push(a === 0 ? '  · ' : String(a).padStart(4));
    }
    rows.push(row.join(' '));
  }
  target.textContent = rows.join('\n');
}

sampleSelect.addEventListener('change', () => {
  if (!validSampleId(sampleSelect.value)) return;
  state.sampleId = sampleSelect.value;
  const sample = getSample(state.sampleId);
  state.arrangement = sample.arrangement;
  state.elapsedMs = 0;
  state.playing = true;
  updateArrangementButtons();
  updatePlayButton();
  progressRange.value = '0';
  renderFrame();
});

sourceSelect.addEventListener('change', () => {
  if (!validSourceId(sourceSelect.value)) return;
  state.sourceId = sourceSelect.value;
  state.roi = null;
  rebuildDataAndTextures();
});

cutoffRange.addEventListener('input', () => {
  state.cutoff = clampCutoff(Number(cutoffRange.value));
  cutoffRange.value = String(state.cutoff);
  cutoffValue.textContent = String(state.cutoff);
  rebuildDataAndTextures();
});

lodLockSelect.addEventListener('change', () => {
  state.lodLock = lodLockSelect.value === 'auto' ? 'auto' : Number(lodLockSelect.value);
  renderPanels();
  renderFrame();
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-arrangement]')) {
  button.addEventListener('click', () => {
    const arrangementValue = button.dataset.arrangement;
    if (arrangementValue !== 'front' && arrangementValue !== 'cross') return;
    state.arrangement = arrangementValue;
    updateArrangementButtons();
    renderFrame();
  });
}

playPauseButton.addEventListener('click', () => {
  state.playing = !state.playing;
  updatePlayButton();
  renderFrame();
});

replayButton.addEventListener('click', () => {
  state.elapsedMs = 0;
  state.playing = true;
  updatePlayButton();
  progressRange.value = '0';
  renderFrame();
});

progressRange.addEventListener('input', () => {
  const sample = getSample(state.sampleId);
  state.elapsedMs = (Number(progressRange.value) / 1000) * sample.durationMs;
  state.playing = false;
  updatePlayButton();
  renderFrame();
});

ordinaryPanel.addEventListener('click', (event) => {
  const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('.level-card');
  if (card?.dataset.level) toggleLevelLock(Number(card.dataset.level));
});
areaPanel.addEventListener('click', (event) => {
  const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('.level-card');
  if (card?.dataset.level) toggleLevelLock(Number(card.dataset.level));
});

canvas.addEventListener('click', (event) => {
  if (state.playing) {
    canvasHint.textContent = '镜头仍在播放：先点“暂停”，再框选放大块。';
    return;
  }
  state.roi = eventToRoi(event, canvas);
  updateRoiBoxes();
  clearZoomCanvases();
  if (lastInfo) paintZoom(lastInfo);
});

clearRoiButton.addEventListener('click', () => {
  state.roi = null;
  updateRoiBoxes();
  clearZoomCanvases();
});

outlineToggle.addEventListener('change', () => {
  state.showOutline = outlineToggle.checked;
  if (lastInfo && state.roi) paintZoom(lastInfo);
});

backgroundSelect.addEventListener('change', () => {
  state.background = backgroundSelect.value === 'dark' ? 'dark' : 'checker';
  if (lastInfo && state.roi) paintZoom(lastInfo);
});

updateArrangementButtons();
updatePlayButton();
renderHandMatrix();
renderAtlasPanel(requiredElement<HTMLElement>('atlasPanel'));

try {
  renderer = new LeafRenderer(canvas);
} catch (error) {
  showError('WebGL2 初始化失败；逐层读数、手算表和本地测试仍可使用。', error);
}

populateLodOptions();
renderVerdict();
renderPanels();
uploadTextures();
updateRoiBoxes();
clearZoomCanvases();
renderFrame();

let lastTimestamp = performance.now();
function frame(timestamp: number): void {
  const delta = Math.min(50, timestamp - lastTimestamp);
  lastTimestamp = timestamp;
  if (state.playing) state.elapsedMs += delta;
  renderFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for scripted/local browser checks; not required by the UI.
(window as unknown as { __leafLab?: unknown }).__leafLab = {
  state,
  comparison: () => comparison,
  samples: DOLLY_SAMPLES,
};
