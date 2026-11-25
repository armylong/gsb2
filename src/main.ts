import './style.css';

import {
  DEFAULT_PARAMS,
  PRESETS,
  type GpuReadout,
  type SceneParams,
  type Vec3,
} from './scene/config';
import {
  antiSunDirection,
  clamp,
  DEG,
  directionAngles,
  exposureScale,
  eyeHeightFromSlider,
  farRidgeDirection,
  horizonDirection,
  intersectSceneCpu,
  projectDirection,
  sliderFromEyeHeight,
  sunDirection,
  viewRay,
} from './scene/math';
import { ComponentRenderer, MainRenderer } from './gl/renderer';
import { fmt, luminance } from './ui/format';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
};

const state: SceneParams = { ...DEFAULT_PARAMS };
const selectedNdc: { x: number; y: number } = { x: 0.12, y: -0.08 };

const mainCanvas = $<HTMLCanvasElement>('mainCanvas');
const rayCanvas = $<HTMLCanvasElement>('rayCanvas');
const mieCanvas = $<HTMLCanvasElement>('mieCanvas');
const glError = $<HTMLDivElement>('glError');

const sunInput = $<HTMLInputElement>('sunElevation');
const eyeInput = $<HTMLInputElement>('eyeHeight');
const pitchInput = $<HTMLInputElement>('viewPitch');
const yawInput = $<HTMLInputElement>('yaw');
const turbidityInput = $<HTMLInputElement>('turbidity');
const exposureInput = $<HTMLInputElement>('exposureEv');
const rayleighInput = $<HTMLInputElement>('rayleighEnabled');
const mieInput = $<HTMLInputElement>('mieEnabled');
const autoExposureInput = $<HTMLInputElement>('autoExposure');

const sunValue = $<HTMLOutputElement>('sunElevationValue');
const eyeValue = $<HTMLOutputElement>('eyeHeightValue');
const pitchValue = $<HTMLOutputElement>('viewPitchValue');
const yawValue = $<HTMLOutputElement>('yawValue');
const turbidityValue = $<HTMLOutputElement>('turbidityValue');
const exposureValue = $<HTMLOutputElement>('exposureEvValue');
const averageLuminanceText = $<HTMLParagraphElement>('averageLuminance');

const rayState = $<HTMLSpanElement>('rayState');
const mieState = $<HTMLSpanElement>('mieState');

const readElevation = $<HTMLElement>('readElevation');
const readAzimuth = $<HTMLElement>('readAzimuth');
const readHit = $<HTMLElement>('readHit');
const readDistance = $<HTMLElement>('readDistance');
const readMeta = $<HTMLParagraphElement>('readMeta');
const componentRows = $<HTMLTableSectionElement>('componentRows');
const probeRows = $<HTMLTableSectionElement>('probeRows');

const selectedMarker = $<HTMLDivElement>('selectedMarker');
const sunMarker = $<HTMLDivElement>('sunMarker');
const antiMarker = $<HTMLDivElement>('antiMarker');

const HIT_NAMES = ['天空', '近山脊', '远山脊', '地面'] as const;

function showError(error: unknown): void {
  glError.hidden = false;
  glError.textContent = error instanceof Error ? error.message : String(error);
}

let mainRenderer: MainRenderer;
let rayRenderer: ComponentRenderer;
let mieRenderer: ComponentRenderer;

try {
  mainRenderer = new MainRenderer(mainCanvas);
  rayRenderer = new ComponentRenderer(rayCanvas, 1);
  mieRenderer = new ComponentRenderer(mieCanvas, 2);
} catch (error) {
  showError(error);
  throw error;
}

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    update();
  });
}

