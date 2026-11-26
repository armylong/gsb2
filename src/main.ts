import { getLevel, LEVELS } from './game/levels.js';
import { createReplay, simulate } from './game/engine.js';
import type {
  Dir,
  EditAction,
  EditActionType,
  LevelDef,
  Placement,
  ReplayRecord,
  SimulationResult,
} from './game/types.js';
import { rotateClockwise } from './game/geometry.js';
import { layoutFor, renderGame, slotAtPoint } from './ui/renderer.js';

const STORAGE_KEY = 'wood-relay-winning-replays/v1';

const canvas = must<HTMLCanvasElement>('board');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D context unavailable');
const ctx: CanvasRenderingContext2D = context;

let level: LevelDef = LEVELS[0] ?? getLevel('level-1-post-and-gate');
let placement: Placement[] = [];
let actions: EditAction[] = [];
let actionSeq = 0;

let toolType: Placement['type'] = 'thin';
let toolFacing: Dir = 'E';
let selectedSlotId: string | null = null;
let hoverSlotId: string | null = null;
let pointerInside = false;

let result: SimulationResult | null = null;
let currentReplay: ReplayRecord | null = null;
let lastWinningReplay: ReplayRecord | null = loadLatestWinningReplay();
let recordStale = false;

let mode: 'edit' | 'playing' | 'paused' | 'finished' = 'edit';
let viewMs = 0;
let speed = 1;
let lastFrameAt = 0;
let lastDisplayedBeat = -1;
let mapLabels = true;

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const startBtn = must<HTMLButtonElement>('startBtn');
const pauseBtn = must<HTMLButtonElement>('pauseBtn');
const stepBackBtn = must<HTMLButtonElement>('stepBackBtn');
const stepForwardBtn = must<HTMLButtonElement>('stepForwardBtn');
const replayBtn = must<HTMLButtonElement>('replayBtn');
const editBtn = must<HTMLButtonElement>('editBtn');
const scrub = must<HTMLInputElement>('scrub');
const beatLabel = must<HTMLSpanElement>('beatLabel');
const speedSelect = must<HTMLSelectElement>('speedSelect');
const thinTool = must<HTMLButtonElement>('thinTool');
const wideTool = must<HTMLButtonElement>('wideTool');
const rotateBtn = must<HTMLButtonElement>('rotateBtn');
const removeBtn = must<HTMLButtonElement>('removeBtn');
const clearBtn = must<HTMLButtonElement>('clearBtn');
const sampleBtn = must<HTMLButtonElement>('sampleBtn');
const facingLabel = must<HTMLSpanElement>('facingLabel');
const inventoryEl = must<HTMLDivElement>('inventory');
const directionHint = must<HTMLParagraphElement>('directionHint');
const checksEl = must<HTMLDivElement>('checks');
const recordSummary = must<HTMLDivElement>('recordSummary');
const eventLog = must<HTMLDivElement>('eventLog');
const exportBtn = must<HTMLButtonElement>('exportBtn');
const copyBtn = must<HTMLButtonElement>('copyBtn');
const downloadWinBtn = must<HTMLButtonElement>('downloadWinBtn');
const labelsToggle = must<HTMLInputElement>('labelsToggle');

function logAction(type: EditActionType, extra: Partial<EditAction> = {}): EditAction {
  actionSeq += 1;
  const action: EditAction = {
    seq: actionSeq,
    type,
    atLogicalMs: actionSeq,
    ...extra,
  };
  actions.push(action);
  if (type === 'start') recordStale = false;
  else if (currentReplay) {
    recordStale = true;
    renderRecordSummary();
  }
  return action;
}

function clonePlacement(items: Placement[]): Placement[] {
  return items.map((p) => ({ ...p }));
}

function selectLevel(next: LevelDef): void {
  level = next;
  placement = [];
  actions = [];
  actionSeq = 0;
  selectedSlotId = null;
  hoverSlotId = null;
  result = null;
  currentReplay = null;
  recordStale = false;
  mode = 'edit';
  viewMs = 0;
  lastDisplayedBeat = -1;
  toolType = 'thin';
  toolFacing = 'E';
  renderLevelTabs();
  renderLevelStatic();
  resizeCanvas();
  renderInventory();
  renderChecks(null);
  renderEventLog(null);
  renderRecordSummary();
  updateTransport();
}

