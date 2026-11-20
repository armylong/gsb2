import * as THREE from 'three';
import { PairScene, GAP_LABELS, GAP_RATIOS } from './core/labScene';
import {
  DepthSession,
  type DepthAttachmentType,
  type FrameStats,
  type OverlayMode,
} from './core/depthSession';
import { readCapabilities, type Capabilities } from './core/capabilities';
import {
  DEFAULT_SCAN_CONFIG,
  type ScanConfig,
  type ScanResult,
  formatScanSummary,
  runScan,
  scanDistances,
} from './core/scan';
import { renderPrecisionChart, PRECISION_COLORS } from './charts/precisionChart';
import { renderScanChart } from './charts/scanChart';
import { CHART_COLORS, formatNumber, formatPercent, htmlEl } from './charts/svg';

type Mode = 'direct' | 'reversed';

interface ModeState {
  mode: Mode;
  session: DepthSession;
  stats: FrameStats | null;
}

const RESOLUTIONS = [
  { label: '240p', width: 384, height: 240 },
  { label: '360p', width: 576, height: 360 },
  { label: '480p', width: 768, height: 480 },
] as const;

const CAMERA_PRESETS: { label: string; near: number; far: number }[] = [
  { label: '0.1 / 1e3', near: 0.1, far: 1000 },
  { label: '0.1 / 1e5', near: 0.1, far: 100000 },
  { label: '1 / 1e5', near: 1, far: 100000 },
  { label: '0.01 / 1e6', near: 0.01, far: 1000000 },
];

const DISTANCE_MIN = 10;
const DISTANCE_MAX = 90000;

interface AppState {
  distance: number;
  near: number;
  far: number;
  fovDeg: number;
  keepScreenScale: boolean;
  gapScale: number;
  overlay: OverlayMode;
  resolutionIndex: number;
  depthType: DepthAttachmentType;
}

const appState: AppState = {
  distance: 1000,
  near: 0.1,
  far: 100000,
  fovDeg: 45,
  keepScreenScale: true,
  gapScale: 1,
  overlay: 'contested',
  resolutionIndex: 1,
  depthType: 'u24',
};

const scene = new PairScene();
let modes: ModeState[] = [];
let capabilities: Capabilities | null = null;
let scanResults: Partial<Record<Mode, ScanResult>> = {};
let scanBusy = false;
let latestScanSummary = '';

function required<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`缺少必需节点: ${selector}`);
  return node;
}

function distanceFromSlider(value: number): number {
  const t = value / 1000;
  return DISTANCE_MIN * Math.pow(DISTANCE_MAX / DISTANCE_MIN, t);
}

function sliderFromDistance(distance: number): number {
  const t = Math.log(distance / DISTANCE_MIN) / Math.log(DISTANCE_MAX / DISTANCE_MIN);
  return Math.round(Math.min(1, Math.max(0, t)) * 1000);
}

function paramsForDistance(distance: number) {
  return {
    distance,
    near: appState.near,
    far: appState.far,
    fovDeg: appState.fovDeg,
    keepScreenScale: appState.keepScreenScale,
    gapScale: appState.gapScale,
  };
}

function modeLabel(mode: Mode): string {
  if (mode === 'direct') return '直接深度';
  return '反向深度';
}

function createModeState(mode: Mode, width: number, height: number): ModeState {
  return {
    mode,
    session: new DepthSession({ mode, scene, width, height, depthType: appState.depthType }),
    stats: null,
  };
}

function disposeModes(): void {
  for (const state of modes) {
    state.session.canvas.remove();
    state.session.dispose();
  }
  modes = [];
}

function setupViewports(): void {
  disposeModes();
  const resolution = RESOLUTIONS[appState.resolutionIndex];
  modes = [createModeState('direct', resolution.width, resolution.height), createModeState('reversed', resolution.width, resolution.height)];
  // 立刻实测一次存储行为，让理论曲线和 UI 标签从一开始就是“实际”而不是“声称”的格式。
  for (const state of modes) state.session.probeStorage();

  for (const state of modes) {
    const card = required<HTMLElement>(document, `.viewport-card[data-mode="${state.mode}"]`);
    const slot = required<HTMLElement>(card, '[data-role="viewport"]');
    slot.replaceChildren(state.session.canvas);
    const legend = required<HTMLElement>(card, '[data-role="legend"]');
    legend.replaceChildren(...GAP_LABELS.map((label) => legendItemText(label)));
  }
  refreshCapabilityBadges();
  renderFrame();
}

