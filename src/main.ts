import { Simulation, type Liquid, type Snapshot } from './engine.ts';
import { PRESETS, GRID_W, GRID_H } from './presets.ts';
import { render, canvasSize } from './renderer.ts';

type Tool = 'water' | 'oil' | 'wall' | 'erase' | 'port';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const size = canvasSize();
canvas.width = size.w;
canvas.height = size.h;

// ---------- 状态 ----------
let sim: Simulation = PRESETS[0].build();
let initialSnapshot: Snapshot = sim.snapshot();
let initialTotals = sim.totals();
let tool: Tool = 'water';
let dose = 0.5;
let running = true;
let stepsPerSecond = 20;
let painting = false;
let lastPointerCell = -1;

// ---------- 固定步长循环：渲染帧率与仿真步数完全解耦 ----------
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  const dt = now - last;
  last = now;
  if (running) {
    acc += dt;
    const stepMs = 1000 / stepsPerSecond;
    // 防止后台标签切回时一次性追跑过多步
    if (acc > stepMs * 100) acc = stepMs * 100;
    while (acc >= stepMs) {
      sim.advance();
      acc -= stepMs;
    }
  } else {
    acc = 0;
  }
  render(ctx, sim);
  updateStats();
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});

// ---------- 画布交互 ----------
function cellFromEvent(e: PointerEvent): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID_W);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID_H);
  if (!sim.inBounds(x, y)) return null;
  return { x, y };
}

function applyTool(x: number, y: number): void {
  const c = sim.get(x, y);
  switch (tool) {
    case 'water':
    case 'oil': {
      const kind: Liquid = tool === 'water' ? 'w' : 'o';
      sim.addLiquid(x, y, kind, dose);
      break;
    }
    case 'wall':
      sim.setWall(x, y, true);
      break;
    case 'erase':
      sim.setWall(x, y, false);
      break;
    case 'port': {
      // 点中已有口：切换开关；否则在非墙格放置新口
      const existing = sim.ports.get(sim.idx(x, y));
      if (existing) sim.setPortOpen(x, y, !existing.open);
      else if (!c.wall) sim.togglePort(x, y);
      break;
    }
  }
}

canvas.addEventListener('pointerdown', (e) => {
  const cell = cellFromEvent(e);
  if (!cell) return;
  painting = true;
  lastPointerCell = sim.idx(cell.x, cell.y);
  canvas.setPointerCapture(e.pointerId);
  applyTool(cell.x, cell.y);
});

canvas.addEventListener('pointermove', (e) => {
  const cell = cellFromEvent(e);
  const hover = document.getElementById('hover')!;
  if (!cell) {
    hover.textContent = '悬停格子查看储量';
    return;
  }
  const c = sim.get(cell.x, cell.y);
  const port = sim.ports.get(sim.idx(cell.x, cell.y));
  hover.textContent = c.wall
    ? `格子(${cell.x},${cell.y}) 挡板`
    : `格子(${cell.x},${cell.y}) 水=${c.w.toFixed(3)} 油=${c.o.toFixed(
        3,
      )} 剩余容量=${(1 - c.w - c.o).toFixed(3)}${
        port ? `｜口 ${port.open ? '开' : '关'}` : ''
      }`;
  if (!painting) return;
  const i = sim.idx(cell.x, cell.y);
  // 挡板/擦除支持拖拽；加液与口仅在按下时作用一次，避免连加
  if (i !== lastPointerCell && (tool === 'wall' || tool === 'erase')) {
    applyTool(cell.x, cell.y);
    lastPointerCell = i;
  }
});

window.addEventListener('pointerup', () => {
  painting = false;
});

// ---------- 工具按钮 ----------
document.querySelectorAll<HTMLButtonElement>('.tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    tool = btn.dataset.tool as Tool;
    document
      .querySelectorAll('.tool')
      .forEach((b) => b.classList.toggle('active', b === btn));
  });
});

document.getElementById('dose')!.addEventListener('change', (e) => {
  dose = Number((e.target as HTMLSelectElement).value);
});