function renderLevelTabs(): void {
  const tabs = must<HTMLDivElement>('levelTabs');
  tabs.innerHTML = '';
  for (const item of LEVELS) {
    const btn = document.createElement('button');
    btn.textContent = item.name;
    btn.dataset.id = item.id;
    if (item.id === level.id) btn.classList.add('active');
    if (item.id.startsWith('sample-')) btn.classList.add('sample-tab');
    btn.addEventListener('click', () => selectLevel(item));
    tabs.appendChild(btn);
  }
}

function renderLevelStatic(): void {
  must<HTMLHeadingElement>('levelName').textContent = level.name;
  must<HTMLParagraphElement>('levelSubtitle').textContent = level.subtitle;
  must<HTMLParagraphElement>('levelBrief').textContent = level.brief;
  sampleBtn.hidden = !level.samplePlacement;
  sampleBtn.textContent = level.sampleButtonLabel ?? (level.sampleNote ? '载入可重复样例摆法' : '载入样例摆法');
  directionHint.textContent = level.hint;
  updateFacingLabel();
}

function updateFacingLabel(): void {
  const dirText: Record<Dir, string> = { N: '北 ↑', E: '东 →', S: '南 ↓', W: '西 ←' };
  const selected = placement.find((p) => p.slotId === selectedSlotId);
  if (selected) {
    facingLabel.textContent = `选中片 ${dirText[selected.facing]}`;
  } else {
    facingLabel.textContent = `新片 ${dirText[toolFacing]}`;
  }
  thinTool.classList.toggle('active', toolType === 'thin');
  wideTool.classList.toggle('active', toolType === 'wide');
}

function renderInventory(): void {
  const used = { thin: 0, wide: 0 };
  for (const p of placement) used[p.type] += 1;
  const total = placement.length;
  inventoryEl.innerHTML = '';
  const addPill = (text: string, over: boolean): void => {
    const span = document.createElement('span');
    span.textContent = text;
    if (over) span.classList.add('over');
    inventoryEl.appendChild(span);
  };
  addPill(`细片 ${used.thin}/${level.inventory.thin}`, used.thin > level.inventory.thin);
  addPill(`宽片 ${used.wide}/${level.inventory.wide}`, used.wide > level.inventory.wide);
  addPill(`总片数 ${total}/${level.win.maxPieces} 通关上限`, total > level.win.maxPieces);
}

function setHint(text: string, isError = false): void {
  directionHint.textContent = text;
  directionHint.style.color = isError ? '#b91c1c' : '';
}

function canvasPoint(event: MouseEvent): { x: number; y: number } {
  const layout = layoutFor(level);
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * layout.width,
    y: ((event.clientY - rect.top) / rect.height) * layout.height,
  };
}

function handleCanvasClick(event: MouseEvent): void {
  if (mode !== 'edit') {
    setHint('回放中不能直接改：请先暂停/单步，或点“返回原摆放修改”。');
    return;
  }
  const pt = canvasPoint(event);
  const slotId = slotAtPoint(level, pt.x, pt.y);
  selectedSlotId = slotId;
  if (!slotId) {
    updateFacingLabel();
    return;
  }

  const existingIndex = placement.findIndex((p) => p.slotId === slotId);
  if (existingIndex >= 0) {
    updateFacingLabel();
    renderInventory();
    return;
  }

  const fixed = level.fixed.find((f) => f.slotId === slotId);
  if (fixed) {
    setHint('这是固定物件槽位，不能摆木片。', true);
    return;
  }

  const slot = level.slots.find((s) => s.id === slotId);
  if (!slot) return;
  if (toolType === 'wide' && !slot.wideBase) {
    setHint('宽木片只能放在蓝色“宽槽”指定位置。', true);
    return;
  }
  const usedType = placement.filter((p) => p.type === toolType).length;
  if (usedType >= level.inventory[toolType]) {
    setHint(`${toolType === 'thin' ? '细' : '宽'}木片库存已用完；可拆除后再摆。`, true);
    return;
  }

  const item: Placement = { slotId, type: toolType, facing: toolFacing };
  placement.push(item);
  logAction('place', { slotId, pieceType: item.type, toFacing: item.facing });
  selectedSlotId = slotId;
  if (slot.forbidden) setHint('这是禁碰槽：摆上去或连锁碰到，都会让通关检查失败。', true);
  else setHint('已摆放。可按 R、双击或“转向”调整面朝方向。');
  renderInventory();
  updateFacingLabel();
}

