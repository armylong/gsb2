import type { BatchPlan, DrawGroup } from './core/batching';
import { buildPlan, spriteRect } from './core/batching';
import type { PathDraw } from './gl/renderer';
import { clampZoom, fitCamera, eyeToWorld, panByEye, zoomAt, type Camera } from './core/camera';
import { compareRgba, type BufferDiff, type PixelSample } from './core/compare';
import { batchColorBuffer, groupsFromPlan } from './core/plan';
import { buildScene, SCENE_META, snapshotSprites } from './core/scenes';
import { fnv1a, toHex32 } from './core/rng';
import type { Scene, SceneKey, Sprite } from './core/types';
import { SceneRenderer } from './gl/renderer';
import { buildAllTextures, type TextureDef } from './render/textures';
import {
  renderBatchList,
  renderDiff,
  renderInterruptionList,
  renderNotes,
  renderOffScreenNote,
  renderPixel,
  renderProbes,
  renderProbeEditor,
  renderRibbon,
  renderStats,
  renderTextures,
  type PanelCallbacks,
} from './ui/panels';
import { drawOverlay } from './ui/overlay';

interface AppState {
  sceneKey: SceneKey;
  scene: Scene;
  sprites: Sprite[];
  camera: Camera;
  selectedSpriteId: number | null;
  selectedBatch: number | null;
  hoverSpriteId: number | null;
  hoverBatch: number | null;
  focusPair: [number, number] | null;
  compareMode: number;
  split: number;
  amplify: number;
  batchColor: boolean;
  pixelProbe: boolean;
  autoCompare: boolean;
  plan: BatchPlan;
  /** 参考路径始终用真实画家顺序。 */
  refOrder: readonly number[];
  refGroups: DrawGroup[];
  refColors: Float32Array;
  batchGroups: DrawGroup[];
  batchColors: Float32Array;
  textures: TextureDef[];
  needsRender: boolean;
  /** 反例诊断：合批路径在同层内按混合重排，理应产生像素差异。 */
  breakOrder: boolean;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 元素 #${id}`);
  return node as T;
}

const glCanvas = byId<HTMLCanvasElement>('glCanvas');
const overlayCanvas = byId<HTMLCanvasElement>('overlayCanvas');
const stageCanvas = byId<HTMLDivElement>('stageCanvas');
const fatalBox = byId<HTMLDivElement>('fatal');
const statGrid = byId<HTMLDivElement>('statGrid');
const offScreenNote = byId<HTMLDivElement>('offScreenNote');
const ribbon = byId<HTMLDivElement>('ribbon');
const batchList = byId<HTMLDivElement>('batchList');
const interruptionList = byId<HTMLDivElement>('interruptionList');
const probeList = byId<HTMLDivElement>('probeList');
const probeEditor = byId<HTMLDivElement>('probeEditor');
const selectionInfo = byId<HTMLDivElement>('selectionInfo');
const diffResult = byId<HTMLDivElement>('diffResult');
const pixelResult = byId<HTMLDivElement>('pixelResult');
const textureStrip = byId<HTMLDivElement>('textureStrip');
const sceneNotes = byId<HTMLUListElement>('sceneNotes');
const sceneTag = byId<HTMLSpanElement>('sceneTag');
const sceneSubtitle = byId<HTMLParagraphElement>('sceneSubtitle');
const sceneTabs = byId<HTMLElement>('sceneTabs');
const compareModes = byId<HTMLElement>('compareModes');
const splitControl = byId<HTMLLabelElement>('splitControl');
const amplifyControl = byId<HTMLLabelElement>('amplifyControl');
const splitSlider = byId<HTMLInputElement>('splitSlider');
const amplifySlider = byId<HTMLInputElement>('amplifySlider');
const amplifyValue = byId<HTMLSpanElement>('amplifyValue');
const batchColorToggle = byId<HTMLInputElement>('batchColorToggle');
const pixelProbeToggle = byId<HTMLInputElement>('pixelProbeToggle');
const autoCompareToggle = byId<HTMLInputElement>('autoCompareToggle');
const readbackBtn = byId<HTMLButtonElement>('readbackBtn');

const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
const textures = buildAllTextures();
const renderer = new SceneRenderer(glCanvas);
renderer.setTextures(textures);

