import {
  applyFold,
  applyPunch,
  applyUnfold,
  createInitialState,
  evaluate,
  keyOf,
  maybeWin,
  undoLast,
  type ActionResult,
  type GameState,
} from './engine.js';
import { LEVELS } from './levels.js';
import {
  computeCamera,
  drawFolded,
  drawLayerInspector,
  drawUnfoldPreview,
  pxToCell,
} from './render.js';

type Mode = 'fold' | 'punch';

interface El {
  main: HTMLCanvasElement;
  layers: HTMLCanvasElement;
  preview: HTMLCanvasElement;
  log: HTMLUListElement;
  brief: HTMLParagraphElement;
  status: HTMLDivElement;
  counters: HTMLDivElement;
  levelSelect: HTMLSelectElement;
  modeFold: HTMLInputElement;
  modePunch: HTMLInputElement;
  foldAxis: HTMLSelectElement;
  foldLine: HTMLSelectElement;
  foldSide: HTMLSelectElement;
  punchDepth: HTMLSelectElement;
  selectedInfo: HTMLDivElement;
  undo: HTMLButtonElement;
  unfold: HTMLButtonElement;
  restart: HTMLButtonElement;
  demo: HTMLButtonElement;
  stopDemo: HTMLButtonElement;
  toast: HTMLDivElement;
}

const el = {} as El;
let state: GameState;
let selected: { x: number; y: number } | null = null;
let hover: { x: number; y: number } | null = null;
let mode: Mode = 'fold';
let demoTimer: ReturnType<typeof setTimeout> | null = null;

function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

function init(): void {
  el.main = $<HTMLCanvasElement>('mainCanvas');
  el.layers = $<HTMLCanvasElement>('layerCanvas');
  el.preview = $<HTMLCanvasElement>('previewCanvas');
  el.log = $<HTMLUListElement>('logList');
  el.brief = $<HTMLParagraphElement>('brief');
  el.status = $<HTMLDivElement>('status');
  el.counters = $<HTMLDivElement>('counters');
  el.levelSelect = $<HTMLSelectElement>('levelSelect');
  el.modeFold = $<HTMLInputElement>('modeFold');
  el.modePunch = $<HTMLInputElement>('modePunch');
  el.foldAxis = $<HTMLSelectElement>('foldAxis');
  el.foldLine = $<HTMLSelectElement>('foldLine');
  el.foldSide = $<HTMLSelectElement>('foldSide');
  el.punchDepth = $<HTMLSelectElement>('punchDepth');
  el.selectedInfo = $<HTMLDivElement>('selectedInfo');
  el.undo = $<HTMLButtonElement>('undoBtn');
  el.unfold = $<HTMLButtonElement>('unfoldBtn');
  el.restart = $<HTMLButtonElement>('restartBtn');
  el.demo = $<HTMLButtonElement>('demoBtn');
  el.stopDemo = $<HTMLButtonElement>('stopDemoBtn');
  el.toast = $<HTMLDivElement>('toast');

  for (const level of LEVELS) {
    const opt = document.createElement('option');
    opt.value = String(level.id);
    opt.textContent = level.name;
    el.levelSelect.add(opt);
  }
  el.levelSelect.addEventListener('change', () => loadLevel(Number(el.levelSelect.value)));
  el.modeFold.addEventListener('change', () => setMode('fold'));
  el.modePunch.addEventListener('change', () => setMode('punch'));
  el.foldAxis.addEventListener('change', refreshFoldLines);
  el.undo.addEventListener('click', () => guard(() => undoLast(state)));
  el.unfold.addEventListener('click', () => guard(() => applyUnfold(state)));
  el.restart.addEventListener('click', () => restart());
  el.demo.addEventListener('click', () => playDemo());
  el.stopDemo.addEventListener('click', () => stopDemo());
  el.stopDemo.hidden = true;

  el.main.addEventListener('mousemove', onMove);
  el.main.addEventListener('mouseleave', () => {
    hover = null;
    render();
  });
  el.main.addEventListener('click', onClick);

  loadLevel(LEVELS[0].id);
}

function loadLevel(id: number): void {
  stopDemo();
  const level = LEVELS.find((l) => l.id === id)!;
  state = createInitialState(level);
  selected = null;
  hover = null;
  el.levelSelect.value = String(id);
  el.brief.textContent =
    `${level.brief} ｜ 纸面 ${level.width}×${level.height}，厚度上限 ${level.maxThickness} 层。`;
  refreshFoldLines();
  refreshDepthOptions();
  render();
}