function legendItemText(label: string): HTMLElement {
  const item = htmlEl('span', 'legend-item');
  const key = htmlEl('span', 'legend-item__key');
  key.style.background = CHART_COLORS.textMuted;
  item.append(key, document.createTextNode(`间距 ${label}`));
  return item;
}

function renderFrame(): void {
  if (modes.length === 0) return;
  const params = paramsForDistance(appState.distance);
  for (const state of modes) {
    state.session.renderFrame(params, appState.overlay);
    state.stats = state.session.measure(params);
  }
  updateStatsTables();
  updateModeMeta();
  // sampleContention 会把绑定重置到默认目标，因此放在合成之后，避免黑屏。
  updatePrecisionNote();
}

/** 把「实测争抢」与「理论步长」的对照写进统计卡标题，便于判读。 */
function updatePrecisionNote(): void {
  const summary = required<HTMLElement>(document, '#frame-summary');
  const parts = modes.map((state) => {
    const tile = state.stats?.tiles[0];
    if (!tile) return `${modeLabel(state.mode)} —`;
    return `${modeLabel(state.mode)} 间距${GAP_LABELS[0]}：争抢 ${tile.contestedPx}px、实测深度差中位 ${formatNumber(
      tile.deltaMedian,
      3,
    )}、理论码点步长 ${formatNumber(tile.predictedStep, 3)}`;
  });
  summary.textContent = parts.join(' · ');
}

function updateStatsTables(): void {
  let totalContested = 0;
  let totalCoverage = 0;
  for (const state of modes) {
    const tbody = required<HTMLElement>(
      document,
      `.stats-table-wrap[data-mode="${state.mode}"] [data-role="stats-body"]`,
    );
    tbody.replaceChildren();
    const stats = state.stats;
    if (!stats) continue;
    totalContested += stats.contestedPx;
    totalCoverage += stats.coveragePx;
    const maxRatio = Math.max(...stats.tiles.map((t) => t.ratio), 1e-9);
    for (const tile of stats.tiles) {
      const tr = htmlEl('tr');
      const name = htmlEl('td', undefined, `#${tile.index + 1} · ${GAP_LABELS[tile.index]}`);
      const contested = htmlEl('td', undefined, String(tile.contestedPx));
      const ratio = htmlEl('td', undefined, formatPercent(tile.ratio, 3));
      const meter = htmlEl('span', 'meter');
      const fill = htmlEl('span');
      fill.style.width = `${Math.min(100, (tile.ratio / maxRatio) * 100)}%`;
      meter.appendChild(fill);
      ratio.prepend(meter);
      const delta = htmlEl(
        'td',
        undefined,
        `${formatNumber(tile.deltaMedian, 3)} / ${formatNumber(tile.deltaMax, 3)}`,
      );
      if (tile.ratio > 0) {
        contested.dataset.hot = 'true';
        ratio.dataset.hot = 'true';
      }
      tr.append(name, contested, ratio, delta);
      tbody.appendChild(tr);
    }
  }
  const ratio = totalCoverage ? totalContested / totalCoverage : 0;
  const statsHeader = required<HTMLElement>(document, '#stats-summary');
  statsHeader.textContent = `合计争抢 ${totalContested} / ${totalCoverage} px（${formatPercent(ratio, 3)}）`;
}