const state: AppState = {
  sceneKey: 'interleaved',
  scene: null as unknown as Scene,
  sprites: [],
  camera: { cx: 1800, cy: 1200, zoom: 0.35 },
  selectedSpriteId: null,
  selectedBatch: null,
  hoverSpriteId: null,
  hoverBatch: null,
  focusPair: null,
  compareMode: 0,
  split: 0.5,
  amplify: 8,
  batchColor: false,
  pixelProbe: true,
  autoCompare: true,
  plan: null as unknown as BatchPlan,
  refOrder: [],
  refGroups: [],
  refColors: new Float32Array(0),
  batchGroups: [],
  batchColors: new Float32Array(0),
  textures,
  needsRender: true,
  breakOrder: false,
};

let ready = false;
let diffUi: Parameters<typeof renderDiff>[1] = { status: 'idle' };
let lastPixel: { sample: PixelSample | null; pos: { x: number; y: number } | null } = {
  sample: null,
  pos: null,
};

let deviceW = 1;
let deviceH = 1;
let cssW = 1;
let cssH = 1;

function eyeSize(): { w: number; h: number } {
  return { w: deviceW, h: deviceH };
}

function initialCameraFor(scene: Scene): Camera {
  const fit = fitCamera(scene.worldWidth, scene.worldHeight, deviceW, deviceH);
  // 初始比"全图"略近，探针与批次差异更容易看清。
  return { cx: fit.cx, cy: fit.cy, zoom: clampZoom(fit.zoom * 1.7) };
}

function loadScene(key: SceneKey, keepCamera = false): void {
  const scene = buildScene(key);
  state.sceneKey = key;
  state.scene = scene;
  state.sprites = snapshotSprites(scene);
  state.selectedSpriteId = null;
  state.selectedBatch = null;
  state.hoverSpriteId = null;
  state.hoverBatch = null;
  state.focusPair = null;
  if (!keepCamera) state.camera = initialCameraFor(scene);
  for (const tab of Array.from(sceneTabs.querySelectorAll('button'))) {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.scene === key);
  }
  sceneTag.textContent = `${scene.title} · 种子 0x${scene.seed.toString(16)}`;
  sceneSubtitle.textContent = scene.subtitle;
  renderNotes(sceneNotes, scene);
  makeDirty();
}

function makeDirty(): void {
  state.needsRender = true;
}

function recompute(): void {
  const { w, h } = eyeSize();
  // 参考侧永远按真实画家顺序，逐个绘制。
  const canonical = buildPlan(state.sprites, state.camera, w, h);
  state.refOrder = canonical.paintOrder;
  state.refGroups = canonical.paintOrder.map((si, rank) => ({
    first: rank,
    count: 1,
    blend: state.sprites[si]!.blend,
  }));
  state.refColors = batchColorBuffer(canonical);

  // 合批侧默认与参考同序；开反例诊断时同层内按混合重排，批次更少但次序被破坏。
  state.plan = state.breakOrder
    ? buildPlan(state.sprites, state.camera, w, h, { reorderWithinLayer: true })
    : canonical;
  state.batchGroups = groupsFromPlan(state.plan);
  state.batchColors = batchColorBuffer(state.plan);
}

function spriteIndexOfId(id: number | null): number | null {
  if (id === null) return null;
  const idx = state.sprites.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : null;
}

/* ------------------------------------------------------------------ */
/* 面板渲染                                                            */
/* ------------------------------------------------------------------ */