function updateLabels(): void {
  sunValue.textContent = `${state.sunElevationDeg.toFixed(1)}°`;

  const heightM = state.cameraHeightKm * 1000;
  eyeValue.textContent = heightM >= 1000
    ? `${(heightM / 1000).toFixed(2)} km`
    : `${heightM.toFixed(0)} m`;

  pitchValue.textContent = `${state.viewPitchDeg.toFixed(1)}°`;
  yawValue.textContent = `${state.yawDeg.toFixed(1)}°`;
  turbidityValue.textContent = `T=${state.turbidity.toFixed(1)}`;
  exposureValue.textContent = `${state.exposureEv.toFixed(2)} EV`;

  exposureInput.disabled = state.autoExposure;
  rayState.textContent = state.rayleighEnabled ? '显示中' : '已关闭';
  mieState.textContent = state.mieEnabled ? '显示中' : '已关闭';
  rayState.classList.toggle('off', !state.rayleighEnabled);
  mieState.classList.toggle('off', !state.mieEnabled);
}

function syncControls(): void {
  sunInput.value = String(state.sunElevationDeg);
  eyeInput.value = String(sliderFromEyeHeight(state.cameraHeightKm));
  pitchInput.value = String(state.viewPitchDeg);
  yawInput.value = String(state.yawDeg);
  turbidityInput.value = String(state.turbidity);
  exposureInput.value = String(state.exposureEv);
  rayleighInput.checked = state.rayleighEnabled;
  mieInput.checked = state.mieEnabled;
  autoExposureInput.checked = state.autoExposure;
  updateLabels();
}

sunInput.addEventListener('input', () => {
  state.sunElevationDeg = Number(sunInput.value);
  updateLabels();
  scheduleRender();
});

eyeInput.addEventListener('input', () => {
  state.cameraHeightKm = eyeHeightFromSlider(Number(eyeInput.value));
  updateLabels();
  scheduleRender();
});

pitchInput.addEventListener('input', () => {
  state.viewPitchDeg = Number(pitchInput.value);
  updateLabels();
  scheduleRender();
});

yawInput.addEventListener('input', () => {
  state.yawDeg = Number(yawInput.value);
  updateLabels();
  scheduleRender();
});

turbidityInput.addEventListener('input', () => {
  state.turbidity = Number(turbidityInput.value);
  updateLabels();
  scheduleRender();
});

rayleighInput.addEventListener('change', () => {
  state.rayleighEnabled = rayleighInput.checked;
  updateLabels();
  scheduleRender();
});

mieInput.addEventListener('change', () => {
  state.mieEnabled = mieInput.checked;
  updateLabels();
  scheduleRender();
});

autoExposureInput.addEventListener('change', () => {
  state.autoExposure = autoExposureInput.checked;
  updateLabels();
  scheduleRender();
});

exposureInput.addEventListener('input', () => {
  state.autoExposure = false;
  autoExposureInput.checked = false;
  state.exposureEv = Number(exposureInput.value);
  updateLabels();
  scheduleRender();
});

for (const [id, presetKey] of [
  ['presetNoon', 'noon'],
  ['presetLow', 'lowSun'],
  ['presetExtreme', 'extreme'],
] as const) {
  const button = $<HTMLButtonElement>(id);
  button.addEventListener('click', () => {
    Object.assign(state, PRESETS[presetKey]);
    syncControls();
    scheduleRender();
  });
}

$<HTMLButtonElement>('resetView').addEventListener('click', () => {
  state.yawDeg = 0;
  state.viewPitchDeg = PRESETS.lowSun.viewPitchDeg;
  syncControls();
  scheduleRender();
});

$<HTMLButtonElement>('lookBack').addEventListener('click', () => {
  const anti = antiSunDirection(state);
  state.yawDeg = Math.atan2(anti[0], anti[2]) / DEG;
  state.viewPitchDeg = clamp(-state.sunElevationDeg, -10, 25);
  syncControls();
  scheduleRender();
});

interface PointerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

let drag: PointerDrag | null = null;

mainCanvas.addEventListener('pointerdown', (event: PointerEvent) => {
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    moved: false,
  };
  mainCanvas.setPointerCapture(event.pointerId);
});

