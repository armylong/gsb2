import { createCamera, fitCamera, panBy, pickCell, zoomAt, type Camera } from './camera';
import { axialToOffset, hexCentre, MAP_COLS, MAP_ROWS, offsetToAxial } from './hex';
import { Renderer } from './render';
import { Sandbox } from './sandbox';
import { SCENARIOS, type ScenarioId } from './scenarios';
import type { CellKey, Terrain, UnitId, ViewMode } from './types';

/** World-space bounds of the 15×12 board (circumradius 1), measured once. */
const WORLD = { width: 27.12, height: 18.5, centreX: 12.56, centreY: 8.25 };

type PendingEdit =
  | { kind: 'terrain'; key: CellKey; terrain: Terrain }
  | { kind: 'door'; key: CellKey };

type Brush = 'wall' | 'floor' | 'door';

function editKey(edit: PendingEdit): CellKey {
  return edit.key;
}

const canvas = document.getElementById('map') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const hoverEl = document.getElementById('hover') as HTMLDivElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const bannerEl = document.getElementById('debug-banner') as HTMLDivElement;
const panel = {
  scenarios: document.getElementById('scenarios') as HTMLDivElement,
  blurb: document.getElementById('blurb') as HTMLParagraphElement,
  sanity: document.getElementById('sanity') as HTMLParagraphElement,
  units: document.getElementById('units') as HTMLDivElement,
  actions: document.getElementById('actions') as HTMLDivElement,
  checklist: document.getElementById('checklist') as HTMLDivElement,
  modes: document.getElementById('mode-switch') as HTMLDivElement,
};

const sandbox = new Sandbox({ scenarioId: 'sandbox', mode: 'player' });
const renderer = new Renderer(canvas);

let camera: Camera = createCamera({ width: stage.clientWidth, height: stage.clientHeight }, 30);
let hovered: { q: number; r: number } | null = null;
let pointer: { sx: number; sy: number } | null = null;
let dragging: { sx: number; sy: number; moved: boolean } | null = null;
let brush: Brush = 'wall';
let editPaused = true;
let pendingEdits = new Map<string, PendingEdit>();
let selectedEnemyId: number | null = null;
let toastTimer = 0;

function layout(): void {
  const width = stage.clientWidth || window.innerWidth - 380;
  const height = stage.clientHeight || window.innerHeight;
  renderer.resize(width, height);
  camera = fitCamera({ width, height }, WORLD.width, WORLD.height, 46);
  camera.centre = { x: WORLD.centreX, y: WORLD.centreY };
  draw();
}

function draw(): void {
  renderer.render(sandbox, camera, {
    hovered,
    pendingEdits: new Set([...pendingEdits.values()].map(editKey)),
    selectedEnemyId,
  });
  updateHint();
  updateHoverCard();
}

function resizeToFitScene(): void {
  const { width, height } = stage.getBoundingClientRect();
  renderer.resize(width, height);
  camera = fitCamera({ width, height }, WORLD.width, WORLD.height, 46);
  camera.centre = { x: WORLD.centreX, y: WORLD.centreY };
  draw();
}

function applyMode(mode: ViewMode): void {
  const leavingEdit = sandbox.mode === 'edit' && mode !== 'edit';
  if (leavingEdit && pendingEdits.size > 0) {
    // Never silently drop queued edits: commit them, then say so.
    const count = pendingEdits.size;
    applyPending();
    toast(`离开编辑模式 — 已应用 ${count} 处待处理改动并重算视野`);
  }
  sandbox.mode = mode;
  if (mode !== 'edit') {
    editPaused = true;
  }
  if (mode !== 'debug') selectedEnemyId = null;
  for (const button of panel.modes.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  bannerEl.classList.toggle('show', mode === 'debug');
  rebuildPanel();
  draw();
}

function updateHint(): void {
  const base =
    '<b>拖拽</b> 平移 · <b>滚轮</b> 缩放 · <b>点击</b> 选中/移动 · <b>右键 / Shift+点击</b> 开关门 · <b>空格</b> 暂停编辑';
  if (sandbox.mode === 'edit') {
    hintEl.innerHTML = `${base}<br><b>编辑模式</b>：左键按当前笔刷落笔（先进入待应用队列），<b>应用并重算</b>才会改变视野；也可直接点击门开关。`;
  } else if (sandbox.mode === 'debug') {
    hintEl.innerHTML = `${base}<br><b>调试视图</b>：悬停任意格可见全部敌人与视线辅助线；点击敌人后按方向键移动。`;
  } else {
    hintEl.innerHTML = base;
  }
}

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function cellFromEvent(event: PointerEvent | MouseEvent | WheelEvent): { q: number; r: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  return pickCell(camera, sx, sy);
}

function inBounds(q: number, r: number): boolean {
  const { col, row } = axialToOffset(q, r);
  return col >= 0 && col < MAP_COLS && row >= 0 && row < MAP_ROWS;
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1) return;
  canvas.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  dragging = { sx: event.clientX - rect.left, sy: event.clientY - rect.top, moved: false };
});

canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  pointer = { sx, sy };
  if (dragging) {
    const dx = sx - dragging.sx;
    const dy = sy - dragging.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
    if (dragging.moved) {
      camera = panBy(camera, dx, dy);
      dragging.sx = sx;
      dragging.sy = sy;
    }
  }
  const cell = pickCell(camera, sx, sy);
  hovered = inBounds(cell.q, cell.r) ? cell : null;
  draw();
  positionHover(sx, sy);
});

canvas.addEventListener('pointerup', (event) => {
  if (!dragging) return;
  const wasDrag = dragging.moved;
  dragging = null;
  if (wasDrag) return;
  const cell = cellFromEvent(event);
  if (!inBounds(cell.q, cell.r)) return;
  if (event.button === 2) {
    toggleDoorForCurrentMode(cell.q, cell.r);
    return;
  }
  handleClick(cell.q, cell.r, event.shiftKey);
});

canvas.addEventListener('pointerleave', () => {
  hovered = null;
  pointer = null;
  hoverEl.style.display = 'none';
  draw();
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0016);
    camera = zoomAt(camera, sx, sy, camera.zoom * factor);
    const cell = pickCell(camera, sx, sy);
    hovered = inBounds(cell.q, cell.r) ? cell : null;
    draw();
    positionHover(sx, sy);
  },
  { passive: false },
);

window.addEventListener('keydown', (event) => {
  if ((event.target as HTMLElement)?.tagName === 'INPUT') return;
  if (event.key === ' ') {
    event.preventDefault();
    if (sandbox.mode !== 'edit') {
      applyMode('edit');
      toast('已进入编辑模式 — 空格可暂停/恢复编辑的即时应用');
    } else {
      togglePause();
    }
    return;
  }
  if (event.key === 'r' || event.key === 'R') {
    resetAll();
    return;
  }
  if (event.key === '1') selectUnit('A');
  if (event.key === '2') selectUnit('B');
  if (sandbox.mode === 'debug' && selectedEnemyId !== null) {
    const dirs: Record<string, { q: number; r: number }> = {
      ArrowRight: { q: 1, r: 0 },
      ArrowLeft: { q: -1, r: 0 },
      ArrowUp: { q: 1, r: -1 },
      ArrowDown: { q: -1, r: 1 },
    };
    const delta = dirs[event.key];
    if (delta) {
      event.preventDefault();
      const enemy = sandbox.enemies.find((e) => e.id === selectedEnemyId);
      if (enemy) {
        const ok = sandbox.moveEnemy(enemy.id, enemy.q + delta.q, enemy.r + delta.r);
        if (!ok) toast('该格不可通行或已被占用');
        draw();
      }
      return;
    }
  }
  if (event.key.startsWith('Arrow')) {
    const step = 60;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const delta = map[event.key];
    if (delta) {
      event.preventDefault();
      camera = panBy(camera, delta[0]!, delta[1]!);
      draw();
    }
  }
  if (event.key === '+' || event.key === '=') {
    camera = zoomAt(camera, camera.viewport.width / 2, camera.viewport.height / 2, camera.zoom * 1.2);
    draw();
  }
  if (event.key === '-') {
    camera = zoomAt(camera, camera.viewport.width / 2, camera.viewport.height / 2, camera.zoom / 1.2);
    draw();
  }
});