function updateModeMeta(): void {
  for (const state of modes) {
    const card = required<HTMLElement>(document, `.viewport-card[data-mode="${state.mode}"]`);
    const meta = required<HTMLElement>(card, '[data-role="mode-meta"]');
    const attachment = state.session.readAttachmentInfo();
    const active = state.session.effectiveReversed;
    const requested = state.mode === 'reversed';
    const status =
      requested && !active
        ? 'EXT_clip_control 缺失，已回退直接深度'
        : active
          ? '反向深度已启用'
          : '直接深度';
    const storageNames: Record<string, string> = {
      fixed16: '实测 16 位定点',
      fixed24: '实测 24 位定点',
      f32: '实测 32F 浮点',
      unknown: '存储未知',
    };
    const measured = storageNames[state.session.storageModel()] ?? '存储未知';
    const declared = attachment.label;
    const suffix = measured.includes(declared.replace('深度', ''))
      ? measured
      : `${declared} · ${measured}`;
    meta.textContent = `${status} · ${suffix}`;
    meta.dataset.active = String(active);
  }
}

function refreshCapabilityBadges(): void {
  const container = required<HTMLElement>(document, '#capability-badges');
  container.replaceChildren();
  if (!capabilities) return;
  const caps = capabilities;
  const badges: { label: string; status: 'good' | 'warning' | 'critical' }[] = [
    {
      label: 'reversedDepthBuffer',
      status: caps.reversedDepthBufferActive ? 'good' : 'critical',
    },
    { label: 'EXT_clip_control', status: caps.extClipControl ? 'good' : 'critical' },
    { label: 'EXT_color_buffer_float', status: caps.floatColorBuffer ? 'good' : 'warning' },
    {
      label: caps.trueFixedPointAvailable ? '真定点深度可用' : '无真定点深度',
      status: caps.trueFixedPointAvailable ? 'good' : 'warning',
    },
  ];
  for (const badge of badges) {
    const node = htmlEl('span', 'badge');
    node.dataset.status = badge.status;
    const dot = htmlEl('span', 'badge__dot');
    node.append(dot, document.createTextNode(badge.label));
    container.appendChild(node);
  }
  const gpu = htmlEl('span', 'badge');
  gpu.dataset.status = 'good';
  const strong = htmlEl('strong', undefined, caps.gpu);
  gpu.append(document.createTextNode('GPU '), strong);
  container.appendChild(gpu);

  // 真实存储行为：很多驱动把 DEPTH_COMPONENT24 实现为 32F，必须显式告知。
  const storageNames: Record<string, string> = {
    fixed16: '16 位定点',
    fixed24: '24 位定点',
    f32: '32F 浮点',
    unknown: '未知',
  };
  const formatText = caps.formats
    .map(
      (f) =>
        `${f.label}→${f.attachable ? storageNames[f.storage] : '不可用'}`,
    )
    .join(' · ');
  const formatBadge = htmlEl('span', 'badge', formatText);
  container.appendChild(formatBadge);
}

function syncInputs(): void {
  const distanceInput = required<HTMLInputElement>(document, '#distance-input');
  distanceInput.value = String(sliderFromDistance(appState.distance));
  required<HTMLOutputElement>(document, '#distance-value').textContent = `${formatNumber(
    appState.distance,
    4,
  )}`;
  required<HTMLInputElement>(document, '#near-input').value = String(appState.near);
  required<HTMLInputElement>(document, '#far-input').value = String(appState.far);
  required<HTMLOutputElement>(document, '#near-value').textContent = formatNumber(appState.near, 4);
  required<HTMLOutputElement>(document, '#far-value').textContent = formatNumber(appState.far, 4);
  required<HTMLElement>(document, '#range-ratio').textContent = `far / near = ${formatNumber(
    appState.far / appState.near,
    4,
  )} · far − near = ${formatNumber(appState.far - appState.near, 4)}`;
  required<HTMLInputElement>(document, '#keep-ratio').checked = appState.keepScreenScale;
  required<HTMLInputElement>(document, '#gap-scale-input').value = String(
    Math.round(Math.log10(appState.gapScale) * 50 + 50),
  );
  required<HTMLOutputElement>(document, '#gap-scale-value').textContent = `×${formatNumber(
    appState.gapScale,
    3,
  )}`;
}

