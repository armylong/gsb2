import {
  Body, Input, Rect, Segment, SimEvent, SimResult, World,
  cloneBody, expandPlan, firstEvents, simulate, stepBody, IDLE_INPUT,
} from './physics';
import { CANVAS_H, CANVAS_W, GROUND, SCENARIOS, Scenario } from './scenarios';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>('cv');
const ctx = cv.getContext('2d')!;
const ui = {
  scenario: $<HTMLSelectElement>('scenario'),
  scenDesc: $('scenDesc'),
  jumpVel: $<HTMLInputElement>('jumpVel'),
  gravity: $<HTMLInputElement>('gravity'),
  airAccel: $<HTMLInputElement>('airAccel'),
  maxAirSpeed: $<HTMLInputElement>('maxAirSpeed'),
  hz: $<HTMLSelectElement>('hz'),
  planRows: $('planRows'),
  addRow: $<HTMLButtonElement>('addRow'),
  predict: $<HTMLButtonElement>('predict'),
  run: $<HTMLButtonElement>('run'),
  step: $<HTMLButtonElement>('step'),
  reset: $<HTMLButtonElement>('reset'),
  status: $('status'),
  diff: $('diff'),
};

// ---------- 状态 ----------
let scenario: Scenario;
let world: World;            // 当前可编辑的世界(障碍可拖动)
let start: Body;             // 起跳初始状态
let plan: Segment[];         // 输入计划(段形式)
let prediction: { result: SimResult; sig: string; sigObj: SigObj } | null = null;
let blurred = false;         // 窗口失焦标记
let dragIdx = -1;            // 正在拖动的障碍下标(-1 无)

interface Actual {
  world: World;              // 执行开始时的快照,执行期间不受面板修改影响
  sigObj: SigObj;
  body: Body;
  inputs: Input[];
  tick: number;
  points: { x: number; y: number }[];
  events: SimEvent[];
  paused: boolean;
  done: boolean;
}
let actual: Actual | null = null;

interface SigObj {
  params: Record<string, number>;
  obstacles: Rect[];
  start: Body;
  plan: Segment[];
  hz: number;
}

// ---------- 签名 / 失效 ----------
function currentSigObj(): SigObj {
  return {
    params: { ...world.params },
    obstacles: world.obstacles.map(o => ({ ...o })),
    start: cloneBody(start),
    plan: plan.map(s => ({ ...s })),
    hz: currentHz(),
  };
}
const sigOf = (o: unknown) => JSON.stringify(o);
const currentHz = () => Number(ui.hz.value);

function isStale(): boolean {
  return !!prediction && (prediction.sig !== sigOf(currentSigObj()) || blurred);
}

/** 归因:对比预测时与执行时的签名,列出发生变化的组件。 */
function attribute(a: SigObj, b: SigObj): string[] {
  const out: string[] = [];
  const pk = Object.keys(a.params) as (keyof typeof a.params)[];
  const changedParams = pk.filter(k => a.params[k] !== b.params[k]);
  if (changedParams.length) out.push(`物理参数变化: ${changedParams.join(', ')}`);
  if (sigOf(a.obstacles) !== sigOf(b.obstacles)) out.push('障碍位置/数量变化');
  if (sigOf(a.start) !== sigOf(b.start)) out.push('起跳状态变化');
  if (sigOf(a.plan) !== sigOf(b.plan)) out.push('输入计划变化');
  if (a.hz !== b.hz) out.push(`模拟频率变化: ${a.hz}Hz → ${b.hz}Hz`);
  return out;
}

// ---------- 场景加载 ----------
function loadScenario(s: Scenario) {
  scenario = s;
  world = { params: { ...s.params, dt: 1 / currentHz() }, obstacles: [ { ...GROUND }, ...s.obstacles.map(o => ({ ...o })) ] };
  start = cloneBody(s.start);
  plan = s.plan.map(p => ({ ...p }));
  prediction = null;
  actual = null;
  blurred = false;
  ui.scenDesc.textContent = s.desc;
  ui.jumpVel.value = String(s.params.jumpVel);
  ui.gravity.value = String(s.params.gravity);
  ui.airAccel.value = String(s.params.airAccel);
  ui.maxAirSpeed.value = String(s.params.maxAirSpeed);
  syncSliderLabels();
  renderPlanRows();
  setStatus('尚未生成预测');
  ui.diff.textContent = '执行后在此显示差值与归因。';
}

