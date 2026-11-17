/**
 * main —— 交互编排：把数据层、选择层、几何拾取层、渲染层与 DOM 接起来
 */

import './styles.css';
import { FieldModel } from './core/FieldModel.js';
import {
  SelectionStore,
  MODE_REPLACE,
  MODE_ADD,
  MODE_REMOVE,
  MODE_LABELS,
} from './core/SelectionStore.js';
import { pickPointId, pickBoxIds, projectInstance, toLocal } from './core/Picker.js';
import { SceneView } from './scene/SceneView.js';
import { Marquee } from './ui/Marquee.js';
import { HUD } from './ui/HUD.js';

const OBJECT_COUNT = 5000;
const DRAG_THRESHOLD_PX = 5; // 小于该位移视为单击，否则视为拖框

// ---- 基础对象 ----
const canvas = document.getElementById('scene');
const model = new FieldModel({ count: OBJECT_COUNT });
const selection = new SelectionStore();
const view = new SceneView(canvas, model);
const marquee = new Marquee(document.getElementById('marquee'));
const hud = new HUD();
const tooltip = document.getElementById('tooltip');

view.refreshColors(selection);

/** 修饰键实时状态（键盘事件 + 指针事件双来源，避免按下顺序导致状态丢失） */
const modifiers = { shift: false, ctrl: false, alt: false };

function effectiveMode() {
  if (modifiers.shift) return MODE_ADD;
  if (modifiers.ctrl || modifiers.alt) return MODE_REMOVE;
  return selection.stickyMode;
}

function syncHUD(message) {
  hud.update(model, selection, effectiveMode());
  if (message) hud.setMessage(message);
}

// ---- 点选 / 框选手势 ----
let gesture = null; // {start:{x,y}, pointerId, moved:boolean}

canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 右键留给 OrbitControls

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return; // 仅左键参与选择；右键旋转、中键缩放
  modifiers.shift = event.shiftKey;
  modifiers.ctrl = event.ctrlKey || event.metaKey;
  modifiers.alt = event.altKey;
  const local = toLocal(event, canvas.getBoundingClientRect());
  gesture = { start: local, pointerId: event.pointerId, moved: false };
  canvas.setPointerCapture(event.pointerId);
  tooltip.hidden = true;
});

canvas.addEventListener('pointermove', (event) => {
  modifiers.shift = event.shiftKey;
  modifiers.ctrl = event.ctrlKey || event.metaKey;
  modifiers.alt = event.altKey;
  const local = toLocal(event, canvas.getBoundingClientRect());

  if (gesture && event.pointerId === gesture.pointerId) {
    const dx = local.x - gesture.start.x;
    const dy = local.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      gesture.moved = true;
      marquee.begin(gesture.start);
    }
    if (gesture.moved) marquee.update(local);
    return;
  }
  scheduleHover(local);
});

canvas.addEventListener('pointerup', (event) => {
  if (!gesture || event.button !== 0 || event.pointerId !== gesture.pointerId) return;
  const local = toLocal(event, canvas.getBoundingClientRect());
  const mode = effectiveMode();

  if (gesture.moved) {
    // ---- 拖框选择：在“松手当下”用最新相机/尺寸重新投影，保证区域准确 ----
    const rect = marquee.end(local);
    const hits = pickBoxIds(
      view.mesh,
      view.camera,
      view.width,
      view.height,
      rect,
      (id) => model.isHidden(id),
    );
    selection.apply(hits, mode, 'box');
    syncHUD(
      `框选（${MODE_LABELS[mode]}）命中 ${hits.length} 个，当前已选 ${selection.size} 个`,
    );
  } else {
    // ---- 点选：最近可见实例 ----
    const id = pickPointId(
      view.mesh,
      view.camera,
      local.x,
      local.y,
      view.width,
      view.height,
      (hiddenId) => model.isHidden(hiddenId),
    );
    if (id == null) {
      if (mode === MODE_REPLACE) {
        selection.clear('empty-click');
        syncHUD('点到空白处，已清空选择');
      } else {
        syncHUD('空白处无命中，选择不变');
      }
    } else {
      selection.apply([id], mode, 'point');
      const verb =
        mode === MODE_REMOVE ? '取消选择' : mode === MODE_ADD ? '追加选择' : '点选';
      syncHUD(`${verb}物件 #${id}，当前已选 ${selection.size} 个`);
    }
  }

  gesture = null;
  view.refreshColors(selection);
  syncHUD();
});

canvas.addEventListener('pointercancel', () => {
  gesture = null;
  marquee.cancel();
});

