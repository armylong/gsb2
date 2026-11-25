import './styles.css';
import { Renderer } from './render/renderer';
import { AppController } from './ui/controller';
import { defaultScene, trapScene } from './core/scene/scene';
import { runCanvasCrossCheck, runGeometrySelftest, type SelftestResult } from './core/selftest';
import { downloadPng } from './render/exporter';
import type { HitResult } from './core/hitTest';
import type { FillRule } from './core/geometry/path';
import type { LayerKey, ViewMode } from './core/scene/types';
import { fillRuleAt } from './core/geometry/path';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const sidebar = document.getElementById('sidebar') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const badge = document.getElementById('selftest-badge') as HTMLElement;
const viewGroup = document.getElementById('view-mode-group') as HTMLElement;

const renderer = new Renderer(canvas);
const controller = new AppController(defaultScene(), renderer, {
  onHitChange: () => renderSidebar(),
  onSceneChange: () => renderSidebar(),
});

/* ------------------------------- 顶部视图切换 ------------------------------- */

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'outline', label: '原轮廓' },
  { key: 'maskA', label: '仅 A' },
  { key: 'maskB', label: '仅 B' },
  { key: 'final', label: '最终结果' },
];

for (const v of VIEW_MODES) {
  const btn = document.createElement('button');
  btn.className = 'seg-btn';
  btn.textContent = v.label;
  btn.dataset.mode = v.key;
  btn.addEventListener('click', () => {
    controller.setMode(v.key);
    syncViewButtons();
  });
  viewGroup.appendChild(btn);
}

function syncViewButtons(): void {
  for (const btn of viewGroup.querySelectorAll<HTMLButtonElement>('.seg-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === controller.mode);
  }
}

/* --------------------------------- 侧栏 --------------------------------- */

function ruleSelect(current: FillRule, onChange: (rule: FillRule) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'rule-select';
  wrap.textContent = '填充规则 ';
  const sel = document.createElement('select');
  for (const rule of ['nonzero', 'evenodd'] as FillRule[]) {
    const opt = document.createElement('option');
    opt.value = rule;
    opt.textContent = rule === 'nonzero' ? '方向计数 nonzero' : '奇偶 evenodd';
    if (rule === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    onChange(sel.value as FillRule);
    controller.draw();
    renderSidebar();
  });
  wrap.appendChild(sel);
  return wrap;
}

function layerCard(layer: LayerKey, title: string, color: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card layer-card';
  card.dataset.layer = layer;

  const head = document.createElement('div');
  head.className = 'card-head';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = color;
  const name = document.createElement('strong');
  name.textContent = title;
  head.append(dot, name);
  card.appendChild(head);

  if (layer !== 'content') {
    const mask = controller.scene.masks[layer];
    card.appendChild(
      ruleSelect(mask.rule, (rule) => {
        mask.rule = rule;
      }),
    );
  } else {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '每个图形各自的填充规则见下方图形列表。';
    card.appendChild(hint);
  }

  const actions = document.createElement('div');
  actions.className = 'btn-row';
  const selectBtn = document.createElement('button');
  selectBtn.textContent = '设为活动层';
  selectBtn.addEventListener('click', () => {
    controller.setActive(layer);
    renderSidebar();
  });
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '复位变换';
  resetBtn.addEventListener('click', () => controller.resetLayer(layer));
  actions.append(selectBtn, resetBtn);
  card.appendChild(actions);
  return card;
}

function shapeListCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = '<strong>镂空图案(内容)</strong>';
  card.appendChild(head);
  for (const shape of controller.scene.shapes) {
    const row = document.createElement('div');
    row.className = 'shape-row';
    const swatch = document.createElement('span');
    swatch.className = 'dot';
    swatch.style.background = shape.color;
    const label = document.createElement('span');
    label.className = 'shape-label';
    label.textContent = shape.label;
    row.append(swatch, label);
    row.appendChild(
      ruleSelect(shape.rule, (rule) => {
        shape.rule = rule;
      }),
    );
    card.appendChild(row);
  }
  return card;
}

function verdictText(v: 'inside' | 'outside' | 'boundary'): string {
  return v === 'inside' ? '内部(放行)' : v === 'outside' ? '外部/孔内(裁掉)' : '轮廓边上(按放行)';
}

function hitCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = '<strong>点击核对</strong>';
  card.appendChild(head);

  const hit: HitResult | null = controller.hit;
  if (!hit) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '在画面上点击任意位置, 这里会显示点中了哪个图形, 以及两层遮罩各自的判定。';
    card.appendChild(empty);
    return card;
  }

  const fmt = (p: { x: number; y: number }) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
  const coords = document.createElement('div');
  coords.className = 'kv';
  coords.innerHTML = `根坐标 ${fmt(hit.pointRoot)}<br>内容局部 ${fmt(hit.pointContent)}`;
  card.appendChild(coords);

  const shapeLine = document.createElement('div');
  shapeLine.className = hit.visible ? 'verdict pass' : hit.shape ? 'verdict block' : 'verdict miss';
  if (hit.shape && hit.shapeProbe) {
    const visibleNote =
      hit.visibleShape && hit.visibleShape.id !== hit.shape.id
        ? `<br><span class="hint">几何顶层被遮罩裁掉, 此点实际可见的是: <b>${hit.visibleShape.label}</b></span>`
        : '';
    shapeLine.innerHTML =
      `最上层几何命中: <b>${hit.shape.label}</b><br>` +
      `该图形规则判定: ${verdictText(hit.shapeProbe.verdict)} ` +
      `(winding=${hit.shapeProbe.winding}, 交点=${hit.shapeProbe.crossings})<br>` +
      (hit.visible
        ? '✔ 两层均放行, 这是画面上实际可见、可点的像素'
        : '✖ 被遮罩裁掉, 该位置看不到此图形(可穿透到下层图形或背景)') +
      visibleNote;
  } else {
    shapeLine.textContent = '未命中任何图形(点在所有图形的孔或外部)';
  }
  card.appendChild(shapeLine);

  for (const key of ['A', 'B'] as const) {
    const info = hit.masks[key];
    const mask = controller.scene.masks[key];
    const row = document.createElement('div');
    row.className = info.passes ? 'verdict pass' : 'verdict block';
    const probeNow = fillRuleAt(mask.path, info.localPoint, mask.rule);
    const alt = mask.rule === 'evenodd' ? 'nonzero' : 'evenodd';
    const probeAlt = fillRuleAt(mask.path, info.localPoint, alt);
    row.innerHTML =
      `<b>${mask.label}</b> · ${info.rule === 'evenodd' ? '奇偶' : '方向计数'}<br>` +
      `局部点 ${fmt(info.localPoint)} → ${verdictText(info.probe.verdict)} ` +
      `(winding=${probeNow.winding}, 交点=${probeNow.crossings})<br>` +
      `<span class="hint">若换成${alt === 'evenodd' ? '奇偶' : '方向计数'}: ${verdictText(probeAlt.verdict)}</span>`;
    card.appendChild(row);
  }

  const compose = document.createElement('div');
  compose.className = 'hint';
  compose.textContent =
    '可见性 = 图形命中 ∩ A 放行 ∩ B 放行; A 裁掉的点即使 B 在板内也不会重新打开。';
  card.appendChild(compose);
  return card;
}

function exportCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = '<strong>导出透明 PNG</strong>';
  card.appendChild(head);

  const row = document.createElement('div');
  row.className = 'export-row';
  const w = document.createElement('input');
  w.type = 'number';
  w.value = '1024';
  w.min = '64';
  w.max = '4096';
  const x = document.createElement('span');
  x.textContent = '×';
  const h = document.createElement('input');
  h.type = 'number';
  h.value = '1024';
  h.min = '64';
  h.max = '4096';
  row.append(w, x, h);
  card.appendChild(row);

  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = '按当前场景导出';
  btn.addEventListener('click', () => {
    const width = Number(w.value);
    const height = Number(h.value);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
    downloadPng(controller.scene, { width, height, mode: 'final' });
  });
  card.appendChild(btn);
  return card;
}

function renderSidebar(): void {
  sidebar.innerHTML = '';
  sidebar.append(
    layerCard('content', '内容层 C(镂空图案)', '#0f766e'),
    layerCard('A', '父遮罩 A(板+孔)', '#0369a1'),
    layerCard('B', '子遮罩 B(嵌套在 A 内)', '#c2410c'),
    shapeListCard(),
    hitCard(),
    exportCard(),
  );
  for (const card of sidebar.querySelectorAll<HTMLElement>('.layer-card')) {
    card.classList.toggle('active-layer', card.dataset.layer === controller.active);
  }
}