function syncSliderLabels() {
  for (const el of [ui.jumpVel, ui.gravity, ui.airAccel, ui.maxAirSpeed]) {
    (el.nextElementSibling as HTMLElement).textContent = el.value;
  }
}

function readSliders() {
  world.params.jumpVel = Number(ui.jumpVel.value);
  world.params.gravity = Number(ui.gravity.value);
  world.params.airAccel = Number(ui.airAccel.value);
  world.params.maxAirSpeed = Number(ui.maxAirSpeed.value);
}

// ---------- 输入计划编辑 ----------
function renderPlanRows() {
  ui.planRows.innerHTML = '';
  plan.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'plan-row';

    const ticks = document.createElement('input');
    ticks.type = 'number'; ticks.min = '1'; ticks.max = '600'; ticks.value = String(seg.ticks);
    ticks.onchange = () => { seg.ticks = Math.max(1, Number(ticks.value) | 0); ticks.value = String(seg.ticks); };

    const move = document.createElement('select');
    for (const [label, val] of [['← 左', -1], ['· 停', 0], ['→ 右', 1]] as const) {
      const op = document.createElement('option');
      op.value = String(val); op.textContent = label;
      if (val === seg.move) op.selected = true;
      move.appendChild(op);
    }
    move.onchange = () => { seg.move = Number(move.value) as -1 | 0 | 1; };

    const jumpLabel = document.createElement('label');
    const jump = document.createElement('input');
    jump.type = 'checkbox'; jump.checked = seg.jump;
    jump.onchange = () => { seg.jump = jump.checked; };
    jumpLabel.append(jump, ' 跳');

    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = () => { plan.splice(i, 1); renderPlanRows(); };

    row.append(ticks, move, jumpLabel, del);
    ui.planRows.appendChild(row);
  });
}

// ---------- 预测 / 执行 ----------
function doPredict() {
  readSliders();
  world.params.dt = 1 / currentHz();
  const sigObj = currentSigObj();
  const inputs = expandPlan(plan);
  prediction = {
    result: simulate(world, start, inputs, currentHz() * 10),
    sig: sigOf(sigObj),
    sigObj,
  };
  blurred = false;
  const f = firstEvents(prediction.result.events);
  const bits = [`预测已生成 (${prediction.result.ticks} tick)`];
  if (f.land) bits.push(`首次触地 (${f.land.x.toFixed(0)}, ${f.land.y.toFixed(0)}) t=${f.land.t.toFixed(2)}s`);
  if (f.wall) bits.push(`撞墙 (${f.wall.x.toFixed(0)}, ${f.wall.y.toFixed(0)})`);
  if (f.ceiling) bits.push(`撞顶 (${f.ceiling.x.toFixed(0)}, ${f.ceiling.y.toFixed(0)})`);
  setStatus(bits.join('\n'));
}

function startActual(paused: boolean): Actual {
  if (!prediction) doPredict();
  readSliders();
  world.params.dt = 1 / currentHz();
  const sigObj = currentSigObj();
  actual = {
    world: { params: { ...world.params }, obstacles: world.obstacles.map(o => ({ ...o })) },
    sigObj,
    body: cloneBody(start),
    inputs: expandPlan(plan),
    tick: 0,
    points: [],
    events: [],
    paused,
    done: false,
  };
  ui.diff.textContent = paused ? '单步模式:每点一次「单步」推进一个 tick。' : '执行中…';
  return actual;
}

