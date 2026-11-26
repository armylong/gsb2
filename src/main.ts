import './style.css';
import {
  cloneSetup,
  defaultSetup,
  findHint,
  simulateLevel,
  validateSetup,
} from './game/engine';
import { levels } from './game/levels';
import { runSelfChecks, type SelfCheckItem } from './game/selfCheck';
import type {
  BeadColor,
  HintResult,
  SetupState,
  Side,
  SimFrame,
  SimulationResult,
} from './game/types';
import { pickChute, pickSlot, renderBoard } from './ui/renderer';

type ToolColor = BeadColor | 'eraser';

interface UiState {
  levelIndex: number;
  setup: SetupState;
  history: SetupState[];
  tool: ToolColor;
  result: SimulationResult | null;
  cursor: number;
  playing: boolean;
  progress: number;
  beatMs: number;
  hint: HintResult | null;
  checks: SelfCheckItem[];
  hoverChute: string | null;
  hoverSlot: string | null;
  notice: { kind: 'info' | 'failed'; text: string } | null;
}

const initialLevel = levels[0];
const state: UiState = {
  levelIndex: 0,
  setup: defaultSetup(initialLevel),
  history: [],
  tool: 'red',
  result: null,
  cursor: 0,
  playing: false,
  progress: 0,
  beatMs: 650,
  hint: null,
  checks: runSelfChecks(),
  hoverChute: null,
  hoverSlot: null,
  notice: null,
};

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;

function level() {
  return levels[state.levelIndex];
}

function setupCanvasSize(): void {
  const current = level();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(current.width * dpr);
  canvas.height = Math.round(current.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function invalidateRun(): void {
  state.result = null;
  state.playing = false;
  state.cursor = 0;
  state.progress = 0;
}

function commit(mutator: () => void): void {
  const before = cloneSetup(state.setup);
  mutator();
  const changed = JSON.stringify(before) !== JSON.stringify(state.setup);
  if (changed) state.history.push(before);
  invalidateRun();
  state.hint = null;
  updateDom();
}

function shortBead(beadId: string): string {
  return beadId.replace('bead:', '');
}

function prettifyTraceText(text: string, frame: SimFrame | undefined): string {
  let out = text;
  for (const bead of frame?.beads ?? []) {
    out = out.split(bead.id).join(shortBead(bead.id));
  }
  return out;
}

function renderTabs(): void {
  const nav = document.querySelector<HTMLElement>('#levelTabs')!;
  nav.innerHTML = levels
    .map(
      (item, index) =>
        `<button data-level="${index}" class="${index === state.levelIndex ? 'active' : ''}">${item.name}</button>`,
    )
    .join('');
}

function renderLevelPanel(): void {
  const current = level();
  document.querySelector<HTMLElement>('#levelName')!.textContent = current.name;
  document.querySelector<HTMLElement>('#levelSubtitle')!.textContent = current.subtitle;
  document.querySelector<HTMLElement>('#levelBrief')!.innerHTML = current.brief
    .map((line) => `<li>${line}</li>`)
    .join('');
  document.querySelector<HTMLElement>('#priorityBox')!.textContent = `优先条件：${current.priority.label}`;
  document.querySelector<HTMLElement>('#goalList')!.innerHTML = current.goal
    .map(
      (goal, index) =>
        `${index > 0 ? '<span class="goal-arrow">→</span>' : ''}
         <span class="goal-chip ${goal.color}">${index + 1}. ${goal.color === 'red' ? '红' : '蓝'} → ${
           goal.bin === 'L' ? '左' : '右'
         }${goal.note ? ` · ${goal.note}` : ''}</span>`,
    )
    .join('');
}

function renderEditor(): void {
  const current = level();
  const slotEditor = document.querySelector<HTMLElement>('#slotEditor')!;
  slotEditor.innerHTML = current.slots
    .map((slot) => {
      const color = state.setup.colors[slot.id];
      return `
        <div class="slot-row">
          <div>
            <span class="slot-name">${slot.id}</span>
            <span class="slot-meta">第 ${slot.releaseTick + 1} 拍可发射 · 入口 ${slot.node}</span>
          </div>
          <div class="mini-actions">
            <button data-action="set-slot" data-slot="${slot.id}" data-color="red" class="${color === 'red' ? 'active-left' : ''}">红</button>
            <button data-action="set-slot" data-slot="${slot.id}" data-color="blue" class="${color === 'blue' ? 'active-right' : ''}">蓝</button>
            <button data-action="clear-slot" data-slot="${slot.id}">空</button>
          </div>
        </div>`;
    })
    .join('');

  const chuteEditor = document.querySelector<HTMLElement>('#chuteEditor')!;
  chuteEditor.innerHTML = current.chutes
    .filter((chute) => chute.adjustable !== false)
    .map((chute) => {
      const tilt = state.setup.tilts[chute.id] ?? chute.initial;
      return `
        <div class="chute-row">
          <div>
            <span class="chute-name">${chute.id}</span>
            <span class="chute-label">${chute.label ?? ''}${chute.trigger ? ` · 开关 ${chute.trigger.id}` : ''}</span>
          </div>
          <div class="mini-actions">
            <button data-action="set-tilt" data-chute="${chute.id}" data-side="left" class="${tilt === 'left' ? 'active-left' : ''}">左倾</button>
            <button data-action="set-tilt" data-chute="${chute.id}" data-side="right" class="${tilt === 'right' ? 'active-right' : ''}">右倾</button>
          </div>
        </div>`;
    })
    .join('');

  document.querySelector<HTMLButtonElement>('#undoBtn')!.disabled = state.history.length === 0;

  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === state.tool);
  });
}

