import { LEVELS } from '../engine/levels';
import {
  alternatingSide,
  doorDescription,
  getBox,
  sideName,
} from '../engine/engine';
import type { Action, TransferTarget } from '../engine/types';
import { GameController } from './controller';
import { Renderer, type HitRegion } from './renderer';
import './style.css';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const $ = (id: string) => document.getElementById(id)!;

let levelIndex = 0;
const controller = new GameController(LEVELS[0]);
const renderer = new Renderer(canvas, LEVELS[0]);
let toastTimer: number | undefined;

// ---- HUD 与按钮 ----
function buildFloorButtons(): void {
  const wrap = $('floor-buttons');
  wrap.innerHTML = '';
  for (const f of LEVELS[levelIndex].floors) {
    const btn = document.createElement('button');
    btn.className = 'btn floor-btn';
    btn.textContent = `${f.id} 层`;
    btn.addEventListener('click', () => tryMove(f.id));
    wrap.appendChild(btn);
  }
}

function tryMove(toFloor: number): void {
  if (controller.replayIndex !== null) return;
  const action: Action = { type: 'move', toFloor };
  const pv = controller.preview(action);
  if (!pv.ok) {
    flash(pv.reason?.message ?? '无法移动');
    return;
  }
  const before = cloneForAnim();
  const reject = controller.commit(action);
  if (!reject) afterCommit(before);
}

function tryWait(): void {
  if (controller.replayIndex !== null) return;
  const action: Action = { type: 'wait' };
  const before = cloneForAnim();
  const reject = controller.commit(action);
  if (!reject) afterCommit(before);
}

function cloneForAnim() {
  return JSON.parse(JSON.stringify(controller.state)) as typeof controller.state;
}

function afterCommit(before: typeof controller.state): void {
  renderer.transition(before, controller.state);
  refresh();
  if (controller.won) showWin();
}