function stepActualOnce(a: Actual) {
  const inp = a.tick < a.inputs.length ? a.inputs[a.tick] : IDLE_INPUT;
  stepBody(a.body, inp, a.world, a.tick, a.events);
  a.tick++;
  a.points.push({ x: a.body.x + a.body.w / 2, y: a.body.y + a.body.h / 2 });
  if (a.tick >= a.inputs.length && a.body.grounded) { a.done = true; finishActual(a); }
  if (a.tick > 2400) { a.done = true; finishActual(a); }
}

function finishActual(a: Actual) {
  if (!prediction) return;
  const p = prediction.result;
  const lines: string[] = [];
  const dx = a.body.x - p.final.x, dy = a.body.y - p.final.y;
  lines.push(`终点差: dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} (tick ${p.ticks} vs ${a.tick})`);

  const pf = firstEvents(p.events), af = firstEvents(a.events);
  for (const type of ['land', 'wall', 'ceiling'] as const) {
    const pe = pf[type], ae = af[type];
    const name = { land: '首次触地', wall: '撞墙', ceiling: '撞顶' }[type];
    if (pe && ae) {
      lines.push(`${name}: 预测(${pe.x.toFixed(1)},${pe.y.toFixed(1)})@${pe.t.toFixed(2)}s 实际(${ae.x.toFixed(1)},${ae.y.toFixed(1)})@${ae.t.toFixed(2)}s  Δ=(${(ae.x - pe.x).toFixed(2)},${(ae.y - pe.y).toFixed(2)})`);
    } else if (pe || ae) {
      lines.push(`${name}: ${pe ? '仅预测发生' : '仅实际发生'}`);
    }
  }
  lines.push(`事件数: 预测 ${p.events.length} / 实际 ${a.events.length}`);

  const causes = attribute(prediction.sigObj, a.sigObj);
  if (blurred) causes.push('窗口曾失焦(预测已被标记失效)');
  if (causes.length === 0 && dx === 0 && dy === 0) {
    lines.push('归因: 状态与输入完全一致,确定性模拟逐 tick 相同,差值为 0。');
  } else {
    lines.push('归因: ' + (causes.length ? causes.join(';') : '签名一致但结果不同(不应发生,请检查物理代码)'));
  }
  ui.diff.textContent = lines.join('\n');
}

function setStatus(msg: string) {
  ui.status.textContent = msg;
  ui.status.className = '';
}

// ---------- 渲染 ----------
const EVENT_COLOR: Record<string, string> = { land: '#6fd08a', wall: '#f0a04b', ceiling: '#c792ea' };

function drawTrajectory(points: { x: number; y: number }[], color: string, dashed: boolean) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawEventMarkers(events: SimEvent[], filled: boolean) {
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.type)) continue;
    seen.add(e.type);
    const cx = e.x + start.w / 2, cy = e.y + start.h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    if (filled) { ctx.fillStyle = EVENT_COLOR[e.type]; ctx.fill(); }
    else { ctx.strokeStyle = EVENT_COLOR[e.type]; ctx.lineWidth = 2.5; ctx.stroke(); }
    ctx.fillStyle = EVENT_COLOR[e.type];
    ctx.font = '11px sans-serif';
    const label = { land: '触地', wall: '撞墙', ceiling: '撞顶' }[e.type as string];
    ctx.fillText(`${label} ${e.t.toFixed(2)}s`, cx + 10, cy - 8);
  }
}

