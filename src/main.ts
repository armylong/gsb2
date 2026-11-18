import { Vec2, Circle, Polygon } from 'planck';
import { Sim, SCALE, MAX_BODIES, advanceWithSpeed } from './sim';
import { loadScene, SCENE_LABELS, type SceneName } from './scenes';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const W = canvas.width;
const H = canvas.height;

const sim = new Sim();
let currentScene: SceneName = 'stack';
loadScene(sim, currentScene);

// ---- 模拟控制状态 ----
let running = true;
let speed = 1;
const accumulator = { acc: 0 };
let selectedId: number | null = null;

// ---- 接触显示开关 ----
const show = { points: true, normals: true, depth: true, onlySelected: false };

// ---- 鼠标交互状态 ----
type DragMode = 'none' | 'move' | 'impulse';
let dragMode: DragMode = 'none';
let dragId: number | null = null;
let dragStart = { x: 0, y: 0 };
let dragCur = { x: 0, y: 0 };
let dragInvalid = false;

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLDivElement>('status');
const selInfoEl = $<HTMLDivElement>('selInfo');
const btnPause = $<HTMLButtonElement>('btnPause');
const btnStep = $<HTMLButtonElement>('btnStep');
const speedSel = $<HTMLSelectElement>('speed');
const pMass = $<HTMLInputElement>('pMass');
const pFriction = $<HTMLInputElement>('pFriction');
const pRest = $<HTMLInputElement>('pRest');

// 场景按钮
const sceneButtons = $<HTMLDivElement>('sceneButtons');
for (const name of Object.keys(SCENE_LABELS) as SceneName[]) {
  const b = document.createElement('button');
  b.textContent = SCENE_LABELS[name];
  b.dataset.scene = name;
  if (name === currentScene) b.classList.add('active');
  b.onclick = () => {
    currentScene = name;
    resetScene();
    sceneButtons.querySelectorAll('button').forEach((el) => {
      el.classList.toggle('active', el.dataset.scene === name);
    });
  };
  sceneButtons.appendChild(b);
}

function resetScene(): void {
  loadScene(sim, currentScene);
  selectedId = null;
  dragMode = 'none';
  accumulator.acc = 0;
  refreshParamInputs();
}

$('btnReset').onclick = resetScene;

btnPause.onclick = () => {
  running = !running;
  btnPause.textContent = running ? '暂停' : '继续';
  btnStep.disabled = running;
};

btnStep.onclick = () => {
  if (!running) sim.stepOnce();
};

speedSel.onchange = () => {
  speed = parseFloat(speedSel.value);
};

// 添加刚体(从场景上方落下)
function spawnPos(): { x: number; y: number } {
  return { x: 6 + Math.random() * 8, y: 9.5 };
}
function tryAdd(add: (x: number, y: number) => number | null): void {
  const p = spawnPos();
  const id = add(p.x, p.y);
  if (id === null) flashStatus(`已达数量上限 ${MAX_BODIES}`);
  else selectedId = id;
  refreshParamInputs();
}
$('addCircle').onclick = () => tryAdd((x, y) => sim.addCircle(x, y));
$('addRect').onclick = () => tryAdd((x, y) => sim.addRect(x, y));
$('addPoly').onclick = () => tryAdd((x, y) => sim.addPoly(x, y));

$('btnApply').onclick = () => {
  if (selectedId === null) return;
  sim.setParams(selectedId, {
    mass: parseFloat(pMass.value),
    friction: parseFloat(pFriction.value),
    restitution: parseFloat(pRest.value),
  });
  refreshParamInputs();
};

$('btnDelete').onclick = () => {
  if (selectedId === null) return;
  sim.removeBody(selectedId);
  selectedId = null; // 删除后清空选择,接触标记随世界更新自动消失
  refreshParamInputs();
};

for (const [id, key] of [
  ['cPoints', 'points'],
  ['cNormals', 'normals'],
  ['cDepth', 'depth'],
  ['cOnlySel', 'onlySelected'],
] as const) {
  $(id as string).onclick = (e) => {
    show[key] = (e.target as HTMLInputElement).checked;
  };
}

let statusFlash = '';
let statusFlashUntil = 0;
function flashStatus(msg: string): void {
  statusFlash = msg;
  statusFlashUntil = performance.now() + 2000;
}

