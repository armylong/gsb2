import { ROOMS } from './rooms.ts';
import { createState, resetState, tick, boxSeated } from './physics.ts';
import { render } from './renderer.ts';
import { TICK, SEAT_REQUIRED_TICKS } from './types.ts';
import type { GameState, InputState, RejectReason } from './types.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const REJECT_CN: Record<RejectReason, string> = {
  'not-grounded': '本次没有发生：人物不在地面（必须贴住支撑面才能触发）',
  'same-direction': '本次没有发生：重力已经是这个方向',
  'flip-in-progress': '本次没有发生：上一次翻转还没结算，连按不会重复结算',
  'game-over': '本次没有发生：本局已结束，请先按 R 重开',
};

let roomIndex = 0;
let state: GameState = createState(ROOMS[0]);
let paused = false;
let debug = true;

/** 边沿输入：按下时置位，被 tick 消费后清掉 */
const held = { left: false, right: false };
const edge = { flipUp: false, flipDown: false };

function loadRoom(index: number, startPaused: boolean): void {
  roomIndex = index;
  state = createState(ROOMS[index]);
  paused = startPaused;
  canvas.width = ROOMS[index].width;
  canvas.height = ROOMS[index].height;
  document.getElementById('room-hint')!.textContent = ROOMS[index].hint;
  updateRoomButtons();
  draw();
}

function restart(): void {
  resetState(state);
  paused = false;
  draw();
}

function consumeInput(): InputState {
  const input: InputState = {
    left: held.left,
    right: held.right,
    flipUp: edge.flipUp,
    flipDown: edge.flipDown,
  };
  edge.flipUp = false;
  edge.flipDown = false;
  return input;
}

function stepOnce(): void {
  if (state.status === 'playing') tick(state, consumeInput());
  draw();
}

// ---- 固定步长主循环（渲染插值省略：60Hz 物理与显示刷新基本同频）----
let last = performance.now();
let acc = 0;
function frame(now: number): void {
  const frameDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += frameDt;
    // 防止标签页切回后追帧过多
    let guard = 0;
    while (acc >= TICK && guard < 8) {
      stepOnce();
      acc -= TICK;
      guard += 1;
    }
    if (guard === 8) acc = 0;
  }
  draw();
  requestAnimationFrame(frame);
}

function draw(): void {
  render(ctx, state, debug);
  syncHud();
}

function syncHud(): void {
  const $ = (id: string) => document.getElementById(id)!;
  $('hud-gravity').textContent = state.gravity === 1 ? '↓ 向下' : '↑ 向上';
  $('hud-flip').textContent =
    state.flipPhase === 'flipping' ? `翻转中 ${state.flipAgeTicks}t` : 'idle';
  $('hud-grounded').textContent = state.player.grounded ? '贴地 ✓' : '悬空 ✗';
  $('hud-seat').textContent =
    `${state.seatedTicks}/${SEAT_REQUIRED_TICKS}${boxSeated(state) ? '（箱在槽内）' : ''}`;
  $('hud-tick').textContent = String(state.tick);
  $('hud-pause').textContent = paused ? '是（N 单步）' : '否';
  $('btn-pause').textContent = paused ? '继续 (Space)' : '暂停 (Space)';

  const rejectEl = $('reject');
  if (state.lastReject && state.tick - state.lastReject.tick <= 120) {
    rejectEl.textContent = `⚠ ${REJECT_CN[state.lastReject.reason]}`;
  } else {
    rejectEl.textContent = '';
  }

  const logsEl = $('logs');
  logsEl.innerHTML = state.logs
    .map((l) => `<div class="${l.kind}">[t${l.tick}] ${escapeHtml(l.text)}</div>`)
    .join('');
  logsEl.scrollTop = logsEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---- 房间按钮 ----
function updateRoomButtons(): void {
  const wrap = document.getElementById('room-buttons')!;
  wrap.innerHTML = '';
  ROOMS.forEach((room, i) => {
    const btn = document.createElement('button');
    btn.textContent = room.name;
    if (i === roomIndex) btn.classList.add('active');
    btn.addEventListener('click', () => loadRoom(i, i === 1));
    wrap.appendChild(btn);
  });
}

// ---- 输入 ----
window.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'ArrowLeft':
    case 'KeyA':
      held.left = true;
      e.preventDefault();
      break;
    case 'ArrowRight':
    case 'KeyD':
      held.right = true;
      e.preventDefault();
      break;
    case 'KeyW':
    case 'ArrowUp':
      if (!e.repeat) edge.flipUp = true;
      e.preventDefault();
      break;
    case 'KeyS':
    case 'ArrowDown':
      if (!e.repeat) edge.flipDown = true;
      e.preventDefault();
      break;
    case 'Space':
      if (!e.repeat) paused = !paused;
      e.preventDefault();
      break;
    case 'KeyN':
      if (!e.repeat && paused) stepOnce();
      break;
    case 'KeyR':
      if (!e.repeat) restart();
      break;
    case 'F3':
      if (!e.repeat) {
        debug = !debug;
        debugToggle.checked = debug;
      }
      e.preventDefault();
      break;
    default:
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') held.left = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') held.right = false;
});

document.getElementById('btn-restart')!.addEventListener('click', restart);
document.getElementById('btn-pause')!.addEventListener('click', () => {
  paused = !paused;
  draw();
});
document.getElementById('btn-step')!.addEventListener('click', () => {
  if (paused) stepOnce();
});
const debugToggle = document.getElementById('debug-toggle') as HTMLInputElement;
debugToggle.checked = debug;
debugToggle.addEventListener('change', () => {
  debug = debugToggle.checked;
  draw();
});

// 房间 2 以暂停态进入，方便逐步核对
loadRoom(0, false);
// 调试/冒烟用只读状态入口
(window as unknown as { __game: { getState: () => GameState } }).__game = { getState: () => state };
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});
