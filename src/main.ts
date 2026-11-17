import './ui/style.css';
import { AppStore, Derived } from './ui/store';
import type { AppState } from './ui/store';
import { StrokeView2D, ViewDisplay } from './ui/view2d';
import { buildPanel } from './ui/panel';
import { Vec2 } from './core/math2d';

const store = new AppStore();
const display: ViewDisplay = { showFill: true, showWire: true, showCenter: true, showVertices: true };

const viewsHost = document.querySelector('#views') as HTMLElement;

function makeViewWrap(label: string): { wrap: HTMLElement; host: HTMLElement; overlay: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.className = 'view-wrap';
  const overlay = document.createElement('div');
  overlay.className = 'view-overlay';
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  const hint = document.createElement('div');
  hint.className = 'view-hint';
  hint.innerHTML = '左键空白：添加顶点　左键拖动：移动<br>双击顶点：删除　右键/中键：平移<br>滚轮：以光标为中心缩放';
  wrap.append(overlay, host, hint);
  wrap.dataset.label = label;
  viewsHost.appendChild(wrap);
  return { wrap, host, overlay };
}

const a = makeViewWrap('编辑视图');
let viewA: StrokeView2D;
viewA = new StrokeView2D(a.host, makeCallbacks(() => viewA));
let viewB: StrokeView2D | null = null;
let bWrap: HTMLElement | null = null;
let bOverlay: HTMLElement | null = null;

function makeCallbacks(viewRef: () => StrokeView2D) {
  return {
    pickVertex(world: Vec2): number {
      const pts = store.state.points;
      let best = -1;
      let bestD = Infinity;
      // 拾取容差按“触发事件的那个视图”的缩放计算，避免双视图缩放不同时串扰
      const tol = viewRef().pixelsToWorld(12);
      pts.forEach((p, i) => {
        const d = Math.hypot(p.x - world.x, p.y - world.y);
        if (d < tol && d < bestD) { best = i; bestD = d; }
      });
      return best;
    },
    onAddPoint(world: Vec2) {
      if (store.state.points.length === 0) return;
      store.addPoint(world);
    },
    onMoveVertex(index: number, world: Vec2) {
      store.moveVertex(index, world);
    },
    onDeleteVertex(index: number) {
      store.deleteVertex(index);
    },
    onDragStateChange: () => undefined,
  };
}

// ---------- 状态 → 所有视图 ----------
store.subscribe((_s, d) => {
  for (const v of [viewA, viewB].filter(Boolean) as StrokeView2D[]) {
    v.setStroke(d.mesh, display);
    if (d.path.isValid) v.setCenterline(d.path, display.showCenter);
    v.setVertices(store.state.points, display.showVertices, store.state.closed);
    v.setDisplay(display);
  }
  (window as unknown as { __updateStats?: (d: Derived, s: AppState) => void }).__updateStats?.(d, _s);
  updateOverlays();
});

function updateOverlays(): void {
  const d = store.derive();
  const camA = viewA.getCameraState();
  a.overlay.innerHTML =
    `<b>${a.wrap.dataset.label}</b>　zoom ${camA.zoom.toFixed(2)}×<br>` +
    `L=${d.totalLength.toFixed(2)}　顶点 ${d.mesh?.vertexCount ?? 0}　三角 ${d.mesh?.triangleCount ?? 0}`;
  if (viewB && bOverlay) {
    const camB = viewB.getCameraState();
    bOverlay.innerHTML =
      `<b>${bWrap?.dataset.label}</b>　zoom ${camB.zoom.toFixed(2)}×<br>` +
      `同一路径与参数，独立相机缩放/平移<br>` +
      `L=${d.totalLength.toFixed(2)}　顶点 ${d.mesh?.vertexCount ?? 0}　三角 ${d.mesh?.triangleCount ?? 0}`;
  }
}

// ---------- 显示开关 ----------
window.addEventListener('display-change', () => {
  for (const v of [viewA, viewB].filter(Boolean) as StrokeView2D[]) v.setDisplay(display);
});

// ---------- 对照视图开关 ----------
const compareBtn = document.querySelector('#compare-btn') as HTMLButtonElement;
compareBtn.addEventListener('click', () => {
  if (viewB) {
    viewB.dispose();
    viewB = null;
    bWrap?.remove();
    bWrap = null; bOverlay = null;
    compareBtn.textContent = '打开对照视图（不同缩放）';
    compareBtn.classList.remove('active');
  } else {
    const made = makeViewWrap('对照视图（独立缩放）');
    bWrap = made.wrap; bOverlay = made.overlay;
    viewB = new StrokeView2D(made.host, makeCallbacks(() => viewB ?? viewA));
    const d = store.derive();
    viewB.setStroke(d.mesh, display);
    if (d.path.isValid) viewB.setCenterline(d.path, display.showCenter);
    viewB.setVertices(store.state.points, display.showVertices, store.state.closed);
    viewB.fitTo(store.state.points, 2.5);
    viewB.camera.zoom = 0.5;
    viewB.camera.updateProjectionMatrix();
    compareBtn.textContent = '关闭对照视图';
    compareBtn.classList.add('active');
    setTimeout(() => { viewB?.fitTo(store.state.points, 2.5); viewB?.update(); }, 0);
  }
  updateOverlays();
});

const fitBtn = document.querySelector('#fit-btn') as HTMLButtonElement;
fitBtn.addEventListener('click', () => {
  viewA.fitTo(store.state.points, 2);
  updateOverlays();
});

viewA.onCameraChange = updateOverlays;

// ---------- 面板 ----------
buildPanel(store, () => {
  viewA.fitTo(store.state.points, 2);
  updateOverlays();
});

// ---------- 初始 ----------
viewA.fitTo(store.state.points, 2);
{
  const d = store.derive();
  viewA.setStroke(d.mesh, display);
  viewA.setCenterline(d.path, display.showCenter);
  viewA.setVertices(store.state.points, display.showVertices, store.state.closed);
  updateOverlays();
}

// 尺寸变化后刷新
window.addEventListener('resize', () => { viewA.update(); viewB?.update(); });
