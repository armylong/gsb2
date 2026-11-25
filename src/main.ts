import { getScenarios } from './scenarios.ts';
import { simulate, stateAt } from './engine.ts';
import { draw } from './renderer.ts';
import { clearPrograms, loadPrograms, savePrograms } from './storage.ts';
import { OP_LABELS, type OpCode, type Scenario, type Simulation } from './types.ts';

const OP_OPTIONS: OpCode[] = ['F', 'L', 'R', 'PICK', 'DROP', 'W'];
const CELL = 72;
const PLAY_INTERVAL_MS = 650;

const scenarios = getScenarios();

interface UIState {
  scenario: Scenario;
  programs: Record<string, OpCode[]>;
  simulation: Simulation;
  /** 当前查看的拍，0 = 初始局面 */
  viewTick: number;
  playing: boolean;
  playTimer: number | null;
}

const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const elSwitch = document.getElementById('scenario-switch')!;
const elEditors = document.getElementById('editors')!;
const elTimeline = document.getElementById('timeline')!;
const elDetail = document.getElementById('detail')!;
const elDetailTitle = document.getElementById('detail-title')!;
const elHint = document.getElementById('hint')!;
const elLegend = document.getElementById('legend')!;
const elWin = document.getElementById('win-banner') as HTMLElement;

let state: UIState;

function effectivePrograms(scn: Scenario): Record<string, OpCode[]> {
  const saved = loadPrograms(scn.id);
  if (saved) return saved;
  return structuredClone(scn.defaultPrograms);
}

function recompute(): void {
  state.simulation = simulate(state.scenario, state.programs);
  if (state.viewTick > state.simulation.ticks.length) {
    state.viewTick = state.simulation.ticks.length;
  }
}

function selectScenario(index: number): void {
  stopPlay();
  const scn = scenarios[index];
  state = {
    scenario: scn,
    programs: effectivePrograms(scn),
    simulation: null as unknown as Simulation,
    viewTick: 0,
    playing: false,
    playTimer: null,
  };
  recompute();
  renderScenarioSwitch(index);
  renderEditors();
  renderTimeline();
  renderHintAndLegend();
  renderAll();
}

function renderScenarioSwitch(activeIndex: number): void {
  elSwitch.innerHTML = '';
  scenarios.forEach((scn, i) => {
    const btn = document.createElement('button');
    btn.textContent = scn.name;
    if (i === activeIndex) btn.classList.add('active');
    btn.addEventListener('click', () => selectScenario(i));
    elSwitch.appendChild(btn);
  });
}

function renderHintAndLegend(): void {
  elHint.textContent = state.scenario.hint;
  elLegend.innerHTML = `
    <span class="item"><span class="swatch" style="background:#3a4654"></span>墙</span>
    <span class="item"><span class="swatch" style="background:#eef1f4"></span>普通台面</span>
    <span class="item"><span class="swatch" style="background:#f7dedc;border-color:#d4453d"></span>红色角落台面</span>
    <span class="item"><span class="swatch" style="background:#dde7fa;border-color:#3d6fd4"></span>蓝色角落台面</span>
    <span class="item"><span class="swatch" style="background:#d4453d"></span>红书</span>
    <span class="item"><span class="swatch" style="background:#3d6fd4"></span>蓝书</span>
    <span class="item">虚线框 = 当拍前进请求（绿成功 / 琥珀被挡）</span>
  `;
}

