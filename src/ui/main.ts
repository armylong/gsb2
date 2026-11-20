import { Harness } from '../core/harness';
import { NetConfig, TICK_MS } from '../core/protocol';
import { getScenario } from '../core/scenarios';
import { runAll, TestResult } from '../tests/run';
import { Renderer } from './renderer';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const netConfig = (): NetConfig => ({
  up: {
    delayMs: num('up-delay'),
    jitterMs: num('up-jitter'),
    lossPct: num('up-loss'),
  },
  down: {
    delayMs: num('down-delay'),
    jitterMs: num('down-jitter'),
    lossPct: num('down-loss'),
  },
});

function num(id: string): number {
  return Number($<HTMLInputElement>(id).value) || 0;
}

const harness = new Harness({
  seed: num('seed'),
  net: netConfig(),
  smoothing: $<HTMLInputElement>('smooth').checked,
  tauMs: num('tau'),
  showTrail: $<HTMLInputElement>('show-trail').checked,
  pushZone: $<HTMLInputElement>('push-zone').checked,
});
const renderer = new Renderer($<HTMLCanvasElement>('canvas'));

let paused = false;
let accumulator = 0;
let lastFrame = performance.now();
let lastUiRefresh = 0;

// ---------------- 主循环：固定步长，暂停即不推进，单步只推一个 tick ----------------
function frame(now: number): void {
  const elapsed = Math.min(100, now - lastFrame);
  lastFrame = now;
  if (!paused) {
    accumulator += elapsed;
    while (accumulator >= TICK_MS) {
      harness.advanceTick();
      accumulator -= TICK_MS;
    }
  } else {
    accumulator = 0;
  }
  renderer.draw(harness);
  if (now - lastUiRefresh > 100) {
    refreshPanels();
    lastUiRefresh = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => {
  lastFrame = t;
  requestAnimationFrame(frame);
});

// ---------------- 键盘 ----------------
const keyMap: Record<string, number> = {
  ArrowUp: 1, KeyW: 1,
  ArrowDown: 2, KeyS: 2,
  ArrowLeft: 4, KeyA: 4,
  ArrowRight: 8, KeyD: 8,
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    togglePause();
    return;
  }
  const bit = keyMap[e.code];
  if (bit !== undefined) {
    e.preventDefault();
    harness.manualKeys |= bit;
  }
});
window.addEventListener('keyup', (e) => {
  const bit = keyMap[e.code];
  if (bit !== undefined) {
    e.preventDefault();
    harness.manualKeys &= ~bit;
  }
});

// ---------------- 按钮 ----------------
function togglePause(): void {
  paused = !paused;
  $<HTMLButtonElement>('btn-pause').textContent = paused ? '继续' : '暂停';
}

$<HTMLButtonElement>('btn-pause').addEventListener('click', togglePause);
$<HTMLButtonElement>('btn-step').addEventListener('click', () => {
  paused = true;
  $<HTMLButtonElement>('btn-pause').textContent = '继续';
  harness.advanceTick();
  renderer.draw(harness);
  refreshPanels();
});
$<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
  const scenarioId = $<HTMLSelectElement>('scenario').value;
  harness.loadScenario(scenarioId === 'manual' ? null : getScenario(scenarioId) ?? null);
  accumulator = 0;
  renderer.draw(harness);
  refreshPanels();
});

$<HTMLButtonElement>('btn-test').addEventListener('click', () => {
  const results: TestResult[] = runAll();
  const panel = $('test-panel');
  panel.classList.remove('hidden');
  panel.innerHTML =
    `<h3>验证结果（真实引擎实时执行，非预设数据）</h3>` +
    results
      .map(
        (r) =>
          `<div class="test-row ${r.pass ? 'pass' : 'fail'}">
             <span class="chip">${r.pass ? 'PASS' : 'FAIL'}</span>
             <div><b>${r.name}</b><div class="detail">${r.detail}</div></div>
           </div>`,
      )
      .join('');
});

// ---------------- 参数绑定（改动只影响新消息） ----------------
for (const id of ['up-delay', 'up-jitter', 'up-loss', 'down-delay', 'down-jitter', 'down-loss']) {
  $<HTMLInputElement>(id).addEventListener('change', () => harness.updateNetConfig(netConfig()));
}
$<HTMLInputElement>('seed').addEventListener('change', () => harness.updateSeed(num('seed')));
$<HTMLInputElement>('show-trail').addEventListener('change', (e) =>
  harness.updateDisplay(
    $<HTMLInputElement>('smooth').checked,
    num('tau'),
    (e.target as HTMLInputElement).checked,
  ),
);
$<HTMLInputElement>('smooth').addEventListener('change', () =>
  harness.updateDisplay(
    $<HTMLInputElement>('smooth').checked,
    num('tau'),
    $<HTMLInputElement>('show-trail').checked,
  ),
);
$<HTMLInputElement>('tau').addEventListener('change', () =>
  harness.updateDisplay(
    $<HTMLInputElement>('smooth').checked,
    num('tau'),
    $<HTMLInputElement>('show-trail').checked,
  ),
);
$<HTMLInputElement>('push-zone').addEventListener('change', (e) =>
  harness.setPushZone((e.target as HTMLInputElement).checked),
);

