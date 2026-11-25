// 主控制器: 把 DOM 事件翻译成 core 层的纯函数调用, 再驱动 canvas 重绘。
import { PRESETS } from './data/presets.js';
import {
  AppState,
  Store,
  boardConflicts,
  createStore,
  deserialize,
  previewConflicts,
  rotatePlacement,
  serialize,
  toggleLock,
  trayTiles,
  withHighlight,
  withPlacement,
  withPreview,
  withoutTile,
} from './core/state.js';
import { Dir, Placement, Puzzle } from './core/types.js';
import {
  edgeConditionAt,
  freeCells,
  placementAt,
  pruneEdgeConditions,
  setEdgeCondition,
  validateEdgeConditions,
} from './core/board.js';
import { findCompletions, getHint } from './core/solver.js';
import {
  Geometry,
  cellAtPixel,
  computeGeometry,
  edgeAtPixel,
  render,
} from './ui/render.js';

const boardCanvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = boardCanvas.getContext('2d')!;

let geo: Geometry;
let store: Store;
let hoverCell: { x: number; y: number } | null = null;
let selectedTrayTile: string | null = null;
let editMode: 'play' | 'hole' | 'edge' = 'play';
let edgeLabelInput = 'A';

const $ = (id: string) => document.getElementById(id)!;
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;

function redraw() {
  const s = store.state;
  geo = computeGeometry(boardCanvas, s.puzzle.board);
  render(ctx, geo, {
    board: s.puzzle.board,
    tiles: s.puzzle.tiles,
    placements: s.puzzle.placements,
    preview: s.preview,
    previewConflicts: previewConflicts(s),
    boardConflicts: boardConflicts(s),
    highlight: s.highlight,
    hoverCell,
  });
  renderTray();
  renderStatus();
}

function renderTray() {
  const tray = $('tray');
  const s = store.state;
  const available = trayTiles(s);
  tray.innerHTML = '';
  if (available.length === 0) {
    tray.innerHTML = '<p class="muted">所有木片都已摆上盘面。撤销或移除一片会回到这里。</p>';
    return;
  }
  for (const tile of available) {
    const btn = document.createElement('button');
    btn.className = 'tray-tile' + (selectedTrayTile === tile.id ? ' selected' : '');
    btn.draggable = true;
    btn.dataset.tileId = tile.id;
    btn.innerHTML = `<strong>${tile.id}</strong><span class="edges">${tile.edges.join(' · ')}</span>`;
    btn.addEventListener('dragstart', (e) => {
      selectedTrayTile = tile.id;
      e.dataTransfer!.setData('text/plain', tile.id);
      e.dataTransfer!.effectAllowed = 'move';
    });
    btn.addEventListener('click', () => {
      selectedTrayTile = selectedTrayTile === tile.id ? null : tile.id;
      redraw();
    });
    tray.appendChild(btn);
  }
}

function renderStatus() {
  const s = store.state;
  const lines: string[] = [];
  const conflicts = boardConflicts(s);
  const cells = freeCells(s.puzzle.board, s.puzzle.placements);
  lines.push(
    `盘面 ${s.puzzle.board.width}×${s.puzzle.board.height}, 可放格 ${
      s.puzzle.board.width * s.puzzle.board.height - s.puzzle.board.holes.length
    } 个, 已放 ${s.puzzle.placements.length}/${s.puzzle.tiles.length} 块, 空格 ${cells.length} 个`,
  );
  if (s.preview) {
    const pc = previewConflicts(s);
    lines.push(
      pc.length === 0
        ? '✅ 当前预览位置与所有已摆方片、洞边、外边条件一致'
        : `❌ 预览有 ${pc.length} 条冲突: ${pc.map((c) => c.message).join(' / ')}`,
    );
  } else if (conflicts.length > 0) {
    lines.push(`❌ 盘面冲突 ${conflicts.length} 条: ${conflicts.map((c) => c.message).join(' / ')}`);
  } else {
    lines.push('✅ 已摆方片之间没有冲突');
  }
  $('status').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');

  const bad = validateEdgeConditions(s.puzzle.board);
  $('edge-warn').style.display = bad.length ? 'block' : 'none';
  if (bad.length) $('edge-warn').textContent = `⚠️ 有 ${bad.length} 条边条件不在外边/洞边上, 求解器会拒绝`;
}