function renderEditors(): void {
  elEditors.innerHTML = '';
  state.scenario.carts.forEach((cart) => {
    const ops = state.programs[cart.id] ?? [];
    const card = document.createElement('div');
    card.className = `editor-card cart-${cart.id}`;

    const head = document.createElement('div');
    head.className = 'editor-head';
    head.innerHTML = `<span>${cart.label}</span><span class="meta">共 ${ops.length} 拍 · 书箱至多一格</span>`;
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'op-grid';
    ops.forEach((op, idx) => {
      const cellWrap = document.createElement('div');
      cellWrap.className = 'op-cell';
      const no = document.createElement('span');
      no.className = 'tick-no';
      no.textContent = `第${idx + 1}拍`;
      const select = document.createElement('select');
      OP_OPTIONS.forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = `${OP_LABELS[value]} ${value}`;
        if (value === op) opt.selected = true;
        select.appendChild(opt);
      });
      select.dataset.tick = String(idx + 1);
      if (idx + 1 <= state.viewTick) select.classList.add('done');
      if (idx + 1 === state.viewTick + 1) select.classList.add('pending');
      select.addEventListener('change', () => {
        state.programs[cart.id][idx] = select.value as OpCode;
        persistAndRecompute();
      });
      cellWrap.append(no, select);
      grid.appendChild(cellWrap);
    });
    card.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'editor-actions';
    const addBtn = document.createElement('button');
    addBtn.textContent = '末尾加一拍';
    addBtn.addEventListener('click', () => {
      state.programs[cart.id].push('W');
      persistAndRecompute();
    });
    const insertBtn = document.createElement('button');
    insertBtn.textContent = '当前拍后插入';
    insertBtn.addEventListener('click', () => {
      const at = Math.min(state.viewTick, state.programs[cart.id].length);
      state.programs[cart.id].splice(at, 0, 'W');
      persistAndRecompute();
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除当前拍';
    delBtn.addEventListener('click', () => {
      if (state.programs[cart.id].length === 0) return;
      const at = Math.max(0, state.viewTick - 1);
      state.programs[cart.id].splice(at, 1);
      if (state.viewTick > 0) state.viewTick -= 1;
      persistAndRecompute();
    });
    actions.append(addBtn, insertBtn, delBtn);
    card.appendChild(actions);

    elEditors.appendChild(card);
  });
}

function persistAndRecompute(): void {
  stopPlay();
  savePrograms(state.scenario.id, state.programs);
  recompute();
  renderEditors();
  renderTimeline();
  renderAll();
}

function renderTimeline(): void {
  elTimeline.innerHTML = '';

  const zero = document.createElement('button');
  zero.type = 'button';
  zero.className = 'tick-chip' + (state.viewTick === 0 ? ' viewed' : '');
  zero.innerHTML = `<div class="n">起点</div>`;
  zero.addEventListener('click', () => setViewTick(0));
  elTimeline.appendChild(zero);

  state.simulation.ticks.forEach((record) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tick-chip';
    if (record.tick === state.viewTick) chip.classList.add('viewed');
    if (record.won) chip.classList.add('win');
    const dots = state.scenario.carts
      .map((cart) => {
        const r = record.results[cart.id];
        return `<span class="dot ${r.status}" title="${cart.label}：${r.reason}"></span>`;
      })
      .join('');
    chip.innerHTML = `<div class="n">第${record.tick}拍${record.won ? ' 🏁' : ''}</div><div class="marks">${dots}</div>`;
    chip.addEventListener('click', () => setViewTick(record.tick));
    elTimeline.appendChild(chip);
  });
}

function setViewTick(tick: number): void {
  stopPlay();
  state.viewTick = Math.max(0, Math.min(tick, state.simulation.ticks.length));
  renderEditors();
  renderTimeline();
  renderAll();
}

function renderAll(): void {
  renderCanvas();
  renderDetail();
  renderWin();
}

function renderCanvas(): void {
  const sim = state.simulation;
  const shown = stateAt(sim, state.viewTick);
  const record = state.viewTick > 0 ? sim.ticks[state.viewTick - 1] : undefined;
  canvas.width = state.scenario.width * CELL;
  canvas.height = state.scenario.height * CELL;
  draw(ctx, {
    cell: CELL,
    state: shown,
    scenario: state.scenario,
    viewTick: state.viewTick,
    results: record?.results,
  });
}