function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // 障碍(含地面)
  for (let i = 0; i < world.obstacles.length; i++) {
    const o = world.obstacles[i];
    ctx.fillStyle = i === dragIdx ? '#6a6f80' : '#494c58';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    if (i > 0) { // 非地面可拖动
      ctx.strokeStyle = '#7a7f90';
      ctx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
    }
  }

  // 预测
  if (prediction) {
    const stale = isStale();
    drawTrajectory(prediction.result.points, stale ? '#777' : '#57c7ff', true);
    if (!stale) drawEventMarkers(prediction.result.events, false);
    if (stale) {
      ctx.fillStyle = '#e0a04b';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('预测已失效(参数/障碍/输入变化或窗口失焦),请重新生成', 16, 28);
    }
  }

  // 实际轨迹与角色
  const body = actual ? actual.body : start;
  if (actual) {
    drawTrajectory(actual.points, '#ff5f56', false);
    drawEventMarkers(actual.events, true);
  }
  // 起始位置虚框
  ctx.strokeStyle = '#8a8f9e';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(start.x + 0.5, start.y + 0.5, start.w - 1, start.h - 1);
  ctx.setLineDash([]);
  // 角色本体
  ctx.fillStyle = actual && !actual.done ? '#4da3ff' : '#2f6db3';
  ctx.fillRect(body.x, body.y, body.w, body.h);

  // 单步模式下的逐 tick 对比
  if (actual && prediction && actual.tick > 0 && actual.tick < prediction.result.points.length) {
    const pp = prediction.result.points[actual.tick];
    const ap = actual.points[actual.tick - 1];
    ctx.fillStyle = '#ddd';
    ctx.font = '12px monospace';
    ctx.fillText(`tick ${actual.tick}  逐点差: dx=${(ap.x - pp.x).toFixed(2)} dy=${(ap.y - pp.y).toFixed(2)}`, 16, CANVAS_H - 14);
  }
}

// ---------- 主循环(固定步长 + 累加器,渲染频率不影响模拟) ----------
let lastT = performance.now();
let acc = 0;
function frame(now: number) {
  const dt = world.params.dt;
  acc += Math.min((now - lastT) / 1000, 0.25);
  lastT = now;
  if (actual && !actual.paused && !actual.done) {
    let n = 0;
    while (acc >= dt && n++ < 600 && !actual.done) {
      stepActualOnce(actual);
      acc -= dt;
    }
  } else {
    acc = 0;
  }
  render();
  requestAnimationFrame(frame);
}

// ---------- 事件绑定 ----------
for (const s of SCENARIOS) {
  const op = document.createElement('option');
  op.value = s.id; op.textContent = s.name;
  ui.scenario.appendChild(op);
}
ui.scenario.onchange = () => loadScenario(SCENARIOS.find(s => s.id === ui.scenario.value)!);

for (const el of [ui.jumpVel, ui.gravity, ui.airAccel, ui.maxAirSpeed]) {
  el.oninput = () => { syncSliderLabels(); readSliders(); };
}
ui.hz.onchange = () => { world.params.dt = 1 / currentHz(); };

ui.addRow.onclick = () => { plan.push({ ticks: 20, move: 0, jump: false }); renderPlanRows(); };
ui.predict.onclick = doPredict;
ui.run.onclick = () => { startActual(false); };
ui.step.onclick = () => {
  if (!actual || actual.done) startActual(true);
  else actual.paused = true;
  if (actual && !actual.done) stepActualOnce(actual);
};
ui.reset.onclick = () => loadScenario(scenario);

window.addEventListener('blur', () => {
  if (prediction) {
    blurred = true;
    setStatus('窗口失焦:预测已失效,请重新生成');
    ui.status.className = 'stale';
  }
});

// 障碍拖动
const mousePos = (e: MouseEvent) => {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
};
cv.addEventListener('mousedown', e => {
  const m = mousePos(e);
  for (let i = world.obstacles.length - 1; i >= 1; i--) { // 0 是地面,不可拖
    const o = world.obstacles[i];
    if (m.x >= o.x && m.x <= o.x + o.w && m.y >= o.y && m.y <= o.y + o.h) { dragIdx = i; break; }
  }
});
cv.addEventListener('mousemove', e => {
  if (dragIdx < 0) return;
  const m = mousePos(e);
  const o = world.obstacles[dragIdx];
  o.x = Math.round(Math.min(Math.max(m.x - o.w / 2, 0), CANVAS_W - o.w));
  o.y = Math.round(Math.min(Math.max(m.y - o.h / 2, 0), CANVAS_H - o.h));
});
window.addEventListener('mouseup', () => { dragIdx = -1; });

// ---------- 启动 ----------
loadScenario(SCENARIOS[0]);
requestAnimationFrame(frame);