// ---------- 放置 / 拖动 ----------

function previewAt(tileId: string, x: number, y: number, rot: Dir, fromBoard: boolean) {
  const s = store.state;
  const kind = (() => {
    const b = s.puzzle.board;
    if (x < 0 || y < 0 || x >= b.width || y >= b.height) return 'outside';
    return b.holes.some((h) => h.x === x && h.y === y) ? 'hole' : 'cell';
  })();
  if (kind !== 'cell') {
    store.commit(withPreview(s, null));
    return;
  }
  store.commit(withPreview(s, { tileId, x, y, rot, fromBoard }));
}

function dropPreview() {
  const s = store.state;
  if (!s.preview) return;
  const pv = s.preview;
  const conflicts = previewConflicts(s);
  // 冲突也允许落盘(玩家可以先放再看), 但状态条与红边会持续标出
  const placement: Placement = {
    tileId: pv.tileId,
    x: pv.x,
    y: pv.y,
    rot: pv.rot,
    locked: false,
  };
  store.commit(withPlacement(s, placement));
  if (conflicts.length > 0) {
    pushLog(`落盘 ${pv.tileId} 到 (${pv.x + 1},${pv.y + 1}), 但带 ${conflicts.length} 条冲突`);
  } else {
    pushLog(`放置 ${pv.tileId} 到 (${pv.x + 1},${pv.y + 1})`);
  }
  selectedTrayTile = null;
}

boardCanvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  const rect = boardCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const hit = cellAtPixel(geo, store.state.puzzle.board, px, py);
  if (!hit || !selectedTrayTile) return;
  const tileId = selectedTrayTile;
  const fromBoard = store.state.puzzle.placements.some((p) => p.tileId === tileId);
  const existing = store.state.puzzle.placements.find((p) => p.tileId === tileId);
  previewAt(tileId, hit.x, hit.y, existing?.rot ?? 0, fromBoard);
});

boardCanvas.addEventListener('drop', (e) => {
  e.preventDefault();
  dropPreview();
});

boardCanvas.addEventListener('dragleave', () => {
  if (store.state.preview) store.commit(withPreview(store.state, null));
});

// 鼠标交互: 选中托盘片后点击放置; 点击已放片选中; R 旋转; Delete 移除; L 锁定
boardCanvas.addEventListener('mousemove', (e) => {
  const rect = boardCanvas.getBoundingClientRect();
  const hit = cellAtPixel(geo, store.state.puzzle.board, e.clientX - rect.left, e.clientY - rect.top);
  hoverCell = hit;
  redraw();
});
boardCanvas.addEventListener('mouseleave', () => {
  hoverCell = null;
  redraw();
});

