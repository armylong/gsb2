import './style.css';
import * as THREE from 'three';
import { AssemblyScene } from './scene';
import { PHASE_SPAN, evaluateActive, phaseWindowToGlobal } from './explosion';
import { buildConflictConfig, buildValidConfig } from './preset';
import { summarizeHit } from './collision';
import {
  clearSession,
  downloadConfig,
  loadSession,
  saveSession,
  validateConfig,
} from './storage';
import type {
  CameraSnapshot,
  CollisionHit,
  EditorConfig,
  PartDef,
  SavedSession,
} from './types';

// ------------------------------------------------------------ DOM 句柄
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  viewport: $<HTMLDivElement>('viewport'),
  tree: $<HTMLDivElement>('tree'),
  partEditor: $<HTMLDivElement>('part-editor'),
  progress: $<HTMLInputElement>('progress'),
  progressValue: $<HTMLSpanElement>('progress-value'),
  timeline: $<HTMLDivElement>('timeline'),
  badgePhase: $<HTMLSpanElement>('badge-phase'),
  activeParts: $<HTMLSpanElement>('active-parts'),
  liveWarning: $<HTMLDivElement>('live-warning'),
  liveWarningText: $<HTMLSpanElement>('live-warning-text'),
  collisionList: $<HTMLDivElement>('collision-list'),
  lid: $<HTMLInputElement>('lid-angle'),
  lidValue: $<HTMLSpanElement>('lid-value'),
  play: $<HTMLButtonElement>('btn-play'),
  assemble: $<HTMLButtonElement>('btn-assemble'),
  explode: $<HTMLButtonElement>('btn-explode'),
  camera: $<HTMLButtonElement>('btn-camera'),
};

// ------------------------------------------------------------ 应用状态
interface AppState {
  config: EditorConfig;
  progress: number;
  lidAngle: number;
  selectedId: string | null;
  camera?: CameraSnapshot;
}

let state: AppState = bootstrapState();
let scene: AssemblyScene;
let saveTimer: number | undefined;
let playRaf = 0;
let playDirection = 1;

function bootstrapState(): AppState {
  const saved = loadSession();
  if (saved) {
    return {
      config: saved.config,
      progress: saved.progress,
      lidAngle: saved.lidAngle,
      selectedId: null,
      camera: saved.camera,
    };
  }
  return { config: buildValidConfig(), progress: 0, lidAngle: 0, selectedId: null };
}

// ------------------------------------------------------------ 场景生命周期
let resizeObserver: ResizeObserver | null = null;
let resizeBound = false;

function startScene() {
  scene = new AssemblyScene(els.viewport, state.config);
  scene.onPick = (id) => {
    state.selectedId = id;
    scene.select(id);
    renderTree();
    renderPartEditor();
  };
  if (state.camera) scene.restoreCamera(state.camera);
  scene.startLoop();

  const resize = () => scene.resize(els.viewport.clientWidth, els.viewport.clientHeight);
  // Observer/监听只注册一次, 避免反复切换预设时泄漏
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(els.viewport);
  }
  if (!resizeBound) {
    window.addEventListener('resize', resize);
    resizeBound = true;
  }

  scene.applyProgress(state.progress, state.lidAngle);
  scene.recomputeCollisions();
  refreshAll();
}

function restartScene(config: EditorConfig, keepCamera = true) {
  const camera = scene ? scene.getCameraSnapshot() : state.camera;
  scene?.dispose();
  state.config = config;
  state.selectedId = null;
  // 切换/导入配置后回到合装状态, 避免在旧进度上扫描新配置
  state.progress = 0;
  liveWarningIds.clear();
  els.progress.value = '0';
  startScene();
  if (keepCamera && camera) scene.restoreCamera(camera);
  scheduleSave();
}

// ------------------------------------------------------------ 进度驱动
function setProgress(p: number, opts: { syncSlider?: boolean } = {}) {
  state.progress = THREE.MathUtils.clamp(p, 0, 1);
  if (opts.syncSlider !== false) els.progress.value = String(Math.round(state.progress * 1000));
  scene.applyProgress(state.progress, state.lidAngle);
  refreshHud();
  refreshTimelineCursor();
  refreshLiveWarning();
  scheduleSave();
}

