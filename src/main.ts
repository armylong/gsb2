import { LEVEL } from './engine/level';
import {
  createSimulation,
  deliver,
  move,
  neighbors,
  pickup,
  wait,
  finalizeRecord,
  cellName,
  type SimState,
} from './engine/engine';
import { planHint } from './engine/planner';
import { clearRecords, loadRecords, saveRecord } from './engine/storage';
import { CANVAS_H, CANVAS_W, drawScene, drawTideStrip, pickCell } from './ui/renderer';
import type { HintPlan } from './engine/planner';
import type { LogEntry, RunRecord } from './engine/types';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="layout">
    <div class="board">
      <canvas id="canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
      <div class="controls">
        <button id="btn-wait1">等 1 刻</button>
        <button id="btn-wait5">等 5 刻</button>
        <button id="btn-wait10">等 10 刻</button>
        <button id="btn-pickup">拾件</button>
        <button id="btn-deliver">交件</button>
        <button id="btn-hint" class="accent">路线提示</button>
        <button id="btn-hint-home">只看回程</button>
        <label class="switch"><input type="checkbox" id="chk-hint" checked /> 常驻提示</label>
        <button id="btn-reset" class="warn">重开本局</button>
      </div>
      <div id="msg" class="msg"></div>
    </div>
    <aside class="side">
      <section>
        <h3>规则速览</h3>
        <ul class="rules">
          <li>潮水按 60 刻周期：退潮 0–20、低潮 20–34、涨潮 34–54、满潮 54–60</li>
          <li>水位超过路面高程即封路；跨格 3 刻，负重 5 刻，途中上水立即打断</li>
          <li>打断后优先退回出发格（2 刻），出发格也上水则撤向最近高处干地</li>
          <li>低格等过涨潮逐刻受淹：连续 6 刻被困；轻信片泡水 3 刻损毁</li>
          <li>重信片禁走 h0/h1 低路；轻信片怕泡水，负重移动变慢</li>
        </ul>
      </section>
      <section>
        <h3>当前可走（按此刻潮时）</h3>
        <div id="neighbors"></div>
      </section>
      <section>
        <h3>路线提示</h3>
        <div id="hint" class="hint">点「路线提示」按当前潮时与携带状态计算</div>
      </section>
      <section>
        <h3>事件日志</h3>
        <ol id="log" class="log"></ol>
      </section>
      <section>
        <h3>历史对照 <button id="btn-clear" class="mini">清空</button></h3>
        <div id="records" class="records"></div>
      </section>
    </aside>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const ctx = canvas.getContext('2d')!;
const msgEl = document.querySelector<HTMLDivElement>('#msg')!;
const logEl = document.querySelector<HTMLOListElement>('#log')!;
const neighborsEl = document.querySelector<HTMLDivElement>('#neighbors')!;
const hintEl = document.querySelector<HTMLDivElement>('#hint')!;
const recordsEl = document.querySelector<HTMLDivElement>('#records')!;
const chkHint = document.querySelector<HTMLInputElement>('#chk-hint')!;

let state: SimState = createSimulation(LEVEL);
let hint: HintPlan | null = null;
let animating = false;
let savedThisRun = false;

function flash(text: string, danger = false): void {
  msgEl.textContent = text;
  msgEl.className = `msg show ${danger ? 'danger' : ''}`;
  window.setTimeout(() => msgEl.classList.remove('show'), 2600);
}

function render(): void {
  drawScene(ctx, state, LEVEL, hint, chkHint.checked);
  drawTideStrip(ctx, LEVEL, state.tick, CANVAS_W - 230, 12, 210, 46);
  renderNeighbors();
  renderLog();
  renderRecords();
  if (state.status !== 'running' && !savedThisRun) {
    savedThisRun = true;
    saveRecord(finalizeRecord(state));
    renderRecords();
  }
}

function renderNeighbors(): void {
  const ns = neighbors(state);
  if (ns.length === 0) {
    neighborsEl.innerHTML = '<p class="dim">没有相邻路</p>';
    return;
  }
  neighborsEl.innerHTML = ns
    .map((n) => {
      const cls = n.feasible ? 'go' : 'blocked';
      const reason = n.feasible ? `点击地图 ${n.cellId} 或按按钮移动` : n.reason;
      return `<button class="nb ${cls}" data-to="${n.cellId}" ${n.feasible ? '' : 'disabled'}>
        → ${cellName(LEVEL, n.cellId)} <small>${reason}</small></button>`;
    })
    .join('');
  neighborsEl.querySelectorAll<HTMLButtonElement>('.nb').forEach((btn) => {
    btn.addEventListener('click', () => doMove(btn.dataset.to!));
  });
}

function renderLog(): void {
  logEl.innerHTML = state.log
    .slice(-30)
    .map((l: LogEntry) => `<li class="log-${l.kind}"><b>t${l.t}</b> ${l.text}</li>`)
    .join('');
  logEl.scrollTop = logEl.scrollHeight;
}