boardCanvas.addEventListener('click', (e) => {
  const s = store.state;
  const rect = boardCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const hit = cellAtPixel(geo, s.puzzle.board, px, py);
  if (!hit) return;

  if (editMode === 'hole') {
    const b = s.puzzle.board;
    const isHoleNow = b.holes.some((h) => h.x === hit.x && h.y === hit.y);
    const next = structuredClone(s);
    if (isHoleNow) next.puzzle.board.holes = b.holes.filter((h) => !(h.x === hit.x && h.y === hit.y));
    else if (!placementAt(s.puzzle.placements, hit.x, hit.y)) next.puzzle.board.holes.push({ ...hit });
    else return pushLog('该格有木片, 先移走再设为留空');
    const removed = pruneEdgeConditions(next.puzzle.board);
    if (removed > 0) pushLog(`洞变化使 ${removed} 条固定边条件失效, 已自动清除`);
    store.commit(next);
    return;
  }

  if (editMode === 'edge') {
    const dir = edgeAtPixel(geo, hit.x, hit.y, px, py);
    const b = s.puzzle.board;
    const [dx, dy] = [
      [0, -1], [1, 0], [0, 1], [-1, 0],
    ][dir];
    const nx = hit.x + dx;
    const ny = hit.y + dy;
    const neighbor =
      nx >= 0 && ny >= 0 && nx < b.width && ny < b.height &&
      !b.holes.some((h) => h.x === nx && h.y === ny);
    if (neighbor) return pushLog('固定边条件只能设在外边界或洞边上');
    const next = structuredClone(s);
    const cur = edgeConditionAt(next.puzzle.board, hit.x, hit.y, dir);
    // 同一条边重复点击: 设值 -> 清除 -> 设值
    if (cur !== null && cur === edgeLabelInput) {
      setEdgeCondition(next.puzzle.board, hit.x, hit.y, dir, null);
      pushLog(`清除 (${hit.x + 1},${hit.y + 1}) ${['上', '右', '下', '左'][dir]} 边条件`);
    } else {
      setEdgeCondition(next.puzzle.board, hit.x, hit.y, dir, edgeLabelInput);
      pushLog(`设置 (${hit.x + 1},${hit.y + 1}) ${['上', '右', '下', '左'][dir]} 边条件 = ${edgeLabelInput}`);
    }
    store.commit(next);
    return;
  }

  // play 模式
  const p = placementAt(s.puzzle.placements, hit.x, hit.y);
  if (p) {
    selectedTrayTile = p.tileId;
    pushLog(`选中 ${p.tileId}(R 旋转, L 锁定, Delete 移回托盘)`);
    redraw();
    return;
  }
  if (selectedTrayTile) {
    const fromBoard = s.puzzle.placements.some((q) => q.tileId === selectedTrayTile);
    const existing = s.puzzle.placements.find((q) => q.tileId === selectedTrayTile);
    previewAt(selectedTrayTile, hit.x, hit.y, existing?.rot ?? 0, fromBoard);
    dropPreview();
  }
});

window.addEventListener('keydown', (e) => {
  if (!selectedTrayTile) return;
  const s = store.state;
  const p = s.puzzle.placements.find((q) => q.tileId === selectedTrayTile);
  if (e.key === 'r' || e.key === 'R') {
    if (p?.locked) return pushLog(`${selectedTrayTile} 已锁定, 先解锁再旋转`);
    if (p) store.commit(rotatePlacement(s, selectedTrayTile));
    else if (s.preview) store.commit(withPreview(s, { ...s.preview, rot: ((s.preview.rot + 1) % 4) as Dir }));
    pushLog(`${selectedTrayTile} 旋转 90°`);
  } else if (e.key === 'l' || e.key === 'L') {
    if (p) store.commit(toggleLock(s, selectedTrayTile));
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (p && !p.locked) {
      store.commit(withoutTile(s, selectedTrayTile));
      pushLog(`${selectedTrayTile} 移回托盘, 可再次使用`);
      selectedTrayTile = null;
    }
  }
});

// ---------- 求解 / 提示 / 撤销 ----------

$('btn-solve').addEventListener('click', () => {
  const s = store.state;
  const r = findCompletions(s.puzzle.board, s.puzzle.placements, s.puzzle.tiles, 2);
  if (r.status === 'unsat') {
    const e = r.explanation;
    store.commit(withHighlight(s, { type: 'conflicts', conflicts: e.conflicts ?? [] }));
    let msg = `🚫 ${e.title} — ${e.detail}`;
    if (e.deadCell) msg += ` 死位 (${e.deadCell.x + 1},${e.deadCell.y + 1})`;
    if (e.reasons?.length) msg += `。依据: ${e.reasons.slice(0, 4).join(' | ')}`;
    pushLog(msg);
    return;
  }
  const sol = r.solutions[0];
  const many = r.solutions.length > 1;
  // 只展示补全方案的高亮, 不自动改盘面(尊重"提示不直接改盘面"; 补全入口给"应用方案"按钮)
  const firstNew = sol.find(
    (p) => !s.puzzle.placements.some((q) => q.tileId === p.tileId),
  );
  store.commit(
    withHighlight(s, firstNew ? { type: 'move', ...firstNew } : null),
  );
  pendingSolution = sol;
  btn('btn-apply').disabled = false;
  pushLog(
    many
      ? `找到补全(至少 2 种, 展示其一; 已摆/锁定片保持不动)`
      : `找到唯一补全(已摆/锁定片保持不动)。点"应用补全方案"落盘, 或只看高亮`,
  );
});

