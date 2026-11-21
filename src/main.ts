import * as THREE from 'three';
import { buildScene, type Sample } from './scene';
import { filmColorSrgb, filmReflectance, reflectanceSpectrum } from './physics';
import {
  BUILTIN_PRESETS,
  loadUserPresets,
  saveUserPresets,
  type SampleState,
  type ViewPreset,
} from './presets';

const container = document.getElementById('viewport')!;
const bundle = buildScene(container);
const { renderer, scene, camera, controls, samples, lightRig, keyLight } = bundle;

// ---------------------------------------------------------------- 状态

interface AppState {
  light: { azimuthDeg: number; elevationDeg: number; fixed: boolean };
  samples: [SampleState, SampleState];
}

const state: AppState = {
  light: { azimuthDeg: 35, elevationDeg: 55, fixed: true },
  samples: [
    { thicknessNm: 500, gradientOn: false, gradientSpanNm: 400, filmOn: true },
    { thicknessNm: 500, gradientOn: false, gradientSpanNm: 400, filmOn: true },
  ],
};

const READOUT_WAVELENGTHS = [450, 500, 550, 600, 650];

// ---------------------------------------------------------------- 照明

function lightDirection(): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(state.light.azimuthDeg);
  const el = THREE.MathUtils.degToRad(state.light.elevationDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();
}

function applyLighting(): void {
  // 固定照明：世界系方向；非固定：跟随相机视线方向（便于打光找高光）
  const dir = state.light.fixed
    ? lightDirection()
    : camera.position.clone().sub(controls.target).normalize();
  for (const s of samples) s.film.uniforms.uLightDir.value.copy(dir);
  keyLight.position.copy(dir).multiplyScalar(6);
  lightRig.position.copy(dir).multiplyScalar(3.2);
  lightRig.lookAt(0, 0, 0);
}

// ---------------------------------------------------------------- 样片参数 → uniform

function applySampleState(i: number): void {
  const st = state.samples[i];
  const u = samples[i].film.uniforms;
  u.uThickness.value = st.thicknessNm;
  u.uGradientOn.value = st.gradientOn ? 1 : 0;
  u.uGradientSpan.value = st.gradientSpanNm;
  u.uFilmOn.value = st.filmOn ? 1 : 0;
}

function applyAll(): void {
  applySampleState(0);
  applySampleState(1);
  applyLighting();
}

// ---------------------------------------------------------------- 样片控制 UI