function renderHint(): void {
  const box = document.querySelector<HTMLElement>('#hintBox')!;
  const apply = document.querySelector<HTMLButtonElement>('#applyHintBtn')!;
  if (!state.hint) {
    box.hidden = true;
    apply.hidden = true;
    return;
  }
  box.hidden = false;
  apply.hidden = false;
  box.innerHTML = `
    <strong>搜索到一套通关摆放（由 simulateLevel 直接预演）：</strong>
    <ul>${state.hint.summary.map((line) => `<li>${line}</li>`).join('')}</ul>
    <div class="muted">提示没有另写竞争规则；它枚举可调朝向/发珠颜色，并调用同一个确定性引擎验证。</div>
  `;
}

function renderBanner(): void {
  const banner = document.querySelector<HTMLElement>('#banner')!;
  if (state.notice) {
    banner.className = `banner ${state.notice.kind}`;
    banner.textContent = state.notice.text;
    return;
  }
  if (!state.result) {
    banner.className = 'banner';
    banner.textContent = '先调槽、放珠，再点“放珠运行”。同格竞争、开关来源和等待原因都会进入单步记录。';
    return;
  }
  const final = state.result.final;
  const frame = state.result.frames[state.cursor] ?? final;
  const atEnd = state.cursor >= state.result.frames.length - 1;
  if (atEnd && final.status === 'won') {
    banner.className = 'banner won';
    banner.textContent = `过关：${final.arrivals
      .map((a) => `${a.tick}拍 ${a.color === 'red' ? '红' : '蓝'}→${a.bin === 'L' ? '左' : '右'}`)
      .join('，')}`;
  } else if (atEnd && final.status === 'failed') {
    banner.className = 'banner failed';
    banner.textContent = final.failure?.message ?? '运行失败';
  } else if (frame.failure) {
    banner.className = 'banner failed';
    banner.textContent = frame.failure.message ?? '运行失败';
  } else {
    banner.className = 'banner info';
    const beat = state.cursor;
    banner.textContent = state.playing
      ? `回放中：当前第 ${beat} 帧；可暂停后单步查看竞争、等待和开关来源。结局需播放到末尾或拖动进度条。`
      : `已定位到第 ${beat} 帧；这一拍若显示 occupied/lost-priority，只表示珠子在等待或让位，并不提前判失败。`;
  }
}