function renderDetail(): void {
  if (state.viewTick === 0) {
    elDetailTitle.textContent = '初始局面（第 0 拍）';
    elDetail.innerHTML = state.scenario.carts
      .map((cart) => {
        const c = state.simulation.initial.carts.find((x) => x.id === cart.id)!;
        return `<div class="detail-row cart-${cart.id}">
          <span class="who">${cart.label}</span>
          <span>位于 (${c.pos.x}, ${c.pos.y})，车箱空，等待第一拍指令。</span>
        </div>`;
      })
      .join('');
    return;
  }
  const record = state.simulation.ticks[state.viewTick - 1];
  elDetailTitle.textContent = `第 ${record.tick} 拍 · 请求与判定`;
  elDetail.innerHTML = state.scenario.carts
    .map((cart) => {
      const r = record.results[cart.id];
      const after = record.after.carts.find((c) => c.id === cart.id)!;
      const label = r.status === 'ok' ? '成功' : r.status === 'blocked' ? '被挡' : '失败';
      return `<div class="detail-row cart-${cart.id}">
        <span class="who">${cart.label}</span>
        <span>
          <span class="status-pill ${r.status}">${label}</span>
          指令 ${r.op}（${OP_LABELS[r.op]}）：${r.reason}<br/>
          拍后位置 (${after.pos.x}, ${after.pos.y})，
          车箱：${after.carrying ? '有书' : '空'}
        </span>
      </div>`;
    })
    .join('');
}

function renderWin(): void {
  if (state.simulation.winTick !== null && state.viewTick >= state.simulation.winTick) {
    elWin.hidden = false;
    elWin.textContent = `过关！第 ${state.simulation.winTick} 拍所有角落台面都收到了同色书（来自成功放书，不是路过）。`;
  } else {
    elWin.hidden = true;
  }
}

function stepForward(): void {
  if (state.viewTick >= state.simulation.ticks.length) return;
  state.viewTick += 1;
  renderEditors();
  renderTimeline();
  renderAll();
}

function stepBack(): void {
  setViewTick(state.viewTick - 1);
}

function resetView(): void {
  stopPlay();
  state.viewTick = 0;
  renderEditors();
  renderTimeline();
  renderAll();
}

function startPlay(): void {
  if (state.playing) {
    stopPlay();
    return;
  }
  if (state.viewTick >= state.simulation.ticks.length) state.viewTick = 0;
  state.playing = true;
  updatePlayButton();
  state.playTimer = window.setInterval(() => {
    if (state.viewTick >= state.simulation.ticks.length) {
      stopPlay();
      return;
    }
    stepForward();
  }, PLAY_INTERVAL_MS);
}

function stopPlay(): void {
  if (state?.playTimer !== null && state?.playTimer !== undefined) {
    clearInterval(state.playTimer);
    state.playTimer = null;
  }
  if (state) state.playing = false;
  updatePlayButton();
}

function updatePlayButton(): void {
  const btn = document.getElementById('btn-play')!;
  btn.textContent = state?.playing ? '暂停' : '完整走';
  btn.classList.toggle('primary', !!state?.playing);
}

function restoreDefaults(): void {
  stopPlay();
  clearPrograms(state.scenario.id);
  state.programs = structuredClone(state.scenario.defaultPrograms);
  state.viewTick = 0;
  recompute();
  renderEditors();
  renderTimeline();
  renderAll();
}

// ---- 控件绑定 ----
document.getElementById('btn-reset')!.addEventListener('click', resetView);
document.getElementById('btn-step-back')!.addEventListener('click', stepBack);
document.getElementById('btn-step')!.addEventListener('click', stepForward);
document.getElementById('btn-play')!.addEventListener('click', startPlay);
document.getElementById('btn-restore')!.addEventListener('click', restoreDefaults);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    stepForward();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepBack();
  }
});

selectScenario(0);
