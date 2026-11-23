import {
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { bakeLightmap } from './baker.js';
import { packAtlas } from './packer.js';
import { applyLightmapUV, buildSurfaceGeometry, buildSurfaces, defaultSettings, defaultTexelsPerUnit } from './scene.js';
import { downloadBlob, downloadText, encodePngBrowser } from './png.js';
import { fnvBytes, settingsHash, stableStringify } from './settings.js';
import type { BakedLightmap, BakeSettings, ExportBundle, PackedAtlas } from './types.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  canvas: $<HTMLCanvasElement>('canvas'),
  lightX: $<HTMLInputElement>('light-x'),
  lightY: $<HTMLInputElement>('light-y'),
  lightZ: $<HTMLInputElement>('light-z'),
  lightIntensity: $<HTMLInputElement>('light-intensity'),
  lightAmbient: $<HTMLInputElement>('light-ambient'),
  atlasSize: $<HTMLSelectElement>('atlas-size'),
  texelsPerUnit: $<HTMLInputElement>('texels-per-unit'),
  padding: $<HTMLInputElement>('padding'),
  dilation: $<HTMLInputElement>('dilation'),
  rayBias: $<HTMLInputElement>('ray-bias'),
  biasHint: $<HTMLElement>('bias-hint'),
  viewMode: $<HTMLSelectElement>('view-mode'),
  showBoundary: $<HTMLInputElement>('show-boundary'),
  btnBake: $<HTMLButtonElement>('btn-bake'),
  btnExport: $<HTMLButtonElement>('btn-export'),
  message: $<HTMLElement>('bake-message'),
  staleBanner: $<HTMLElement>('stale-banner'),
  atlasCanvas: $<HTMLCanvasElement>('atlas-canvas'),
  zoomCanvas: $<HTMLCanvasElement>('zoom-canvas'),
  atlasCurrent: $<HTMLCanvasElement>('atlas-current'),
  atlasOld: $<HTMLCanvasElement>('atlas-old'),
  atlasCaption: $<HTMLElement>('atlas-caption'),
  stats: $<HTMLElement>('stats'),
};

interface BakedState {
  lightmap: BakedLightmap;
  atlas: PackedAtlas;
  settings: BakeSettings;
  hash: string;
  texture: CanvasTexture;
  boundaryPoints: Points | null;
}

let settings: BakeSettings = defaultSettings();
let baked: BakedState | null = null;
let previousBaked: BakedState | null = null;
let currentHash = settingsHash(settings);