function renderInspector(): void {
  const inspector = document.querySelector<HTMLElement>('#inspector')!;
  const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
  const beatLabel = document.querySelector<HTMLElement>('#beatLabel')!;
  const playButton = document.querySelector<HTMLButtonElement>('[data-action="playpause"]')!;

  const maxFrame = state.result ? state.result.frames.length - 1 : 0;
  scrub.max = String(maxFrame);
  scrub.value = String(state.cursor);
  scrub.disabled = !state.result;
  beatLabel.textContent = state.result ? `帧 ${state.cursor}/${maxFrame}` : '未运行';
  playButton.textContent = state.playing ? '⏸ 暂停' : '⏯ 播放';

  if (!state.result) {
    inspector.innerHTML = `<div class="empty-note">还没有回放。运行后，这里会按拍列出：同格竞争胜方、未移动/等待原因、真实移动、以及每个开关变化的来源。</div>`;
    return;
  }

  const frame = state.result.frames[state.cursor];
  const trace = frame?.trace;
  const arrivals = frame?.arrivals ?? [];
  const arrivalStrip = `
    <div class="arrival-strip">
      ${arrivals
        .map(
          (a) =>
            `<span class="arrival-chip ${a.color}">#${a.order} ${a.color === 'red' ? '红' : '蓝'}→${
              a.bin === 'L' ? '左' : '右'
            } · ${a.tick}拍</span>`,
        )
        .join('') || '<span class="empty-note">尚无珠子到达出口。</span>'}
    </div>`;

  if (!trace) {
    inspector.innerHTML = `
      ${arrivalStrip}
      <div class="empty-note">第 0 帧是未放珠的初始布局。点“单步 ▶”或“放珠运行”开始第一拍。</div>`;
    return;
  }

  const conflicts = trace.conflicts
    .map(
      (c) => `
      <div class="trace-line conflict">
        <strong>${c.node} 同格竞争</strong>（${c.ruleLabel}）<br>
        优先级排序：${c.claimants.map(shortBead).join(' &gt; ')}；先占者：<strong>${shortBead(c.winnerId)}</strong>
      </div>`,
    )
    .join('');

  const moves = trace.moves
    .map(
      (m) => `
      <div class="trace-line move">
        ${shortBead(m.beadId)}${m.color === 'red' ? '红' : '蓝'} 经 <strong>${m.chuteId}</strong>
        ${m.side === 'left' ? '左倾' : '右倾'}：${m.from} → ${m.to}${m.exited ? '（到出口）' : ''}
      </div>`,
    )
    .join('');

  const blocks = trace.blocks
    .map(
      (b) => `
      <div class="trace-line block">
        <strong>${b.kind}</strong>：${prettifyTraceText(b.message, frame)}
      </div>`,
    )
    .join('');

  const switches = trace.switchResolutions
    .map(
      (r) => `
      <div class="trace-line switch">
        <strong>${r.targetChuteId}</strong>：${r.from} → <strong>${r.to}</strong>；
        净 toggle ${r.netToggles} 次，${r.changed ? '发生变向' : '偶数次抵消/保持'}。<br>
        来源：${r.sources
          .map((s) => `${s.switchId}（${shortBead(s.beadId)} 经过 ${s.sourceChuteId}）`)
          .join('，')}
        <br><span class="muted">${r.rule}</span>
      </div>`,
    )
    .join('');

  inspector.innerHTML = `
    ${arrivalStrip}
    <div class="trace-section">
      <h4>第 ${trace.tick + 1} 拍</h4>
      <div class="trace-line">发射：${trace.spawned.length ? trace.spawned.map(shortBead).join('、') : '无新发射'}</div>
    </div>
    ${conflicts ? `<div class="trace-section"><h4>竞争</h4>${conflicts}</div>` : ''}
    ${moves ? `<div class="trace-section"><h4>成功移动（只有这些珠触发开关）</h4>${moves}</div>` : ''}
    ${blocks ? `<div class="trace-section"><h4>拦截 / 等待 / 故障</h4>${blocks}</div>` : ''}
    ${switches ? `<div class="trace-section"><h4>同拍开关结算</h4>${switches}</div>` : ''}
    ${!conflicts && !moves && !blocks && !switches ? '<div class="empty-note">这一拍没有状态变化。</div>' : ''}
    ${frame?.failure ? `<div class="banner failed">${frame.failure.message}</div>` : ''}
  `;
}