function flash(message: string): void {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function showWin(): void {
  $('win-detail').textContent =
    `用时 ${controller.state.turn} 回合，剩余 ${controller.remaining} 回合，评分 ${controller.scoreValue}。`;
  $('win-banner').hidden = false;
}

// ---- 画布点击 ----
canvas.addEventListener('click', (e) => {
  if (controller.replayIndex !== null) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const hit: HitRegion | null = renderer.hitTest(mx, my);
  if (!hit) {
    controller.select(null);
    refresh();
    return;
  }
  if (hit.kind === 'box') {
    controller.select(hit.boxId!);
    refresh();
    return;
  }
  // 点击货位：若已选中箱子，尝试搬入
  if (controller.selectedBoxId && hit.target) {
    const target: TransferTarget = hit.target;
    const action: Action = { type: 'transfer', boxId: controller.selectedBoxId, target };
    const before = cloneForAnim();
    const reject = controller.commit(action);
    if (reject) flash(reject.message);
    else afterCommit(before);
  }
});

// ---- 侧栏目标按钮 ----
function renderDestHints(): void {
  const box = $('dest-hints');
  box.innerHTML = '';
  if (!controller.selectedBoxId) return;
  const targets = controller.transferTargetsFor(controller.selectedBoxId);
  for (const t of targets) {
    const action: Action = { type: 'transfer', boxId: controller.selectedBoxId, target: t };
    const pv = controller.preview(action);
    const btn = document.createElement('button');
    btn.className = `btn dest ${pv.ok ? '' : 'disabled'}`;
    const where =
      t.region === 'car'
        ? '轿厢'
        : `${t.floor}层${sideName(t.side)}${t.region === 'case' ? '展柜' : '暂存位'}`;
    btn.textContent = pv.ok
      ? `→ ${where}（${pv.cost} 回合，预计第 ${pv.projectedTurn} 回合）`
      : `→ ${where}：${pv.reason?.message ?? '不可行'}`;
    btn.disabled = !pv.ok;
    btn.addEventListener('click', () => {
      const before = cloneForAnim();
      const reject = controller.commit(action);
      if (reject) flash(reject.message);
      else afterCommit(before);
    });
    box.appendChild(btn);
  }
}

// ---- 回看 ----
function renderReview(): void {
  const panel = $('review');
  panel.innerHTML = '';
  const states = controller.replayStates;
  const lines = controller.replayLines;
  if (states.length <= 1) {
    panel.innerHTML = '<p class="hint">还没有可回看的步骤。</p>';
    return;
  }
  states.forEach((_, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn review-btn';
    btn.textContent = i === 0 ? '初始' : `第 ${i} 步 · ${lines[i]?.text ?? ''}`;
    if (controller.replayIndex === i) btn.classList.add('active');
    btn.addEventListener('click', () => {
      controller.replayIndex = i;
      renderer.transition(null, controller.displayState, true);
      refresh();
    });
    panel.appendChild(btn);
  });
  if (controller.replayIndex !== null) {
    const exit = document.createElement('button');
    exit.className = 'btn wide';
    exit.textContent = '退出回看，回到当前局面';
    exit.addEventListener('click', () => {
      controller.exitReplay();
      renderer.transition(null, controller.state, true);
      refresh();
    });
    panel.appendChild(exit);
  }
}

// ---- 总刷新 ----
function refresh(): void {
  const level = LEVELS[levelIndex];
  const s = controller.displayState;
  $('level-name').textContent = level.name;
  $('hud-turn').textContent = String(s.turn);
  $('hud-budget').textContent = String(level.budget);
  $('hud-remaining').textContent = String(Math.max(0, level.budget - s.turn));
  $('hud-total').textContent = String(level.goals.length);
  $('hud-delivered').textContent = String(s.deliveredInOrder.length);

  // 交替门提示
  const altFloor = level.floors.find((f) => f.doorMode.kind === 'alternating');
  const alt = $('hud-alt');
  if (altFloor) {
    const cur = alternatingSide(s.turn);
    const nxt = alternatingSide(s.turn + 1);
    alt.textContent = `${altFloor.id}F 交替门：本回合${sideName(cur)}开，下一次${sideName(nxt)}开`;
  } else {
    alt.textContent = '';
  }

  // 等待按钮显示当前与下一门
  const waitBtn = $('btn-wait') as HTMLButtonElement;
  waitBtn.textContent = `等待 1 回合（预计第 ${s.turn + 1} 回合）`;

  // 选择信息
  const sel = $('selection-info');
  if (controller.selectedBoxId) {
    const b = getBox(level, controller.selectedBoxId);
    sel.textContent = `已选中：${b.label}（占 ${b.len} 格，${b.horizontalOnly ? '必须水平' : '可常规放置'}，${b.height === 'low' ? '矮箱可走低过梁' : '高箱'}）`;
  } else {
    sel.textContent = '点击场景中的画箱选中，再点击目标货位 / 门侧。';
  }

  // 楼层按钮标注门况与预计花费
  const floorBtns = document.querySelectorAll('.floor-btn');
  floorBtns.forEach((el, i) => {
    const f = level.floors[i];
    const btn = el as HTMLButtonElement;
    if (f.id === s.carFloor || controller.replayIndex !== null) {
      btn.disabled = true;
      btn.textContent = `${f.id} 层（当前）`;
      return;
    }
    const action: Action = { type: 'move', toFloor: f.id };
    const pv = controller.preview(action);
    btn.disabled = !pv.ok || controller.replayIndex !== null;
    btn.textContent = `${f.id} 层 · ${doorDescription(level, f.id, s.turn)} · ${pv.cost}回合`;
  });

  ($('btn-undo') as HTMLButtonElement).disabled = !controller.canUndo;
  renderDestHints();
  renderReview();
  renderer.draw(s, controller.selectedBoxId, controller.replayIndex === null ? controller.lastReject : null);
}

// ---- 控制按钮 ----
$('btn-wait').addEventListener('click', tryWait);
$('btn-undo').addEventListener('click', () => {
  const before = cloneForAnim();
  controller.undo();
  renderer.transition(before, controller.state, true);
  $('win-banner').hidden = true;
  refresh();
});
$('btn-reset').addEventListener('click', () => {
  controller.reset();
  renderer.transition(null, controller.state, true);
  $('win-banner').hidden = true;
  refresh();
});
$('win-replay').addEventListener('click', () => {
  controller.replayIndex = 0;
  renderer.transition(null, controller.displayState, true);
  $('win-banner').hidden = true;
  refresh();
});

function switchLevel(index: number): void {
  levelIndex = index;
  controller.loadLevel(LEVELS[index]);
  renderer.setLevel(LEVELS[index]);
  renderer.transition(null, controller.state, true);
  $('win-banner').hidden = true;
  buildFloorButtons();
  refresh();
}
$('btn-level1').addEventListener('click', () => switchLevel(0));
$('btn-level2').addEventListener('click', () => switchLevel(1));

// ---- 动画循环 ----
function loop(): void {
  if (renderer.animating) {
    renderer.draw(
      controller.displayState,
      controller.selectedBoxId,
      controller.replayIndex === null ? controller.lastReject : null,
    );
  }
  requestAnimationFrame(loop);
}

buildFloorButtons();
refresh();
loop();