function rotateSelectedOrTool(): void {
  const selected = placement.find((p) => p.slotId === selectedSlotId);
  if (mode === 'edit' && selected) {
    const from = selected.facing;
    selected.facing = rotateClockwise(from);
    logAction('rotate', { slotId: selected.slotId, fromFacing: from, toFacing: selected.facing });
    setHint(`已转向：${from} → ${selected.facing}`);
  } else {
    toolFacing = rotateClockwise(toolFacing);
  }
  updateFacingLabel();
}

function removeSelected(): void {
  if (mode !== 'edit' || !selectedSlotId) return;
  const index = placement.findIndex((p) => p.slotId === selectedSlotId);
  if (index < 0) return;
  const [removed] = placement.splice(index, 1);
  if (removed) logAction('remove', { slotId: removed.slotId, pieceType: removed.type, fromFacing: removed.facing });
  selectedSlotId = null;
  renderInventory();
  updateFacingLabel();
}

function clearPlacement(): void {
  placement = [];
  selectedSlotId = null;
  if (mode !== 'edit') mode = 'edit';
  result = null;
  logAction('clear');
  renderInventory();
  renderChecks(null);
  renderEventLog(null);
  updateTransport();
  setHint('已清空，原始关卡槽位保留。');
}

function loadSample(): void {
  if (!level.samplePlacement) return;
  placement = clonePlacement(level.samplePlacement);
  selectedSlotId = null;
  result = null;
  mode = 'edit';
  logAction('load-sample', { placement: clonePlacement(placement) });
  renderInventory();
  renderChecks(null);
  renderEventLog(null);
  updateTransport();
  setHint(level.sampleNote ?? '已载入可重复样例摆法。');
}

function startRun(): void {
  logAction('start');
  result = simulate(level, placement);
  currentReplay = createReplay(level, placement, actions, result);
  recordStale = false;
  viewMs = 0;
  lastDisplayedBeat = -1;
  mode = 'playing';
  scrub.max = String(result.lastBeat);
  scrub.value = '0';
  scrub.disabled = false;
  renderChecks(result);
  renderEventLog(result);
  renderRecordSummary();
  if (result.win) persistWinningReplay(currentReplay);
  updateTransport();
}

function togglePause(): void {
  if (!result) return;
  if (mode === 'playing') mode = 'paused';
  else if (mode === 'paused' || mode === 'finished') {
    if (mode === 'finished' || viewMs >= result.lastBeat * result.beatMs) viewMs = 0;
    mode = 'playing';
  }
  updateTransport();
}

function stepBeat(delta: number): void {
  if (!result) return;
  mode = 'paused';
  const currentBeat = Math.floor(viewMs / result.beatMs);
  const nextBeat = Math.max(0, Math.min(result.lastBeat, currentBeat + delta));
  viewMs = nextBeat * result.beatMs;
  scrub.value = String(nextBeat);
  updateBeatLabel(nextBeat);
  updateTransport();
}

function replayRun(): void {
  if (!result) return;
  viewMs = 0;
  mode = 'playing';
  updateTransport();
}

function backToEdit(): void {
  mode = 'edit';
  result = null;
  viewMs = 0;
  selectedSlotId = null;
  updateTransport();
  renderInventory();
}

function updateTransport(): void {
  const hasResult = Boolean(result);
  pauseBtn.disabled = !hasResult;
  stepBackBtn.disabled = !hasResult;
  stepForwardBtn.disabled = !hasResult;
  replayBtn.disabled = !hasResult;
  scrub.disabled = !hasResult;
  pauseBtn.textContent = mode === 'playing' ? '⏸ 暂停' : '▶ 继续';
  exportBtn.disabled = !currentReplay;
  copyBtn.disabled = !currentReplay;
  downloadWinBtn.disabled = !lastWinningReplay;
  if (!hasResult) {
    beatLabel.textContent = '摆放阶段';
    scrub.value = '0';
  }
}

function updateBeatLabel(beat?: number): void {
  if (!result) {
    beatLabel.textContent = '摆放阶段';
    return;
  }
  const b = beat ?? Math.floor(viewMs / result.beatMs);
  if (b === lastDisplayedBeat && beat === undefined) return;
  lastDisplayedBeat = b;
  beatLabel.textContent = `第 ${b}/${result.lastBeat} 拍 · ${(b * result.beatMs) / 1000}s`;
  if (document.activeElement !== scrub) scrub.value = String(b);
}