function refreshParamInputs(): void {
  const p = selectedId !== null ? sim.getParams(selectedId) : null;
  pMass.value = p ? p.mass.toFixed(2) : '';
  pFriction.value = p ? p.friction.toFixed(2) : '';
  pRest.value = p ? p.restitution.toFixed(2) : '';
}

// ---------- 鼠标 ----------
function toWorld(e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / SCALE, y: (H - (e.clientY - r.top)) / SCALE };
}

function hitBody(wx: number, wy: number): number | null {
  const p = new Vec2(wx, wy);
  // 后添加的优先(视觉上更靠上)
  const ids = sim.listIds().reverse();
  for (const id of ids) {
    const body = sim.getBody(id)!;
    for (let f = body.getFixtureList(); f; f = f.getNext()) {
      if (f.testPoint(p)) return id;
    }
  }
  return null;
}

canvas.addEventListener('mousedown', (e) => {
  const p = toWorld(e);
  const id = hitBody(p.x, p.y);
  selectedId = id;
  refreshParamInputs();
  if (id === null) return;
  dragId = id;
  dragStart = p;
  dragCur = p;
  dragInvalid = false;
  dragMode = running ? 'impulse' : 'move';
});

canvas.addEventListener('mousemove', (e) => {
  if (dragMode === 'none' || dragId === null) return;
  const p = toWorld(e);
  dragCur = p;
  if (dragMode === 'move') {
    // 暂停中拖动放置:实时检查重叠,重叠则标红,松开时拒绝
    dragInvalid = sim.wouldOverlap(dragId, p.x, p.y);
    if (!dragInvalid) sim.tryMoveBody(dragId, p.x, p.y);
  }
});

window.addEventListener('mouseup', () => {
  if (dragMode === 'impulse' && dragId !== null) {
    const dx = dragCur.x - dragStart.x;
    const dy = dragCur.y - dragStart.y;
    const len = Math.hypot(dx, dy);
    if (len > 0.05) {
      const body = sim.getBody(dragId);
      if (body) {
        const m = body.getMass();
        // 冲量与拖动向量及质量成正比,上限截断避免极端速度
        const k = Math.min(len, 3) * 2 * m;
        sim.applyImpulse(dragId, (dx / len) * k, (dy / len) * k);
      }
    }
  }
  dragMode = 'none';
  dragId = null;
  dragInvalid = false;
});

// ---------- 渲染 ----------
const COLORS: Record<string, string> = { circle: '#e0a458', rect: '#6fa8dc', poly: '#8ec98e' };

