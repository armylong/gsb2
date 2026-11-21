import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Color3,
  DIR_NAMES,
  DIRS,
  Probe,
  SampleMode,
  presetMissing,
  presetWarmCool,
  sampleField,
} from './probes';

const MAX_PROBES = 4;
const PATH_MIN = -6;
const PATH_MAX = 6;
const UP = { x: 0, y: 1, z: 0 };

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
interface State {
  probes: Probe[];
  fallback: Color3;
  mode: SampleMode;
  auto: boolean;
  t: number; // 0..1 路径参数
  dir: 1 | -1;
}

const state: State = {
  ...presetWarmCool(),
  mode: 'blend',
  auto: true,
  t: 0.15,
  dir: 1,
};

// ---------------------------------------------------------------------------
// 颜色工具 (内部存储为线性空间, UI 颜色选择器为 sRGB)
// ---------------------------------------------------------------------------
const linToSrgb = (v: number) => Math.round(255 * Math.pow(Math.max(0, v), 1 / 2.2));
const srgbToLin = (v: number) => Math.pow(v / 255, 2.2);
const toHex = (c: Color3) =>
  '#' + c.map((v) => linToSrgb(v).toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Color3 => [
  srgbToLin(parseInt(hex.slice(1, 3), 16)),
  srgbToLin(parseInt(hex.slice(3, 5), 16)),
  srgbToLin(parseInt(hex.slice(5, 7), 16)),
];

// ---------------------------------------------------------------------------
// three.js 场景
// ---------------------------------------------------------------------------
const view = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14151a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 6.5, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

scene.add(new THREE.GridHelper(20, 20, 0x333844, 0x232733));

// 路径线
{
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(PATH_MIN, 0.02, 0),
    new THREE.Vector3(PATH_MAX, 0.02, 0),
  ]);
  scene.add(new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x555c6e, dashSize: 0.3, gapSize: 0.2 })).computeLineDistances());
}