function handleClick(q: number, r: number, shift: boolean): void {
  if (sandbox.mode === 'edit') {
    if (shift) {
      // Shift-click in edit mode always applies the door change right away.
      if (!applyDoorToggle(q, r)) toast('这里不是门');
      return;
    }
    queueEdit(q, r);
    return;
  }

  if (sandbox.mode === 'debug') {
    const enemy = sandbox.enemyPickableAt(q, r);
    if (enemy) {
      selectedEnemyId = enemy.id;
      toast(`已选中敌人 E${enemy.id} — 用方向键移动它`);
      draw();
      return;
    }
  }

  const unitHere = sandbox.units.find((u) => u.q === q && u.r === r);
  if (unitHere) {
    selectUnit(unitHere.id);
    return;
  }

  const enemy = sandbox.enemyPickableAt(q, r);
  if (enemy) {
    toast(`敌标记 E${enemy.id} — 当前可见，仅显示位置，不能操作`);
    return;
  }

  // Only react to a door the player could know about; otherwise an unseen door
  // would announce itself through click behaviour (or through a toast).
  if (sandbox.mode === 'player' ? sandbox.isDoorKnown(q, r) : sandbox.map.get(q, r)?.terrain === 'door') {
    toggleDoorForCurrentMode(q, r);
    return;
  }

  const selected = sandbox.selected();
  if (!selected) {
    toast('先选中一名斥候（点击友军或按 1 / 2）');
    return;
  }
  const result = sandbox.tryMoveSelectedTo(q, r);
  if (result.ok) {
    rebuildChecklist();
    draw();
  } else if (result.reason === 'blocked') {
    toast('该格不可通行：高墙或关闭的门');
  } else if (result.reason === 'not-adjacent') {
    toast('一次只能移动到相邻格');
  }
}

/**
 * Player/edit/debug door clicking. In edit mode while paused, the toggle is
 * queued like any other edit; elsewhere it applies immediately. Player view
 * only allows doors the player could know about (seen now or remembered).
 */
function toggleDoorForCurrentMode(q: number, r: number): void {
  const cell = sandbox.map.get(q, r);
  if (!cell || cell.terrain !== 'door') return;
  if (sandbox.mode === 'edit' && editPaused) {
    queueEdit(q, r);
    return;
  }
  applyDoorToggle(q, r);
}

function applyDoorToggle(q: number, r: number): boolean {
  const cell = sandbox.map.get(q, r);
  if (!cell || cell.terrain !== 'door') return false;
  if (sandbox.mode === 'player' && !sandbox.isDoorKnown(q, r)) return false;
  sandbox.toggleDoor(q, r);
  toast(cell.doorOpen ? '门已关闭 — 视野立即重算' : '门已打开 — 视野立即重算');
  rebuildChecklist();
  draw();
  return true;
}

function selectUnit(id: UnitId): void {
  if (!sandbox.units.some((u) => u.id === id)) return;
  sandbox.select(id);
  rebuildPanel();
  draw();
}

/**
 * Edit-mode brush semantics:
 *  - wall / floor brush retypes the cell (pending while paused);
 *  - door brush places a door on plain ground, or flips an existing door's
 *    open state (a pending door toggle).
 */
function queueEdit(q: number, r: number): void {
  const key = `${q},${r}`;
  const existing = sandbox.map.get(q, r);
  if (!existing) return;
  const previous = pendingEdits.get(key);

  if (brush === 'door') {
    if (existing.terrain === 'door' && previous?.kind !== 'terrain') {
      if (previous?.kind === 'door') {
        pendingEdits.delete(key);
        toast('已取消待应用的门开关');
      } else {
        pendingEdits.set(key, { kind: 'door', key });
        toast(editPaused ? '待应用：切换此门开关 — 应用后重算视野' : '门已切换 — 视野立即重算');
      }
    } else if (previous?.kind === 'terrain' && previous.terrain === 'door') {
      pendingEdits.delete(key);
      toast('已取消待应用的放门');
    } else {
      pendingEdits.set(key, { kind: 'terrain', key, terrain: 'door' });
      toast(editPaused ? '待应用：在此放置一扇门' : '已放置门 — 视野立即重算');
    }
  } else {
    const terrain: Terrain = brush;
    if (previous?.kind === 'terrain' && previous.terrain === terrain) {
      pendingEdits.delete(key);
      toast('已取消该格的待应用编辑');
    } else {
      pendingEdits.set(key, { kind: 'terrain', key, terrain });
      if (editPaused) toast('已加入待应用队列 — 按“应用并重算”才会影响视野');
    }
  }

  if (!editPaused) applyPending();
  draw();
  rebuildPanelLight();
}

/** Panel refresh that keeps the list DOM stable (avoids stealing slider focus). */
function rebuildPanelLight(): void {
  rebuildActions();
  rebuildChecklist();
}

