import { LEVELS } from './levels';
import {
  cloneState,
  isComplete,
  makeInitialState,
  pickupFrame,
  groundFrame,
  sweepPivot,
  sweepTranslate,
  sweepWalkPerson,
  type GameState,
} from './engine';
import { runDemoAction } from './demo';
import { renderGame } from './render';
import { angleDelta, frameOBB, type BlockInfo, type Vec } from './geom';
import { FRAME_LENGTH, HANDLE_DISTANCE, PORTER_RADIUS, VIEW_H, VIEW_W, type DemoAction } from './types';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ctx = canvas?.getContext('2d')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
const resetBtn = document.querySelector<HTMLButtonElement>('#reset')!;
const hintBtn = document.querySelector<HTMLButtonElement>('#hint')!;
const demoBtn = document.querySelector<HTMLButtonElement>('#demo')!;
const groundBtn = document.querySelector<HTMLButtonElement>('#ground')!;
const tabsEl = document.querySelector<HTMLElement>('#levelTabs')!;
const briefEl = document.querySelector<HTMLParagraphElement>('header p')!;
const winBanner = document.querySelector<HTMLDivElement>('#winBanner')!;
const winText = document.querySelector<HTMLParagraphElement>('#winText')!;
const winReplay = document.querySelector<HTMLButtonElement>('#winReplay')!;
const winNext = document.querySelector<HTMLButtonElement>('#winNext')!;
const hintCard = document.querySelector<HTMLDivElement>('#hintCard')!;
const hintTitle = document.querySelector<HTMLDivElement>('#hintTitle')!;
const hintText = document.querySelector<HTMLDivElement>('#hintText')!;

if (!canvas || !ctx || !statusEl || !undoBtn || !resetBtn || !hintBtn || !demoBtn || !groundBtn || !tabsEl || !briefEl || !winBanner || !winText || !winReplay || !winNext || !hintCard || !hintTitle || !hintText) {
  throw new Error('页面缺少必要的 DOM 元素');
}

type DragKind = 'porter' | 'body' | 'walk';

interface DragState {
  kind: DragKind;
  who: 0 | 1;
  pointerId: number;
  last: Vec;
  downAt: Vec;
  snapshot: GameState;
}

let levelIndex = 0;
let level = LEVELS[0]!;
let state: GameState = makeInitialState(level);
let undoStack: GameState[] = [];
let drag: DragState | null = null;
let blockFlash: (BlockInfo & { atTime: number }) | null = null;
let hintIndex = 0;
let hintGhost: GameState | null = null;
let demoRunning = false;
let demoToken = 0;