function refreshHud() {
  const { phase, movingParts } = evaluateActive(state.config, state.progress);
  els.badgePhase.textContent = `第 ${phase + 1} 段`;
  els.badgePhase.style.background = phase === 0 ? '#2e7d32' : '#6a3d9a';
  if (movingParts.length === 0) {
    els.activeParts.textContent =
      state.progress === 0 ? '合装状态' : state.progress >= 1 ? '完全展开' : '当前窗口无零件动作';
  } else {
    els.activeParts.textContent = `动作中: ${movingParts.map((p) => p.name).join('、')}`;
  }
  els.progressValue.textContent = `${Math.round(state.progress * 100)}%`;
  // 翻盖只允许在合装状态调整
  els.lid.disabled = state.progress !== 0;
}

/** 当前实时干涉的零件集合, 树的红色高亮与 3D 场景都以它为准 */
const liveWarningIds = new Set<string>();

/** 当前实时干涉 -> 红色高亮 + HUD 警告; 恢复顺序/进度后自动消失 */
function refreshLiveWarning() {
  const live = scene.liveCollisions(state.progress);
  liveWarningIds.clear();
  for (const h of live) {
    liveWarningIds.add(h.moving);
    liveWarningIds.add(h.blocker);
  }
  // 高亮以实时结果为准; 无实时碰撞时清空, 避免扫描残留让红色不消失
  scene.setWarningIds(new Set(liveWarningIds));
  if (live.length === 0) {
    els.liveWarning.hidden = true;
    renderTree();
    return;
  }
  els.liveWarning.hidden = false;
  const names = live
    .map((h) => `${nameOf(h.moving)} ✕ ${nameOf(h.blocker)}`)
    .filter((value, i, arr) => arr.indexOf(value) === i)
    .join('；');
  els.liveWarningText.textContent = `实时干涉: ${names}`;
  renderTree();
}

// ------------------------------------------------------------ 装配树
function renderTree() {
  const roots = state.config.parts.filter((p) => p.parentId === null);
  const warningIds = collectWarningIds();
  const walk = (part: PartDef): string => {
    const children = state.config.parts.filter((p) => p.parentId === part.id);
    const dot = part.step ? `p${part.step.phase}` : 'none';
    const sel = state.selectedId === part.id ? 'selected' : '';
    const warn = warningIds.has(part.id) ? 'warning' : '';
    const childHtml = children.length ? `<ul>${children.map(walk).join('')}</ul>` : '';
    return `
      <li>
        <div class="tree-node ${sel} ${warn}" data-id="${part.id}">
          <span class="phase-dot ${dot}"></span>
          <span class="node-name">${part.name}</span>
          <span class="node-id">${part.id}</span>
        </div>
        ${childHtml}
      </li>`;
  };
  els.tree.innerHTML = `<ul>${roots.map(walk).join('')}</ul>`;
  els.tree.querySelectorAll<HTMLElement>('.tree-node').forEach((node) => {
    node.addEventListener('click', () => selectPart(node.dataset.id!));
  });
}

function selectPart(id: string) {
  state.selectedId = id;
  scene.select(id);
  // 选中后刷新方向箭头, 并让时间轴/树的选中态同步
  scene.applyProgress(state.progress, state.lidAngle);
  renderTree();
  renderTimeline();
  renderPartEditor();
}

/** 树的红色高亮只反映「当前时刻」的实时干涉, 拖回安全进度后立即清空 */
function collectWarningIds(): Set<string> {
  return new Set(liveWarningIds);
}