function buildControls(): void {
  const presets = required<HTMLElement>(document, '#camera-presets');
  for (const preset of CAMERA_PRESETS) {
    const button = htmlEl('button', 'chip', preset.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      appState.near = preset.near;
      appState.far = preset.far;
      syncInputs();
      renderFrame();
      refreshCharts();
    });
    presets.appendChild(button);
  }

  const distanceInput = required<HTMLInputElement>(document, '#distance-input');
  distanceInput.addEventListener('input', () => {
    appState.distance = distanceFromSlider(Number(distanceInput.value));
    syncInputs();
    renderFrame();
  });

  required<HTMLInputElement>(document, '#near-input').addEventListener('change', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0 && value < appState.far) {
      appState.near = value;
      syncInputs();
      renderFrame();
      refreshCharts();
    } else {
      syncInputs();
    }
  });
  required<HTMLInputElement>(document, '#far-input').addEventListener('change', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > appState.near) {
      appState.far = value;
      syncInputs();
      renderFrame();
      refreshCharts();
    } else {
      syncInputs();
    }
  });
  required<HTMLInputElement>(document, '#keep-ratio').addEventListener('change', (event) => {
    appState.keepScreenScale = (event.target as HTMLInputElement).checked;
    renderFrame();
  });
  required<HTMLInputElement>(document, '#gap-scale-input').addEventListener('input', (event) => {
    const t = Number((event.target as HTMLInputElement).value) / 100;
    appState.gapScale = Math.pow(10, (t - 0.5) * 2); // 0.1× – 10×
    syncInputs();
    renderFrame();
  });

  const modeToggles = required<HTMLElement>(document, '#mode-toggles');
  for (const mode of ['direct', 'reversed'] as const) {
    const button = htmlEl('button', 'mode-toggle');
    button.type = 'button';
    button.dataset.mode = mode;
    const title = htmlEl('span', 'mode-toggle__title');
    const swatch = htmlEl('span', `swatch swatch--${mode}`);
    title.append(swatch, document.createTextNode(modeLabel(mode)));
    const state = htmlEl('span', 'mode-toggle__state', '—');
    button.append(title, state);
    button.addEventListener('click', () => {
      appState.overlay = appState.overlay;
      renderFrame();
    });
    modeToggles.appendChild(button);
  }

  const storageToggles = required<HTMLElement>(document, '#storage-toggles');
  const storageOptions: { type: DepthAttachmentType; label: string; hint: string }[] = [
    { type: 'u16', label: '16 位定点', hint: '最易复现' },
    { type: 'u24', label: '24 位定点', hint: '驱动可能实现为 32F' },
    { type: 'f32', label: '32F 浮点', hint: '反向深度在此才有收益' },
  ];
  for (const option of storageOptions) {
    const button = htmlEl('button', 'chip', option.label);
    button.type = 'button';
    button.title = option.hint;
    button.dataset.storage = option.type;
    button.addEventListener('click', () => {
      appState.depthType = option.type;
      for (const state of modes) {
        state.session.setDepthType(option.type);
        state.session.probeStorage();
      }
      updateToggleStates();
      renderFrame();
      refreshCharts();
    });
    storageToggles.appendChild(button);
  }

  const overlayToggles = required<HTMLElement>(document, '#overlay-toggles');
  const overlayOptions: { value: OverlayMode; label: string }[] = [
    { value: 'none', label: '原始' },
    { value: 'contested', label: '争抢像素' },
    { value: 'delta', label: '深度差' },
  ];
  for (const option of overlayOptions) {
    const button = htmlEl('button', 'chip', option.label);
    button.type = 'button';
    button.dataset.overlay = option.value;
    button.addEventListener('click', () => {
      appState.overlay = option.value;
      updateToggleStates();
      renderFrame();
    });
    overlayToggles.appendChild(button);
  }

  const resolutionToggles = required<HTMLElement>(document, '#resolution-toggles');
  RESOLUTIONS.forEach((resolution, index) => {
    const button = htmlEl('button', 'chip', resolution.label);
    button.type = 'button';
    button.dataset.resolution = String(index);
    button.addEventListener('click', () => {
      if (appState.resolutionIndex === index) return;
      appState.resolutionIndex = index;
      if (capabilities) {
        const previous = modes[0]?.session.renderer;
        previous?.dispose();
      }
      setupViewports();
      updateToggleStates();
    });
    resolutionToggles.appendChild(button);
  });
}