const callbacks: PanelCallbacks = {
  onHoverBatch: (batch) => {
    if (state.hoverBatch === batch) return;
    state.hoverBatch = batch;
    renderPanels();
    makeDirty();
  },
  onSelectBatch: (batch) => {
    state.selectedBatch = batch;
    state.focusPair = null;
    const b = state.plan.batches[batch];
    if (b) {
      const firstSprite = state.plan.paintOrder[b.first];
      if (firstSprite !== undefined) state.selectedSpriteId = state.sprites[firstSprite]!.id;
    }
    renderPanels();
    makeDirty();
  },
  onSelectSprite: (spriteIndex) => {
    const sprite = state.sprites[spriteIndex];
    if (!sprite) return;
    state.selectedSpriteId = sprite.id;
    state.selectedBatch = state.plan.batchOfSprite[spriteIndex] ?? null;
    state.focusPair = null;
    renderPanels();
    makeDirty();
  },
  onFocusInterruption: (before, after) => {
    state.focusPair = [before, after];
    state.selectedBatch = before;
    state.hoverBatch = null;
    renderPanels();
    makeDirty();
  },
  onSetProbeLayer: (spriteIndex, layer) => {
    const sprite = state.sprites[spriteIndex];
    if (!sprite) return;
    sprite.layer = Math.max(0, Math.min(state.scene.layerCount - 1, layer));
    makeDirty();
    scheduleCompare();
  },
  onSetProbeBlend: (spriteIndex, blend) => {
    const sprite = state.sprites[spriteIndex];
    if (!sprite) return;
    (sprite as { blend: Sprite['blend'] }).blend = blend;
    makeDirty();
    scheduleCompare();
  },
};

function renderPanelsNow(): void {
  const plan = state.plan;
  const statsData = {
    plan,
    stats: renderer.stats,
    scene: state.scene,
    offScreenProbes: 0,
    frameDrawCalls: renderer.stats.frameDrawCalls,
  };
  renderStats(statGrid, statsData);
  renderOffScreenNote(offScreenNote, statsData);
  renderRibbon(
    ribbon,
    plan,
    state.sprites,
    state.selectedBatch,
    state.hoverBatch,
    state.focusPair,
    callbacks,
  );
  renderInterruptionList(interruptionList, plan, callbacks, state.focusPair);
  renderBatchList(batchList, plan, state.sprites, state.selectedBatch, callbacks);
  renderProbes(probeList, plan, state.sprites, state.selectedSpriteId, callbacks);
  const selIdx = spriteIndexOfId(state.selectedSpriteId);
  renderProbeEditor(probeEditor, plan, state.sprites, selIdx, state.scene, callbacks);
  renderSelectionInfo();
  renderDiff(diffResult, diffUi);
  renderPixel(pixelResult, lastPixel.sample, lastPixel.pos);
}

function renderSelectionInfo(): void {
  selectionInfo.replaceChildren();
  const idx = spriteIndexOfId(state.selectedSpriteId);
  if (idx === null) {
    selectionInfo.textContent = '尚未选中。点画布上的任意精灵，或点批次带/批次列表。';
    return;
  }
  const sprite = state.sprites[idx]!;
  const rank = state.plan.rankOfSprite[idx]!;
  if (rank < 0) {
    selectionInfo.innerHTML = `<b>${sprite.label}</b> 已离开画面：不计入入镜与绘制统计。`;
    return;
  }
  const batch = state.plan.batchOfSprite[idx]!;
  const b = state.plan.batches[batch]!;
  const sameBatch = state.plan.paintOrder.slice(b.first, b.first + b.count).map((si) => state.sprites[si]!);
  const chips = sameBatch
    .slice(0, 12)
    .map(
      (s) =>
        `<span class="pill${s.id === sprite.id ? ' on' : ''}">${s.label}${s.draggable ? '' : ''}</span>`,
    )
    .join(' ');
  const more = sameBatch.length > 12 ? ` <span class="muted">+${sameBatch.length - 12}</span>` : '';
  selectionInfo.innerHTML =
    `<b>${sprite.label}</b> · 第 ${sprite.layer + 1} 层 · ${sprite.blend === 'alpha' ? '普通透明' : '叠加发光'}<br/>` +
    `实际批次 <b>#${batch}</b>（第 ${b.first + 1}..${b.first + b.count} 位，共 ${b.count} 个）` +
    `${state.plan.interruptedBatch[batch] ? ' · <span style="color:var(--interrupt)">被夹断</span>' : ''}<br/>` +
    `同批精灵：${chips}${more}`;
}

function highlightBatches(): Set<number> {
  const set = new Set<number>();
  if (state.hoverBatch !== null) set.add(state.hoverBatch);
  if (state.focusPair) {
    const it = state.plan.interruptions.find(
      (i) => i.before === state.focusPair![0] && i.after === state.focusPair![1],
    );
    if (it) {
      set.add(it.before);
      set.add(it.after);
      for (const b of it.between) set.add(b);
    }
  }
  return set;
}