mainCanvas.addEventListener('pointermove', (event: PointerEvent) => {
  if (!drag || drag.pointerId !== event.pointerId) return;

  const totalMove = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (totalMove > 5) drag.moved = true;

  if (drag.moved) {
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    state.yawDeg = clamp(state.yawDeg - dx * 0.22, -180, 180);
    state.viewPitchDeg = clamp(state.viewPitchDeg - dy * 0.16, -10, 25);
    yawInput.value = String(state.yawDeg);
    pitchInput.value = String(state.viewPitchDeg);
    updateLabels();
    scheduleRender();
  }

  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
});

function pickFromPointer(event: PointerEvent): void {
  const rect = mainCanvas.getBoundingClientRect();
  selectedNdc.x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
  selectedNdc.y = clamp(1 - ((event.clientY - rect.top) / rect.height) * 2, -1, 1);
  positionSelectedMarker();
  scheduleRender();
}

mainCanvas.addEventListener('pointerup', (event: PointerEvent) => {
  if (drag && drag.pointerId === event.pointerId && !drag.moved) {
    pickFromPointer(event);
  }
  drag = null;
});

mainCanvas.addEventListener('pointercancel', () => {
  drag = null;
});

mainCanvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  showError('WebGL2 上下文丢失，请刷新页面重新初始化。');
});

function canvasAspect(): number {
  const rect = mainCanvas.getBoundingClientRect();
  return Math.max(0.2, rect.width / Math.max(1, rect.height));
}

function positionSelectedMarker(): void {
  selectedMarker.hidden = false;
  selectedMarker.style.left = `${(selectedNdc.x * 0.5 + 0.5) * 100}%`;
  selectedMarker.style.top = `${(1 - (selectedNdc.y * 0.5 + 0.5)) * 100}%`;
}

function positionDirectionMarker(
  marker: HTMLDivElement,
  direction: Vec3,
  aspect: number,
): void {
  const projected = projectDirection(direction, state, aspect);
  if (!projected) {
    marker.hidden = true;
    return;
  }

  const clampedX = clamp(projected.x, -0.94, 0.94);
  const clampedY = clamp(projected.y, -0.9, 0.9);
  marker.hidden = false;
  marker.style.left = `${(clampedX * 0.5 + 0.5) * 100}%`;
  marker.style.top = `${(1 - (clampedY * 0.5 + 0.5)) * 100}%`;
  marker.classList.toggle(
    'offscreen',
    Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1,
  );
}

function updateMarkers(): void {
  const aspect = canvasAspect();
  positionSelectedMarker();
  positionDirectionMarker(sunMarker, sunDirection(state), aspect);
  positionDirectionMarker(antiMarker, antiSunDirection(state), aspect);
}

function renderComponentRows(readout: GpuReadout): void {
  const rows: Array<{ key: string; name: string; value: Vec3; trans?: boolean }> = [
    { key: 'total', name: '合成 HDR', value: readout.total },
    { key: 'rayleigh', name: '瑞利散射', value: readout.rayleigh },
    { key: 'mie', name: '雾粒散射', value: readout.mie },
    { key: 'surface', name: '表面底色辐射', value: readout.surface },
    { key: 'direct', name: '直接光源项', value: readout.direct },
    { key: 'trans', name: '视线透射率', value: readout.transmittance, trans: true },
  ];

  componentRows.innerHTML = rows.map((row) => {
    const brightness = row.trans
      ? (row.value[0] + row.value[1] + row.value[2]) / 3
      : luminance(row.value);
    return `
      <tr>
        <td><span class="component-name"><i class="swatch ${row.key}"></i>${row.name}</span></td>
        <td>${fmt(row.value[0])}</td>
        <td>${fmt(row.value[1])}</td>
        <td>${fmt(row.value[2])}</td>
        <td>${fmt(brightness)}</td>
      </tr>
    `;
  }).join('');
}