function updateToggleStates(): void {
  for (const button of document.querySelectorAll<HTMLElement>('#storage-toggles .chip')) {
    button.setAttribute('aria-pressed', String(button.dataset.storage === appState.depthType));
  }
  for (const button of document.querySelectorAll<HTMLElement>('#overlay-toggles .chip')) {
    button.setAttribute('aria-pressed', String(button.dataset.overlay === appState.overlay));
  }
  for (const button of document.querySelectorAll<HTMLElement>('#resolution-toggles .chip')) {
    button.setAttribute(
      'aria-pressed',
      String(Number(button.dataset.resolution) === appState.resolutionIndex),
    );
  }
  for (const state of modes) {
    const button = document.querySelector<HTMLElement>(`#mode-toggles [data-mode="${state.mode}"]`);
    if (!button) continue;
    const active = state.session.effectiveReversed;
    button.dataset.active = String(state.mode === 'direct' ? !active : active);
    const stateLabel = button.querySelector<HTMLElement>('.mode-toggle__state');
    if (stateLabel) {
      if (state.mode === 'direct') stateLabel.textContent = active ? '已启用' : '已启用';
      else stateLabel.textContent = active ? '已启用' : '不可用：已回退';
    }
  }
}

function refreshCharts(): void {
  const precisionHost = required<HTMLElement>(document, '[data-role="precision-chart"]');
  const startDistance = Math.max(appState.near * 1.5, DISTANCE_MIN);
  const endDistance = Math.min(appState.far * 0.7, DISTANCE_MAX);
  if (!(endDistance > startDistance)) return;
  renderPrecisionChart(precisionHost, {
    near: appState.near,
    far: appState.far,
    startDistance,
    endDistance,
    curves: [
      {
        key: 'direct-fixed',
        label: '直接 · 定点',
        color: PRECISION_COLORS.directFixed,
        mode: 'direct',
        model: 'fixed24',
      },
      {
        key: 'reversed-fixed',
        label: '反向 · 定点',
        color: PRECISION_COLORS.reversedFixed,
        mode: 'reversed',
        model: 'fixed24',
      },
      {
        key: 'direct-f32',
        label: '直接 · 32F',
        color: PRECISION_COLORS.directF32,
        mode: 'direct',
        model: 'f32',
        dashed: true,
      },
      {
        key: 'reversed-f32',
        label: '反向 · 32F',
        color: PRECISION_COLORS.reversedF32,
        mode: 'reversed',
        model: 'f32',
        dashed: true,
      },
    ],
  });
}

function setupPrecisionTableToggle(): void {
  const button = required<HTMLButtonElement>(document, '[data-role="precision-table-toggle"]');
  button.addEventListener('click', () => {
    const host = required<HTMLElement>(document, '[data-role="precision-chart"]');
    const table = host.querySelector<HTMLElement>('[data-role="precision-table"]');
    if (!table) return;
    table.hidden = !table.hidden;
    button.textContent = table.hidden ? '表格视图' : '收起表格';
  });
}

function buildScanConfig(): void {
  const host = required<HTMLElement>(document, '#scan-config');
  host.replaceChildren();
  const config: ScanConfig = DEFAULT_SCAN_CONFIG;
  const fields: { key: keyof ScanConfig; label: string; step?: number }[] = [
    { key: 'near', label: 'near' },
    { key: 'far', label: 'far' },
    { key: 'startDistance', label: '起始距离' },
    { key: 'endDistance', label: '终止距离' },
    { key: 'steps', label: '采样点数', step: 1 },
    { key: 'overlapThreshold', label: '阈值（占比）' },
    { key: 'sustain', label: '连续样本数', step: 1 },
  ];
  for (const field of fields) {
    const label = htmlEl('label', 'field');
    const labelText = htmlEl('span', 'field__label', field.label);
    const input = htmlEl('input');
    input.type = 'number';
    input.step = String(field.step ?? 'any');
    input.value = String(config[field.key]);
    input.dataset.scanKey = field.key;
    label.append(labelText, input);
    host.appendChild(label);
  }
  required<HTMLElement>(document, '[data-role="sustain-label"]').textContent = String(config.sustain);
  required<HTMLElement>(document, '[data-role="threshold-label"]').textContent = formatPercent(
    config.overlapThreshold,
    2,
  );
}