/* --------------------------------- 自检 --------------------------------- */

function setBadge(result: SelftestResult, label: string): void {
  badge.className = `badge ${result.ok ? 'badge-ok' : 'badge-fail'}`;
  const failed = result.checks.filter((c) => !c.passed);
  badge.textContent = `${label}: ${result.ok ? '全部通过' : `${failed.length} 项失败`}`;
  badge.title = result.checks.map((c) => `${c.passed ? '✔' : '✖'} ${c.name} — ${c.detail}`).join('\n');
}

function runSelftest(): void {
  const geo = runGeometrySelftest();
  const cross = runCanvasCrossCheck([
    { name: '反向内孔方块', path: controller.scene.masks.A.path, rule: controller.scene.masks.A.rule },
    { name: '自交五角星', path: controller.scene.shapes.find((s) => s.id === 'star')!.path, rule: 'evenodd' },
    { name: '重叠双圆', path: controller.scene.shapes.find((s) => s.id === 'overlap')!.path, rule: 'evenodd' },
  ]);
  const merged: SelftestResult = {
    ok: geo.ok && cross.ok,
    checks: [...geo.checks, ...cross.checks],
  };
  setBadge(merged, '自检');
}

/* -------------------------------- 工具栏附加项 -------------------------------- */

function toolbarButton(text: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'tool-btn';
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

const spacer = document.querySelector('.spacer') as HTMLElement;
spacer.after(
  toolbarButton('加载填充规则陷阱样例', () => {
    Object.assign(controller.scene, trapScene());
    controller.hit = null;
    renderSidebar();
    controller.draw();
  }),
  toolbarButton('恢复默认场景', () => {
    const fresh = defaultScene();
    Object.assign(controller.scene, fresh);
    controller.hit = null;
    renderSidebar();
    controller.draw();
  }),
  toolbarButton('棋盘背景', () => {
    controller.showChecker = !controller.showChecker;
    controller.draw();
  }),
  toolbarButton('适应视图', () => controller.fitView()),
);

/* -------------------------------- 画布事件 -------------------------------- */

function cssPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  controller.onPointerDown(cssPoint(e));
});
canvas.addEventListener('pointermove', (e) => {
  const dragging = controller.onPointerMove(cssPoint(e));
  const coords = controller.pointerCoordinates(cssPoint(e));
  hud.textContent =
    `指针 根(${coords.root.x.toFixed(1)}, ${coords.root.y.toFixed(1)}) ` +
    `内容(${coords.content.x.toFixed(1)}, ${coords.content.y.toFixed(1)}) ` +
    `A(${coords.a.x.toFixed(1)}, ${coords.a.y.toFixed(1)}) ` +
    `B(${coords.b.x.toFixed(1)}, ${coords.b.y.toFixed(1)})` +
    (dragging ? ' · 拖动中' : '');
});
canvas.addEventListener('pointerup', () => controller.onPointerUp());
canvas.addEventListener('pointercancel', () => controller.onPointerUp());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  controller.onWheel(cssPoint(e), e.deltaY);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') controller.nudge(-step, 0, e.altKey);
  else if (e.key === 'ArrowRight') controller.nudge(step, 0, e.altKey);
  else if (e.key === 'ArrowUp') controller.nudge(0, -step, false);
  else if (e.key === 'ArrowDown') controller.nudge(0, step, false);
  else if (e.key === '1') controller.setActive('content');
  else if (e.key === '2') controller.setActive('A');
  else if (e.key === '3') controller.setActive('B');
  else return;
  renderSidebar();
  e.preventDefault();
});

/* --------------------------------- 启动 --------------------------------- */

const resize = () => {
  const wrap = canvas.parentElement!;
  controller.setSize(wrap.clientWidth, wrap.clientHeight);
  controller.fitView();
};
new ResizeObserver(resize).observe(canvas.parentElement!);
resize();
syncViewButtons();
renderSidebar();
runSelftest();

// dev/headless 验证钩子: 暴露运行态供测试读取(生产构建中 import.meta.env.DEV 为 false)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vmp = { controller, renderer, scene: controller.scene };
}