/* ------------------------------------------------------------------ */
/* 渲染循环                                                            */
/* ------------------------------------------------------------------ */

let rafId = 0;

function frame(): void {
  rafId = 0;
  if (!state.needsRender || !ready) return;
  state.needsRender = false;
  recompute();
  const ref: PathDraw = {
    order: state.refOrder,
    colors: state.refColors,
    groups: state.refGroups,
    perSprite: true,
  };
  const batch: PathDraw = {
    order: state.plan.paintOrder,
    colors: state.batchColors,
    groups: state.batchGroups,
    perSprite: false,
  };
  renderer.render({
    camera: state.camera,
    sprites: state.sprites,
    ref,
    batch,
    batchColorMode: state.batchColor,
  });
  renderer.present(state.compareMode, state.split, state.amplify);
  drawOverlay(overlayCanvas, {
    camera: state.camera,
    hud: {
      visible: state.plan.counts.visible,
      culled: state.plan.counts.culled,
      batchCalls: renderer.stats.batchSpriteCalls,
      refCalls: renderer.stats.refSpriteCalls,
      batches: state.plan.counts.batches,
      frameDrawCalls: renderer.stats.frameDrawCalls,
    },
    deviceWidth: deviceW,
    deviceHeight: deviceH,
    dpr,
    sprites: state.sprites,
    plan: state.plan,
    selectedSpriteId: state.selectedSpriteId,
    hoverSpriteId: state.hoverSpriteId,
    highlightBatches: highlightBatches(),
    compareMode: state.compareMode,
    split: state.split,
    breakOrder: state.breakOrder,
  });
  renderPanels();
}

/** 侧栏批量 DOM 较重（最多数百个批次段），拖拽时限制重建频率。 */
const PANEL_MIN_INTERVAL_MS = 110;
let lastPanelBuild = 0;
let panelTimer = 0;

function renderPanels(force = false): void {
  const now = performance.now();
  const elapsed = now - lastPanelBuild;
  if (!force && elapsed < PANEL_MIN_INTERVAL_MS) {
    if (panelTimer === 0) {
      panelTimer = window.setTimeout(() => {
        panelTimer = 0;
        renderPanels(true);
      }, PANEL_MIN_INTERVAL_MS - elapsed + 4);
    }
    return;
  }
  if (panelTimer !== 0) {
    window.clearTimeout(panelTimer);
    panelTimer = 0;
  }
  lastPanelBuild = now;
  renderPanelsNow();
}

function requestFrame(): void {
  if (rafId === 0) rafId = requestAnimationFrame(frame);
}

/** 同步完成一次渲染，供读回、取样与自动化钩子使用。 */
function flush(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (state.needsRender && ready) frame();
}

function invalidate(): void {
  state.needsRender = true;
  requestFrame();
}

/* ------------------------------------------------------------------ */
/* 尺寸                                                                */
/* ------------------------------------------------------------------ */

function resize(): void {
  const rect = stageCanvas.getBoundingClientRect();
  cssW = Math.max(1, rect.width);
  cssH = Math.max(1, rect.height);
  deviceW = Math.max(1, Math.round(cssW * dpr));
  deviceH = Math.max(1, Math.round(cssH * dpr));
  renderer.resize(deviceW, deviceH);
  glCanvas.style.width = '100%';
  glCanvas.style.height = '100%';
  invalidate();
  scheduleCompare();
}

const resizeObserver = new ResizeObserver(() => resize());
resizeObserver.observe(stageCanvas);

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number; moved: number }
  | { kind: 'probe'; spriteIndex: number; grabDX: number; grabDY: number; moved: number };

let drag: DragState = { kind: 'none' };
let pointerCss = { x: 0, y: 0 };
let pointerInside = false;