function renderChecks(sim: SimulationResult | null): void {
  if (!sim) {
    checksEl.innerHTML = '<p class="muted">开始后这里会逐项检查旗序、间隔、禁碰槽和用片数量。</p>';
    return;
  }
  const banner = document.createElement('div');
  banner.className = sim.win ? 'win-banner' : 'fail-banner';
  banner.textContent = sim.win ? '✔ 通关：顺序、间隔、禁碰槽和用片数全部满足' : '✕ 尚未通关：可暂停/退回一拍查看原因';
  checksEl.innerHTML = '';
  checksEl.appendChild(banner);

  for (const check of sim.checks) {
    const row = document.createElement('div');
    row.className = `check ${check.pass ? 'pass' : 'fail'}`;
    row.innerHTML = `<span class="icon">${check.pass ? '✓' : '!'}</span><div><b>${check.label}</b><small>${check.detail}</small></div>`;
    checksEl.appendChild(row);
  }
}

function renderEventLog(sim: SimulationResult | null): void {
  eventLog.innerHTML = '';
  if (!sim) {
    eventLog.innerHTML = '<p class="muted" style="padding:6px">开始后，这里会按拍列出触发、同拍合并、阻挡和重复碰撞；点击可回看。</p>';
    return;
  }

  const important = sim.collisions.filter((c) => c.outcome !== 'empty');
  for (const c of important) {
    const btn = document.createElement('button');
    btn.className = 'log-row';
    if (c.outcome === 'merged-same-beat') btn.classList.add('same');
    if (c.outcome.startsWith('blocked')) btn.classList.add('block');
    const target = c.targetSlotId ?? '空格';
    const source = c.sourceSlotId ?? '启动';
    const outcomeText: Record<string, string> = {
      triggered: '触发',
      'merged-same-beat': '同拍合并，只算一次',
      'duplicate-route': '重复路线',
      'already-falling': '正在倒下，不重触发',
      'already-fallen': '已躺下，不重触发',
      'blocked-post': '被挡柱拦下',
      'blocked-wrong-side': '入射侧不对，被单向片拦下',
      empty: '落空',
    };
    btn.innerHTML = `<span class="beat">${c.beat} 拍</span><span>${source} → ${target}<br><b>${outcomeText[c.outcome] ?? c.outcome}</b>${c.simultaneous ? ' · 同拍组 ' + c.groupId : ''}</span>`;
    btn.addEventListener('click', () => {
      if (!result) return;
      mode = 'paused';
      viewMs = c.beat * result.beatMs;
      updateTransport();
    });
    eventLog.appendChild(btn);
  }

  for (const f of sim.flags) {
    const btn = document.createElement('button');
    btn.className = `log-row ${sim.win ? 'win' : 'block'}`;
    btn.innerHTML = `<span class="beat">${f.landedBeat ?? '--'} 拍</span><span><b>${f.flagId} 落地</b> · 触碰 ${f.touchedBeat ?? '--'} 拍</span>`;
    btn.addEventListener('click', () => {
      if (!result || f.landedBeat === null) return;
      mode = 'paused';
      viewMs = f.landedBeat * result.beatMs;
      updateTransport();
    });
    eventLog.appendChild(btn);
  }
}

function renderRecordSummary(): void {
  if (!currentReplay || !result) {
    recordSummary.textContent = '尚未生成记录。';
    return;
  }
  const same = result.groups.filter((g) => g.simultaneous);
  recordSummary.innerHTML =
    `<b>${currentReplay.levelName}</b><br>` +
    `摆放 ${result.pieceCount} 片；碰撞 ${result.collisions.length} 条；` +
    `同拍多碰撞组 <b>${same.length}</b> 个：${same.map((g) => g.targetSlotId + '@' + g.beat).join('，') || '无'}<br>` +
    `结果：<b style="color:${result.win ? '#15803d' : '#b91c1c'}">${result.win ? '通关' : '未通关'}</b>；动作 ${actions.length} 条，可导出完整 JSON。` +
    (recordStale ? '<br><b style="color:#b45309">摆放已继续修改；当前导出的是上一次开局的记录，重新开始会刷新。</b>' : '');
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyJson(data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setHint('回看 JSON 已复制到剪贴板。');
  } catch {
    downloadJson('wood-relay-replay.json', data);
    setHint('剪贴板不可用，已改为下载 JSON。');
  }
}