// ---------------- 渲染器 / 相机 ----------------
const renderer = new WebGLRenderer({ canvas: ui.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;

const camera = new PerspectiveCamera(50, 1, 0.05, 100);
camera.position.set(4.6, 3.6, 5.2);
const controls = new OrbitControls(camera, ui.canvas);
controls.target.set(1.2, 0.8, 1.2);
controls.enableDamping = true;

// ---------------- 场景构建（实时 / 烘焙两套） ----------------
const surfaces = buildSurfaces(settings.scene);

const realtimeScene = new Scene();
const bakedScene = new Scene();
realtimeScene.background = new Color(0x101216);
bakedScene.background = new Color(0x101216);

const realtimeMeshes: Mesh[] = [];
const bakedMeshes: Mesh[] = [];
const geometries = surfaces.map((s) => buildSurfaceGeometry(s));

for (let i = 0; i < surfaces.length; i++) {
  const color = new Color(...surfaces[i].baseColor);
  const rtMesh = new Mesh(
    geometries[i],
    new MeshLambertMaterial({ color, emissive: new Color(0x000000) }),
  );
  realtimeMeshes.push(rtMesh);
  realtimeScene.add(rtMesh);

  const bkMesh = new Mesh(
    geometries[i].clone(),
    new MeshLambertMaterial({ color: new Color(1, 1, 1) }),
  );
  bakedMeshes.push(bkMesh);
  bakedScene.add(bkMesh);
}

// 实时光照：环境光 + 可移动点光源（带阴影）
const ambient = new AmbientLight(0xffffff, 1);
realtimeScene.add(ambient);
const pointLight = new PointLight(0xffffff, 1, 0, 2);
pointLight.castShadow = true;
pointLight.shadow.mapSize.set(1024, 1024);
pointLight.shadow.bias = -0.004;
realtimeScene.add(pointLight);
realtimeMeshes.forEach((m) => {
  m.castShadow = true;
  m.receiveShadow = true;
});

// 光源位置标记球
const lightMarker = new Mesh(
  new SphereGeometry(0.06, 16, 12),
  new MeshBasicMaterial({ color: 0xffe2a8 }),
);
realtimeScene.add(lightMarker);

const boundaryGroup = new Group();
bakedScene.add(boundaryGroup);

function syncLight(): void {
  const l = settings.light;
  pointLight.position.set(...l.position);
  pointLight.color.setRGB(l.color[0], l.color[1], l.color[2]);
  pointLight.intensity = l.intensity;
  ambient.intensity = l.ambient;
  lightMarker.position.set(...l.position);
}
syncLight();

// ---------------- 烘焙 ----------------
function doBake(): void {
  const atlas = packAtlas(
    surfaces,
    settings.atlasSize,
    settings.texelsPerUnit,
    settings.paddingPx,
  );
  if (atlas.overflow.length > 0) {
    ui.message.textContent = `❌ 图集装不下：${atlas.overflow.join('、')}，请提高分辨率或降低纹素密度`;
    return;
  }
  ui.message.textContent = '烘焙中…';
  // 让浏览器有机会刷新提示
  setTimeout(() => {
    const t0 = performance.now();
    const lightmap = bakeLightmap(surfaces, atlas.rects, settings);
    const hash = settingsHash(settings);

    // 给烘焙场景的几何写入 uv2 并换贴图
    lightmap.rects.forEach((rect) => {
      const idx = surfaces.findIndex((s) => s.id === rect.surfaceId);
      applyLightmapUV(bakedMeshes[idx].geometry as BufferGeometry, rect);
    });

    const oldTexture = baked?.texture;
    if (baked) previousBaked = baked;
    const texture = new CanvasTexture(imageBitmapCanvas(lightmap.rgba, lightmap.size));
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = true;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    bakedMeshes.forEach((m) => {
      (m.material as MeshLambertMaterial).map = texture;
      (m.material as MeshLambertMaterial).needsUpdate = true;
    });
    oldTexture?.dispose();

    const boundaryPoints = rebuildBoundaryPoints(lightmap);

    baked = { lightmap, atlas, settings: structuredClone(settings), hash, texture, boundaryPoints };
    currentHash = hash;
    ui.message.textContent = `✅ 烘焙完成（${Math.round(performance.now() - t0)} ms）`;
    updateStaleState();
    drawAtlasPreviews();
    drawStats();
  }, 16);
}

function imageBitmapCanvas(rgba: Uint8ClampedArray, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, size, size), 0, 0);
  return canvas;
}

function rebuildBoundaryPoints(lightmap: BakedLightmap): Points | null {
  boundaryGroup.clear();
  const positions: number[] = [];
  const rectById = new Map(lightmap.rects.map((r) => [r.surfaceId, r]));
  for (let i = 0; i < lightmap.boundary.length; i++) {
    if (!lightmap.boundary[i]) continue;
    const surfaceId = lightmap.owner[i];
    if (!surfaceId) continue;
    const surface = surfaces.find((s) => s.id === surfaceId)!;
    const rect = rectById.get(surfaceId)!;
    const x = i % lightmap.size;
    const y = Math.floor(i / lightmap.size);
    const v = (x - rect.x + 0.5) / rect.w;
    const u = (y - rect.y + 0.5) / rect.h;
    const px =
      surface.origin[0] +
      surface.uAxis[0] * surface.width * v +
      surface.vAxis[0] * surface.height * u +
      surface.normal[0] * 0.012;
    const py =
      surface.origin[1] +
      surface.uAxis[1] * surface.width * v +
      surface.vAxis[1] * surface.height * u +
      surface.normal[1] * 0.012;
    const pz =
      surface.origin[2] +
      surface.uAxis[2] * surface.width * v +
      surface.vAxis[2] * surface.height * u +
      surface.normal[2] * 0.012;
    positions.push(px, py, pz);
  }
  if (positions.length === 0) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const pts = new Points(
    geo,
    new PointsMaterial({ color: 0xff3b3b, size: 0.045, sizeAttenuation: true }),
  );
  boundaryGroup.add(pts);
  boundaryGroup.visible = ui.viewMode.value === 'deviation';
  return pts;
}

// ---------------- 过期标记 ----------------
function updateStaleState(): void {
  const stale = baked !== null && currentHash !== baked.hash;
  ui.staleBanner.classList.toggle('hidden', !stale);
  if (stale) {
    ui.atlasCaption.textContent = '（当前设置未烘焙，显示的是旧贴图）';
  } else {
    ui.atlasCaption.textContent = '';
  }
}

// ---------------- 图集 2D 预览 ----------------
function drawAtlasPreviews(): void {
  if (!baked) return;
  drawAtlas(ui.atlasCanvas, baked, true);
  drawAtlas(ui.atlasCurrent, baked, false);
  if (previousBaked) {
    drawAtlas(ui.atlasOld, previousBaked, false);
  } else {
    const ctx = ui.atlasOld.getContext('2d')!;
    ctx.clearRect(0, 0, ui.atlasOld.width, ui.atlasOld.height);
    ctx.fillStyle = '#8b93a3';
    ctx.font = '10px sans-serif';
    ctx.fillText('暂无旧贴图', 12, 46);
  }
}