function readScanConfig(): ScanConfig {
  const config: ScanConfig = { ...DEFAULT_SCAN_CONFIG };
  const inputs = document.querySelectorAll<HTMLInputElement>('#scan-config [data-scan-key]');
  for (const input of inputs) {
    const key = input.dataset.scanKey as keyof ScanConfig;
    const value = Number(input.value);
    if (Number.isFinite(value)) {
      (config as unknown as Record<string, number>)[key] = value;
    }
  }
  config.steps = Math.max(2, Math.floor(config.steps));
  config.sustain = Math.max(1, Math.floor(config.sustain));
  config.overlapThreshold = Math.max(0, config.overlapThreshold);
  return config;
}

async function runScanAll(): Promise<void> {
  if (scanBusy || modes.length === 0) return;
  scanBusy = true;
  const button = required<HTMLButtonElement>(document, '#scan-run');
  const copyButton = required<HTMLButtonElement>(document, '#scan-copy');
  const status = required<HTMLElement>(document, '#scan-status');
  button.disabled = true;
  copyButton.disabled = true;
  status.dataset.state = 'running';
  const config = readScanConfig();
  const distances = scanDistances(config);
  status.textContent = `扫描中… 0/${distances.length}`;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  try {
    const results: Partial<Record<Mode, ScanResult>> = {};
    for (const state of modes) {
      const result = runScan(state.session, config, (step, total) => {
        status.textContent = `扫描中… ${step.step + 1}/${total} · ${modeLabel(state.mode)}`;
      });
      results[state.mode] = result;
    }
    scanResults = results;
    status.dataset.state = 'done';
    const direct = results.direct;
    status.textContent = direct
      ? `完成：${distances.length} 个采样点，指纹 ${direct.digest}`
      : '完成';
    renderScanPanels();
    copyButton.disabled = false;
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = `扫描失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    scanBusy = false;
    button.disabled = false;
  }
}

function renderScanPanels(): void {
  for (const mode of ['direct', 'reversed'] as const) {
    const host = required<HTMLElement>(document, `[data-testid="scan-chart-${mode}"]`);
    const summaryHost = required<HTMLElement>(document, `[data-testid="scan-summary-${mode}"]`);
    const result = scanResults[mode];
    summaryHost.replaceChildren();
    if (!result) {
      host.replaceChildren();
      continue;
    }
    renderScanChart(host, { mode, result });
    renderScanSummary(summaryHost, result, mode);
  }
  renderScanTable();
  const output = required<HTMLElement>(document, '[data-testid="scan-output"]');
  const direct = scanResults.direct;
  const reversed = scanResults.reversed;
  if (direct && reversed) {
    latestScanSummary = [
      formatScanSummary(direct, `直接深度 · ${storageName(modes[0])}`),
      '',
      formatScanSummary(reversed, `反向深度 · ${storageName(modes[1])}`),
    ].join('\n');
    const digest = htmlEl('p', 'scan-digest', `直接 ${direct.digest} · 反向 ${reversed.digest}`);
    output.replaceChildren(digest);
  } else {
    output.replaceChildren();
    latestScanSummary = '';
  }
}

function storageName(state: ModeState | undefined): string {
  if (!state) return '未知';
  const names: Record<string, string> = {
    fixed16: '16 位定点',
    fixed24: '24 位定点',
    f32: '32F 浮点',
  };
  return names[state.session.storageModel()] ?? '未知';
}

function renderScanSummary(host: HTMLElement, result: ScanResult, mode: Mode): void {
  for (const onset of result.onsets) {
    const row = htmlEl('div', 'summary-row');
    const key = htmlEl('span', 'summary-row__key');
    key.style.background = CHART_COLORS.series[onset.index];
    const label = htmlEl('span', 'summary-row__label', `#${onset.index + 1} 间距 ${GAP_LABELS[onset.index]}`);
    const value = htmlEl(
      'span',
      'summary-row__value',
      onset.measured === null ? '未触发' : `z≈${formatNumber(onset.measured, 3)}`,
    );
    row.append(key, label, value);
    if (onset.predicted !== null) {
      // 这是“一个码点 = 间距”的解析解，只覆盖深度量化本身；
      // 实测通常更早触发，因为顶点级浮点误差与斜坡几何都会贡献额外的相等判定。
      const storageLabel = mode === 'direct' ? storageName(modes[0]) : storageName(modes[1]);
      const note = htmlEl(
        'span',
        'summary-row__note',
        `量化下限（${storageLabel}，不含顶点误差）：${formatNumber(onset.predicted, 3)}`,
      );
      row.appendChild(note);
    }
    host.appendChild(row);
  }
}