function eventCss(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = overlayCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function cssToWorld(cssX: number, cssY: number): { x: number; y: number } {
  return eyeToWorld(state.camera, deviceW, deviceH, cssX * dpr, cssY * dpr);
}

function topmostSpriteAt(cssX: number, cssY: number, onlyDraggable: boolean): number | null {
  const world = cssToWorld(cssX, cssY);
  const order = state.plan.paintOrder;
  for (let i = order.length - 1; i >= 0; i--) {
    const si = order[i]!;
    const sprite = state.sprites[si]!;
    if (onlyDraggable && !sprite.draggable) continue;
    const r = spriteRect(sprite);
    if (world.x >= r.minX && world.x <= r.maxX && world.y >= r.minY && world.y <= r.maxY) return si;
  }
  return null;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  overlayCanvas.setPointerCapture(event.pointerId);
  const p = eventCss(event);
  const hitProbe = topmostSpriteAt(p.x, p.y, true);
  let hit: number | null = hitProbe;
  if (hit === null) hit = topmostSpriteAt(p.x, p.y, false);
  if (hit !== null) {
    const sprite = state.sprites[hit]!;
    state.selectedSpriteId = sprite.id;
    state.selectedBatch = state.plan.batchOfSprite[hit] ?? null;
    state.focusPair = null;
    renderPanels();
    invalidate();
  }
  const world = cssToWorld(p.x, p.y);
  if (hitProbe !== null) {
    const sprite = state.sprites[hitProbe]!;
    drag = {
      kind: 'probe',
      spriteIndex: hitProbe,
      grabDX: world.x - sprite.x,
      grabDY: world.y - sprite.y,
      moved: 0,
    };
    overlayCanvas.classList.add('dragging');
  } else {
    drag = { kind: 'pan', lastX: p.x, lastY: p.y, moved: 0 };
    overlayCanvas.classList.add('dragging');
  }
}

function onPointerMove(event: PointerEvent): void {
  const p = eventCss(event);
  pointerCss = p;
  pointerInside = true;
  if (drag.kind === 'probe') {
    const world = cssToWorld(p.x, p.y);
    const sprite = state.sprites[drag.spriteIndex];
    if (sprite) {
      const margin = 900;
      sprite.x = Math.max(-margin, Math.min(state.scene.worldWidth + margin, world.x - drag.grabDX));
      sprite.y = Math.max(-margin, Math.min(state.scene.worldHeight + margin, world.y - drag.grabDY));
      drag.moved += Math.abs(event.movementX) + Math.abs(event.movementY);
    }
    invalidate();
    scheduleCompare();
    return;
  }
  if (drag.kind === 'pan') {
    const dx = (p.x - drag.lastX) * dpr;
    const dy = (p.y - drag.lastY) * dpr;
    drag.lastX = p.x;
    drag.lastY = p.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    state.camera = panByEye(state.camera, dx, dy);
    invalidate();
    scheduleCompare();
    return;
  }
  // 悬停：找最上层的精灵用于描边与像素取样。
  const hit = topmostSpriteAt(p.x, p.y, false);
  const hoverId = hit === null ? null : state.sprites[hit]!.id;
  if (hoverId !== state.hoverSpriteId) {
    state.hoverSpriteId = hoverId;
    invalidate();
  }
  if (state.pixelProbe) updatePixelSample(p);
}

function onPointerUp(event: PointerEvent): void {
  if (drag.kind === 'none') return;
  overlayCanvas.classList.remove('dragging');
  const wasProbe = drag.kind === 'probe';
  drag = { kind: 'none' };
  if (event.pointerId !== undefined && overlayCanvas.hasPointerCapture(event.pointerId)) {
    overlayCanvas.releasePointerCapture(event.pointerId);
  }
  if (wasProbe) scheduleCompare();
}

function onPointerLeave(): void {
  pointerInside = false;
  if (state.hoverSpriteId !== null) {
    state.hoverSpriteId = null;
    invalidate();
  }
}

overlayCanvas.addEventListener('pointerdown', onPointerDown);
overlayCanvas.addEventListener('pointermove', onPointerMove);
overlayCanvas.addEventListener('pointerup', onPointerUp);
overlayCanvas.addEventListener('pointercancel', onPointerUp);
overlayCanvas.addEventListener('pointerleave', onPointerLeave);

overlayCanvas.addEventListener(
  'wheel',
  (event: WheelEvent) => {
    event.preventDefault();
    const p = eventCss(event);
    const factor = Math.exp(-event.deltaY * 0.0016);
    state.camera = zoomAt(
      state.camera,
      factor,
      p.x * dpr,
      p.y * dpr,
      deviceW,
      deviceH,
    );
    invalidate();
    scheduleCompare();
  },
  { passive: false },
);

overlayCanvas.addEventListener('dblclick', (event: MouseEvent) => {
  const rect = overlayCanvas.getBoundingClientRect();
  const p = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  state.camera = zoomAt(state.camera, 1.8, p.x * dpr, p.y * dpr, deviceW, deviceH);
  invalidate();
  scheduleCompare();
});

/* ------------------------------------------------------------------ */
/* 像素取样与整幅比对                                                  */
/* ------------------------------------------------------------------ */

/** 1×1 读回仍是一次 GPU 同步，悬停取样按 ~70ms 节流。 */
const PIXEL_SAMPLE_INTERVAL_MS = 70;
let lastPixelSampleAt = 0;
let pendingPixelPoint: { x: number; y: number } | null = null;
let pixelTimer = 0;

function updatePixelSample(cssPoint: { x: number; y: number }): void {
  const now = performance.now();
  if (now - lastPixelSampleAt < PIXEL_SAMPLE_INTERVAL_MS) {
    pendingPixelPoint = cssPoint;
    if (pixelTimer === 0) {
      pixelTimer = window.setTimeout(() => {
        pixelTimer = 0;
        const p = pendingPixelPoint;
        pendingPixelPoint = null;
        if (p && state.pixelProbe) updatePixelSample(p);
      }, PIXEL_SAMPLE_INTERVAL_MS);
    }
    return;
  }
  lastPixelSampleAt = now;
  flush();
  const px = Math.floor(cssPoint.x * dpr);
  const py = Math.floor(cssPoint.y * dpr);
  if (px < 0 || py < 0 || px >= deviceW || py >= deviceH) return;
  const { ref, batch } = renderer.samplePixel(px, py);
  const sample: PixelSample = {
    ref,
    batch,
    maxDelta: Math.max(
      Math.abs(ref[0] - batch[0]),
      Math.abs(ref[1] - batch[1]),
      Math.abs(ref[2] - batch[2]),
      Math.abs(ref[3] - batch[3]),
    ),
  };
  lastPixel = { sample, pos: { x: px, y: py } };
  renderPixel(pixelResult, sample, lastPixel.pos);
}

let compareTimer = 0;
function scheduleCompare(): void {
  if (!ready || !state.autoCompare) return;
  window.clearTimeout(compareTimer);
  compareTimer = window.setTimeout(() => runCompare(false), 260);
}

let compareToken = 0;
function runCompare(forceUi = true): BufferDiff | null {
  if (!ready) return null;
  flush();
  const token = ++compareToken;
  const { ref, batch, width, height } = renderer.readback();
  if (token !== compareToken) return null;
  const diff = compareRgba(ref, batch, width, height, (bytes) => toHex32(fnv1a(bytes)));
  diffUi = {
    status: 'done',
    diff,
    sceneKey: state.scene.title,
    when: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
  renderDiff(diffResult, diffUi);
  void forceUi;
  return diff;
}

readbackBtn.addEventListener('click', () => {
  diffUi = { status: 'running' };
  renderDiff(diffResult, diffUi);
  // 让"读回中"先上屏，再做同步 readPixels。
  window.setTimeout(() => runCompare(true), 16);
});

/* ------------------------------------------------------------------ */
/* 工具栏                                                              */
/* ------------------------------------------------------------------ */

function setCompareMode(mode: number): void {
  state.compareMode = mode;
  for (const btn of Array.from(compareModes.querySelectorAll('button'))) {
    btn.classList.toggle('active', Number((btn as HTMLElement).dataset.mode) === mode);
  }
  splitControl.classList.toggle('hidden', mode !== 2);
  amplifyControl.classList.toggle('hidden', mode !== 3);
  invalidate();
}

compareModes.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button');
  if (!target) return;
  setCompareMode(Number(target.dataset.mode));
});