function buildSampleControls(): void {
  const host = document.getElementById('sample-controls')!;
  samples.forEach((sample: Sample, i: number) => {
    const st = state.samples[i];
    const fs = document.createElement('fieldset');
    fs.innerHTML = `<legend>${sample.name}</legend>`;

    const row = (label: string, min: number, max: number, step: number, val: number, onInput: (v: number, out: HTMLOutputElement) => void) => {
      const l = document.createElement('label');
      l.className = 'row';
      l.innerHTML = `<span>${label}</span>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(val);
      const out = document.createElement('output');
      const update = () => { onInput(Number(input.value), out); };
      input.addEventListener('input', update);
      update();
      l.append(input, out);
      fs.appendChild(l);
      return input;
    };

    const thicknessSlider = row('膜厚', 0, 1000, 1, st.thicknessNm, (v, out) => {
      st.thicknessNm = v;
      out.value = `${v} nm`;
      applySampleState(i);
    });
    const spanSlider = row('渐变幅度', 0, 900, 5, st.gradientSpanNm, (v, out) => {
      st.gradientSpanNm = v;
      out.value = `+${v} nm`;
      applySampleState(i);
    });

    const checks = document.createElement('div');
    checks.className = 'checks';
    const gradLabel = document.createElement('label');
    const gradBox = document.createElement('input');
    gradBox.type = 'checkbox';
    gradBox.checked = st.gradientOn;
    gradBox.addEventListener('change', () => {
      st.gradientOn = gradBox.checked;
      applySampleState(i);
    });
    gradLabel.append(gradBox, ' 沿曲面渐变');
    const filmLabel = document.createElement('label');
    const filmBox = document.createElement('input');
    filmBox.type = 'checkbox';
    filmBox.checked = st.filmOn;
    filmBox.addEventListener('change', () => {
      st.filmOn = filmBox.checked;
      applySampleState(i);
    });
    filmLabel.append(filmBox, ' 启用薄膜层');
    checks.append(gradLabel, filmLabel);
    fs.appendChild(checks);

    // 供预设回填
    sampleUI[i] = { thicknessSlider, spanSlider, gradBox, filmBox };
    host.appendChild(fs);
  });
}

interface SampleUIRefs {
  thicknessSlider: HTMLInputElement;
  spanSlider: HTMLInputElement;
  gradBox: HTMLInputElement;
  filmBox: HTMLInputElement;
}
const sampleUI: SampleUIRefs[] = [];

function refreshSampleUI(): void {
  state.samples.forEach((st, i) => {
    const ui = sampleUI[i];
    ui.thicknessSlider.value = String(st.thicknessNm);
    ui.thicknessSlider.dispatchEvent(new Event('input'));
    ui.spanSlider.value = String(st.gradientSpanNm);
    ui.spanSlider.dispatchEvent(new Event('input'));
    ui.gradBox.checked = st.gradientOn;
    ui.filmBox.checked = st.filmOn;
  });
}

// ---------------------------------------------------------------- 照明 UI

function bindLightUI(): void {
  const az = document.getElementById('light-az') as HTMLInputElement;
  const el = document.getElementById('light-el') as HTMLInputElement;
  const fixed = document.getElementById('light-fixed') as HTMLInputElement;
  const azV = document.getElementById('light-az-v') as HTMLOutputElement;
  const elV = document.getElementById('light-el-v') as HTMLOutputElement;
  const update = () => {
    state.light.azimuthDeg = Number(az.value);
    state.light.elevationDeg = Number(el.value);
    state.light.fixed = fixed.checked;
    azV.value = `${az.value}°`;
    elV.value = `${el.value}°`;
    applyLighting();
  };
  az.addEventListener('input', update);
  el.addEventListener('input', update);
  fixed.addEventListener('change', update);
  update();
}

function refreshLightUI(): void {
  (document.getElementById('light-az') as HTMLInputElement).value = String(state.light.azimuthDeg);
  (document.getElementById('light-el') as HTMLInputElement).value = String(state.light.elevationDeg);
  (document.getElementById('light-fixed') as HTMLInputElement).checked = state.light.fixed;
  for (const id of ['light-az', 'light-el', 'light-fixed']) {
    document.getElementById(id)!.dispatchEvent(new Event(id === 'light-fixed' ? 'change' : 'input'));
  }
}

// ---------------------------------------------------------------- 点选取样

const raycaster = new THREE.Raycaster();
const readoutEl = document.getElementById('readout')!;

function sampleAtPoint(sample: Sample, point: THREE.Vector3, normal: THREE.Vector3, uv: THREE.Vector2 | undefined): void {
  const st = state.samples[samples.indexOf(sample)];
  const v = camera.position.clone().sub(point).normalize();
  const cosV = THREE.MathUtils.clamp(normal.dot(v), 0, 1);
  const angleDeg = THREE.MathUtils.radToDeg(Math.acos(cosV));

  const u = uv ? uv.x : 0;
  const d = (st.thicknessNm + (st.gradientOn ? st.gradientSpanNm * u : 0)) * (st.filmOn ? 1 : 0);

  const [r, g, b] = filmColorSrgb(cosV, d);
  const css = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

  const rows = READOUT_WAVELENGTHS.map((l) => {
    const rv = filmReflectance(l, cosV, d);
    return `<tr><td>${l} nm</td><td>${(rv * 100).toFixed(1)}%</td></tr>`;
  }).join('');

  readoutEl.innerHTML = `
    <div>${sample.name} · 入射角 <b>${angleDeg.toFixed(1)}°</b> · 局部膜厚 <b>${d.toFixed(0)} nm</b></div>
    <div id="swatch" style="background:${css}"></div>
    <canvas id="spectrum" width="300" height="56"></canvas>
    <table class="rvals">${rows}</table>
  `;
  drawSpectrum(cosV, d);
}

function drawSpectrum(cosV: number, d: number): void {
  const canvas = document.getElementById('spectrum') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const data = reflectanceSpectrum(cosV, d, 5);
  const xOf = (l: number) => ((l - 380) / 400) * (w - 8) + 4;
  // 参考网格
  ctx.strokeStyle = '#33363d';
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, h - frac * (h - 6) - 3);
    ctx.lineTo(w, h - frac * (h - 6) - 3);
    ctx.stroke();
  }
  // 反射率曲线：强弱区域随膜厚移动
  ctx.strokeStyle = '#9ec2ff';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  data.forEach(({ lambda, r: rv }, i) => {
    const x = xOf(lambda);
    const y = h - rv * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // 读数波长标记
  ctx.fillStyle = '#e8c46a';
  for (const l of READOUT_WAVELENGTHS) {
    ctx.fillRect(xOf(l) - 0.5, h - 5, 1, 5);
  }
}

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(samples.map((s) => s.mesh), false);
  const hit = hits[0];
  if (!hit || !hit.face) return;
  const sample = samples.find((s) => s.mesh === hit.object)!;
  const normal = hit.face.normal
    .clone()
    .transformDirection(sample.mesh.matrixWorld)
    .normalize();
  // 背面命中时翻转法线，与着色器一致
  const v = camera.position.clone().sub(hit.point).normalize();
  if (normal.dot(v) < 0) normal.negate();
  sampleAtPoint(sample, hit.point, normal, hit.uv ?? undefined);
}

// ---------------------------------------------------------------- 预设

function currentPreset(name: string): ViewPreset {
  return {
    name,
    camera: {
      pos: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
    },
    light: { ...state.light },
    samples: state.samples.map((s) => ({ ...s })) as [SampleState, SampleState],
  };
}

function applyPreset(p: ViewPreset): void {
  camera.position.set(...p.camera.pos);
  controls.target.set(...p.camera.target);
  controls.update();
  state.light = { ...p.light };
  state.samples = p.samples.map((s) => ({ ...s })) as [SampleState, SampleState];
  refreshLightUI();
  refreshSampleUI();
  applyAll();
}

function buildPresetUI(): void {
  const builtinHost = document.getElementById('builtin-presets')!;
  for (const p of BUILTIN_PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = p.name;
    btn.title = '应用该观察条件';
    btn.addEventListener('click', () => applyPreset(p));
    builtinHost.appendChild(btn);
  }
  renderUserPresets();

  document.getElementById('save-preset')!.addEventListener('click', () => {
    const name = window.prompt('预设名称（将按相同观察条件复现当前画面）');
    if (!name) return;
    const presets = loadUserPresets();
    presets.push(currentPreset(name));
    saveUserPresets(presets);
    renderUserPresets();
  });

  document.getElementById('snapshot')!.addEventListener('click', () => {
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.href = renderer.domElement.toDataURL('image/png');
    a.download = `thin-film-${Date.now()}.png`;
    a.click();
  });
}

function renderUserPresets(): void {
  const host = document.getElementById('user-presets')!;
  host.innerHTML = '';
  for (const p of loadUserPresets()) {
    const row = document.createElement('div');
    row.className = 'preset-item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    const apply = document.createElement('button');
    apply.textContent = '复现';
    apply.addEventListener('click', () => applyPreset(p));
    const del = document.createElement('button');
    del.textContent = '删';
    del.addEventListener('click', () => {
      saveUserPresets(loadUserPresets().filter((q) => q.name !== p.name));
      renderUserPresets();
    });
    row.append(name, apply, del);
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------- 启动

buildSampleControls();
bindLightUI();
buildPresetUI();
applyAll();

renderer.domElement.addEventListener('pointerdown', onPointerDown);

renderer.setAnimationLoop(() => {
  controls.update();
  if (!state.light.fixed) applyLighting();
  renderer.render(scene, camera);
});