// ---------- 预设 ----------
const presetBar = document.getElementById('presets')!;
const presetHint = document.getElementById('preset-hint')!;

function loadPreset(index: number): void {
  sim = PRESETS[index].build();
  initialSnapshot = sim.snapshot();
  initialTotals = sim.totals();
  presetHint.textContent = PRESETS[index].hint;
  running = true;
  syncPlayButton();
}

PRESETS.forEach((p, i) => {
  const btn = document.createElement('button');
  btn.textContent = p.name;
  btn.addEventListener('click', () => {
    presetBar
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('active', b === btn));
    loadPreset(i);
  });
  if (i === 0) btn.classList.add('active');
  presetBar.appendChild(btn);
});
presetHint.textContent = PRESETS[0].hint;

document.getElementById('remove-divider')!.addEventListener('click', () => {
  // 只移内部隔板（外墙保留），用于 U 形管中途移开隔板实验
  for (let y = 1; y < GRID_H - 1; y++) {
    for (let x = 1; x < GRID_W - 1; x++) {
      if (sim.get(x, y).wall) sim.setWall(x, y, false);
    }
  }
});

document.getElementById('reset')!.addEventListener('click', () => {
  sim.restore(initialSnapshot);
  initialTotals = sim.totals();
});

// ---------- 播放控制 ----------
const playBtn = document.getElementById('play')!;
function syncPlayButton(): void {
  playBtn.textContent = running ? '暂停' : '继续';
}
playBtn.addEventListener('click', () => {
  running = !running;
  syncPlayButton();
});

document.getElementById('step')!.addEventListener('click', () => {
  running = false;
  syncPlayButton();
  sim.advance();
});

const rate = document.getElementById('rate') as HTMLInputElement;
const rateVal = document.getElementById('rate-val')!;
rate.addEventListener('input', () => {
  stepsPerSecond = Number(rate.value);
  rateVal.textContent = rate.value;
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)
    return;
  if (e.code === 'Space') {
    e.preventDefault();
    running = !running;
    syncPlayButton();
  } else if (e.code === 'ArrowRight') {
    running = false;
    syncPlayButton();
    sim.advance();
  }
});

// ---------- 统计面板 ----------
const fmt = (v: number): string => v.toFixed(3);

function updateStats(): void {
  const t = sim.totals();
  document.getElementById('stat-step')!.textContent = String(sim.step);
  document.getElementById('stat-water')!.textContent = fmt(t.w);
  document.getElementById('stat-oil')!.textContent = fmt(t.o);
  document.getElementById('stat-cap')!.textContent =
    `${fmt(t.w + t.o)} / ${t.capacity}`;
  document.getElementById('stat-dir')!.textContent =
    sim.step % 2 === 0 ? '顺时针（偶数步）' : '逆时针（奇数步）';

  // 守恒：初始总量 + 口净注入 - 当前总量 应恒为 0
  const net = sim.netPortFlow();
  const dw = initialTotals.w + net.w - t.w;
  const dwo = initialTotals.o + net.o - t.o;
  const consW = document.getElementById('cons-w')!;
  const consO = document.getElementById('cons-o')!;
  consW.textContent = `偏差 ${dw.toExponential(2)}`;
  consW.className = Math.abs(dw) < 1e-9 ? 'ok' : 'bad';
  consO.textContent = `偏差 ${dwo.toExponential(2)}`;
  consO.className = Math.abs(dwo) < 1e-9 ? 'ok' : 'bad';

  // 口账本
  const tbody = document.querySelector('#port-table tbody')!;
  const rows = [...sim.ports.values()];
  document.getElementById('no-port')!.style.display = rows.length ? 'none' : 'block';
  tbody.innerHTML = rows
    .map(
      (p) => `<tr>
        <td>${p.id} (${p.x},${p.y})</td>
        <td class="${p.open ? 'port-open' : 'port-closed'}">${
        p.open ? '开' : '关'
      }</td>
        <td>${fmt(p.wIn)}</td><td>${fmt(p.wOut)}</td>
        <td>${fmt(p.oIn)}</td><td>${fmt(p.oOut)}</td>
      </tr>`,
    )
    .join('');
}

updateStats();