splitSlider.addEventListener('input', () => {
  state.split = Number(splitSlider.value) / 1000;
  invalidate();
});

amplifySlider.addEventListener('input', () => {
  state.amplify = Number(amplifySlider.value);
  amplifyValue.textContent = String(state.amplify);
  invalidate();
});

batchColorToggle.addEventListener('change', () => {
  state.batchColor = batchColorToggle.checked;
  invalidate();
});

const breakOrderToggle = byId<HTMLInputElement>('breakOrderToggle');
breakOrderToggle.addEventListener('change', () => {
  state.breakOrder = breakOrderToggle.checked;
  makeDirty();
  invalidate();
  scheduleCompare();
});

pixelProbeToggle.addEventListener('change', () => {
  state.pixelProbe = pixelProbeToggle.checked;
  if (!state.pixelProbe) {
    pendingPixelPoint = null;
    lastPixel = { sample: null, pos: null };
    renderPixel(pixelResult, null, null);
  } else if (pointerInside) {
    updatePixelSample(pointerCss);
  }
});

autoCompareToggle.addEventListener('change', () => {
  state.autoCompare = autoCompareToggle.checked;
  if (state.autoCompare) scheduleCompare();
});

sceneTabs.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button');
  if (!target) return;
  const key = target.dataset.scene as SceneKey | undefined;
  if (!key || key === state.sceneKey) return;
  loadScene(key);
  invalidate();
  scheduleCompare();
});