function applyPending(): void {
  if (pendingEdits.size === 0) return;
  let touched = false;
  for (const edit of pendingEdits.values()) {
    const [q, r] = edit.key.split(',').map(Number) as [number, number];
    if (edit.kind === 'terrain') {
      sandbox.map.setTerrain(q, r, edit.terrain);
      touched = true;
    } else if (sandbox.map.toggleDoor(q, r)) {
      touched = true;
    }
  }
  pendingEdits.clear();
  if (touched) sandbox.refresh();
  rebuildPanelLight();
  draw();
}

function togglePause(): void {
  editPaused = !editPaused;
  if (sandbox.mode !== 'edit') {
    applyMode('edit');
  }
  rebuildPanel();
  draw();
  toast(editPaused ? '编辑已暂停 — 待应用的改动不影响当前视野' : '编辑即时应用 — 每次落笔立即重算视野');
}

// ---------------------------------------------------------------------------
// Hover card
// ---------------------------------------------------------------------------

function positionHover(sx: number, sy: number): void {
  if (hoverEl.style.display === 'none' && hoverEl.textContent === '') return;
  const margin = 16;
  let x = sx + 18;
  let y = sy + 16;
  if (x + 310 > camera.viewport.width) x = sx - 310 - 12;
  if (y + 190 > camera.viewport.height) y = sy - 190 - 12;
  hoverEl.style.left = `${Math.max(margin, x)}px`;
  hoverEl.style.top = `${Math.max(margin, y)}px`;
}