function renderChecks(): void {
  const box = document.querySelector<HTMLElement>('#selfCheck')!;
  box.innerHTML = state.checks
    .map(
      (item) => `
      <div class="check-item ${item.ok ? 'ok' : 'bad'}">
        <span class="check-icon">${item.ok ? '✓' : '×'}</span>
        <div>
          <div class="check-name">${item.name}</div>
          <div class="check-detail">${item.detail}</div>
        </div>
      </div>`,
    )
    .join('');
}

function updateDom(): void {
  renderTabs();
  renderLevelPanel();
  renderEditor();
  renderHint();
  renderBanner();
  renderInspector();
}

function selectLevel(index: number): void {
  state.levelIndex = index;
  const nextLevel = levels[index];
  state.setup = defaultSetup(nextLevel);
  state.history = [];
  state.hint = null;
  state.notice = null;
  invalidateRun();
  setupCanvasSize();
  updateDom();
}

function applyTilt(chuteId: string, side: Side): void {
  const chute = level().chutes.find((c) => c.id === chuteId);
  if (chute?.adjustable === false) {
    state.notice = { kind: 'info', text: `${chuteId} 是题面固定槽，不能在开局前调整；开关仍可能在运行中改变它。` };
    updateDom();
    return;
  }
  if (state.setup.tilts[chuteId] === side && !state.result) return;
  commit(() => {
    state.setup.tilts[chuteId] = side;
  });
}

function applySlot(slotId: string, color: BeadColor | null): void {
  if (state.setup.colors[slotId] === color && !state.result) return;
  commit(() => {
    state.setup.colors[slotId] = color;
  });
}

function runSimulation(): void {
  const problems = validateSetup(level(), state.setup);
  if (problems.length) {
    state.notice = { kind: 'failed', text: `还不能放珠：${problems.join('；')}` };
    updateDom();
    return;
  }
  state.result = simulateLevel(level(), state.setup);
  state.cursor = 0;
  state.progress = 0;
  state.playing = true;
  state.notice = null;
  updateDom();
}

document.addEventListener('click', (event) => {
  const levelButton = (event.target as HTMLElement).closest<HTMLElement>('[data-level]');
  if (levelButton?.dataset.level !== undefined) {
    selectLevel(Number(levelButton.dataset.level));
    return;
  }

  const toolButton = (event.target as HTMLElement).closest<HTMLElement>('[data-tool]');
  if (toolButton?.dataset.tool) {
    state.tool = toolButton.dataset.tool as ToolColor;
    renderEditor();
    return;
  }

  const actionEl = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  switch (action) {
    case 'run':
      runSimulation();
      break;
    case 'edit':
      invalidateRun();
      state.notice = null;
      updateDom();
      break;
    case 'undo': {
      const previous = state.history.pop();
      if (previous) {
        state.setup = previous;
        invalidateRun();
        state.hint = null;
        state.notice = null;
        updateDom();
      }
      break;
    }
    case 'reset':
      state.setup = defaultSetup(level());
      state.history = [];
      state.hint = null;
      state.notice = null;
      invalidateRun();
      updateDom();
      break;
    case 'set-tilt':
      if (actionEl.dataset.chute && actionEl.dataset.side) {
        applyTilt(actionEl.dataset.chute, actionEl.dataset.side as Side);
      }
      break;
    case 'set-slot':
      if (actionEl.dataset.slot && actionEl.dataset.color) {
        applySlot(actionEl.dataset.slot, actionEl.dataset.color as BeadColor);
      }
      break;
    case 'clear-slot':
      if (actionEl.dataset.slot) applySlot(actionEl.dataset.slot, null);
      break;
    case 'hint':
      state.hint = findHint(level(), state.setup);
      if (!state.hint) {
        state.notice = { kind: 'failed', text: '枚举范围内没有找到可通关摆放；请检查关卡定义。' };
      } else {
        state.notice = { kind: 'info', text: '已用同一个 simulateLevel 找到解法，可在提示框查看并应用。' };
      }
      renderHint();
      renderBanner();
      break;
    case 'applyHint':
      if (state.hint) {
        commit(() => {
          state.setup = cloneSetup(state.hint!.setup);
        });
      }
      break;
    case 'selfcheck':
      state.checks = runSelfChecks();
      renderChecks();
      break;
    case 'first':
      state.playing = false;
      state.cursor = 0;
      state.progress = 0;
      updateDom();
      break;
    case 'prev':
      state.playing = false;
      state.cursor = Math.max(0, state.cursor - 1);
      state.progress = 0;
      updateDom();
      break;
    case 'next':
      state.playing = false;
      if (state.result) state.cursor = Math.min(state.result.frames.length - 1, state.cursor + 1);
      state.progress = 0;
      updateDom();
      break;
    case 'playpause': {
      if (!state.result) {
        runSimulation();
        break;
      }
      if (state.cursor >= state.result.frames.length - 1) {
        state.cursor = 0;
        state.progress = 0;
      }
      state.playing = !state.playing;
      updateDom();
      break;
    }
  }
});