byId<HTMLButtonElement>('resetCamera').addEventListener('click', () => {
  state.camera = fitCamera(state.scene.worldWidth, state.scene.worldHeight, deviceW, deviceH);
  invalidate();
  scheduleCompare();
});

byId<HTMLButtonElement>('zoomIn').addEventListener('click', () => {
  state.camera = { ...state.camera, zoom: clampZoom(state.camera.zoom * 1.35) };
  invalidate();
  scheduleCompare();
});

byId<HTMLButtonElement>('zoomOut').addEventListener('click', () => {
  state.camera = { ...state.camera, zoom: clampZoom(state.camera.zoom / 1.35) };
  invalidate();
  scheduleCompare();
});

byId<HTMLButtonElement>('resetDrag').addEventListener('click', () => {
  const fresh = buildScene(state.sceneKey);
  for (const sprite of state.sprites) {
    if (!sprite.draggable) continue;
    const source = fresh.sprites.find((s) => s.id === sprite.id);
    if (!source) continue;
    sprite.x = source.x;
    sprite.y = source.y;
    sprite.layer = source.layer;
    (sprite as { blend: Sprite['blend'] }).blend = source.blend;
  }
  makeDirty();
  invalidate();
  scheduleCompare();
});

splitControl.classList.toggle('hidden', state.compareMode !== 2);
amplifyControl.classList.toggle('hidden', state.compareMode !== 3);
renderTextures(textureStrip, textures);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

try {
  resize();
  loadScene('interleaved');
  recompute();
  ready = true;
  invalidate();
  // 首帧后再做一次比对，作为"打开即一致"的基线。
  window.setTimeout(() => runCompare(true), 400);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fatalBox.classList.remove('hidden');
  fatalBox.textContent = `初始化失败：${message}`;
  console.error(error);
}

/* ------------------------------------------------------------------ */
/* 自动化测试钩子                                                      */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    __lab?: {
      ready: boolean;
      getState: () => {
        sceneKey: SceneKey;
        visible: number;
        culled: number;
        batches: number;
        drawCalls: number;
        refDrawCalls: number;
        frameDrawCalls: number;
        camera: Camera;
        selectedSpriteId: number | null;
        selectedBatch: number | null;
        batchOfSelected: number | null;
        interruptedPairs: number;
        blendBreaks: number;
        layerBreaks: number;
      };
      setScene: (key: SceneKey) => void;
      setCamera: (partial: Partial<Camera>) => void;
      runCompare: () => BufferDiff;
      pixelAt: (cssX: number, cssY: number) => PixelSample;
      setProbe: (label: string, patch: { x?: number; y?: number; layer?: number; blend?: 'alpha' | 'additive' }) => void;
      selectSpriteByLabel: (label: string) => void;
      selectSpriteIndex: (index: number) => void;
      batchSpriteLabels: (batch: number) => string[];
      setBreakOrder: (on: boolean) => void;
      moveProbeOffscreen: (label: string) => void;
      measureRange: () => { min: number; max: number; avg: number };
      types: typeof SCENE_META;
    };
  }
}