function updateHoverCard(): void {
  if (!hovered || !inBounds(hovered.q, hovered.r)) {
    hoverEl.style.display = 'none';
    return;
  }
  const info = sandbox.hover(hovered.q, hovered.r);
  const concealed = sandbox.mode === 'player' && info.state === 'unexplored';
  const terrainLabel = concealed
    ? '未知（未探索）'
    : info.terrain === 'wall'
      ? '高墙'
      : info.terrain === 'door'
        ? info.doorOpen
          ? '打开的门'
          : '关闭的门'
        : '地面';
  const stateLabel =
    info.state === 'visible' ? '当前可见' : info.state === 'explored' ? '已探索（记忆）' : '未探索';
  const rows: string[] = [];
  rows.push(`<div class="row"><span class="k">格子</span><span>#${info.col},${info.row} · ${stateLabel}</span></div>`);
  rows.push(`<div class="row"><span class="k">地形</span><span>${terrainLabel}</span></div>`);

  for (const unit of info.perUnit) {
    const distance = `d=${unit.distance}`;
    if (unit.reason === 'self') {
      rows.push(`<div class="row"><span class="k">斥候 ${unit.unitId}</span><span class="good">${distance} · 自身</span></div>`);
    } else if (unit.reason === 'out-of-range') {
      rows.push(`<div class="row"><span class="k">斥候 ${unit.unitId}</span><span>${distance} · 超出视距</span></div>`);
    } else if (unit.reason === 'blocked' && unit.blocker) {
      const b = axialToOffset(unit.blocker.q, unit.blocker.r);
      const what = unit.blocker.terrain === 'wall' ? '高墙' : '关闭的门';
      rows.push(
        `<div class="row"><span class="k">斥候 ${unit.unitId}</span><span class="bad">${distance} · 被 ${what} #${b.col},${b.row} 遮挡</span></div>`,
      );
    } else {
      rows.push(`<div class="row"><span class="k">斥候 ${unit.unitId}</span><span class="good">${distance} · 可见</span></div>`);
    }
  }
  if (info.sources.length > 0) {
    rows.push(`<hr><div class="row"><span class="k">可见来源</span><span>${info.sources.map((s) => `斥候 ${s}`).join(' + ')}</span></div>`);
  } else if (info.state === 'explored') {
    rows.push('<hr><div class="row"><span class="k">记忆</span><span>地形保留，敌人不会显示</span></div>');
  }

  if (sandbox.mode === 'debug') {
    const enemy = sandbox.enemyPickableAt(hovered.q, hovered.r);
    rows.push(
      `<hr><div class="row"><span class="k">调试</span><span>${enemy ? `敌人 E${enemy.id}（${sandbox.vision.isVisible(enemy.q, enemy.r) ? '当前可见' : '当前隐藏'}）` : '无敌标记'}</span></div>`,
    );
  }
  hoverEl.innerHTML = rows.join('');
  hoverEl.style.display = 'block';
  if (pointer) positionHover(pointer.sx, pointer.sy);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function rebuildPanel(): void {
  rebuildScenarios();
  rebuildUnits();
  rebuildActions();
  rebuildChecklist();
  updateHint();
  draw();
}

function loadScenario(id: ScenarioId): void {
  sandbox.loadScenario(id);
  pendingEdits.clear();
  selectedEnemyId = null;
  rebuildPanel();
  toast(`已加载样例：${sandbox.scenario.title}（探索记录已清空）`);
}

function rebuildScenarios(): void {
  panel.scenarios.innerHTML = '';
  for (const spec of SCENARIOS) {
    const button = document.createElement('button');
    button.innerHTML = `<strong>${spec.title}</strong><span>${spec.units.length} 名斥候</span>`;
    button.setAttribute('aria-pressed', String(sandbox.scenario.id === spec.id));
    button.addEventListener('click', () => {
      loadScenario(spec.id as ScenarioId);
    });
    panel.scenarios.append(button);
  }
  panel.blurb.textContent = sandbox.scenario.blurb;
}

function rebuildUnits(): void {
  panel.units.innerHTML = '';
  for (const unit of sandbox.units) {
    const row = document.createElement('div');
    row.className = 'unit-row';
    const chip = document.createElement('span');
    chip.className = `chip ${unit.id.toLowerCase()}`;
    chip.textContent = unit.id;
    const name = document.createElement('div');
    name.className = 'name';
    const offset = axialToOffset(unit.q, unit.r);
    name.innerHTML = `${unit.label}<small>位置 #${offset.col},${offset.row}</small>`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1';
    slider.max = '12';
    slider.value = String(unit.radius);
    slider.title = '视野半径';
    slider.addEventListener('input', () => {
      sandbox.setRadius(unit.id, Number(slider.value));
      value.textContent = slider.value;
      rebuildChecklist();
      draw();
    });
    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = String(unit.radius);
    const selectBtn = document.createElement('button');
    selectBtn.textContent = sandbox.selectedUnit === unit.id ? '已选中' : '选中';
    selectBtn.setAttribute('aria-pressed', String(sandbox.selectedUnit === unit.id));
    selectBtn.addEventListener('click', () => selectUnit(unit.id));
    row.append(chip, name, slider, value, selectBtn);
    panel.units.append(row);
  }
}

function rebuildActions(): void {
  panel.actions.innerHTML = '';
  const make = (label: string, cls: string, onClick: () => void, disabled = false) => {
    const b = document.createElement('button');
    b.className = `action ${cls}`;
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };

  if (sandbox.mode === 'edit') {
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const [value, label] of [
      ['wall', '放墙'],
      ['floor', '清除'],
      ['door', '放门'],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(brush === value));
      b.addEventListener('click', () => {
        brush = value;
        rebuildActions();
      });
      seg.append(b);
    }
    panel.actions.append(seg);
    panel.actions.append(
      make(editPaused ? '▶ 继续编辑（立即应用）' : '⏸ 暂停编辑', editPaused ? 'primary' : '', () => {
        togglePause();
      }),
    );
    panel.actions.append(
      make(
        `应用并重算 (${pendingEdits.size})`,
        'primary',
        () => {
          applyPending();
          toast('改动已应用 — 视野重算，探索记录保留');
        },
        pendingEdits.size === 0,
      ),
    );
    panel.actions.append(
      make(
        '放弃待应用',
        '',
        () => {
          pendingEdits.clear();
          draw();
          toast('已放弃待应用的改动');
        },
        pendingEdits.size === 0,
      ),
    );
  }

  // Withdrawal is how a player verifies shared vision: hide A, B's cells stay lit.
  for (const unit of sandbox.units) {
    panel.actions.append(
      make(`收回斥候 ${unit.id}`, '', () => {
        sandbox.withdrawUnit(unit.id);
        rebuildPanel();
        toast(`斥候 ${unit.id} 已收回 — 另一名斥候的视野立即重算`);
      }),
    );
  }
  for (const id of [...sandbox.withdrawn.keys()]) {
    panel.actions.append(
      make(`恢复斥候 ${id}`, 'primary', () => {
        sandbox.restoreUnit(id);
        rebuildPanel();
        toast(`斥候 ${id} 已恢复`);
      }),
    );
  }

  panel.actions.append(
    make('重置地图', 'danger', () => {
      resetAll();
    }),
  );
  panel.actions.append(
    make('回到全局视野', '', () => {
      resizeToFitScene();
    }),
  );
}