function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind === 'info' ? '' : kind}`.trim();
}

function flashBlock(block: BlockInfo, message: string): void {
  blockFlash = { ...block, atTime: performance.now() };
  setStatus(message, 'error');
}

function statesDiffer(a: GameState, b: GameState): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function updateControls(): void {
  undoBtn.disabled = undoStack.length === 0 || demoRunning;
  resetBtn.disabled = false;
  hintBtn.disabled = demoRunning;
  demoBtn.textContent = demoRunning ? '■ 停止演示' : '▶ 播放通关演示';
  groundBtn.disabled = demoRunning;
  groundBtn.textContent = state.mode === 'carry' ? '放下画框（需在绿区内）' : '拿起 / 交换把手';
  canvas.classList.toggle('dragging', drag !== null);
}

function updateWin(): void {
  const won = isComplete(state, level);
  winBanner.hidden = !won;
  if (won) {
    winText.textContent =
      levelIndex === LEVELS.length - 1
        ? '两关的搬运都完成了：长画框完整入架，方向标记一致。'
        : '画框完整进入框架，方向标记一致。可以进入下一关。';
    winNext.textContent = levelIndex === LEVELS.length - 1 ? '回到第一关' : '下一关';
    setStatus('通关！画框完整入架且方向正确。', 'success');
  }
  updateControls();
}

function buildTabs(): void {
  tabsEl.innerHTML = '';
  LEVELS.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `level-tab ${i === levelIndex ? 'active' : ''}`;
    btn.textContent = item.name;
    btn.addEventListener('click', () => loadLevel(i));
    tabsEl.appendChild(btn);
  });
}

function loadLevel(index: number): void {
  stopDemo();
  levelIndex = index;
  level = LEVELS[index]!;
  state = makeInitialState(level);
  undoStack = [];
  drag = null;
  blockFlash = null;
  hintIndex = 0;
  hintGhost = null;
  hintCard.hidden = true;
  briefEl.textContent = level.brief;
  buildTabs();
  winBanner.hidden = true;
  setStatus('准备就绪：拖动一名搬运工开始。');
  updateControls();
}

function resetLevel(): void {
  stopDemo();
  state = makeInitialState(level);
  undoStack = [];
  drag = null;
  blockFlash = null;
  hintIndex = 0;
  hintGhost = null;
  hintCard.hidden = true;
  winBanner.hidden = true;
  setStatus('已回到本关初始位置。');
  updateControls();
}

function undo(): void {
  stopDemo();
  const previous = undoStack.pop();
  if (!previous) return;
  state = previous;
  blockFlash = null;
  setStatus('已撤销最近一步。');
  updateWin();
}

function toWorld(event: PointerEvent): Vec {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * VIEW_W,
    y: ((event.clientY - rect.top) / rect.height) * VIEW_H,
  };
}

function hitPorter(p: Vec): 0 | 1 | null {
  for (const i of [0, 1] as const) {
    const q = state.people[i]!;
    if (Math.hypot(p.x - q.x, p.y - q.y) <= PORTER_RADIUS + 10) return i;
  }
  return null;
}

function hitFrameBody(p: Vec): boolean {
  const obb = frameOBB(state.h[0]!, state.h[1]!, FRAME_LENGTH, 30);
  const c = Math.cos(-obb.angle);
  const s = Math.sin(-obb.angle);
  const dx = p.x - obb.cx;
  const dy = p.y - obb.cy;
  const localX = dx * c - dy * s;
  const localY = dx * s + dy * c;
  // Include the short handle rods in the body-drag hit area.
  return Math.abs(localX) <= HANDLE_DISTANCE / 2 + 8 && Math.abs(localY) <= 26;
}

function onPointerDown(event: PointerEvent): void {
  if (demoRunning) stopDemo();
  const p = toWorld(event);
  canvas.setPointerCapture(event.pointerId);

  const porter = hitPorter(p);
  if (state.mode === 'ground') {
    if (porter !== null) {
      drag = { kind: 'walk', who: porter, pointerId: event.pointerId, last: p, downAt: p, snapshot: cloneState(state) };
      updateControls();
    } else {
      setStatus('画框已落地：拖动工人绕到另一个把手旁，再按“拿起 / 交换把手”。', 'info');
    }
    return;
  }

  if (porter !== null) {
    drag = { kind: 'porter', who: porter, pointerId: event.pointerId, last: p, downAt: p, snapshot: cloneState(state) };
  } else if (hitFrameBody(p)) {
    drag = { kind: 'body', who: 0, pointerId: event.pointerId, last: p, downAt: p, snapshot: cloneState(state) };
  } else {
    setStatus('请拖蓝/橙搬运工，或拖画框中段。', 'info');
  }
  updateControls();
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  const p = toWorld(event);
  const dx = p.x - drag.last.x;
  const dy = p.y - drag.last.y;

  if (drag.kind === 'walk') {
    const person = state.people[drag.who]!;
    const result = sweepWalkPerson(state, drag.who, { x: person.x + dx, y: person.y + dy }, level);
    state = result.state;
    if (result.block) flashBlock(result.block, result.message);
    else blockFlash = null;
  } else if (drag.kind === 'body') {
    const result = sweepTranslate(state, dx, dy, level);
    state = result.state;
    if (result.block) flashBlock(result.block, result.message);
    else blockFlash = null;
  } else {
    const heldHandle = state.grip[drag.who]!;
    const pivot = state.h[1 - heldHandle as 0 | 1]!;
    const lastAngle = Math.atan2(drag.last.y - pivot.y, drag.last.x - pivot.x);
    const nextAngle = Math.atan2(p.y - pivot.y, p.x - pivot.x);
    const result = sweepPivot(state, drag.who, angleDelta(lastAngle, nextAngle), level);
    state = result.state;
    if (result.block) flashBlock(result.block, result.message);
    else blockFlash = null;
  }

  drag.last = p;
  updateControls();
}

function finishPointer(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const active = drag;
  if (statesDiffer(active.snapshot, state)) undoStack.push(active.snapshot);
  if (undoStack.length > 120) undoStack.shift();
  drag = null;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {
    /* capture may already be released */
  }
  updateWin();
  updateControls();
}

function applyGroundOrPickup(): void {
  stopDemo();
  const snapshot = cloneState(state);
  const result = state.mode === 'carry' ? groundFrame(state, level) : pickupFrame(state, level);
  if (!result.ok) {
    setStatus(result.message, 'error');
    return;
  }
  state = result.state;
  undoStack.push(snapshot);
  setStatus(result.message, 'success');
  updateWin();
}

function canonicalStateThrough(index: number): GameState {
  let s = makeInitialState(level);
  for (let i = 0; i <= index; i++) {
    const action = level.demo[i];
    if (!action) break;
    s = runDemoAction(s, action, level).state;
  }
  return s;
}

function showHint(): void {
  stopDemo();
  const action: DemoAction | undefined = level.demo[hintIndex];
  if (!action) return;
  hintGhost = canonicalStateThrough(hintIndex);
  hintCard.hidden = false;
  hintTitle.textContent = `参考路线 ${hintIndex + 1}/${level.demo.length}`;
  hintText.textContent = action.say;
  hintIndex = (hintIndex + 1) % level.demo.length;
  setStatus('绿色虚线幻影是该提示完成后的参考姿态。', 'info');
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function stopDemo(): void {
  demoToken++;
  demoRunning = false;
  updateControls();
}

async function playDemo(): Promise<void> {
  if (demoRunning) {
    stopDemo();
    setStatus('演示已停止，可以从当前姿态撤销或继续操作。', 'info');
    return;
  }

  const token = ++demoToken;
  demoRunning = true;
  state = makeInitialState(level);
  undoStack = [];
  blockFlash = null;
  winBanner.hidden = true;
  hintCard.hidden = true;
  hintGhost = null;
  hintIndex = 0;
  updateControls();
  setStatus('演示开始：每个动作都通过真实的连续碰撞检查。', 'info');

  for (let i = 0; i < level.demo.length; i++) {
    await wait(820);
    if (token !== demoToken) return;
    const action = level.demo[i]!;
    const out = runDemoAction(state, action, level);
    if (!out.ok) {
      demoRunning = false;
      updateControls();
      setStatus(`演示在第 ${i + 1} 步失败：${out.message}`, 'error');
      return;
    }
    state = out.state;
    setStatus(`演示 ${i + 1}/${level.demo.length}：${action.say}`, 'info');
    updateControls();
  }

  await wait(500);
  if (token !== demoToken) return;
  demoRunning = false;
  updateWin();
  updateControls();
}

function frame(now: number): void {
  renderGame(ctx, {
    level,
    state,
    ghost: hintGhost,
    block: blockFlash,
    now,
    dragging: drag !== null,
  });
  requestAnimationFrame(frame);
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', finishPointer);
undoBtn.addEventListener('click', undo);
resetBtn.addEventListener('click', resetLevel);
hintBtn.addEventListener('click', showHint);
demoBtn.addEventListener('click', () => void playDemo());
groundBtn.addEventListener('click', applyGroundOrPickup);
winReplay.addEventListener('click', resetLevel);
winNext.addEventListener('click', () => loadLevel((levelIndex + 1) % LEVELS.length));

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
  } else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'r') {
    resetLevel();
  } else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'h') {
    showHint();
  }
});

buildTabs();
updateControls();
requestAnimationFrame(frame);