// 漫反射球: 自定义 shader, 权重在 CPU 计算, 方向颜色在 GPU 按法线解析
const sphereUniforms = {
  uDirColors: { value: Array.from({ length: MAX_PROBES * 6 }, () => new THREE.Vector3()) },
  uWeights: { value: new Array<number>(MAX_PROBES).fill(0) },
  uCoverage: { value: 0 },
  uFallback: { value: new THREE.Vector3() },
};
const sphereMat = new THREE.ShaderMaterial({
  uniforms: sphereUniforms,
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    void main() {
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #define MAXP ${MAX_PROBES}
    uniform vec3 uDirColors[MAXP * 6];
    uniform float uWeights[MAXP];
    uniform float uCoverage;
    uniform vec3 uFallback;
    varying vec3 vNormal;
    void main() {
      vec3 n = normalize(vNormal);
      vec3 dirs[6];
      dirs[0] = vec3(1,0,0);  dirs[1] = vec3(-1,0,0);
      dirs[2] = vec3(0,1,0);  dirs[3] = vec3(0,-1,0);
      dirs[4] = vec3(0,0,1);  dirs[5] = vec3(0,0,-1);
      vec3 blended = vec3(0.0);
      for (int i = 0; i < MAXP; i++) {
        float w = uWeights[i];
        if (w <= 0.0) continue;
        vec3 c = vec3(0.0);
        float ws = 0.0;
        for (int k = 0; k < 6; k++) {
          float a = max(0.0, dot(n, dirs[k]));
          float ww = a * a;
          c += ww * uDirColors[i * 6 + k];
          ws += ww;
        }
        blended += w * (ws > 0.0 ? c / ws : vec3(0.0));
      }
      vec3 col = mix(uFallback, blended, uCoverage);
      gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
    }
  `,
});
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), sphereMat);
sphere.position.y = 1;
scene.add(sphere);

// 探针 gizmo
interface ProbeGizmo {
  group: THREE.Group;
  centerMat: THREE.MeshBasicMaterial;
  radiusMat: THREE.MeshBasicMaterial;
  dirMats: THREE.MeshBasicMaterial[];
}
let gizmos: ProbeGizmo[] = [];

function rebuildGizmos() {
  for (const g of gizmos) scene.remove(g.group);
  gizmos = state.probes.map((p) => {
    const group = new THREE.Group();
    group.position.set(p.position.x, p.position.y, p.position.z);

    const centerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), centerMat));

    const radiusMat = new THREE.MeshBasicMaterial({
      color: 0x8a93a8,
      wireframe: true,
      transparent: true,
      opacity: 0.18,
    });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(p.radius, 24, 16), radiusMat));

    const dirMats: THREE.MeshBasicMaterial[] = [];
    for (let k = 0; k < 6; k++) {
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), m);
      dot.position.set(DIRS[k].x * 0.55, DIRS[k].y * 0.55, DIRS[k].z * 0.55);
      group.add(dot);
      dirMats.push(m);
    }
    scene.add(group);
    return { group, centerMat, radiusMat, dirMats };
  });
  refreshGizmoColors();
}

function refreshGizmoColors() {
  state.probes.forEach((p, i) => {
    const g = gizmos[i];
    if (!g) return;
    const avg: Color3 = [0, 0, 0];
    p.dirColors.forEach((c) => {
      avg[0] += c[0] / 6;
      avg[1] += c[1] / 6;
      avg[2] += c[2] / 6;
    });
    g.centerMat.color.setRGB(avg[0], avg[1], avg[2], THREE.SRGBColorSpace);
    p.dirColors.forEach((c, k) =>
      g.dirMats[k].color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace),
    );
    g.radiusMat.opacity = p.enabled ? 0.18 : 0.05;
    g.centerMat.transparent = true;
    g.centerMat.opacity = p.enabled ? 1 : 0.3;
  });
}

// ---------------------------------------------------------------------------
// 面板 UI
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const probeEls: { bar: HTMLDivElement; weightText: HTMLSpanElement }[] = [];

function rebuildProbePanel() {
  const host = $('probes');
  host.innerHTML = '';
  probeEls.length = 0;
  state.probes.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'probe' + (p.enabled ? '' : ' disabled');

    const head = document.createElement('div');
    head.className = 'probe-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.title = '启用/禁用该探针';
    cb.onchange = () => {
      p.enabled = cb.checked;
      div.classList.toggle('disabled', !p.enabled);
      refreshGizmoColors();
    };
    const name = document.createElement('b');
    name.textContent = p.name;
    const weightText = document.createElement('span');
    weightText.className = 'mono';
    weightText.textContent = 'w=0.00';
    head.append(cb, name, weightText);

    const bar = document.createElement('div');
    bar.className = 'weightbar';
    const barInner = document.createElement('div');
    bar.appendChild(barInner);

    const dirs = document.createElement('div');
    dirs.className = 'dirs';
    p.dirColors.forEach((c, k) => {
      const label = document.createElement('label');
      label.textContent = DIR_NAMES[k];
      const input = document.createElement('input');
      input.type = 'color';
      input.value = toHex(c);
      input.title = `${p.name} ${DIR_NAMES[k]} 方向颜色`;
      input.oninput = () => {
        p.dirColors[k] = fromHex(input.value);
        refreshGizmoColors();
      };
      label.appendChild(input);
      dirs.appendChild(label);
    });

    div.append(head, bar, dirs);
    host.appendChild(div);
    probeEls.push({ bar: barInner, weightText });
    void i;
  });
}

function setMode(mode: SampleMode) {
  state.mode = mode;
  $('mode-blend').classList.toggle('active', mode === 'blend');
  $('mode-nearest').classList.toggle('active', mode === 'nearest');
}

function loadPreset(kind: 'warmcool' | 'missing') {
  const preset = kind === 'warmcool' ? presetWarmCool() : presetMissing();
  state.probes = preset.probes;
  state.fallback = preset.fallback;
  rebuildGizmos();
  rebuildProbePanel();
}

$('mode-blend').onclick = () => setMode('blend');
$('mode-nearest').onclick = () => setMode('nearest');
$('preset-warmcool').onclick = () => loadPreset('warmcool');
$('preset-missing').onclick = () => loadPreset('missing');
$('auto').onchange = (e) => (state.auto = (e.target as HTMLInputElement).checked);
$('pos').oninput = (e) => {
  state.t = Number((e.target as HTMLInputElement).value) / 1000;
  state.auto = false;
  ($('auto') as HTMLInputElement).checked = false;
};

// ---------------------------------------------------------------------------
// 每帧更新
// ---------------------------------------------------------------------------
const SOURCE_LABEL = { blend: '插值混合', nearest: '最近探针', fallback: '回退环境色' };

function explain(source: string, coverage: number): string {
  const parts: string[] = [];
  const disabled = state.probes.filter((p) => !p.enabled);
  if (source === 'fallback') {
    parts.push('当前位置不在任何启用探针的影响半径内 → 按明确规则取回退环境色。');
  } else if (coverage < 1) {
    parts.push(
      `覆盖度 ${coverage.toFixed(2)} < 1: 处于影响区边缘, 有效探针权重不足, 正在向回退色软过渡 (采样退化)。`,
    );
  } else {
    const n = state.probes.filter((p) => p.enabled).length;
    parts.push(`覆盖充足, ${n} 个启用探针的权重已归一化 (Σw = 1), 边界两侧颜色连续。`);
  }
  if (disabled.length > 0) {
    parts.push(
      `探针「${disabled.map((p) => p.name).join('、')}」已禁用: 剩余探针权重即时重新归一, 其影响区由邻近探针与回退色补偿。`,
    );
  }
  if (state.mode === 'nearest') {
    parts.push('最近探针模式: 不做混合, 跨越两探针分界或影响半径边缘时颜色跳变 — 用于对照插值混合的连续性。');
  }
  return parts.join('\n');
}

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();

  if (state.auto) {
    state.t += dt * 0.12 * state.dir;
    if (state.t >= 1) {
      state.t = 1;
      state.dir = -1;
    } else if (state.t <= 0) {
      state.t = 0;
      state.dir = 1;
    }
    ($('pos') as HTMLInputElement).value = String(Math.round(state.t * 1000));
  }

  const x = PATH_MIN + (PATH_MAX - PATH_MIN) * state.t;
  sphere.position.x = x;

  const sample = sampleField(state.probes, sphere.position, UP, state.mode, state.fallback);

  // 更新 shader uniforms
  const dirCols = sphereUniforms.uDirColors.value as THREE.Vector3[];
  const weights = sphereUniforms.uWeights.value as number[];
  for (let i = 0; i < MAX_PROBES; i++) {
    const p = state.probes[i];
    weights[i] = p ? sample.weights[i] : 0;
    for (let k = 0; k < 6; k++) {
      const c = p ? p.dirColors[k] : ([0, 0, 0] as Color3);
      dirCols[i * 6 + k].set(c[0], c[1], c[2]);
    }
  }
  sphereUniforms.uCoverage.value = sample.coverage;
  (sphereUniforms.uFallback.value as THREE.Vector3).set(...state.fallback);

  // 更新面板
  probeEls.forEach((el, i) => {
    const w = sample.weights[i] ?? 0;
    el.bar.style.width = `${(w * 100).toFixed(1)}%`;
    el.weightText.textContent = `w=${w.toFixed(2)}`;
  });
  $('swatch').style.background = toHex(sample.color);
  $('source').textContent = SOURCE_LABEL[sample.source];
  $('coverage').textContent = sample.coverage.toFixed(2);
  $('colorhex').textContent = sample.color.map((v) => v.toFixed(3)).join(', ');
  $('explain').textContent = explain(sample.source, sample.coverage);

  controls.update();
  renderer.render(scene, camera);
}

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
resize();

rebuildGizmos();
rebuildProbePanel();
tick();