function resetAll(): void {
  sandbox.reset();
  pendingEdits.clear();
  selectedEnemyId = null;
  rebuildPanel();
  toast('地图已重置 — 探索记录已清空');
}

function rebuildChecklist(): void {
  const results = sandbox.expectations();
  const failed = results.filter((r) => !r.ok).length;
  panel.sanity.textContent = failed
    ? `样例核对：${failed}/${results.length} 条与初始预期不符（视野已被你的操作改变）`
    : '';
  panel.checklist.innerHTML = '';
  for (const r of results) {
    const row = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = `mark ${r.ok ? 'ok' : 'bad'}`;
    mark.textContent = r.ok ? '✓' : '✕';
    const text = document.createElement('span');
    const expected = r.expect === 'visible' ? '应可见' : '应不可见';
    text.innerHTML = `#${r.col},${r.row} ${expected} <small>· 实际 ${labelOf(r.actual)} · ${r.note}</small>`;
    row.append(mark, text);
    panel.checklist.append(row);
  }
  if (failed > 0) {
    const note = document.createElement('p');
    note.className = 'blurb';
    note.textContent = '若只想复核初始约定，请点「重置地图」或重新加载该样例。';
    panel.checklist.append(note);
  }
}

function labelOf(state: 'visible' | 'explored' | 'unexplored'): string {
  return state === 'visible' ? '当前可见' : state === 'explored' ? '已探索' : '未探索';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

for (const button of panel.modes.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
  button.addEventListener('click', () => applyMode(button.dataset.mode as ViewMode));
}

const observer = new ResizeObserver(() => {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width === 0 || height === 0) return;
  if (width === camera.viewport.width && height === camera.viewport.height) return;
  renderer.resize(width, height);
  camera = { ...camera, viewport: { width, height } };
  draw();
});
observer.observe(stage);



layout();
applyMode('player');
rebuildPanel();

// ---------------------------------------------------------------------------
// Test / debugging hooks. Read-only-ish helpers so Playwright and the browser
// console can query real vision data and drive the camera deterministically.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __sandbox?: Sandbox;
    __stage?: {
      camera: Camera;
      sandbox: Sandbox;
      loadScenario: (id: ScenarioId) => void;
      setMode: (mode: ViewMode) => void;
      selectUnit: (id: UnitId) => void;
      toggleDoorAt: (col: number, row: number) => void;
      queueEdit: (col: number, row: number) => void;
      applyPending: () => void;
      setPaused: (paused: boolean) => void;
      setBrush: (b: 'wall' | 'floor' | 'door') => void;
      centreOf: (col: number, row: number) => { x: number; y: number };
      pick: (sx: number, sy: number) => { q: number; r: number; col: number; row: number };
      setViewport: (width: number, height: number) => void;
      viewport: () => { width: number; height: number };
    };
  }
}
window.__sandbox = sandbox;
window.__stage = {
  get camera() {
    return camera;
  },
  sandbox,
  loadScenario(id) {
    loadScenario(id);
  },
  setMode(mode) {
    applyMode(mode);
  },
  selectUnit(id) {
    selectUnit(id);
  },
  toggleDoorAt(col, row) {
    const { q, r } = offsetToAxial(col, row);
    sandbox.toggleDoor(q, r);
    rebuildChecklist();
    draw();
  },
  queueEdit(col, row) {
    const { q, r } = offsetToAxial(col, row);
    queueEdit(q, r);
  },
  applyPending() {
    applyPending();
  },
  setPaused(paused) {
    editPaused = paused;
    rebuildActions();
  },
  setBrush(value) {
    brush = value;
    rebuildActions();
  },
  centreOf(col, row) {
    const { q, r } = offsetToAxial(col, row);
    return hexCentre(q, r);
  },
  pick(sx, sy) {
    const cell = pickCell(camera, sx, sy);
    return { q: cell.q, r: cell.r, col: axialToOffset(cell.q, cell.r).col, row: axialToOffset(cell.q, cell.r).row };
  },
  setViewport(width, height) {
    renderer.resize(width, height);
    camera = { ...camera, viewport: { width, height } };
    draw();
  },
  viewport() {
    return camera.viewport;
  },
};
