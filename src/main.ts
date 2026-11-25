import './style.css';
import * as THREE from 'three';
import { CompareScene } from './scene';

const container = document.getElementById('app')!;
const compare = new CompareScene(container);

// ---------- 小工具：滑块 + 数值 ----------
function bindSlider(id: string, onChange: (v: number) => void): void {
  const el = document.getElementById(id) as HTMLInputElement;
  const out = document.getElementById(`${id}-val`)!;
  const apply = () => {
    const v = parseFloat(el.value);
    out.textContent = el.step.includes('.') ? v.toFixed(2) : `${v}°`;
    onChange(v);
  };
  el.addEventListener('input', apply);
  apply();
}

function setSlider(id: string, v: number): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = String(v);
  el.dispatchEvent(new Event('input'));
}

// ---------- 材质参数 ----------
const state = {
  isoRough: 0.35,
  roughAlong: 0.22,
  roughAcross: 0.62,
};

function applyRoughness(): void {
  compare.setRoughness('iso', state.isoRough, state.isoRough);
  compare.setRoughness('aniso', state.roughAlong, state.roughAcross);
}

bindSlider('iso-rough', (v) => {
  state.isoRough = v;
  applyRoughness();
});
bindSlider('rough-along', (v) => {
  state.roughAlong = v;
  applyRoughness();
});
bindSlider('rough-across', (v) => {
  state.roughAcross = v;
  applyRoughness();
});
applyRoughness();

// ---------- 纹路方向 ----------
const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="grain-mode"]');
modeRadios.forEach((r) =>
  r.addEventListener('change', () => {
    compare.setGrainMode(r.value === 'circular' ? 'circular' : 'linear');
  }),
);
bindSlider('grain-angle', (v) => compare.setGrainAngle(v));
bindSlider('aniso-offset', (v) => compare.setAnisoAngleOffset(v));
bindSlider('object-yaw', (v) => compare.setObjectYaw(v));

// ---------- 灯 ----------
const azEl = document.getElementById('light-az') as HTMLInputElement;
const elEl = document.getElementById('light-el') as HTMLInputElement;
function syncLightSliders(): void {
  const { azimuth, elevation } = compare.getLightOrbit();
  azEl.value = String(THREE.MathUtils.radToDeg(azimuth));
  elEl.value = String(THREE.MathUtils.radToDeg(elevation));
  document.getElementById('light-az-val')!.textContent = `${azEl.value}°`;
  document.getElementById('light-el-val')!.textContent = `${elEl.value}°`;
}
azEl.addEventListener('input', () => {
  compare.setLightOrbit(
    THREE.MathUtils.degToRad(parseFloat(azEl.value)),
    THREE.MathUtils.degToRad(parseFloat(elEl.value)),
  );
  syncLightSliders();
});
elEl.addEventListener('input', () => {
  compare.setLightOrbit(
    THREE.MathUtils.degToRad(parseFloat(azEl.value)),
    THREE.MathUtils.degToRad(parseFloat(elEl.value)),
  );
  syncLightSliders();
});
compare.onLightMoved = () => syncLightSliders();
syncLightSliders();

// ---------- 视角预设 ----------
document.getElementById('view-front')!.addEventListener('click', () => compare.setViewPreset('front'));
document.getElementById('view-grazing')!.addEventListener('click', () => compare.setViewPreset('grazing'));

// ---------- 显示开关（不改变材质状态） ----------
const dirToggle = document.getElementById('show-directions') as HTMLInputElement;
dirToggle.addEventListener('change', () => compare.inspector.setVisible(dirToggle.checked));
const fieldToggle = document.getElementById('show-field') as HTMLInputElement;
fieldToggle.addEventListener('change', () => compare.setFieldVisible(fieldToggle.checked));
document.getElementById('clear-markers')!.addEventListener('click', () => compare.inspector.clear());

// ---------- 对照预设 ----------
function resetCommon(): void {
  setSlider('object-yaw', 0);
  setSlider('grain-angle', 0);
  compare.setGrainMode('linear');
  (document.querySelector('input[name="grain-mode"][value="linear"]') as HTMLInputElement).checked = true;
  compare.inspector.clear();
}

document.getElementById('preset-rotate90')!.addEventListener('click', () => {
  // 刻意把右侧拉丝纹路相对左侧转 90°：同灯位、同粗糙度，只交换顺纹/横纹
  resetCommon();
  setSlider('aniso-offset', 90);
  setSlider('iso-rough', 0.35);
  setSlider('rough-along', 0.22);
  setSlider('rough-across', 0.62);
  setStatus('已载入 90° 对照：两块样板仅纹路方向相差 90°，拖动灯位观察高光长轴是否随纹路转。');
});

document.getElementById('preset-equal')!.addEventListener('click', () => {
  // 两方向粗糙度相同：aniso 舞台在数学上退化为各向同性，应与左侧看不出拉丝差别
  resetCommon();
  setSlider('aniso-offset', 0);
  setSlider('iso-rough', 0.35);
  setSlider('rough-along', 0.35);
  setSlider('rough-across', 0.35);
  setStatus('已载入等粗糙度校验：顺纹/横纹粗糙度均为 0.35，两块样板高光形状应一致，拉丝感消失。');
});

document.getElementById('preset-default')!.addEventListener('click', () => {
  resetCommon();
  setSlider('aniso-offset', 0);
  setSlider('iso-rough', 0.35);
  setSlider('rough-along', 0.22);
  setSlider('rough-across', 0.62);
  setStatus('已恢复默认参数。');
});

function setStatus(msg: string): void {
  document.getElementById('status')!.textContent = msg;
}

// ---------- 点击拾取（区分轨道拖拽与点击） ----------
const dom = compare.renderer.domElement;
let downX = 0;
let downY = 0;
dom.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
dom.addEventListener('pointerup', (e) => {
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved > 5) return; // 轨道旋转或拖灯，忽略
  const rect = container.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const info = compare.handleSurfaceClick(ndcX, ndcY);
  if (info) {
    document.getElementById('pick-info')!.textContent = info;
    setStatus('已在表面放置方向标记：青色=纹路方向，黄色=横过纹路，标记随物体转动。');
  }
});

// ---------- 渲染循环 ----------
function loop(): void {
  compare.render();
  requestAnimationFrame(loop);
}
loop();
