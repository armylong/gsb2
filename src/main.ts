import './style.css';
import type { Block, Camera, EntityId, Scene, SortMode } from './core/types';
import { GRID_SIZE, blockAABB, characterAABB, project, screenToGround } from './core/geometry';
import { computeOrder, dependenciesOf, type OrderResult } from './core/ordering';
import {
  CHAR_MOVE_STEP,
  canCharacterMoveTo,
  checkBlockPlacement,
  createDefaultScene,
  groundHeightAt,
} from './core/scene';
import { pickEntity, pickGroundCell } from './core/picking';
import { Renderer } from './render/renderer';
import { runAllChecks, type CheckResult } from './core/selfcheck';

interface DragState {
  blockId: EntityId;
  offsetX: number;
  offsetY: number;
  original: Block;
  valid: boolean;
  candidate: Block;
}

interface PanState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

interface Tween {
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  elapsed: number;
  duration: number;
}

const HEIGHT_STEP = 0.5;
const MAX_HEIGHT = 5;
const SNAP = 0.5;

class App {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private scene: Scene;
  private resetSnapshot: Scene;
  private camera: Camera;
  private defaultCamera: Camera;
  private mode: SortMode = 'correct';
  private selectedId: EntityId | null = null;
  private order: OrderResult | null = null;
  private lastGoodOrder: EntityId[] | null = null;
  private drag: DragState | null = null;
  private pan: PanState | null = null;
  private hoverCell: { gx: number; gy: number } | null = null;
  private tween: Tween | null = null;
  private bannerTimer: number | null = null;

  constructor() {
    this.canvas = document.getElementById('scene') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.scene = createDefaultScene();
    this.resetSnapshot = JSON.parse(JSON.stringify(this.scene)) as Scene;
    this.camera = this.fitCamera();
    this.defaultCamera = { ...this.camera };

    this.bindEvents();
    this.recomputeOrder();
    this.updatePanel();
    this.loop();
  }

  // ---------- 相机 ----------

  private fitCamera(): Camera {
    const rect = this.canvas.getBoundingClientRect();
    const k = Math.min(rect.width / (GRID_SIZE * 2.6), rect.height / (GRID_SIZE * 1.7));
    return {
      k: Math.max(16, k),
      originX: rect.width / 2,
      originY: rect.height / 2 - (GRID_SIZE * k) / 4,
    };
  }

  /** 长条物固定机位：把长条平台及其两端箱子完整放到画面中部并留出边距。 */
  private bookmarkCamera(): Camera {
    const rect = this.canvas.getBoundingClientRect();
    // 关注区域：平台 + 两端箱子 + 前矮箱的世界包围盒
    const worldCorners = [
      { x: 2.9, y: 6.9, z: 0 },
      { x: 8.1, y: 9.4, z: 0 },
      { x: 2.9, y: 6.9, z: 2.0 },
      { x: 8.1, y: 9.4, z: 2.0 },
    ].map((c) => project(c, { originX: 0, originY: 0, k: 1 }));
    const minSx = Math.min(...worldCorners.map((c) => c.sx));
    const maxSx = Math.max(...worldCorners.map((c) => c.sx));
    const minSy = Math.min(...worldCorners.map((c) => c.sy));
    const maxSy = Math.max(...worldCorners.map((c) => c.sy));
    const w = maxSx - minSx;
    const h = maxSy - minSy;
    const k = Math.min((rect.width * 0.62) / w, (rect.height * 0.5) / h);
    // 区域屏幕中心（k=1 时）偏移到画布中心偏上，给侧栏提示留空间
    const cx = (minSx + maxSx) / 2;
    const cy = (minSy + maxSy) / 2;
    return { k, originX: rect.width / 2 - cx * k, originY: rect.height * 0.42 - cy * k };
  }

  // ---------- 事件 ----------

