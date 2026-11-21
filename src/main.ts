/**
 * 山坡材质规则检查场景。
 * 着色器中的权重计算与 src/rules.ts 的 evaluateRules 逐项对应（同一套 band 语义），
 * HUD 显示的是 CPU 侧求值结果，可与画面颜色互相印证。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { makeHeightfield, Heightfield } from './heightfield';
import {
  evaluateRules, cloneDefaults, LAYER_NAMES, FALLBACK_NAME, FALLBACK, LayerRule,
} from './rules';
import { makeTextures } from './textures';
import { PRESETS } from './presets';

const SIZE = 400;
const SEGMENTS = 256;

// ---------- 状态 ----------
const rules: LayerRule[] = cloneDefaults();
let hf: Heightfield = makeHeightfield(1337, SIZE);
const params = {
  seed: 1337,
  viewMode: '材质' as '材质' | '权重',
  rebuild: () => rebuildTerrain(),
  resetRules: () => applyRules(cloneDefaults()),
};

// ---------- 渲染基础 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);
scene.fog = new THREE.Fog(0x101418, 300, 900);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(150, 140, 210);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

// ---------- 地形着色器 ----------
const textures = makeTextures();

const uHeight = rules.map(() => new THREE.Vector4());
const uSlope = rules.map(() => new THREE.Vector4());

const uniforms = {
  tGrass: { value: textures.grass },
  tRock: { value: textures.rock },
  tSnow: { value: textures.snow },
  tFallback: { value: textures.fallback },
  uHeight: { value: uHeight }, // 每层: (min, max, feather, priority)
  uSlope: { value: uSlope },   // 每层: (min, max, feather, textureScale)
  uDebug: { value: 0 },        // 0=材质 1=权重视图
  uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.35).normalize() },
};

const terrainMaterial = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tGrass, tRock, tSnow, tFallback;
    uniform vec4 uHeight[3];
    uniform vec4 uSlope[3];
    uniform int uDebug;
    uniform vec3 uLightDir;
    varying vec3 vNormal;
    varying vec3 vWorldPos;

    // 与 rules.ts 的 bandFactor 一致
    float band(float v, float mn, float mx, float f) {
      f = max(f, 1e-6);
      float lo = smoothstep(mn - f, mn, v);
      float hi = 1.0 - smoothstep(mx, mx + f, v);
      return lo * hi;
    }

    void main() {
      vec3 n = normalize(vNormal);
      float slope = degrees(acos(clamp(n.y, -1.0, 1.0)));
      float h = vWorldPos.y;

      // 与 evaluateRules 相同：raw = 高度带 × 坡度带，effective = raw × priority
      vec3 eff;
      eff.r = band(h, uHeight[0].x, uHeight[0].y, uHeight[0].z)
            * band(slope, uSlope[0].x, uSlope[0].y, uSlope[0].z) * max(uHeight[0].w, 1e-4);
      eff.g = band(h, uHeight[1].x, uHeight[1].y, uHeight[1].z)
            * band(slope, uSlope[1].x, uSlope[1].y, uSlope[1].z) * max(uHeight[1].w, 1e-4);
      eff.b = band(h, uHeight[2].x, uHeight[2].y, uHeight[2].z)
            * band(slope, uSlope[2].x, uSlope[2].y, uSlope[2].z) * max(uHeight[2].w, 1e-4);

      float sum = eff.r + eff.g + eff.b;
      vec4 w = sum < 1e-4 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(eff / sum, 0.0);

      if (uDebug == 1) {
        // 权重视图：草=R 岩=G 雪=B 回退=品红
        vec3 c = w.r * vec3(1.0, 0.25, 0.25)
               + w.g * vec3(0.25, 1.0, 0.25)
               + w.b * vec3(0.35, 0.55, 1.0)
               + w.a * vec3(1.0, 0.0, 0.9);
        gl_FragColor = vec4(c, 1.0);
        return;
      }

      vec2 uv = vWorldPos.xz;
      vec3 albedo = texture2D(tGrass, uv / uSlope[0].w).rgb * w.r
                  + texture2D(tRock,  uv / uSlope[1].w).rgb * w.g
                  + texture2D(tSnow,  uv / uSlope[2].w).rgb * w.b
                  + texture2D(tFallback, uv / 10.0).rgb * w.a;

      float diff = max(dot(n, uLightDir), 0.0);
      vec3 col = albedo * (0.28 + 0.72 * diff);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

function updateUniforms(): void {
  rules.forEach((r, i) => {
    uHeight[i].set(r.heightMin, r.heightMax, r.heightFeather, r.priority);
    uSlope[i].set(r.slopeMin, r.slopeMax, r.slopeFeather, Math.max(r.textureScale, 0.1));
  });
}
updateUniforms();

// ---------- 地形网格 ----------
let terrain: THREE.Mesh;

function rebuildTerrain(): void {
  hf = makeHeightfield(params.seed, SIZE);
  if (terrain) {
    terrain.geometry.dispose();
    scene.remove(terrain);
  }
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, hf.height(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();
  terrain = new THREE.Mesh(geo, terrainMaterial);
  scene.add(terrain);
  if (picked) inspect(picked.x, picked.z);
}
rebuildTerrain();

// ---------- 拾取标记 ----------
const marker = new THREE.Mesh(
  new THREE.SphereGeometry(1.2, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
);
marker.visible = false;
scene.add(marker);

const normalArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 12, 0x00e5ff, 3, 1.8,
);
normalArrow.visible = false;
scene.add(normalArrow);

// ---------- HUD ----------
const hud = document.getElementById('hud')!;
const legend = document.getElementById('legend')!;
const LAYER_COLORS = ['#ff4040', '#40ff40', '#59a0ff', '#ff00e6'];
const LAYER_CSS = ['#5a8c3e', '#8a8580', '#eef3fa', '#ff00e6'];

let picked: { x: number; z: number } | null = null;

function inspect(x: number, z: number): void {
  picked = { x, z };
  const h = hf.height(x, z);
  const n = hf.normal(x, z);
  const slope = hf.slopeDeg(x, z);
  const res = evaluateRules(h, slope, rules);

  marker.position.set(x, h + 1.5, z);
  marker.visible = true;
  normalArrow.position.set(x, h + 0.5, z);
  normalArrow.setDirection(new THREE.Vector3(n.x, n.y, n.z));
  normalArrow.visible = true;

  const names = [...LAYER_NAMES, FALLBACK_NAME];
  const lines: string[] = [
    `位置  x=${x.toFixed(1)}  z=${z.toFixed(1)}  高度=${h.toFixed(2)} m`,
    `法线  (${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)})`,
    `坡度  ${slope.toFixed(2)}°`,
    `──────────────────────────────`,
    `层级     覆盖率  ×优先级   归一化`,
  ];
  for (let i = 0; i < 3; i++) {
    lines.push(
      `${names[i].padEnd(4, '　')}  ${res.raw[i].toFixed(3)}   ×${rules[i].priority.toFixed(1).padStart(4)}   ${(res.normalized[i] * 100).toFixed(1).padStart(5)}%`,
    );
  }
  const fb = res.normalized[FALLBACK];
  lines.push(`回退     ${res.fallbackActive ? '生效!' : '—'}          ${(fb * 100).toFixed(1).padStart(5)}%`);
  lines.push(`──────────────────────────────`);
  const winnerName = res.fallbackActive ? FALLBACK_NAME : `${names[res.winner]} (优先级 ${rules[res.winner].priority})`;
  lines.push(`胜出层: ${winnerName}`);

  const bar = res.normalized
    .map((w, i) => `<div style="width:${(w * 100).toFixed(2)}%;background:${LAYER_CSS[i]}"></div>`)
    .join('');
  hud.innerHTML =
    `<div>${lines.join('\n')}</div>` +
    `<div class="bar">${bar}</div>` +
    (res.fallbackActive ? `<div class="fallback">⚠ 无规则覆盖，显式回退层生效</div>` : '');
}

// ---------- 鼠标拾取 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos: { x: number; y: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 5) return; // 拖拽视角不算拾取
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(terrain);
  if (hits.length > 0) {
    const p = hits[0].point;
    inspect(p.x, p.z);
  }
});

// ---------- GUI ----------
const gui = new GUI({ title: '材质规则' });
gui.add(params, 'viewMode', ['材质', '权重']).name('视图模式').onChange((v: string) => {
  uniforms.uDebug.value = v === '权重' ? 1 : 0;
  legend.style.display = v === '权重' ? 'block' : 'none';
  legend.innerHTML =
    '权重视图图例<br>' +
    `<span style="color:${LAYER_COLORS[0]}">■</span> 草地 ` +
    `<span style="color:${LAYER_COLORS[1]}">■</span> 岩石 ` +
    `<span style="color:${LAYER_COLORS[2]}">■</span> 雪 ` +
    `<span style="color:${LAYER_COLORS[3]}">■</span> 回退(无覆盖)`;
});
gui.add(params, 'seed', 1, 9999, 1).name('地形种子');
gui.add(params, 'rebuild').name('按种子重建地形');
gui.add(params, 'resetRules').name('恢复默认规则');

const ruleFolders: GUI[] = [];
function buildRuleFolders(): void {
  ruleFolders.forEach((f) => f.destroy());
  ruleFolders.length = 0;
  rules.forEach((r, i) => {
    const f = gui.addFolder(`${LAYER_NAMES[i]}层`);
    const refresh = () => { updateUniforms(); if (picked) inspect(picked.x, picked.z); };
    f.add(r, 'heightMin', -200, 400, 1).name('高度min').onChange(refresh);
    f.add(r, 'heightMax', -200, 400, 1).name('高度max').onChange(refresh);
    f.add(r, 'heightFeather', 0, 30, 0.5).name('高度过渡宽').onChange(refresh);
    f.add(r, 'slopeMin', 0, 90, 0.5).name('坡度min°').onChange(refresh);
    f.add(r, 'slopeMax', 0, 90, 0.5).name('坡度max°').onChange(refresh);
    f.add(r, 'slopeFeather', 0, 30, 0.5).name('坡度过渡宽°').onChange(refresh);
    f.add(r, 'priority', 0, 10, 0.5).name('优先级').onChange(refresh);
    f.add(r, 'textureScale', 1, 40, 0.5).name('纹理缩放').onChange(refresh);
    ruleFolders.push(f);
  });
}
buildRuleFolders();

function applyRules(next: LayerRule[]): void {
  next.forEach((r, i) => Object.assign(rules[i], r));
  buildRuleFolders();
  updateUniforms();
  if (picked) inspect(picked.x, picked.z);
}

const presetFolder = gui.addFolder('预设测试点（卡在边界上）');
PRESETS.forEach((p) => {
  presetFolder.add(
    {
      go: () => {
        if (p.rulesOverride) applyRules(p.rulesOverride.map((r) => ({ ...r })));
        const pt = p.find(hf);
        inspect(pt.x, pt.z);
        const h = hf.height(pt.x, pt.z);
        controls.target.set(pt.x, h, pt.z);
        camera.position.set(pt.x + 40, h + 45, pt.z + 40);
        console.info(`[预设] ${p.label}\n  ${p.note}`);
      },
    },
    'go',
  ).name(p.label);
});
presetFolder.close();

// ---------- 主循环 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