function drawAtlas(canvas: HTMLCanvasElement, state: BakedState, withRects: boolean): void {
  const ctx = canvas.getContext('2d')!;
  const size = state.lightmap.size;
  // 先用离屏 canvas 承载原始纹素，再整体放大绘制（不能让目标 canvas 自绘缩放）
  const source = document.createElement('canvas');
  source.width = size;
  source.height = size;
  source.getContext('2d')!.putImageData(new ImageData(state.lightmap.rgba, size, size), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, size, size, 0, 0, canvas.width, canvas.height);

  if (withRects) {
    const scale = canvas.width / size;
    ctx.lineWidth = 1;
    for (const rect of state.atlas.rects) {
      ctx.strokeStyle = 'rgba(91,157,255,0.9)';
      ctx.strokeRect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
      // padding 框
      ctx.strokeStyle = 'rgba(255,180,84,0.55)';
      ctx.strokeRect(
        (rect.x - settings.paddingPx) * scale,
        (rect.y - settings.paddingPx) * scale,
        (rect.w + settings.paddingPx * 2) * scale,
        (rect.h + settings.paddingPx * 2) * scale,
      );
    }
    if (ui.showBoundary.checked) {
      ctx.fillStyle = 'rgba(255,59,59,0.95)';
      for (let i = 0; i < state.lightmap.boundary.length; i++) {
        if (!state.lightmap.boundary[i]) continue;
        const x = i % size;
        const y = Math.floor(i / size);
        ctx.fillRect(x * scale, y * scale, Math.max(1, scale), Math.max(1, scale));
      }
    }
  }
}

// 悬停放大（观察接缝与边缘扩张）
ui.atlasCanvas.addEventListener('mousemove', (e) => {
  if (!baked) return;
  const rect = ui.atlasCanvas.getBoundingClientRect();
  const size = baked.lightmap.size;
  const tx = Math.floor(((e.clientX - rect.left) / rect.width) * size);
  const ty = Math.floor(((e.clientY - rect.top) / rect.height) * size);
  const ctx = ui.zoomCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 120, 120);
  const half = 6;
  const zoom = 10;
  for (let y = ty - half; y < ty + half; y++) {
    for (let x = tx - half; x < tx + half; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const idx = (y * size + x) * 4;
      const rgba = baked.lightmap.rgba;
      ctx.fillStyle = `rgb(${rgba[idx]},${rgba[idx + 1]},${rgba[idx + 2]})`;
      ctx.fillRect((x - (tx - half)) * zoom, (y - (ty - half)) * zoom, zoom, zoom);
    }
  }
  ctx.strokeStyle = '#5b9dff';
  ctx.strokeRect(half * zoom - 0.5, half * zoom - 0.5, zoom, zoom);
});

// ---------------- 统计 ----------------
function drawStats(): void {
  if (!baked) return;
  const s = baked.lightmap.stats;
  const pct = s.boundaryCount ? ((s.biasSensitiveCount / s.boundaryCount) * 100).toFixed(1) : '0';
  ui.stats.textContent = [
    `图集: ${baked.lightmap.size}²  charts: ${baked.atlas.rects.length}`,
    `纹素密度: ${settings.texelsPerUnit}/单位  padding: ${settings.paddingPx}px`,
    `扩张迭代: ${settings.dilationPasses}  rayBias: ${settings.rayBias}`,
    `有效纹素: ${s.texelCount}`,
    `阴影边界纹素: ${s.boundaryCount}`,
    `bias 敏感边界: ${s.biasSensitiveCount} (${pct}%)`,
    `padding 环带空洞: ${s.paddingHoles}（闲置区域 ${s.remainingHoles}）`,
    `烘焙耗时: ${s.bakeMs} ms`,
    `设置哈希: ${baked.hash}`,
  ].join('\n');
}

// ---------------- 导出 ----------------
ui.btnExport.addEventListener('click', async () => {
  if (!baked) {
    ui.message.textContent = '请先烘焙再导出';
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const pngBlob = await encodePngBrowser(baked.lightmap.rgba, baked.lightmap.size, baked.lightmap.size);
  const bundle: ExportBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: baked.settings,
    atlas: { size: baked.atlas.size, rects: baked.atlas.rects, overflow: baked.atlas.overflow },
    lightmap: {
      width: baked.lightmap.size,
      height: baked.lightmap.size,
      pngFile: `lightmap-${stamp}.png`,
      rgbaHash: fnvBytes(baked.lightmap.rgba),
    },
    settingsHash: baked.hash,
  };
  downloadBlob(pngBlob, `lightmap-${stamp}.png`);
  downloadText(JSON.stringify(JSON.parse(stableStringify(bundle)), null, 2), `bake-settings-${stamp}.json`);
  ui.message.textContent = '✅ 已导出 PNG 与采样设置 JSON';
});