function renderRecords(): void {
  const records = loadRecords();
  if (records.length === 0) {
    recordsEl.innerHTML = '<p class="dim">尚无完成 / 失败局，重开后这里保留对照</p>';
    return;
  }
  recordsEl.innerHTML = records
    .map((r: RunRecord) => {
      const pickups = Object.entries(r.pickupTicks).map(([id, t]) => `${id}@t${t}`).join('，') || '—';
      const delivers = Object.entries(r.deliverTicks).map(([id, t]) => `${id}@t${t}`).join('，') || '—';
      const outcome = { success: '成功', stranded: '被困', ruined: '损毁', running: '未完' }[r.outcome];
      return `<div class="rec rec-${r.outcome}">
        <b>${outcome}</b> · 总${r.totalTicks}刻 · 等待${r.waitedTicks}刻 · 打断${r.interruptCount}次
        <div class="dim">取件 ${pickups}</div>
        <div class="dim">交件 ${delivers}</div>
      </div>`;
    })
    .join('');
}

function computeHint(goal: 'deliver-all' | 'reach-home'): void {
  hint = planHint(LEVEL, {
    cell: state.cellId,
    carried: [...state.carried],
    tick: state.tick,
    wet: state.wetTicks,
    goal,
  });
  if (!hint) {
    hintEl.innerHTML = `<p class="danger">当前潮时与携带状态下，${goal === 'reach-home' ? '视野内回不了家' : '无法带齐信片回家'}——这不是静态连通问题，是时间窗已经关闭。</p>`;
    flash('提示：时间窗已关闭，无路可走', true);
    return;
  }
  hintEl.innerHTML = `<p class="dim">${hint.note}（预计 ${hint.totalTicks} 刻，目标 t=${state.tick + hint.totalTicks}）</p>
    <ol class="hint-steps">${hint.steps
      .map((s) => `<li class="hint-${s.type}">${s.text}</li>`)
      .join('')}</ol>`;
}

/** 移动后的短暂脉冲动画，引擎状态在 move() 调用时已确定性落定 */
function animateMotion(after: () => void): void {
  animating = true;
  const durationMs = 320;
  const start = performance.now();
  const step = (now: number): void => {
    render();
    if (now - start < durationMs) {
      requestAnimationFrame(step);
    } else {
      animating = false;
      after();
    }
  };
  requestAnimationFrame(step);
}

function doMove(target: string): void {
  if (animating || state.status !== 'running') return;
  const r = move(state, target);
  if (!r.ok) {
    flash(r.reason ?? '不能移动', true);
    render();
    return;
  }
  hint = null;
  if (chkHint.checked) computeHint('deliver-all');
  animateMotion(render);
  render();
}

function doWait(n: number): void {
  if (animating || state.status !== 'running') return;
  wait(state, n);
  hint = null;
  if (chkHint.checked) computeHint('deliver-all');
  render();
}

function doPickup(): void {
  const before = state.carried.length;
  pickup(state);
  if (state.carried.length === before) {
    flash('这格上没有可拾的信片', true);
    return;
  }
  hint = null;
  if (chkHint.checked) computeHint('deliver-all');
  render();
}

function doDeliver(): void {
  const ok = deliver(state, false);
  if (!ok) flash('交件需要在家礁且身上有信片', true);
  render();
}

function reset(): void {
  state = createSimulation(LEVEL);
  hint = null;
  savedThisRun = false;
  hintEl.innerHTML = '点「路线提示」按当前潮时与携带状态计算';
  render();
  flash('已重开，潮汐表与信片位置复位');
}

canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * CANVAS_W;
  const y = ((ev.clientY - rect.top) / rect.height) * CANVAS_H;
  const id = pickCell(LEVEL, x, y);
  if (id && id !== state.cellId) doMove(id);
});

document.querySelector('#btn-wait1')!.addEventListener('click', () => doWait(1));
document.querySelector('#btn-wait5')!.addEventListener('click', () => doWait(5));
document.querySelector('#btn-wait10')!.addEventListener('click', () => doWait(10));
document.querySelector('#btn-pickup')!.addEventListener('click', doPickup);
document.querySelector('#btn-deliver')!.addEventListener('click', doDeliver);
document.querySelector('#btn-hint')!.addEventListener('click', () => computeHint('deliver-all'));
document.querySelector('#btn-hint-home')!.addEventListener('click', () => computeHint('reach-home'));
document.querySelector('#btn-reset')!.addEventListener('click', reset);
document.querySelector('#btn-clear')!.addEventListener('click', () => {
  clearRecords();
  renderRecords();
});
chkHint.addEventListener('change', render);

// 键盘快捷键：1/2/3 等待，空格拾件，Enter 交件，H 提示，R 重开
window.addEventListener('keydown', (ev) => {
  if (ev.key === '1') doWait(1);
  if (ev.key === '2') doWait(5);
  if (ev.key === '3') doWait(10);
  if (ev.key === ' ') {
    ev.preventDefault();
    doPickup();
  }
  if (ev.key === 'Enter') doDeliver();
  if (ev.key.toLowerCase() === 'h') computeHint('deliver-all');
  if (ev.key.toLowerCase() === 'r') reset();
});

computeHint('deliver-all');
render();