document.querySelector<HTMLInputElement>('#scrub')!.addEventListener('input', (event) => {
  if (!state.result) return;
  state.playing = false;
  state.cursor = Number((event.target as HTMLInputElement).value);
  state.progress = 0;
  renderInspector();
  renderBanner();
});

document.querySelector<HTMLSelectElement>('#speedSelect')!.addEventListener('change', (event) => {
  state.beatMs = Number((event.target as HTMLSelectElement).value);
});

function canvasPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const current = level();
  return {
    x: ((event.clientX - rect.left) / rect.width) * current.width,
    y: ((event.clientY - rect.top) / rect.height) * current.height,
  };
}

canvas.addEventListener('pointermove', (event) => {
  const p = canvasPoint(event);
  const slotId = pickSlot(level(), p.x, p.y);
  const picked = slotId ? null : pickChute(level(), p.x, p.y);
  state.hoverSlot = slotId;
  state.hoverChute = picked?.chuteId ?? null;
  canvas.style.cursor = slotId || picked ? 'pointer' : 'crosshair';
});

canvas.addEventListener('pointerleave', () => {
  state.hoverChute = null;
  state.hoverSlot = null;
});

canvas.addEventListener('click', (event) => {
  const p = canvasPoint(event);
  const slotId = pickSlot(level(), p.x, p.y);
  if (slotId) {
    applySlot(slotId, state.tool === 'eraser' ? null : state.tool);
    return;
  }
  const picked = pickChute(level(), p.x, p.y);
  if (picked) applyTilt(picked.chuteId, picked.side);
});

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const p = canvasPoint(event);
  const slotId = pickSlot(level(), p.x, p.y);
  if (slotId) applySlot(slotId, null);
});

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  if (event.code === 'Space') {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>('[data-action="playpause"]')?.click();
  } else if (event.key === 'ArrowRight') {
    document.querySelector<HTMLButtonElement>('[data-action="next"]')?.click();
  } else if (event.key === 'ArrowLeft') {
    document.querySelector<HTMLButtonElement>('[data-action="prev"]')?.click();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>('[data-action="undo"]')?.click();
  }
});

let lastTime = performance.now();
function animationLoop(now: number): void {
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;

  if (state.playing && state.result) {
    state.progress += dt / state.beatMs;
    if (state.progress >= 1) {
      if (state.cursor < state.result.frames.length - 1) {
        state.cursor += 1;
        state.progress = 0;
        renderInspector();
      } else {
        state.playing = false;
        state.progress = 0;
        updateDom();
      }
    }
  }

  const current = level();
  const frame = state.result?.frames[state.cursor] ?? null;
  const nextFrame =
    state.playing && state.result ? state.result.frames[state.cursor + 1] ?? null : null;
  renderBoard(ctx, {
    level: current,
    setup: state.setup,
    frame,
    nextFrame,
    progress: state.progress,
    hoverChute: state.hoverChute,
    hoverSlot: state.hoverSlot,
  });

  requestAnimationFrame(animationLoop);
}

setupCanvasSize();
updateDom();
renderChecks();
requestAnimationFrame(animationLoop);