function updateSelectedReadout(): GpuReadout {
  const aspect = canvasAspect();
  const direction = viewRay(state, selectedNdc.x, selectedNdc.y, aspect);
  const angles = directionAngles(direction);
  const cpuHit = intersectSceneCpu(state.cameraHeightKm, direction);
  const gpu = mainRenderer.readAtNdc(selectedNdc.x, selectedNdc.y);

  readElevation.textContent = `${fmt(angles.elevationDeg, 2)}°`;
  readAzimuth.textContent = `${fmt(angles.azimuthDeg, 2)}°`;

  const gpuName = HIT_NAMES[gpu.hitId] ?? `ID ${gpu.hitId}`;
  const isRidge = gpu.hitId === 1 || gpu.hitId === 2;
  readHit.textContent = isRidge ? gpuName : gpuName;
  readHit.style.color = isRidge ? '#f0c69b' : gpu.hitId === 0 ? '#7db7ff' : '#e8eef8';

  if (gpu.hitId === 0) {
    readDistance.textContent = '光路至大气/行星边界';
  } else {
    readDistance.textContent = `${fmt(gpu.distanceKm, 2)} km`;
  }

  const cpuMatches = cpuHit.id === gpu.hitId;
  readMeta.textContent =
    `观察向量 (${direction.map((v) => fmt(v, 4)).join(', ')}) · ` +
    `CPU 求交：${cpuHit.label}${cpuHit.id === 0 ? '' : ` @ ${fmt(cpuHit.distanceKm, 2)} km`} · ` +
    `GPU ID：${gpu.hitId}${cpuMatches ? '（一致）' : '（边缘采样容差）'}`;

  renderComponentRows(gpu);
  return gpu;
}

function hitCell(readout: GpuReadout): string {
  const name = HIT_NAMES[readout.hitId] ?? `ID ${readout.hitId}`;
  const className = readout.hitId === 0
    ? 'sky'
    : readout.hitId === 3
      ? 'probe-hit'
      : 'ridge';
  return `<td class="probe-hit ${className}">${name}</td>`;
}

function updateProbeRows(): void {
  const probes = [
    { name: '太阳中心', direction: sunDirection(state) },
    { name: '远山轮廓', direction: farRidgeDirection() },
    { name: '背光反太阳', direction: antiSunDirection(state) },
    { name: '地平线', direction: horizonDirection(state) },
  ];

  probeRows.innerHTML = probes.map((probe) => {
    const result = mainRenderer.probe(probe.direction, state);
    return `
      <tr>
        <td>${probe.name}</td>
        ${hitCell(result)}
        <td>${fmt(luminance(result.total), 2)}</td>
        <td>${fmt(luminance(result.rayleigh), 2)}</td>
        <td>${fmt(luminance(result.mie), 2)}</td>
      </tr>
    `;
  }).join('');
}

function update(): void {
  try {
    const mainResult = mainRenderer.render(state);

    if (state.autoExposure && mainResult.autoExposureEv !== null) {
      state.exposureEv = mainResult.autoExposureEv;
      exposureInput.value = state.exposureEv.toFixed(2);
    }
    updateLabels();

    // Finish every main-context HDR readback before presenting the other two
    // WebGL contexts; some drivers otherwise delay/switch the read target.
    updateSelectedReadout();
    updateProbeRows();

    rayRenderer.render(state);
    mieRenderer.render(state);
    updateMarkers();

    if (state.autoExposure) {
      if (mainResult.averageLuminance === null) {
        averageLuminanceText.textContent = '自动测光样本过暗，已使用曝光下限附近的值。';
      } else {
        averageLuminanceText.textContent =
          `几何平均亮度 ${fmt(mainResult.averageLuminance, 3)} → ` +
          `${state.exposureEv.toFixed(2)} EV；取消自动曝光即可冻结对照亮度。`;
      }
    } else {
      averageLuminanceText.textContent =
        `固定亮度：${state.exposureEv.toFixed(2)} EV（线性倍率 ×${fmt(exposureScale(state.exposureEv), 3)}）。两个预设共用此设置。`;
    }
  } catch (error) {
    showError(error);
  }
}

const resizeObserver = new ResizeObserver(() => scheduleRender());
resizeObserver.observe(mainCanvas);
resizeObserver.observe(rayCanvas);
resizeObserver.observe(mieCanvas);
window.addEventListener('resize', scheduleRender);

syncControls();
positionSelectedMarker();
update();