// ---------------- 控件联动 ----------------
function markStale(reason: string): void {
  updateStaleState();
  if (baked && currentHash !== baked.hash) {
    ui.message.textContent = `⚠ 设置已变更（${reason}），旧贴图已标记过期`;
  }
}

function readControls(): void {
  settings.light.position = [
    parseFloat(ui.lightX.value),
    parseFloat(ui.lightY.value),
    parseFloat(ui.lightZ.value),
  ];
  settings.light.intensity = parseFloat(ui.lightIntensity.value);
  settings.light.ambient = parseFloat(ui.lightAmbient.value);
  settings.atlasSize = parseInt(ui.atlasSize.value, 10);
  settings.texelsPerUnit = parseInt(ui.texelsPerUnit.value, 10);
  settings.paddingPx = parseInt(ui.padding.value, 10);
  settings.dilationPasses = parseInt(ui.dilation.value, 10);
  settings.rayBias = parseFloat(ui.rayBias.value);
  currentHash = settingsHash(settings);
}

function writeControls(): void {
  ui.lightX.value = String(settings.light.position[0]);
  ui.lightY.value = String(settings.light.position[1]);
  ui.lightZ.value = String(settings.light.position[2]);
  ui.lightIntensity.value = String(settings.light.intensity);
  ui.lightAmbient.value = String(settings.light.ambient);
  ui.atlasSize.value = String(settings.atlasSize);
  ui.texelsPerUnit.value = String(settings.texelsPerUnit);
  ui.padding.value = String(settings.paddingPx);
  ui.dilation.value = String(settings.dilationPasses);
  ui.rayBias.value = String(settings.rayBias);
  ui.biasHint.textContent =
    'bias 过小 → 阴影痤疮（自遮挡误判）；过大 → 阴影脱离遮挡体（peter-panning）';
}

writeControls();

for (const el of [ui.lightX, ui.lightY, ui.lightZ, ui.lightIntensity, ui.lightAmbient]) {
  el.addEventListener('input', () => {
    readControls();
    syncLight();
    markStale('光源');
  });
}
for (const el of [ui.texelsPerUnit, ui.padding, ui.dilation, ui.rayBias]) {
  el.addEventListener('input', () => {
    readControls();
    markStale('采样设置');
  });
}
ui.atlasSize.addEventListener('change', () => {
  readControls();
  // 切换分辨率时给出匹配的默认密度，用户仍可手动改
  ui.texelsPerUnit.value = String(defaultTexelsPerUnit(settings.atlasSize));
  readControls();
  markStale('图集分辨率');
});
ui.rayBias.addEventListener('input', () => {
  readControls();
  markStale('rayBias');
});
ui.viewMode.addEventListener('change', () => {
  if (baked?.boundaryPoints) {
    baked.boundaryPoints.visible = ui.viewMode.value === 'deviation';
  }
});
ui.showBoundary.addEventListener('change', () => drawAtlasPreviews());
ui.btnBake.addEventListener('click', doBake);

// ---------------- 渲染循环（scissor 双视口） ----------------
function resize(): void {
  const w = ui.canvas.clientWidth;
  const h = ui.canvas.clientHeight;
  renderer.setSize(w, h, false);
}
new ResizeObserver(resize).observe(ui.canvas);
resize();

function render(): void {
  controls.update();
  const mode = ui.viewMode.value;
  const w = ui.canvas.clientWidth;
  const h = ui.canvas.clientHeight;
  renderer.setScissorTest(false);
  renderer.clear();

  const drawScene = (scene: Scene, x: number, width: number) => {
    camera.aspect = width / h;
    camera.updateProjectionMatrix();
    renderer.setViewport(x, 0, width, h);
    renderer.setScissor(x, 0, width, h);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
  };

  if (mode === 'split') {
    drawScene(realtimeScene, 0, Math.floor(w / 2));
    drawScene(bakedScene, Math.floor(w / 2), w - Math.floor(w / 2));
  } else if (mode === 'realtime') {
    drawScene(realtimeScene, 0, w);
  } else {
    drawScene(bakedScene, 0, w);
  }
  renderer.setScissorTest(false);
  requestAnimationFrame(render);
}
render();

// 首次自动烘焙一次
doBake();