function refreshFoldLines(): void {
  const axis = el.foldAxis.value as 'v' | 'h';
  const limit = axis === 'v' ? state.level.width : state.level.height;
  const prev = el.foldLine.value;
  el.foldLine.innerHTML = '';
  for (let i = 1; i < limit; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i}（${axis === 'v' ? `x=${i}` : `y=${i}`}）`;
    el.foldLine.add(opt);
  }
  if ([...el.foldLine.options].some((o) => o.value === prev)) el.foldLine.value = prev;
}

function refreshDepthOptions(): void {
  el.punchDepth.innerHTML = '';
  for (let i = 1; i <= state.level.maxThickness; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = i === 1 ? '仅顶层 1 层' : `顶层 ${i} 层`;
    el.punchDepth.add(opt);
  }
}

function setMode(m: Mode): void {
  mode = m;
  el.modeFold.checked = m === 'fold';
  el.modePunch.checked = m === 'punch';
  render();
}

function onMove(ev: MouseEvent): void {
  const rect = el.main.getBoundingClientRect();
  const cam = computeCamera(state);
  hover = pxToCell(cam, ev.clientX - rect.left, ev.clientY - rect.top);
  render();
}

function onClick(ev: MouseEvent): void {
  if (demoTimer) return;
  const rect = el.main.getBoundingClientRect();
  const cam = computeCamera(state);
  const cell = pxToCell(cam, ev.clientX - rect.left, ev.clientY - rect.top);
  if (!state.cells.has(keyOf(cell.x, cell.y))) {
    flash(`(${cell.x},${cell.y}) 处没有纸`);
    return;
  }
  selected = cell;
  if (mode === 'punch') {
    const depth = Number(el.punchDepth.value);
    guard(() => applyPunch(state, cell.x, cell.y, depth));
  }
  render();
}

/** 折叠通过面板按钮发起（需要指定折痕与方向） */
export function submitFold(): void {
  const axis = el.foldAxis.value as 'v' | 'h';
  const line = Number(el.foldLine.value);
  const side = el.foldSide.value as 'lt' | 'gt';
  guard(() => applyFold(state, axis, line, side));
  render();
}

function guard(fn: () => ActionResult): void {
  const r = fn();
  if (!r.ok) {
    flash(r.reason ?? '动作无效，已原地保持');
  } else {
    const report = maybeWin(state);
    if (report.won) flash('★ 星图对上了，通关！', true);
  }
  render();
}

function restart(): void {
  stopDemo();
  loadLevel(state.level.id);
  flash('已从开头重新开始');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function flash(text: string, good = false): void {
  el.toast.textContent = text;
  el.toast.dataset.kind = good ? 'good' : 'warn';
  el.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

function playDemo(): void {
  stopDemo();
  loadLevel(state.level.id);
  const steps = state.level.solution;
  el.demo.disabled = true;
  el.stopDemo.hidden = false;
  let i = 0;
  const tick = (): void => {
    if (i >= steps.length) {
      stopDemo();
      const report = evaluate(state);
      flash(report.won ? '★ 示例播放完毕并通关' : '示例播放结束（未通关，数据有误）', report.won);
      render();
      return;
    }
    const step = steps[i++];
    const r =
      step.kind === 'fold'
        ? applyFold(state, step.axis, step.line, step.side)
        : step.kind === 'unfold'
          ? applyUnfold(state)
          : applyPunch(state, step.x, step.y, step.depth);
    if (!r.ok) {
      flash(`示例中断：${r.reason}`);
      stopDemo();
      return;
    }
    render();
    demoTimer = setTimeout(tick, 900);
  };
  tick();
}

function stopDemo(): void {
  if (demoTimer) clearTimeout(demoTimer);
  demoTimer = null;
  el.demo.disabled = false;
  el.stopDemo.hidden = true;
}

function render(): void {
  const cam = computeCamera(state);
  const mctx = el.main.getContext('2d')!;
  drawFolded(mctx, state, cam, selected, hover);
  const lctx = el.layers.getContext('2d')!;
  drawLayerInspector(lctx, state, selected);
  // 展开预览使用当前状态实时推演，不修改状态、不消耗次数
  const pctx = el.preview.getContext('2d')!;
  drawUnfoldPreview(pctx, state);

  const lv = state.level;
  el.counters.textContent =
    `折叠 ${state.foldsUsed}/${lv.maxFolds} ｜ 打孔 ${state.punchesUsed}/${lv.maxPunches}` +
    ` ｜ 厚度上限 ${lv.maxThickness} 层`;
  const report = evaluate(state);
  el.status.innerHTML = report.won
    ? '<span class="ok">★ 已对上星图</span>'
    : `缺孔 ${report.missing.length} ｜ 打穿保留格 ${report.broken.length}` +
      (report.extra.length ? ` ｜ 额外孔 ${report.extra.length}` : '');

  el.selectedInfo.textContent = selected
    ? `选中叠纸格 (${selected.x},${selected.y})，厚度 ${state.cells.get(keyOf(selected.x, selected.y))?.length ?? 0} 层`
    : '未选中纸格';
  el.undo.disabled = state.undoStack.length === 0 || demoTimer !== null;
  el.unfold.disabled = state.folds.length === 0 || demoTimer !== null;

  el.log.innerHTML = '';
  for (const entry of state.log) {
    const li = document.createElement('li');
    li.dataset.kind = entry.kind;
    li.textContent = `${entry.seq}. [${kindLabel(entry.kind)}] ${entry.text}`;
    el.log.appendChild(li);
  }
  el.log.scrollTop = el.log.scrollHeight;
}

function kindLabel(k: string): string {
  return k === 'fold' ? '折' : k === 'unfold' ? '展' : '孔';
}

// 折叠按钮在 index.html 中以全局函数调用
declare global {
  interface Window {
    submitFold: () => void;
  }
}
window.submitFold = submitFold;

init();
