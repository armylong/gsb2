/**
 * 页面主控制器: 绑定 DOM 交互、Canvas 指针事件、渲染循环与验证入口。
 */
import { Simulation, STATUS_TEXT, SimStatus } from './core/simulation';
import { LAYOUTS } from './core/layouts';
import { Vec2, pointInRect, Rect } from './core/geometry';
import { Renderer } from './ui/renderer';
import { VALIDATORS, ValidationReport } from './ui/validation';

type ClickMode = 'start' | 'goal' | 'none';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas);

let sim = new Simulation(LAYOUTS[0]);
let clickMode: ClickMode = 'none';
let dragIndex: number | null = null;
let dragOffset: Vec2 = { x: 0, y: 0 };
let lastFrame = performance.now();

const renderOptions = {
  showCells: true,
  showPortals: true,
  showInflat: false,
};

// ---------------- 布局按钮 ----------------

const layoutButtons = document.getElementById('layoutButtons')!;
const layoutDesc = document.getElementById('layoutDesc')!;
for (const layout of LAYOUTS) {
  const btn = document.createElement('button');
  btn.textContent = layout.name;
  btn.dataset.layout = layout.id;
  btn.addEventListener('click', () => switchLayout(layout.id));
  layoutButtons.appendChild(btn);
}

function switchLayout(layoutId: string): void {
  const layout = LAYOUTS.find((l) => l.id === layoutId)!;
  sim = new Simulation(layout);
  dragIndex = null;
  layoutButtons.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === layoutId);
  });
  layoutDesc.textContent = layout.description;
  syncDoorButtons();
  syncRadiusControl();
}

// ---------------- 点击模式 ----------------

document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    clickMode = btn.dataset.mode as ClickMode;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    canvas.style.cursor = clickMode === 'none' ? 'default' : 'crosshair';
  });
});

// ---------------- 播放控制 ----------------

document.getElementById('btnPlay')!.addEventListener('click', () => sim.play());
document.getElementById('btnPause')!.addEventListener('click', () => sim.pause());
document.getElementById('btnReset')!.addEventListener('click', () => {
  sim.resetLayout();
  syncRadiusControl();
  syncDoorButtons();
});

// ---------------- 挡门按钮 ----------------

const doorButtons = document.getElementById('doorButtons')!;
function syncDoorButtons(): void {
  doorButtons.innerHTML = '';
  for (const d of sim.doorList) {
    const btn = document.createElement('button');
    const open = sim.isDoorOpen(d.doorId);
    btn.textContent = `${d.label}: ${open ? '开' : '关'}`;
    btn.classList.add(open ? 'door-open' : 'door-closed');
    btn.addEventListener('click', () => {
      sim.toggleDoor(d.doorId);
      syncDoorButtons();
    });
    doorButtons.appendChild(btn);
  }
}

// ---------------- 半径与显示开关 ----------------

const radiusRange = document.getElementById('radiusRange') as HTMLInputElement;
const radiusValue = document.getElementById('radiusValue')!;
radiusRange.addEventListener('input', () => {
  sim.setRadius(Number(radiusRange.value));
  syncRadiusControl();
});
function syncRadiusControl(): void {
  radiusRange.value = String(sim.radius);
  radiusValue.textContent = sim.radius.toFixed(2);
}

(document.getElementById('chkCells') as HTMLInputElement).addEventListener('change', (e) => {
  renderOptions.showCells = (e.target as HTMLInputElement).checked;
});
(document.getElementById('chkPortals') as HTMLInputElement).addEventListener('change', (e) => {
  renderOptions.showPortals = (e.target as HTMLInputElement).checked;
});
(document.getElementById('chkInflat') as HTMLInputElement).addEventListener('change', (e) => {
  renderOptions.showInflat = (e.target as HTMLInputElement).checked;
});

// ---------------- Canvas 指针交互 ----------------

function eventToScene(e: PointerEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();
  return renderer.toScene(e.clientX - rect.left, e.clientY - rect.top);
}

function hitObstacle(p: Vec2): number {
  const pad = 0.35;
  for (let i = sim.obstacleList.length - 1; i >= 0; i--) {
    const o = sim.obstacleList[i];
    if (!o.movable) continue;
    const hit: Rect = { x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 };
    if (pointInRect(p, hit)) return i;
  }
  return -1;
}