function drawBody(id: number): void {
  const body = sim.getBody(id);
  if (!body) return;
  const kind = sim.getKind(id)!;
  const isSel = id === selectedId;
  const invalid = dragInvalid && dragId === id;
  ctx.strokeStyle = invalid ? '#ff5252' : isSel ? '#ffe14d' : COLORS[kind];
  ctx.fillStyle = invalid ? 'rgba(255,82,82,0.25)' : isSel ? 'rgba(255,225,77,0.18)' : 'rgba(255,255,255,0.07)';
  ctx.lineWidth = isSel ? 2.5 / SCALE : 1.5 / SCALE;

  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === 'circle') {
      const c = shape as Circle;
      const center = body.getWorldPoint(c.m_p);
      ctx.beginPath();
      ctx.arc(center.x, center.y, c.m_radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 角度参考线
      const a = body.getAngle();
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(center.x + c.m_radius * Math.cos(a), center.y + c.m_radius * Math.sin(a));
      ctx.stroke();
    } else if (type === 'polygon') {
      const poly = shape as Polygon;
      ctx.beginPath();
      poly.m_vertices.forEach((v, i) => {
        const w = body.getWorldPoint(v);
        if (i === 0) ctx.moveTo(w.x, w.y);
        else ctx.lineTo(w.x, w.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

function drawStatics(): void {
  ctx.strokeStyle = '#5a6373';
  ctx.fillStyle = 'rgba(120,130,150,0.25)';
  ctx.lineWidth = 1.5 / SCALE;
  for (let b = sim.world.getBodyList(); b; b = b.getNext()) {
    if (b.isDynamic()) continue;
    for (let f = b.getFixtureList(); f; f = f.getNext()) {
      const shape = f.getShape();
      if (shape.getType() !== 'polygon') continue;
      const poly = shape as Polygon;
      ctx.beginPath();
      poly.m_vertices.forEach((v, i) => {
        const w = b.getWorldPoint(v);
        if (i === 0) ctx.moveTo(w.x, w.y);
        else ctx.lineTo(w.x, w.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

function drawContacts(): void {
  const contacts = sim.getContacts();
  const texts: { x: number; y: number; s: string }[] = [];
  for (const c of contacts) {
    if (show.onlySelected && selectedId !== null && c.idA !== selectedId && c.idB !== selectedId) continue;
    for (const p of c.points) {
      if (show.points) {
        ctx.fillStyle = '#ff4d4d';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 / SCALE, 0, Math.PI * 2);
        ctx.fill();
      }
      if (show.normals) {
        ctx.strokeStyle = '#4dff88';
        ctx.lineWidth = 1.5 / SCALE;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + c.normalX * 0.6, p.y + c.normalY * 0.6);
        ctx.stroke();
      }
      if (show.depth && p.depth > 1e-6) {
        ctx.strokeStyle = '#ff4dff';
        ctx.lineWidth = 2.5 / SCALE;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - c.normalX * p.depth, p.y - c.normalY * p.depth);
        ctx.stroke();
        texts.push({ x: p.x, y: p.y, s: `${(p.depth * 1000).toFixed(1)}mm` });
      }
    }
  }
  // 深度数值用屏幕坐标绘制,避免文字翻转
  if (texts.length) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ff9dff';
    ctx.font = '11px ui-monospace, monospace';
    for (const t of texts) {
      ctx.fillText(t.s, t.x * SCALE + 6, H - t.y * SCALE - 6);
    }
    ctx.setTransform(SCALE, 0, 0, -SCALE, 0, H);
  }
}

function drawVelocity(id: number): void {
  const body = sim.getBody(id);
  if (!body) return;
  const p = body.getPosition();
  const v = body.getLinearVelocity();
  const len = Math.hypot(v.x, v.y);
  if (len < 0.05) return;
  ctx.strokeStyle = '#57c7ff';
  ctx.lineWidth = 2 / SCALE;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + v.x * 0.25, p.y + v.y * 0.25);
  ctx.stroke();
}

function drawImpulseArrow(): void {
  if (dragMode !== 'impulse' || dragId === null) return;
  const body = sim.getBody(dragId);
  if (!body) return;
  const c = body.getWorldCenter();
  ctx.strokeStyle = '#ffb84d';
  ctx.lineWidth = 3 / SCALE;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + (dragCur.x - dragStart.x), c.y + (dragCur.y - dragStart.y));
  ctx.stroke();
}

function render(): void {
  ctx.setTransform(SCALE, 0, 0, -SCALE, 0, H);
  ctx.clearRect(0, 0, W / SCALE, H / SCALE);
  // 网格(每 1 米)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1 / SCALE;
  for (let x = 0; x <= W / SCALE; x++) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H / SCALE); ctx.stroke();
  }
  for (let y = 0; y <= H / SCALE; y++) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W / SCALE, y); ctx.stroke();
  }
  drawStatics();
  for (const id of sim.listIds()) drawBody(id);
  drawContacts();
  if (selectedId !== null) drawVelocity(selectedId);
  drawImpulseArrow();
}

// ---------- 面板读数 ----------
function updatePanel(): void {
  const flash = performance.now() < statusFlashUntil ? `\n${statusFlash}` : '';
  statusEl.textContent =
    `状态: ${running ? '运行中' : '已暂停'}  速度: ${speed}×\n` +
    `模拟时间: ${sim.time.toFixed(3)} s  步数: ${sim.steps}\n` +
    `刚体数量: ${sim.dynamicCount} / ${MAX_BODIES}` + flash;

  if (selectedId === null || !sim.getBody(selectedId)) {
    if (selectedId !== null) selectedId = null;
    selInfoEl.textContent = '未选中';
    return;
  }
  const r = sim.getReadings(selectedId)!;
  selInfoEl.textContent =
    `#${r.id} ${r.kind}\n` +
    `位置: (${r.x.toFixed(3)}, ${r.y.toFixed(3)}) m\n` +
    `角度: ${r.angleDeg.toFixed(1)}°\n` +
    `速度: (${r.vx.toFixed(3)}, ${r.vy.toFixed(3)}) m/s\n` +
    `角速度: ${r.omega.toFixed(3)} rad/s`;
}

// ---------- 主循环 ----------
let last = performance.now();
function frame(now: number): void {
  const realDt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (running) advanceWithSpeed(sim, realDt, speed, accumulator);
  render();
  updatePanel();
  requestAnimationFrame(frame);
}
refreshParamInputs();
requestAnimationFrame(frame);