  private bindEvents(): void {
    window.addEventListener('resize', () => {
      this.renderer.resize();
    });
    this.renderer.resize();

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        this.mode = radio.value as SortMode;
        this.recomputeOrder();
        this.updatePanel();
      });
    });

    document.getElementById('btn-reset')!.addEventListener('click', () => this.resetAll());
    document.getElementById('btn-bookmark')!.addEventListener('click', () => {
      this.camera = this.bookmarkCamera();
      this.showBanner('已切换到长条物固定机位：切换上方“对照模式”观察两端箱子的遮挡错误', 'info', 3200);
    });
    document.getElementById('btn-height-up')!.addEventListener('click', () => this.adjustHeight(HEIGHT_STEP));
    document.getElementById('btn-height-down')!.addEventListener('click', () => this.adjustHeight(-HEIGHT_STEP));
    document.getElementById('btn-selfcheck')!.addEventListener('click', () => this.showSelfCheck());
  }

  private pointerPos(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent): void {
    const pos = this.pointerPos(e);
    const hit = this.pick(pos.x, pos.y);
    if (hit) {
      this.selectedId = hit.id;
      const block = this.scene.blocks.find((b) => b.id === hit.id);
      if (block) {
        const g = screenToGround(pos.x, pos.y, this.camera);
        this.drag = {
          blockId: block.id,
          offsetX: g.x - block.x,
          offsetY: g.y - block.y,
          original: { ...block },
          valid: true,
          candidate: { ...block },
        };
        this.canvas.classList.add('dragging');
      }
      this.updatePanel();
      return;
    }
    // 空地：开始平移并取消选中
    this.selectedId = null;
    this.pan = { startX: pos.x, startY: pos.y, originX: this.camera.originX, originY: this.camera.originY, moved: false };
    this.canvas.classList.add('dragging');
    this.updatePanel();
  }

  private onPointerMove(e: PointerEvent): void {
    const pos = this.pointerPos(e);
    const cell = pickGroundCell(pos.x, pos.y, this.camera);
    this.hoverCell = cell;

    if (this.pan) {
      const dx = pos.x - this.pan.startX;
      const dy = pos.y - this.pan.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.pan.moved = true;
      this.camera.originX = this.pan.originX + dx;
      this.camera.originY = this.pan.originY + dy;
      this.recomputeOrder();
      return;
    }
    if (this.drag) {
      const g = screenToGround(pos.x, pos.y, this.camera);
      const nx = Math.round((g.x - this.drag.offsetX) / SNAP) * SNAP;
      const ny = Math.round((g.y - this.drag.offsetY) / SNAP) * SNAP;
      const block = this.scene.blocks.find((b) => b.id === this.drag!.blockId)!;
      const candidate: Block = { ...block, x: nx, y: ny };
      const check = checkBlockPlacement(this.scene, candidate, block.id);
      this.drag.valid = check.ok;
      this.drag.candidate = candidate;
      return;
    }
    const hit = this.pick(pos.x, pos.y);
    this.canvas.classList.toggle('hover-entity', !!hit);
  }

  private onPointerUp(): void {
    this.canvas.classList.remove('dragging');
    if (this.drag) {
      const { candidate, valid, original, blockId } = this.drag;
      if (valid && (candidate.x !== original.x || candidate.y !== original.y)) {
        const block = this.scene.blocks.find((b) => b.id === blockId)!;
        block.x = candidate.x;
        block.y = candidate.y;
        this.recomputeOrder();
        this.showBanner(`「${block.label}」已移动到 (${block.x}, ${block.y})，绘制顺序已重新计算`, 'info', 2000);
      } else if (!valid) {
        const check = checkBlockPlacement(this.scene, candidate, blockId);
        this.showBanner(`摆放被拒绝：${check.reason ?? '无效位置'}，保留最近有效摆放`, 'warn', 3000);
      }
      this.drag = null;
      this.updatePanel();
    }
    if (this.pan) {
      this.pan = null;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const pos = this.pointerPos(e);
    // 先取鼠标下的地面点，缩放后调整 origin 使该点保持在鼠标下
    const world = screenToGround(pos.x, pos.y, this.camera);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.camera.k = Math.max(10, Math.min(120, this.camera.k * factor));
    this.camera.originX = pos.x - (world.x - world.y) * this.camera.k;
    this.camera.originY = pos.y - (world.x + world.y) * 0.5 * this.camera.k;
    this.recomputeOrder();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const moveKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (moveKeys.includes(e.key)) {
      e.preventDefault();
      this.tryCharacterStep(e.key);
      return;
    }
    if (e.repeat) return;
    switch (e.key) {
      case 'q':
      case 'Q':
        this.adjustHeight(HEIGHT_STEP);
        break;
      case 'e':
      case 'E':
        this.adjustHeight(-HEIGHT_STEP);
        break;
      case 'r':
      case 'R':
        this.resetAll();
        break;
      case 'b':
      case 'B':
        this.camera = this.bookmarkCamera();
        this.showBanner('长条物固定机位', 'info', 1800);
        break;
      case 'Escape':
        this.drag = null;
        this.selectedId = null;
        this.updatePanel();
        break;
    }
  }

  // ---------- 角色移动 ----------

  private tryCharacterStep(key: string): void {
    if (this.tween) return;
    const c = this.scene.character;
    let dx = 0;
    let dy = 0;
    if (key === 'ArrowUp') dy = -CHAR_MOVE_STEP;
    if (key === 'ArrowDown') dy = CHAR_MOVE_STEP;
    if (key === 'ArrowLeft') dx = -CHAR_MOVE_STEP;
    if (key === 'ArrowRight') dx = CHAR_MOVE_STEP;
    const nx = c.x + dx;
    const ny = c.y + dy;
    const check = canCharacterMoveTo(this.scene, nx, ny);
    if (!check.ok) {
      this.showBanner(`移动被拒绝：${check.reason ?? '目标位置不可达'}`, 'warn', 1600);
      return;
    }
    const targetZ = groundHeightAt(this.scene, nx, ny);
    this.selectedId = 'character';
    this.tween = {
      fromX: c.x, fromY: c.y, fromZ: c.z,
      toX: nx, toY: ny, toZ: targetZ,
      elapsed: 0, duration: 150,
    };
  }

  private adjustHeight(delta: number): void {
    if (!this.selectedId || this.selectedId === 'character') {
      this.showBanner('请先选中一个积木再调整高度', 'warn', 1600);
      return;
    }
    const block = this.scene.blocks.find((b) => b.id === this.selectedId);
    if (!block) return;
    const candidate: Block = { ...block, h: Math.max(0.5, Math.min(MAX_HEIGHT, block.h + delta)) };
    if (candidate.h === block.h) return;
    const check = checkBlockPlacement(this.scene, candidate, block.id);
    if (!check.ok) {
      this.showBanner(`高度调整被拒绝：${check.reason ?? '会发生穿入'}，保留当前高度`, 'warn', 2600);
      return;
    }
    block.h = candidate.h;
    this.recomputeOrder();
    this.updatePanel();
    this.showBanner(`「${block.label}」高度调整为 ${block.h.toFixed(1)}`, 'info', 1500);
  }

  private resetAll(): void {
    this.scene = JSON.parse(JSON.stringify(this.resetSnapshot)) as Scene;
    this.camera = { ...this.defaultCamera };
    this.selectedId = null;
    this.drag = null;
    this.tween = null;
    this.mode = 'correct';
    document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
      r.checked = r.value === 'correct';
    });
    this.recomputeOrder();
    this.updatePanel();
    this.showBanner('已重置布局、角色位置与相机', 'info', 1800);
  }

  // ---------- 排序 ----------

  private sceneEntities() {
    return [
      ...this.scene.blocks.map((b) => ({ id: b.id, box: blockAABB(b) })),
      { id: 'character' as EntityId, box: characterAABB(this.scene.character) },
    ];
  }

  private recomputeOrder(): void {
    const result = computeOrder(this.sceneEntities(), this.camera, this.mode);
    if (!result.hasConflict) {
      this.lastGoodOrder = [...result.order];
    } else if (this.lastGoodOrder) {
      // 冲突时保留最近有效摆放对应的顺序，不随机闪烁
      result.order = [...this.lastGoodOrder];
      if (!this.drag) this.showConflictBanner(result);
    }
    this.order = result;
  }

  private showConflictBanner(result: OrderResult): void {
    const names = [
      ...new Set([
        ...result.cycleEntities,
        ...result.interpenetrations.flatMap((p) => [p.a, p.b]),
      ]),
    ]
      .map((id) => this.entityName(id))
      .join('、');
    this.showBanner(
      `检测到无法形成一致顺序的布局，相关对象：${names}。已保留最近有效绘制顺序，可重置或移开相关积木`,
      'error',
      4200,
    );
  }

  private entityName(id: EntityId): string {
    if (id === 'character') return '角色';
    return this.scene.blocks.find((b) => b.id === id)?.label ?? id;
  }

  private pick(x: number, y: number) {
    if (!this.order) return null;
    const order = this.lastGoodOrder ?? this.order.order;
    return pickEntity(x, y, this.sceneEntities(), order, this.camera);
  }

  // ---------- 面板 ----------

  private updatePanel(): void {
    const list = document.getElementById('order-list')!;
    if (!this.order) return;
    const order = this.lastGoodOrder ?? this.order.order;
    const conflictSet = new Set([
      ...this.order.cycleEntities,
      ...this.order.interpenetrations.flatMap((p) => [p.a, p.b]),
    ]);
    const violationSet = new Set(this.order.naiveViolations.flatMap((r) => [r.before, r.after]));
    list.innerHTML = order
      .map((id, i) => {
        const classes = [
          conflictSet.has(id) ? 'conflict' : '',
          id === this.selectedId ? 'selected' : '',
          this.mode === 'naive' && violationSet.has(id) ? 'naive-violation' : '',
        ].filter(Boolean).join(' ');
        const sub = conflictSet.has(id) ? '<span class="sub"> — 冲突对象</span>' : '';
        return `<li class="${classes}">${i}. ${this.entityName(id)} <span class="sub">(${id})</span>${sub}</li>`;
      })
      .join('');

    const info = document.getElementById('selection-info')!;
    if (!this.selectedId) {
      info.textContent = '未选中（点击积木或角色查看前后依赖）';
      return;
    }
    const deps = dependenciesOf(this.selectedId, this.order.relations);
    const block = this.scene.blocks.find((b) => b.id === this.selectedId);
    const c = this.scene.character;
    const header =
      this.selectedId === 'character'
        ? `<div><b>角色</b> <span class="kv">位置 (${c.x.toFixed(2)}, ${c.y.toFixed(2)})，底面高 ${c.z.toFixed(2)}</span></div>`
        : block
          ? `<div><b>${block.label}</b> <span class="kv">(${block.id})</span></div>
             <div class="kv">底面 (${block.x}, ${block.y}, ${block.z}) · 占地 ${block.sx}×${block.sy} · 高 ${block.h.toFixed(1)}</div>`
          : '';
    const beforeHtml = deps.before.length
      ? deps.before.map((r) => `<div class="dep">先于本对象绘制：${this.entityName(r.before)} <span class="kv">（${r.reason}）</span></div>`).join('')
      : '<div class="kv">无“必须先画”的依赖</div>';
    const afterHtml = deps.after.length
      ? deps.after.map((r) => `<div class="dep">本对象先于：${this.entityName(r.after)} <span class="kv">（${r.reason}）</span></div>`).join('')
      : '<div class="kv">无“必须后画”的依赖</div>';
    info.innerHTML = `${header}${beforeHtml}${afterHtml}`;
  }

  private showBanner(text: string, type: 'error' | 'warn' | 'info', timeout: number): void {
    const banner = document.getElementById('banner')!;
    banner.textContent = text;
    banner.className = type;
    if (this.bannerTimer) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => banner.classList.add('hidden'), timeout);
  }

  private showSelfCheck(): void {
    const results: CheckResult[] = runAllChecks();
    const section = document.getElementById('selfcheck-section')!;
    const ul = document.getElementById('selfcheck-list')!;
    section.classList.remove('hidden');
    ul.innerHTML = results
      .map(
        (r) =>
          `<li class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓' : '✗'} ${r.name}<span class="detail">${r.detail}</span></li>`,
      )
      .join('');
    const failed = results.filter((r) => !r.pass).length;
    this.showBanner(failed === 0 ? '全部 7 项自检通过' : `有 ${failed} 项自检失败`, failed === 0 ? 'info' : 'error', 3000);
  }

  // ---------- 主循环 ----------

  private loop = (): void => {
    if (this.tween) {
      this.tween.elapsed += 16.7;
      const t = Math.min(1, this.tween.elapsed / this.tween.duration);
      const ease = t * t * (3 - 2 * t);
      const c = this.scene.character;
      c.x = this.tween.fromX + (this.tween.toX - this.tween.fromX) * ease;
      c.y = this.tween.fromY + (this.tween.toY - this.tween.fromY) * ease;
      c.z = this.tween.fromZ + (this.tween.toZ - this.tween.fromZ) * ease;
      // 角色移动时前后关系逐帧变化
      this.recomputeOrder();
      this.updatePanel();
      if (t >= 1) this.tween = null;
    }
    if (this.order) {
      this.renderer.render(this.scene, this.camera, {
        selectedId: this.selectedId,
        order: this.order,
        hoverCell: this.hoverCell,
        dragPreview: this.drag
          ? { block: this.drag.candidate, valid: this.drag.valid }
          : null,
        naiveMode: this.mode === 'naive',
      });
    }
    requestAnimationFrame(this.loop);
  };
}

new App();