canvas.addEventListener('pointerdown', (e) => {
  const p = eventToScene(e);
  const idx = hitObstacle(p);
  if (idx >= 0 && clickMode === 'none') {
    // 只允许暂停时拖动
    if (sim.playing) {
      flashHint('请先暂停再拖动障碍');
      return;
    }
    const o = sim.obstacleList[idx];
    dragIndex = idx;
    dragOffset = { x: p.x - o.x, y: p.y - o.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (clickMode === 'start') sim.setStart(p);
  else if (clickMode === 'goal') sim.setGoal(p);
});

canvas.addEventListener('pointermove', (e) => {
  if (dragIndex === null) return;
  const p = eventToScene(e);
  const o = sim.obstacleList[dragIndex];
  const next: Rect = {
    x: p.x - dragOffset.x,
    y: p.y - dragOffset.y,
    w: o.w,
    h: o.h,
  };
  sim.moveObstacle(dragIndex, next);
});

function endDrag(e: PointerEvent): void {
  if (dragIndex !== null) {
    dragIndex = null;
    canvas.style.cursor = clickMode === 'none' ? 'default' : 'crosshair';
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

const hintEl = document.getElementById('canvasHint')!;
let hintTimer: number | undefined;
function flashHint(text: string): void {
  hintEl.textContent = text;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hintEl.textContent = '点击模式下在房间内点击放置点; 暂停后可拖动灰色障碍';
  }, 2200);
}

// ---------------- 验证入口 ----------------

const validationButtons = document.getElementById('validationButtons')!;
const validationLog = document.getElementById('validationLog')!;
for (const validator of VALIDATORS) {
  const btn = document.createElement('button');
  btn.textContent = `${validator.id} ${validator.title}`;
  btn.addEventListener('click', () => renderReport(validator.run()));
  validationButtons.appendChild(btn);
}

function renderReport(report: ValidationReport): void {
  const wrap = document.createElement('div');
  wrap.className = `report ${report.passed ? 'pass' : 'fail'}`;
  const passedCount = report.checks.filter((c) => c.pass).length;
  const header = document.createElement('div');
  header.className = 'report-header';
  const title = document.createElement('span');
  title.textContent = `${report.id} · ${report.title}`;
  const summary = document.createElement('span');
  summary.textContent = report.passed ? '全部通过' : `${passedCount}/${report.checks.length} 通过`;
  header.append(title, summary);
  wrap.appendChild(header);

  for (const c of report.checks) {
    const row = document.createElement('div');
    row.className = `check ${c.pass ? 'pass' : 'fail'}`;
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.textContent = c.pass ? '✓' : '✗';
    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.name;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = c.detail;
    body.append(name, detail);
    row.append(mark, body);
    wrap.appendChild(row);
  }
  validationLog.prepend(wrap);
}

// ---------------- 状态栏 ----------------

const statusPill = document.getElementById('statusPill')!;
const statPos = document.getElementById('statPos')!;
const statRemain = document.getElementById('statRemain')!;
const statRepath = document.getElementById('statRepath')!;
const statVerify = document.getElementById('statVerify')!;
const statusDetail = document.getElementById('statusDetail')!;

const STATUS_CLASS: Record<SimStatus, string> = {
  idle: 'idle',
  ready: 'ready',
  moving: 'moving',
  arrived: 'arrived',
  'no-path': 'no-path',
  'start-invalid': 'start-invalid',
  'goal-invalid': 'goal-invalid',
  trapped: 'trapped',
};

function syncStats(): void {
  statusPill.textContent = STATUS_TEXT[sim.status];
  statusPill.className = `status-pill ${STATUS_CLASS[sim.status]}`;
  statPos.textContent = `(${sim.position.x.toFixed(2)}, ${sim.position.y.toFixed(2)})`;
  statRemain.textContent = sim.route.length >= 2 ? `${sim.remainingDistance.toFixed(2)} 单位` : '—';
  statRepath.textContent = String(sim.repathCount);
  const verify = sim.verifyRoute();
  if (sim.route.length < 2) {
    statVerify.textContent = sim.status === 'arrived' ? '已到达, 无活动路线' : '无活动路线';
  } else if (verify.ok) {
    statVerify.textContent = `通过(最小间隙 ${verify.clearance.toFixed(2)})`;
  } else {
    statVerify.textContent = `违例: ${verify.reason ?? ''}`;
  }
  statusDetail.textContent = sim.statusDetail;
}

// ---------------- 主循环 ----------------

function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  sim.step(dt);
  renderer.resize();
  renderer.render(sim, renderOptions, dragIndex);
  syncStats();
  requestAnimationFrame(frame);
}

// 初始化
switchLayout(LAYOUTS[0].id);
requestAnimationFrame((t) => {
  lastFrame = t;
  requestAnimationFrame(frame);
});