window.__lab = {
  ready: true,
  getState: () => (flush(), {
    sceneKey: state.sceneKey,
    visible: state.plan.counts.visible,
    culled: state.plan.counts.culled,
    batches: state.plan.counts.batches,
    drawCalls: renderer.stats.batchSpriteCalls,
    refDrawCalls: renderer.stats.refSpriteCalls,
    frameDrawCalls: renderer.stats.frameDrawCalls,
    camera: { ...state.camera },
    selectedSpriteId: state.selectedSpriteId,
    selectedBatch: state.selectedBatch,
    batchOfSelected: spriteIndexOfId(state.selectedSpriteId) !== null
      ? state.plan.batchOfSprite[spriteIndexOfId(state.selectedSpriteId)!]!
      : null,
    interruptedPairs: state.plan.counts.interruptedPairs,
    blendBreaks: state.plan.counts.blendBreaks,
    layerBreaks: state.plan.counts.layerBreaks,
  }),
  setScene: (key) => {
    loadScene(key);
    invalidate();
  },
  setCamera: (partial) => {
    state.camera = { ...state.camera, ...partial };
    state.camera.zoom = clampZoom(state.camera.zoom);
    invalidate();
    scheduleCompare();
  },
  runCompare: () => {
    const diff = runCompare(true);
    if (!diff) throw new Error('比对失败');
    return diff;
  },
  pixelAt: (cssX, cssY) => {
    flush();
    const px = Math.floor(cssX * dpr);
    const py = Math.floor(cssY * dpr);
    const out = renderer.samplePixel(px, py);
    return {
      ref: out.ref,
      batch: out.batch,
      maxDelta: Math.max(
        Math.abs(out.ref[0] - out.batch[0]),
        Math.abs(out.ref[1] - out.batch[1]),
        Math.abs(out.ref[2] - out.batch[2]),
        Math.abs(out.ref[3] - out.batch[3]),
      ),
    };
  },
  setProbe: (label, patch) => {
    const idx = state.sprites.findIndex((s) => s.draggable && s.label === label);
    if (idx < 0) throw new Error(`找不到探针 ${label}`);
    const sprite = state.sprites[idx]!;
    if (patch.x !== undefined) sprite.x = patch.x;
    if (patch.y !== undefined) sprite.y = patch.y;
    if (patch.layer !== undefined) sprite.layer = patch.layer;
    if (patch.blend !== undefined) (sprite as { blend: Sprite['blend'] }).blend = patch.blend;
    state.selectedSpriteId = sprite.id;
    invalidate();
  },
  selectSpriteByLabel: (label) => {
    const idx = state.sprites.findIndex((s) => s.label === label);
    if (idx < 0) throw new Error(`找不到精灵 ${label}`);
    callbacks.onSelectSprite(idx);
    invalidate();
  },
  selectSpriteIndex: (index) => {
    callbacks.onSelectSprite(index);
    invalidate();
  },
  batchSpriteLabels: (batch) => {
    const b = state.plan.batches[batch];
    if (!b) return [];
    return state.plan.paintOrder
      .slice(b.first, b.first + b.count)
      .map((si) => state.sprites[si]!.label);
  },
  setBreakOrder: (on) => {
    breakOrderToggle.checked = on;
    state.breakOrder = on;
    makeDirty();
    invalidate();
  },
  moveProbeOffscreen: (label) => {
    const idx = state.sprites.findIndex((s) => s.draggable && s.label === label);
    if (idx < 0) throw new Error(`找不到探针 ${label}`);
    const sprite = state.sprites[idx]!;
    const view = state.plan.viewRect;
    sprite.x = view.maxX + sprite.w * 2 + 500;
    sprite.y = view.maxY + sprite.h * 2 + 500;
    state.selectedSpriteId = sprite.id;
    invalidate();
  },
  measureRange: () => {
    flush();
    const { ref, batch } = renderer.readback();
    let min = 255;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(ref[i]! - batch[i]!);
      if (d < min) min = d;
      if (d > max) max = d;
      sum += d;
    }
    return { min, max, avg: ref.length ? sum / ref.length : 0 };
  },
  types: SCENE_META,
};