function renderScanTable(): void {
  const host = required<HTMLElement>(document, '[data-testid="scan-table"]');
  // 直接复用反向模式面板生成的表格样式：先清空再放两张表
  host.replaceChildren();
  host.hidden = false;
  for (const mode of ['direct', 'reversed'] as const) {
    const result = scanResults[mode];
    if (!result) continue;
    const title = htmlEl('h3', undefined, `${modeLabel(mode)} · 扫描明细`);
    host.appendChild(title);
    const chartHost = required<HTMLElement>(document, `[data-testid="scan-chart-${mode}"]`);
    const table = chartHost.querySelector<HTMLElement>('[data-role="scan-table"]');
    if (table) {
      table.hidden = false;
      host.appendChild(table);
    }
  }
}

async function copyScanResults(): Promise<void> {
  if (!latestScanSummary) return;
  const button = required<HTMLButtonElement>(document, '#scan-copy');
  try {
    await navigator.clipboard.writeText(latestScanSummary);
    const previous = button.textContent;
    button.textContent = '已复制';
    window.setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  } catch {
    // 剪贴板不可用时退回下载
    const blob = new Blob([latestScanSummary], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'depth-scan.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }
}

function boot(): void {
  const probe = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  capabilities = readCapabilities(probe);
  probe.dispose();

  buildControls();
  buildScanConfig();
  setupPrecisionTableToggle();
  setupViewports();
  syncInputs();
  updateToggleStates();
  refreshCharts();
  renderScanPanels();

  required<HTMLButtonElement>(document, '#scan-run').addEventListener('click', () => {
    void runScanAll();
  });
  required<HTMLButtonElement>(document, '#scan-copy').addEventListener('click', () => {
    void copyScanResults();
  });

  // 暴露只读状态给 e2e 测试。
  (window as unknown as Record<string, unknown>).__DEPTH_LAB__ = {
    getState: () => ({ ...appState, capabilities }),
    getStats: () =>
      modes.map((state) => ({
        mode: state.mode,
        effectiveReversed: state.session.effectiveReversed,
        storageModel: state.session.storageModel(),
        stats: state.stats,
      })),
    runScan: async (config?: Partial<ScanConfig>) => {
      if (config) {
        for (const [key, value] of Object.entries(config)) {
          const input = document.querySelector<HTMLInputElement>(
            `#scan-config [data-scan-key="${key}"]`,
          );
          if (input && value !== undefined) input.value = String(value);
        }
      }
      await runScanAll();
      return scanResults;
    },
    getScanSummary: () => latestScanSummary,
    setDistance: (distance: number) => {
      appState.distance = distance;
      syncInputs();
      renderFrame();
      refreshCharts();
      return appState.distance;
    },
    diagnose: (distance: number) => {
      appState.distance = distance;
      renderFrame();
      return modes.map((state) => ({
        mode: state.mode,
        effectiveReversed: state.session.effectiveReversed,
        storageModel: state.session.storageModel(),
        tiles: state.stats?.tiles ?? [],
      }));
    },
    tileCoverageBounds: () =>
      modes.map((state) => ({
        mode: state.mode,
        bounds: GAP_RATIOS.map((_, index) => state.session.tileCoverageBounds(index)),
      })),
    getContestedMask: () =>
      modes.map((state) => ({
        mode: state.mode,
        width: state.session.width,
        height: state.session.height,
        mask: Array.from(state.session.readContestedMask().filter((_, i) => i % 4 === 0)),
      })),
    sampleDepthAt: (x: number, y: number) =>
      modes.map((state) => ({
        mode: state.mode,
        depths: state.session.sampleDepthAt(x, y),
      })),
  };
}

boot();