// ---- 悬停提示（rAF 合帧，避免高频射线检测）----
let hoverQueued = null;
function scheduleHover(local) {
  hoverQueued = local;
}
function flushHover() {
  if (!hoverQueued || gesture) {
    hoverQueued = null;
    return;
  }
  const local = hoverQueued;
  hoverQueued = null;
  const id = pickPointId(
    view.mesh,
    view.camera,
    local.x,
    local.y,
    view.width,
    view.height,
    (hiddenId) => model.isHidden(hiddenId),
  );
  view.setHover(id);
  if (id == null) {
    tooltip.hidden = true;
  } else {
    tooltip.hidden = false;
    tooltip.textContent = `物件 #${id}${selection.has(id) ? '（已选）' : ''}`;
    const rect = canvas.getBoundingClientRect();
    tooltip.style.left = `${rect.left + local.x + 14}px`;
    tooltip.style.top = `${rect.top + local.y + 14}px`;
  }
}

// ---- 全局修饰键（指针静止时按修饰键也能更新模式显示）----
window.addEventListener('keydown', (event) => {
  modifiers.shift = event.shiftKey;
  modifiers.ctrl = event.ctrlKey || event.metaKey;
  modifiers.alt = event.altKey;

  if (event.key === '1') selection.setStickyMode(MODE_REPLACE);
  if (event.key === '2') selection.setStickyMode(MODE_ADD);
  if (event.key === '3') selection.setStickyMode(MODE_REMOVE);
  if (event.key === 'Escape') {
    selection.clear('esc');
    view.refreshColors(selection);
    syncHUD('已清空选择');
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoLastHide();
  }
  syncHUD();
});
window.addEventListener('keyup', (event) => {
  modifiers.shift = event.shiftKey;
  modifiers.ctrl = event.ctrlKey || event.metaKey;
  modifiers.alt = event.altKey;
  syncHUD();
});

// ---- HUD 按钮 ----
for (const [mode, btn] of Object.entries(hud.el.modeButtons)) {
  btn.addEventListener('click', () => {
    selection.setStickyMode(mode);
    syncHUD(`模式切换为：${MODE_LABELS[mode]}`);
  });
}

hud.el.btnMove.addEventListener('click', () => {
  const ids = selection.values();
  if (ids.length === 0) return;
  // 随机平移一段距离（数据层先更新，渲染层做插值动画；id 全程不变）
  const delta = {
    x: (Math.random() - 0.5) * 14,
    y: (Math.random() - 0.5) * 4,
    z: (Math.random() - 0.5) * 14,
  };
  const moved = model.move(ids, delta);
  view.move(moved);
  syncHUD(`已移动 ${moved.length} 个已选物件（身份保持不变）`);
});

hud.el.btnHide.addEventListener('click', () => {
  const batch = model.hide(selection.values());
  if (batch.length === 0) {
    syncHUD('没有可隐藏的已选物件');
    return;
  }
  view.applyHidden(batch);
  view.refreshIds(batch, selection); // 选中身份保留，恢复后仍是选中态
  syncHUD(`已批量隐藏 ${batch.length} 个物件（可撤销），选择身份保留`);
});

function undoLastHide() {
  const restored = model.undoHide();
  if (restored.length === 0) {
    syncHUD('没有可撤销的隐藏操作');
    return;
  }
  view.applyRestored(restored, selection);
  syncHUD(`已撤销隐藏，恢复 ${restored.length} 个物件`);
}
hud.el.btnUndo.addEventListener('click', undoLastHide);

hud.el.btnRestore.addEventListener('click', () => {
  const restored = model.restoreAll();
  if (restored.length === 0) {
    syncHUD('当前没有隐藏物件');
    return;
  }
  view.applyRestored(restored, selection);
  syncHUD(`已恢复全部 ${restored.length} 个隐藏物件`);
});

hud.el.btnClear.addEventListener('click', () => {
  selection.clear('button');
  view.refreshColors(selection);
  syncHUD('已清空选择（可见性不受影响）');
});

hud.el.btnResetView.addEventListener('click', () => {
  view.resetView();
  syncHUD('视角已重置');
});

// ---- 选择层事件（外部触发时同步 HUD）----
selection.subscribe(() => syncHUD());

// ---- 窗口缩放：渲染尺寸与框选坐标系一起更新 ----
const resizeObserver = new ResizeObserver(() => {
  view.resize();
});
resizeObserver.observe(canvas);

// ---- 渲染循环 ----
function loop() {
  flushHover();
  view.render();
  requestAnimationFrame(loop);
}
loop();

syncHUD(`就绪：场景已生成 ${model.count} 个具有独立身份的物件`);

// 暴露给自动化脚本 / 控制台验证使用
window.__pickTool = {
  model,
  selection,
  view,
  marquee,
  effectiveMode,
  // 几何工具以绑定当前渲染状态的形式暴露，便于 CDP 脚本直接复核投影/拾取
  project: (id) => projectInstance(view.mesh, id, view.camera, view.width, view.height),
  pickBox: (rect) =>
    pickBoxIds(view.mesh, view.camera, view.width, view.height, rect, (id) =>
      model.isHidden(id),
    ),
};