function persistWinningReplay(replay: ReplayRecord): void {
  lastWinningReplay = replay;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: ReplayRecord[] = raw ? (JSON.parse(raw) as ReplayRecord[]) : [];
    list.push(replay);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    // 隐私模式或配额不足时，内存中的导出仍然可用。
  }
  updateTransport();
}

function loadLatestWinningReplay(): ReplayRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw) as ReplayRecord[];
    return list[list.length - 1] ?? null;
  } catch {
    return null;
  }
}

function resizeCanvas(): void {
  const layout = layoutFor(level);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(layout.width * dpr);
  canvas.height = Math.round(layout.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(): void {
  const layout = layoutFor(level);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderGame({
    ctx,
    level,
    placement,
    toolType,
    toolFacing,
    selectedSlotId,
    hoverSlotId,
    pointerInside,
    result: mode === 'edit' ? null : result,
    viewMs,
    showLabels: mapLabels,
  });
  void layout;
}

function frame(now: number): void {
  const dt = lastFrameAt ? now - lastFrameAt : 0;
  lastFrameAt = now;
  if (mode === 'playing' && result) {
    viewMs += dt * speed;
    const maxMs = result.lastBeat * result.beatMs;
    if (viewMs >= maxMs) {
      viewMs = maxMs;
      mode = 'finished';
      updateTransport();
    }
    updateBeatLabel();
  }
  draw();
  requestAnimationFrame(frame);
}

// Wire UI.
thinTool.addEventListener('click', () => {
  toolType = 'thin';
  selectedSlotId = null;
  updateFacingLabel();
});
wideTool.addEventListener('click', () => {
  toolType = 'wide';
  selectedSlotId = null;
  updateFacingLabel();
});
rotateBtn.addEventListener('click', rotateSelectedOrTool);
removeBtn.addEventListener('click', removeSelected);
clearBtn.addEventListener('click', clearPlacement);
sampleBtn.addEventListener('click', loadSample);
startBtn.addEventListener('click', startRun);
pauseBtn.addEventListener('click', togglePause);
stepBackBtn.addEventListener('click', () => stepBeat(-1));
stepForwardBtn.addEventListener('click', () => stepBeat(1));
replayBtn.addEventListener('click', replayRun);
editBtn.addEventListener('click', backToEdit);
speedSelect.addEventListener('change', () => {
  speed = Number(speedSelect.value);
});
labelsToggle.addEventListener('change', () => {
  mapLabels = labelsToggle.checked;
});
scrub.addEventListener('input', () => {
  if (!result) return;
  mode = 'paused';
  const beat = Number(scrub.value);
  viewMs = beat * result.beatMs;
  updateBeatLabel(beat);
  updateTransport();
});
exportBtn.addEventListener('click', () => {
  if (currentReplay) downloadJson(`replay-${level.id}-${Date.now()}.json`, currentReplay);
});
copyBtn.addEventListener('click', () => {
  if (currentReplay) void copyJson(currentReplay);
});
downloadWinBtn.addEventListener('click', () => {
  if (lastWinningReplay) downloadJson(`win-${lastWinningReplay.levelId}.json`, lastWinningReplay);
});

canvas.addEventListener('click', handleCanvasClick);
canvas.addEventListener('dblclick', () => rotateSelectedOrTool());
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  rotateSelectedOrTool();
});
canvas.addEventListener('mousemove', (event) => {
  pointerInside = true;
  const pt = canvasPoint(event);
  hoverSlotId = slotAtPoint(level, pt.x, pt.y);
  canvas.style.cursor = mode === 'edit' ? 'pointer' : 'default';
});
canvas.addEventListener('mouseleave', () => {
  pointerInside = false;
  hoverSlotId = null;
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  if (event.key === 'Escape') {
    selectedSlotId = null;
    updateFacingLabel();
  }
  if (event.key === 'r' || event.key === 'R') rotateSelectedOrTool();
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    removeSelected();
  }
  if (event.key === ' ') {
    event.preventDefault();
    if (!result) startRun();
    else togglePause();
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepBeat(-1);
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepBeat(1);
  }
});

window.addEventListener('resize', resizeCanvas);

renderLevelTabs();
renderLevelStatic();
resizeCanvas();
renderInventory();
updateTransport();
requestAnimationFrame(frame);