// ------------------------------------------------------------ 零件参数编辑
function renderPartEditor() {
  const part = state.config.parts.find((p) => p.id === state.selectedId);
  if (!part) {
    els.partEditor.innerHTML = '<p class="muted">在左侧模型或树中选择一个零件</p>';
    return;
  }
  const step = part.step;
  const phaseBtn = (which: 0 | 1, label: string) =>
    `<button class="btn ${step && step.phase === which ? `on-p${which}` : ''}" data-act="phase" data-phase="${which}">${label}</button>`;

  els.partEditor.innerHTML = `
    <div class="part-title">${part.name}<small>${part.id}</small></div>
    <p class="muted">父组件: ${part.parentId ? nameOf(part.parentId) : '装配根(顶层)'}</p>
    ${
      step
        ? `
      <label class="field"><span>展开段</span>
        <div class="seg-switch">${phaseBtn(0, '第 1 段')}${phaseBtn(1, '第 2 段')}</div>
      </label>
      <label class="field"><span>段内开始 <b data-bind="start"></b></span>
        <input type="range" min="0" max="100" value="${Math.round(step.start * 100)}" data-bind="start" />
      </label>
      <label class="field"><span>段内结束 <b data-bind="end"></b></span>
        <input type="range" min="0" max="100" value="${Math.round(step.end * 100)}" data-bind="end" />
      </label>
      <label class="field"><span>局部拉开方向(父节点局部坐标轴)</span>
        <div class="vec3-row">
          <input type="number" step="0.1" data-bind="dirx" value="${step.dir[0]}" aria-label="dir x" />
          <input type="number" step="0.1" data-bind="diry" value="${step.dir[1]}" aria-label="dir y" />
          <input type="number" step="0.1" data-bind="dirz" value="${step.dir[2]}" aria-label="dir z" />
        </div>
      </label>
      <label class="field"><span>拉开距离: <b data-bind="distance"></b></span>
        <input type="range" min="0" max="6" step="0.05" value="${step.distance}" data-bind="distance" />
      </label>`
        : `<p class="muted">该零件不参与爆炸(外壳为固定基准件)。</p>`
    }`;

  if (!step) return;

  // 数值标签
  const labelOf = (key: 'start' | 'end' | 'distance') =>
    els.partEditor.querySelector<HTMLElement>(`b[data-bind="${key}"]`);
  const updateLabels = () => {
    labelOf('start')!.textContent = `${Math.round(step.start * 100)}%`;
    labelOf('end')!.textContent = `${Math.round(step.end * 100)}%`;
    labelOf('distance')!.textContent = step.distance.toFixed(2);
  };
  updateLabels();

  els.partEditor.querySelectorAll<HTMLInputElement>('input[data-bind]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.bind!;
      if (key === 'start' || key === 'end') {
        step[key] = Number(input.value) / 100;
        if (step.start >= step.end) {
          // 保证窗口合法: 拖动越界时夹住另一个边界
          if (key === 'start') step.start = step.end - 0.01;
          else step.end = step.start + 0.01;
        }
      } else if (key === 'distance') {
        step.distance = Number(input.value);
      } else if (key === 'dirx' || key === 'diry' || key === 'dirz') {
        const idx = key === 'dirx' ? 0 : key === 'diry' ? 1 : 2;
        step.dir[idx] = Number(input.value);
      }
      updateLabels();
      afterConfigEdited();
    });
  });

  els.partEditor.querySelectorAll<HTMLButtonElement>('button[data-act="phase"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      step.phase = Number(btn.dataset.phase) as 0 | 1;
      renderPartEditor();
      afterConfigEdited();
    });
  });
}

/** 任何配置编辑后: 重算位移与干涉, 刷新全部视图并自动保存 */
function afterConfigEdited() {
  scene.applyProgress(state.progress, state.lidAngle);
  scene.recomputeCollisions();
  refreshAll();
  scheduleSave();
}

// ------------------------------------------------------------ 时间轴
function renderTimeline() {
  const moving = new Set(evaluateActive(state.config, state.progress).movingParts.map((p) => p.id));
  const blocks = state.config.parts
    .filter((p) => p.step)
    .map((p) => {
      const step = p.step!;
      const [gStart, gEnd] = phaseWindowToGlobal(step.phase, step.start, step.end);
      const cls = [`tl-block`, `p${step.phase}`];
      if (moving.has(p.id)) cls.push('moving');
      if (p.id === state.selectedId) cls.push('selected');
      return `
        <div class="${cls.join(' ')}" style="left:${gStart * 100}%;width:${(gEnd - gStart) * 100}%"
             data-id="${p.id}" title="${p.name}"></div>`;
    })
    .join('');

  const collisionBands = scene.report.hits
    .map(
      (h) =>
        `<div class="tl-collision" style="left:${h.rangeStart * 100}%;width:${
          (h.rangeEnd - h.rangeStart) * 100
        }%" title="${nameOf(h.moving)} ✕ ${nameOf(h.blocker)}"></div>`,
    )
    .join('');

  els.timeline.innerHTML = `
    <div class="divider"></div>
    ${blocks}
    ${collisionBands}
    <div class="tl-cursor" id="tl-cursor"></div>`;
  refreshTimelineCursor();

  els.timeline.querySelectorAll<HTMLElement>('.tl-block').forEach((b) =>
    b.addEventListener('click', () => selectPart(b.dataset.id!)),
  );
}