let pendingSolution: Placement[] | null = null;
$('btn-apply').addEventListener('click', () => {
  if (!pendingSolution) return;
  const s = store.state;
  let next = s;
  for (const p of pendingSolution) {
    // 锁住的片与已摆片一律不动, 只补剩余
    if (s.puzzle.placements.some((q) => q.tileId === p.tileId)) continue;
    next = withPlacement(next, { ...p, locked: false });
  }
  next = withHighlight(next, null);
  store.commit(next);
  pendingSolution = null;
  btn('btn-apply').disabled = true;
  pushLog('已应用补全方案(锁定片未改动)');
});

$('btn-hint').addEventListener('click', () => {
  const s = store.state;
  const h = getHint(s.puzzle.board, s.puzzle.placements, s.puzzle.tiles);
  if (h.kind === 'conflict') {
    store.commit(withHighlight(s, { type: 'conflicts', conflicts: h.conflicts ?? [] }));
    pushLog(`提示: ${h.message}`);
    return;
  }
  store.commit(withHighlight(s, { type: 'move', ...h.move! }));
  pushLog(`提示(不改盘面): ${h.message}`);
});

$('btn-undo').addEventListener('click', () => store.undo());
$('btn-redo').addEventListener('click', () => store.redo());
$('btn-clear').addEventListener('click', () => {
  const s = store.state;
  const next = structuredClone(s);
  next.puzzle.placements = [];
  next.preview = null;
  next.highlight = null;
  store.commit(next);
  pendingSolution = null;
  btn('btn-apply').disabled = true;
  pushLog('清空盘面, 全部木片恢复到托盘');
});

// ---------- 模式 / 预设 / 存取 ----------

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    editMode = radio.value as typeof editMode;
    pushLog(`编辑模式: ${({ play: '摆片', hole: '留空', edge: '固定边' })[editMode]}`);
  });
});
$('edge-label').addEventListener('change', (e) => {
  edgeLabelInput = (e.target as HTMLInputElement).value.trim() || 'A';
});

const presetSelect = $('preset') as HTMLSelectElement;
PRESETS.forEach((p, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = p.puzzle.name;
  presetSelect.appendChild(opt);
});
$('btn-load-preset').addEventListener('click', () => {
  const info = PRESETS[Number(presetSelect.value)];
  loadPuzzle(info.puzzle);
  pushLog(`载入预设: ${info.puzzle.name}。验证性质: ${info.verified}`);
});

function loadPuzzle(puzzle: Puzzle) {
  const state: AppState = { puzzle, preview: null, highlight: null };
  store.commit(state);
  store.resetHistory();
  selectedTrayTile = null;
  pendingSolution = null;
  btn('btn-apply').disabled = true;
  redraw();
}

$('btn-save').addEventListener('click', () => {
  const blob = new Blob([serialize(store.state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `paper-window-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  pushLog('当前小题面已导出为 JSON');
});

$('file-input').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const puzzle = deserialize(text);
    loadPuzzle(puzzle);
    pushLog(`读入 ${file.name}, 可继续验证; 现有冲突会立即标出`);
  } catch (err) {
    pushLog(`读入失败: ${(err as Error).message}`);
  }
  (e.target as HTMLInputElement).value = '';
});

function pushLog(msg: string) {
  const log = $('log');
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.textContent = `[${time}] ${msg}`;
  log.prepend(div);
}

// ---------- 启动 ----------
function init() {
  store = createStore({ puzzle: structuredClone(PRESETS[0].puzzle), preview: null, highlight: null });
  store.subscribe(redraw);
  btn('btn-apply').disabled = true;
  redraw();
  pushLog(`启动载入: ${PRESETS[0].puzzle.name}。${PRESETS[0].verified}`);
}

init();
