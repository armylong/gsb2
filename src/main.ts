// 调试页控制器：场景加载、按步推进、封路交互、优先级/策略调节、事件面板
import { Simulator, type Strategy } from './simulator';
import { SCENARIOS, type ScenarioDef } from './scenarios';
import { CELL, draw } from './renderer';
import './styles.css';

const els = {
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  scenario: document.getElementById('scenario') as HTMLSelectElement,
  strategy: document.getElementById('strategy') as HTMLSelectElement,
  horizon: document.getElementById('horizon') as HTMLInputElement,
  horizonVal: document.getElementById('horizonVal') as HTMLSpanElement,
  maxWait: document.getElementById('maxWait') as HTMLInputElement,
  maxWaitVal: document.getElementById('maxWaitVal') as HTMLSpanElement,
  step: document.getElementById('stepBtn') as HTMLButtonElement,
  auto: document.getElementById('autoBtn') as HTMLButtonElement,
  reset: document.getElementById('resetBtn') as HTMLButtonElement,
  showRes: document.getElementById('showRes') as HTMLInputElement,
  tick: document.getElementById('tickVal') as HTMLSpanElement,
  carTable: document.getElementById('carTable') as HTMLDivElement,
  log: document.getElementById('log') as HTMLDivElement,
  desc: document.getElementById('scenarioDesc') as HTMLDivElement,
  hint: document.getElementById('hint') as HTMLDivElement,
};

const ctx = els.canvas.getContext('2d')!;
let sim: Simulator;
let currentScenario: ScenarioDef = SCENARIOS[0];
let autoTimer: number | null = null;

function buildSim() {
  const strategy = els.strategy.value as Strategy;
  const horizon = Number(els.horizon.value);
  const maxWait = Number(els.maxWait.value);
  sim = new Simulator(currentScenario.build(strategy, horizon, maxWait));
  for (const e of sim.events) renderLogLine(e);
  render();
}

function render() {
  els.canvas.width = sim.width * CELL;
  els.canvas.height = sim.height * CELL;
  draw(ctx, sim, els.showRes.checked);
  els.tick.textContent = String(sim.tick);
  renderCarTable();
  renderLog();
}

function renderCarTable() {
  els.carTable.innerHTML = '';
  for (const car of sim.cars) {
    const row = document.createElement('div');
    row.className = 'car-row';
    const status =
      car.status === 'done'
        ? '<span class="tag ok">已到达</span>'
        : car.status === 'failed'
          ? '<span class="tag fail">失败</span>'
          : car.waitCount > 0
            ? `<span class="tag wait">等待 ${car.waitCount}</span>`
            : '<span class="tag run">行进</span>';
    row.innerHTML = `
      <span class="dot" style="background:${car.color}"></span>
      <span class="car-name">${car.label}</span>
      ${status}
      <label class="prio">优先级
        <input type="number" min="0" max="99" value="${car.priority}" data-id="${car.id}"
          ${car.status !== 'running' ? 'disabled' : ''}/>
      </label>`;
    els.carTable.appendChild(row);
    const input = row.querySelector('input')!;
    input.addEventListener('change', () => {
      sim.setPriority(input.dataset.id!, Number(input.value));
      render();
    });
    if (car.status === 'failed' && car.failReason) {
      const reason = document.createElement('div');
      reason.className = 'fail-reason';
      reason.textContent = '失败原因：' + car.failReason;
      row.appendChild(reason);
    }
    const next = car.plan[0];
    if (next && car.status === 'running') {
      const detail = document.createElement('div');
      detail.className = 'plan-detail';
      detail.textContent =
        next.type === 'wait'
          ? `下一步：原地等待 — ${next.note ?? ''}`
          : `下一步：(${next.from.x},${next.from.y}) → (${next.to.x},${next.to.y})`;
      row.appendChild(detail);
    }
  }
}

function renderLog() {
  els.log.innerHTML = '';
  for (const e of sim.events) renderLogLine(e);
  els.log.scrollTop = els.log.scrollHeight;
}

function renderLogLine(e: { tick: number; level: string; text: string }) {
  const line = document.createElement('div');
  line.className = `log-line ${e.level}`;
  line.textContent = `[t=${e.tick}] ${e.text}`;
  els.log.appendChild(line);
}

// 点击格子封路 / 解封（再次点击）
els.canvas.addEventListener('click', (ev) => {
  const rect = els.canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * sim.width);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * sim.height);
  const cell = sim.cellAt(x, y);
  if (!cell) return;
  const ok = sim.setClosed(x, y, !cell.closed);
  if (!ok) {
    sim.log('warn', `格子 (${x},${y}) 上有车占用，不能封闭`);
  }
  render();
});

els.scenario.innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${s.name}</option>`).join(
  '',
);
els.scenario.addEventListener('change', () => {
  currentScenario = SCENARIOS.find((s) => s.id === els.scenario.value)!;
  els.desc.textContent = currentScenario.description;
  stopAuto();
  buildSim();
});

els.strategy.addEventListener('change', () => {
  sim.setStrategy(els.strategy.value as Strategy);
  render();
});
els.horizon.addEventListener('input', () => {
  els.horizonVal.textContent = els.horizon.value;
  sim.setHorizon(Number(els.horizon.value));
  render();
});
els.maxWait.addEventListener('input', () => {
  els.maxWaitVal.textContent = els.maxWait.value;
  stopAuto();
  buildSim();
});
els.showRes.addEventListener('change', render);

els.step.addEventListener('click', () => {
  sim.step();
  render();
  if (sim.finished) stopAuto();
});

function stopAuto() {
  if (autoTimer !== null) {
    clearInterval(autoTimer);
    autoTimer = null;
    els.auto.textContent = '自动推进';
  }
}

els.auto.addEventListener('click', () => {
  if (autoTimer !== null) {
    stopAuto();
    return;
  }
  els.auto.textContent = '暂停';
  autoTimer = window.setInterval(() => {
    if (sim.finished) {
      stopAuto();
      return;
    }
    sim.step();
    render();
  }, 700);
});

els.reset.addEventListener('click', () => {
  stopAuto();
  buildSim();
});

els.hint.textContent =
  '操作：单击道路格可封路/解封；勾选「未来预约」查看各车 t+1…t+H 的格子预约幽灵；' +
  '在下表直接修改优先级，下一轮规划立即生效。';
els.desc.textContent = currentScenario.description;
buildSim();