function refreshTimelineCursor() {
  const cursor = document.getElementById('tl-cursor');
  if (cursor) cursor.style.left = `${state.progress * 100}%`;
}

// ------------------------------------------------------------ 干涉面板
function renderCollisionList() {
  const report = scene.report;
  if (report.hits.length === 0) {
    els.collisionList.innerHTML =
      '<div class="collision-ok">✓ 全进度扫描未发现非法干涉, 该顺序可以来回装合</div>';
    return;
  }
  els.collisionList.innerHTML = report.hits
    .map((h: CollisionHit) => {
      const s = summarizeHit(h, nameOf);
      const phaseText = h.rangeStart < PHASE_SPAN ? '第 1 段' : '第 2 段';
      return `
        <div class="collision-item" data-key="${s.key}">
          <div class="ci-title">${s.text}</div>
          <div class="ci-range">${s.rangeText} · 问题段: ${phaseText}</div>
        </div>`;
    })
    .join('');
  els.collisionList.querySelectorAll<HTMLElement>('.collision-item').forEach((item) => {
    item.addEventListener('click', () => {
      const [a] = item.dataset.key!.split('|');
      selectPart(a);
    });
  });
}

function nameOf(id: string): string {
  return state.config.parts.find((p) => p.id === id)?.name ?? id;
}

function refreshAll() {
  refreshHud();
  renderTree();
  renderPartEditor();
  renderTimeline();
  renderCollisionList();
  refreshLiveWarning();
}

// ------------------------------------------------------------ 播放
function togglePlay() {
  if (playRaf) {
    cancelAnimationFrame(playRaf);
    playRaf = 0;
    els.play.textContent = '播放';
    return;
  }
  els.play.textContent = '暂停';
  if (state.progress >= 1 || state.progress <= 0) playDirection = state.progress >= 1 ? -1 : 1;
  let last = performance.now();
  const tick = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    let next = state.progress + playDirection * dt * 0.25;
    if (next >= 1) {
      next = 1;
      playDirection = -1;
    } else if (next <= 0) {
      next = 0;
      playDirection = 1;
    }
    setProgress(next);
    playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
}

// ------------------------------------------------------------ 自动保存 / 导入导出
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const session: SavedSession = {
      version: 1,
      config: state.config,
      progress: state.progress,
      lidAngle: state.lidAngle,
      camera: scene.getCameraSnapshot(),
    };
    saveSession(session);
  }, 400);
}

function exportJson() {
  downloadConfig(state.config);
}

async function importJson(file: File) {
  try {
    const text = await file.text();
    const data = JSON.parse(text) as unknown;
    if (!validateConfig(data)) {
      alert('导入失败: JSON 结构不符合展开配置 schema');
      return;
    }
    restartScene(data, false);
    setProgress(0);
  } catch (err) {
    alert(`导入失败: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------ 事件绑定
function bindEvents() {
  els.progress.addEventListener('input', () => setProgress(Number(els.progress.value) / 1000));
  els.play.addEventListener('click', togglePlay);
  els.assemble.addEventListener('click', () => setProgress(0));
  els.explode.addEventListener('click', () => setProgress(1));
  els.camera.addEventListener('click', () => scene.resetCamera());

  els.lid.addEventListener('input', () => {
    state.lidAngle = (Number(els.lid.value) * Math.PI) / 180;
    els.lidValue.textContent = `${els.lid.value}°`;
    scene.applyProgress(state.progress, state.lidAngle);
    scheduleSave();
  });

  $('btn-preset-valid').addEventListener('click', () => restartScene(buildValidConfig()));
  $('btn-preset-conflict').addEventListener('click', () => restartScene(buildConflictConfig()));
  $('btn-export').addEventListener('click', exportJson);
  $('btn-reset-session').addEventListener('click', () => {
    clearSession();
    location.reload();
  });
  const fileInput = $<HTMLInputElement>('file-import');
  $('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void importJson(file);
    fileInput.value = '';
  });

  // 相机被用户转动后也持久化
  setInterval(() => scheduleSave(), 3000);
}

// ------------------------------------------------------------ 启动
bindEvents();
startScene();
els.lid.value = String(Math.round((state.lidAngle * 180) / Math.PI));
els.lidValue.textContent = `${els.lid.value}°`;
els.progress.value = String(Math.round(state.progress * 1000));