$<HTMLSelectElement>('scenario').addEventListener('change', (e) => {
  const id = (e.target as HTMLSelectElement).value;
  const scenario = id === 'manual' ? null : getScenario(id) ?? null;
  if (scenario) {
    for (const inp of ['up-delay', 'up-jitter', 'up-loss', 'down-delay', 'down-jitter', 'down-loss']) {
      const link = scenario.initialNet[inp.startsWith('up') ? 'up' : 'down'];
      const key = inp.includes('loss') ? 'lossPct' : inp.includes('jitter') ? 'jitterMs' : 'delayMs';
      $<HTMLInputElement>(inp).value = String(link[key]);
    }
  }
  harness.loadScenario(scenario);
  accumulator = 0;
  refreshPanels();
});

// ---------------- 面板刷新 ----------------
function refreshPanels(): void {
  const s = harness.stats();
  $('hud').innerHTML =
    `epoch=<b>${harness.epoch}</b> · 时间=${(s.timeMs / 1000).toFixed(2)}s · tick=${s.tick}` +
    (harness.scenario ? ` · 场景「${harness.scenario.name}」${s.traceFinished ? '（录像已播完）' : ''}` : ' · 手动输入') +
    (paused ? ' · <b>已暂停</b>' : '');

  const convState = s.quiet
    ? s.converged
      ? '<span class="ok">已收敛</span>'
      : '<span class="warn">链路安静但未收敛</span>'
    : '<span>消息未收齐</span>';

  $('stats').innerHTML = `
    <table>
      <tr><td>逻辑误差（预测↔权威）</td><td>${s.logicalError.toFixed(2)} px</td></tr>
      <tr><td>视觉误差（渲染↔权威）</td><td>${s.visualError.toFixed(2)} px</td></tr>
      <tr><td>峰值逻辑误差</td><td>${s.maxLogicalError.toFixed(2)} px</td></tr>
      <tr><td>已确认输入</td><td>#${s.ackedSeq}（未确认 ${s.unackedCount} 个）</td></tr>
      <tr><td>权威端 tick / 已应用</td><td>${s.serverTick} / ${s.serverApplied}</td></tr>
      <tr><td>在途：上行 / 下行</td><td>${s.inFlightUp} / ${s.inFlightDown} 包</td></tr>
      <tr><td>权威端乱序缓存</td><td>${s.serverBuffered} 个</td></tr>
      <tr><td>重传 / 纠正 / 拒绝快照</td><td>${harness.client.counters.retransmits} / ${harness.client.counters.corrections} / ${harness.client.counters.rejectedSnapshots}</td></tr>
      <tr><td>收敛状态（停输入后）</td><td>${convState}</td></tr>
    </table>`;

  // 待发送（等重传计时器的未确认输入）+ 在途消息，展示各自的预定到达时间
  const retryRows = harness.client.unacked
    .map((e) => {
      const remain = Math.max(0, e.nextRetryAtMs - harness.nowMs);
      return `<tr class="retry"><td>输入 #${e.input.seq}</td><td>等待重传</td><td>${remain.toFixed(0)}ms 后重试（已发 ${e.attempt} 次）</td></tr>`;
    })
    .join('');
  const flightRows = harness.net.inFlight
    .map((p) => {
      const remain = Math.max(0, p.arriveAtMs - harness.nowMs);
      const label = p.payload.kind === 'input'
        ? `输入 #${p.payload.input.seq}${p.attempt > 1 ? `（重传x${p.attempt}）` : ''}`
        : `快照 tick=${p.payload.serverTick}`;
      return `<tr class="${p.channel}"><td>${label}</td><td>${p.channel === 'up' ? '上行' : '下行'}</td><td>${remain.toFixed(0)}ms 后到达</td></tr>`;
    })
    .join('');
  $('queues').innerHTML = `
    <div class="sub">待发送/待重传（可靠输入队列）</div>
    <table class="msg-table">${retryRows || '<tr><td class="muted">空</td><td></td><td></td></tr>'}</table>
    <div class="sub">在途消息（到达时间入链时已定，改参数不追溯）</div>
    <table class="msg-table">${flightRows || '<tr><td class="muted">空</td><td></td><td></td></tr>'}</table>
    <div class="sub">最近入链记录（含丢包）</div>
    <table class="msg-table">${harness.net.history
      .slice(0, 12)
      .map((h) => `<tr class="${h.lost ? 'lost' : ''}"><td>${h.label}</td><td>${h.channel === 'up' ? '上行' : '下行'}</td><td>${h.lost ? '已丢失（等重传）' : `${Math.max(0, h.arriveAtMs - harness.nowMs).toFixed(0)}ms 后到达`}</td></tr>`)
      .join('')}</table>`;

  $('events').innerHTML = harness.events
    .map((e) => `<div class="event ${e.level}"><span class="t">${(e.timeMs / 1000).toFixed(2)}s</span>${e.text}</div>`)
    .join('') || '<div class="muted">暂无事件</div>';
}

refreshPanels();
renderer.draw(harness);
