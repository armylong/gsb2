/**
 * 应用主控制器：状态、画布输入、面板联动、持久化。
 * 物理计算全部委托 LightEngine；本文件只负责编辑与呈现。
 */
import type {
  FloorAnalysis,
  HeatMap,
  IrradianceRGB,
  Quality,
  ToolMode,
  Vec2,
  WallSegment,
  World,
} from './types.js';
import { Camera } from './camera.js';
import { LightEngine } from './engine.js';
import { QUALITY_SPECS, createDefaultWorld, createEmptyWorld } from './scene.js';
import { SceneRenderer, type HeatMode, type HoverInfo, type RenderState } from './renderer.js';
import { pick, hoverKind, type PickTarget } from './picking.js';
import { dist, genId, hexToRgb, rgbLuma, rgbToHex } from './geometry.js';
import { mapIrradToCss } from './tonemap.js';

const STORAGE_KEY = 'diffuse-lab-world-v1';

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'wall-endpoint'; wallId: string; end: 'a' | 'b' }
  | { kind: 'wall-body'; wallId: string; last: Vec2 }
  | { kind: 'lamp-endpoint'; end: 'a' | 'b' }
  | { kind: 'lamp-body'; last: Vec2 }
  | { kind: 'sample'; sampleId: string }
  | { kind: 'draft'; start: Vec2 };

interface CanvasPair {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cssW: number;
  cssH: number;
}

export class App {
  private world: World;
  private camera = new Camera();
  private quality: Quality = 'quick';
  private rightMode: HeatMode = 'total';
  private tool: ToolMode = 'select';
  private showHeat = true;
  private exposure = 1;
  private autoExposure = true;

  private engine!: LightEngine;
  private heat: HeatMap | null = null;
  private analysis: FloorAnalysis | null = null;
  private probePos: Vec2 | null = null;
  private selectedSampleId: string | null = null;
  private selectedWallId: string | null = null;
  private hypothetical = new Set<string>();
  private hypoAnalysis: FloorAnalysis | null = null;

  private drag: DragState = { kind: 'none' };
  private draftWall: { a: Vec2; b: Vec2 } | null = null;
  private hover: HoverInfo | null = null;
  private recomputePending = false;

  private left!: CanvasPair;
  private right!: CanvasPair;
  private renderer = new SceneRenderer();

  constructor() {
    this.world = this.loadWorld() ?? createDefaultWorld();
    this.cacheDom();
    this.bindEvents();
    this.resizeCanvases();
    this.camera.fit(this.world.room, this.left.cssW, this.left.cssH);
    this.selectedSampleId = this.world.samples[0]?.id ?? null;
    this.probePos = this.world.samples[0] ? { ...this.world.samples[0].pos } : null;
    this.recompute(true);
    this.syncControls();
  }

  // ---------------- DOM ----------------
  private el = (id: string): HTMLElement => document.getElementById(id)!;
  private input = (id: string): HTMLInputElement => this.el(id) as HTMLInputElement;

  private cacheDom(): void {
    const make = (id: string): CanvasPair => {
      const canvas = this.el(id) as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      return { canvas, ctx, cssW: 0, cssH: 0 };
    };
    this.left = make('canvas-left');
    this.right = make('canvas-right');
  }

  private bindEvents(): void {
    document.querySelectorAll<HTMLButtonElement>('#tool-group button').forEach((btn) => {
      btn.addEventListener('click', () => this.setTool(btn.dataset.tool as ToolMode));
    });
    document.querySelectorAll<HTMLButtonElement>('#quality-group button').forEach((btn) => {
      btn.addEventListener('click', () => this.setQuality(btn.dataset.quality as Quality));
    });
    this.input('show-heat').addEventListener('change', (e) => {
      this.showHeat = (e.target as HTMLInputElement).checked;
      this.draw();
    });
    this.el('right-mode').addEventListener('change', (e) => {
      this.rightMode = (e.target as HTMLSelectElement).value as HeatMode;
      this.el('right-title').textContent =
        this.rightMode === 'total'
          ? '右：直射 + 一次墙面反射'
          : this.rightMode === 'reflected'
            ? '右：仅一次墙面反射'
            : '右：仅直射（对照）';
      this.draw();
    });
    this.el('btn-reset-view').addEventListener('click', () => {
      this.camera.fit(this.world.room, this.left.cssW, this.left.cssH);
      this.draw();
    });
    this.el('btn-preset-default').addEventListener('click', () => this.loadPreset(createDefaultWorld()));
    this.el('btn-preset-empty').addEventListener('click', () => this.loadPreset(createEmptyWorld()));
    this.el('btn-export').addEventListener('click', () => this.exportJson());
    this.el('btn-import').addEventListener('click', () => this.input('import-file').click());
    this.input('import-file').addEventListener('change', (e) => this.importJson(e.target as HTMLInputElement));

    this.input('lamp-power').addEventListener('input', (e) => {
      this.world.lamp.power = Number((e.target as HTMLInputElement).value);
      this.scheduleRecompute();
    });
    this.input('exposure').addEventListener('input', (e) => {
      this.autoExposure = false;
      this.exposure = Number((e.target as HTMLInputElement).value);
      this.draw();
    });
    this.el('btn-delete-wall').addEventListener('click', () => this.deleteSelectedWall());

    for (const pair of [this.left, this.right]) {
      pair.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e, pair));
      pair.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e, pair));
      pair.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e, pair));
      pair.canvas.addEventListener('pointerleave', () => {
        this.hover = null;
        this.draw();
      });
      pair.canvas.addEventListener('wheel', (e) => this.onWheel(e, pair), { passive: false });
      pair.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    window.addEventListener('resize', () => {
      this.resizeCanvases();
      this.draw();
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ---------------- 尺寸 ----------------
  private resizeCanvases(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const p of [this.left, this.right]) {
      const rect = p.canvas.getBoundingClientRect();
      p.cssW = rect.width;
      p.cssH = rect.height;
      p.canvas.width = Math.round(rect.width * dpr);
      p.canvas.height = Math.round(rect.height * dpr);
      p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ---------------- 工具/质量 ----------------
  private setTool(tool: ToolMode): void {
    this.tool = tool;
    document.querySelectorAll('#tool-group button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.tool === tool);
    });
    this.setStatusHint(
      tool === 'wall'
        ? '在画布上按下并拖出一段墙；Esc 取消'
        : tool === 'point'
          ? '点击地面放置取样点'
          : tool === 'pan'
            ? '拖动平移视图，滚轮缩放'
            : '拖动端点/灯/取样点编辑；点击地面查看探针',
    );
  }

  private setQuality(q: Quality): void {
    this.quality = q;
    document.querySelectorAll('#quality-group button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.quality === q);
    });
    this.recompute(true);
  }

  private loadPreset(w: World): void {
    this.world = w;
    this.selectedWallId = null;
    this.hypothetical.clear();
    this.selectedSampleId = w.samples[0]?.id ?? null;
    this.probePos = w.samples[0] ? { ...w.samples[0].pos } : null;
    this.autoExposure = true;
    this.recompute(true);
    this.syncControls();
    this.saveWorld();
  }

  // ---------------- 重算调度 ----------------
  private scheduleRecompute(): void {
    if (this.recomputePending) return;
    this.recomputePending = true;
    requestAnimationFrame(() => {
      this.recomputePending = false;
      this.recompute(false);
    });
  }

  private recompute(resetExposure: boolean): void {
    this.engine = new LightEngine(this.world, QUALITY_SPECS[this.quality]);
    this.heat = this.engine.computeHeatMap();
    if (this.autoExposure || resetExposure) {
      this.exposure = this.heat.p99Luma;
      this.autoExposure = true;
    }
    if (this.probePos) this.refreshAnalysis();
    this.updateStats();
    this.draw();
    this.saveWorldDebounced();
  }

  private refreshAnalysis(): void {
    if (!this.probePos) {
      this.analysis = null;
      this.hypoAnalysis = null;
      return;
    }
    this.analysis = this.engine.analyzeFloor(this.probePos, true);
    this.hypoAnalysis = this.hypothetical.size
      ? this.engine.analyzeFloor(this.probePos, false, this.hypothetical)
      : null;
    this.updateProbePanel();
  }

  // ---------------- 指针交互 ----------------
  private eventWorld(e: PointerEvent | WheelEvent, pair: CanvasPair): Vec2 {
    const rect = pair.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return this.camera.toWorld(screen);
  }

  private doPick(wp: Vec2): PickTarget {
    const metersPerPx = 1 / this.camera.scale;
    return pick(
      wp,
      metersPerPx,
      this.world.walls,
      this.world.lamp,
      this.world.samples.map((s) => ({ id: s.id, pos: s.pos })),
    );
  }

  private onPointerDown(e: PointerEvent, pair: CanvasPair): void {
    pair.canvas.setPointerCapture(e.pointerId);
    const wp = this.eventWorld(e, pair);

    if (e.button === 2 || this.tool === 'pan') {
      this.drag = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      return;
    }

    if (this.tool === 'wall') {
      this.drag = { kind: 'draft', start: wp };
      this.draftWall = { a: wp, b: wp };
      return;
    }

    if (this.tool === 'point') {
      const sp = { id: genId('sample'), pos: this.clampToRoom(wp) };
      this.world.samples.push(sp);
      this.selectedSampleId = sp.id;
      this.probePos = { ...sp.pos };
      this.refreshAnalysis();
      this.updateSampleList();
      this.draw();
      this.saveWorldDebounced();
      return;
    }

    // select 工具
    const target = this.doPick(wp);
    switch (target.kind) {
      case 'wall-endpoint':
        this.selectedWallId = target.wallId;
        this.drag = { kind: 'wall-endpoint', wallId: target.wallId, end: target.end };
        break;
      case 'wall-body':
        this.selectedWallId = target.wallId;
        this.drag = { kind: 'wall-body', wallId: target.wallId, last: wp };
        break;
      case 'lamp-endpoint':
        this.drag = { kind: 'lamp-endpoint', end: target.end };
        break;
      case 'lamp-body':
        this.drag = { kind: 'lamp-body', last: wp };
        break;
      case 'sample':
        this.selectedSampleId = target.sampleId;
        const sp2 = this.world.samples.find((s) => s.id === target.sampleId);
        if (sp2) this.probePos = { ...sp2.pos };
        this.refreshAnalysis();
        this.drag = { kind: 'sample', sampleId: target.sampleId };
        break;
      case 'floor':
        // 点击地面：探针移动到该世界坐标（坐标不随缩放漂移）
        this.probePos = this.clampToRoom(wp);
        this.selectedSampleId = null;
        this.hypothetical.clear();
        this.refreshAnalysis();
        break;
    }
    this.updateWallList();
    this.updateSampleList();
    this.draw();
  }

  private onPointerMove(e: PointerEvent, pair: CanvasPair): void {
    const wp = this.eventWorld(e, pair);
    this.setStatusCoord(wp);

    if (this.drag.kind === 'pan') {
      this.camera.pan(e.clientX - this.drag.lastX, e.clientY - this.drag.lastY);
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
      this.draw();
      return;
    }

    if (this.drag.kind === 'draft') {
      this.draftWall = { a: this.drag.start, b: wp };
      this.draw();
      return;
    }

    if (this.drag.kind === 'none') {
      const target = this.doPick(wp);
      pair.canvas.style.cursor = this.tool === 'pan' ? 'grab' : hoverKind(target);
      this.hover = this.targetToHover(target);
      this.draw();
      return;
    }

    const c = this.clampToRoom(wp);
    const drag = this.drag;
    switch (drag.kind) {
      case 'wall-endpoint': {
        const w = this.findWall(drag.wallId);
        if (w) w[drag.end] = c;
        break;
      }
      case 'wall-body': {
        const w = this.findWall(drag.wallId);
        if (w) {
          const d = { x: wp.x - drag.last.x, y: wp.y - drag.last.y };
          w.a = this.clampToRoom({ x: w.a.x + d.x, y: w.a.y + d.y });
          w.b = this.clampToRoom({ x: w.b.x + d.x, y: w.b.y + d.y });
          drag.last = wp;
        }
        break;
      }
      case 'lamp-endpoint':
        this.world.lamp[drag.end] = c;
        break;
      case 'lamp-body': {
        const d = { x: wp.x - drag.last.x, y: wp.y - drag.last.y };
        this.world.lamp.a = this.clampToRoom({ x: this.world.lamp.a.x + d.x, y: this.world.lamp.a.y + d.y });
        this.world.lamp.b = this.clampToRoom({ x: this.world.lamp.b.x + d.x, y: this.world.lamp.b.y + d.y });
        drag.last = wp;
        break;
      }
      case 'sample': {
        const s = this.world.samples.find((x) => x.id === drag.sampleId);
        if (s) s.pos = c;
        this.probePos = { ...c };
        this.refreshAnalysis();
        break;
      }
    }
    this.scheduleRecompute();
    this.draw();
  }

  private onPointerUp(e: PointerEvent, pair: CanvasPair): void {
    if (this.drag.kind === 'draft' && this.draftWall) {
      const a = this.clampToRoom(this.draftWall.a);
      const b = this.clampToRoom(this.draftWall.b);
      if (dist(a, b) > 0.15) {
        const wall: WallSegment = {
          id: genId('wall'),
          a,
          b,
          color: hexToRgb('#9aa0a6'),
          enabled: true,
        };
        this.world.walls.push(wall);
        this.selectedWallId = wall.id;
        this.updateWallList();
        this.scheduleRecompute();
      }
    }
    this.draftWall = null;
    this.drag = { kind: 'none' };
    void e;
    void pair;
    this.saveWorldDebounced();
  }

  private onWheel(e: WheelEvent, pair: CanvasPair): void {
    e.preventDefault();
    const rect = pair.canvas.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.camera.zoomAt(anchor, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    this.draw();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.draftWall = null;
      this.drag = { kind: 'none' };
      this.hypothetical.clear();
      this.refreshAnalysis();
      this.draw();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedWallId) {
      this.deleteSelectedWall();
    }
  }

  private targetToHover(t: PickTarget): HoverInfo | null {
    if (t.kind === 'floor') return null;
    if (t.kind === 'wall-body' || t.kind === 'wall-endpoint')
      return { kind: 'wall', id: t.wallId };
    if (t.kind === 'lamp-body' || t.kind === 'lamp-endpoint') return { kind: 'lamp-a' };
    if (t.kind === 'sample') return { kind: 'sample', id: t.sampleId };
    return null;
  }

  // ---------------- 墙编辑 ----------------
  private findWall(id: string): WallSegment | undefined {
    return this.world.walls.find((w) => w.id === id);
  }

  private deleteSelectedWall(): void {
    if (!this.selectedWallId) return;
    this.world.walls = this.world.walls.filter((w) => w.id !== this.selectedWallId);
    this.hypothetical.delete(this.selectedWallId);
    this.selectedWallId = null;
    this.updateWallList();
    this.recompute(false);
  }

  // ---------------- 渲染 ----------------
  private baseState(mode: HeatMode): RenderState {
    return {
      world: this.world,
      camera: this.camera,
      heat: this.heat,
      mode,
      exposure: this.exposure,
      showHeat: this.showHeat,
      tool: this.tool,
      selectedSampleId: this.selectedSampleId,
      analysis: mode === 'total' || mode === 'reflected' ? this.analysis : null,
      hover: this.hover,
      draftWall: this.draftWall,
      hypotheticalDisabled: this.hypothetical,
      selectedWallId: this.selectedWallId,
    };
  }

  private draw(): void {
    if (!this.left) return;
    this.renderer.render(this.left.ctx, this.left.cssW, this.left.cssH, this.baseState('direct'));
    this.renderer.render(this.right.ctx, this.right.cssW, this.right.cssH, this.baseState(this.rightMode));
  }

  // ---------------- 面板 ----------------
  private syncControls(): void {
    this.input('lamp-power').value = String(this.world.lamp.power);
    this.el('lamp-power-val').textContent = this.world.lamp.power.toFixed(0);
    this.input('exposure').value = String(this.exposure);
    this.el('exposure-val').textContent = this.autoExposure ? '自动' : this.exposure.toFixed(2);
    this.el('lamp-length').textContent =
      `${dist(this.world.lamp.a, this.world.lamp.b).toFixed(2)} m`;
    this.updateWallList();
    this.updateSampleList();
    if (this.probePos) this.refreshAnalysis();
  }

  private updateWallList(): void {
    const host = this.el('wall-list');
    host.innerHTML = '';
    this.world.walls.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'wall-row' + (w.id === this.selectedWallId ? ' selected' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = w.enabled;
      cb.title = '开关墙段（关闭后从遮挡与反射中移除）';
      cb.addEventListener('change', () => {
        w.enabled = cb.checked;
        if (!cb.checked) this.hypothetical.delete(w.id);
        this.recompute(false);
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `#${i + 1} ${w.id.replace(/^wall-/, '')} (${dist(w.a, w.b).toFixed(1)}m)`;
      name.title = `${w.a.x.toFixed(2)},${w.a.y.toFixed(2)} → ${w.b.x.toFixed(2)},${w.b.y.toFixed(2)}`;
      name.style.cursor = 'pointer';
      name.addEventListener('click', () => {
        this.selectedWallId = w.id;
        this.updateWallList();
        this.draw();
      });

      const color = document.createElement('input');
      color.type = 'color';
      color.value = rgbToHex(w.color);
      color.addEventListener('input', () => {
        w.color = hexToRgb(color.value);
        this.scheduleRecompute();
      });

      const del = document.createElement('button');
      del.textContent = '删';
      del.addEventListener('click', () => {
        this.selectedWallId = w.id;
        this.deleteSelectedWall();
      });

      row.append(cb, name, color, del);
      host.appendChild(row);
    });
    const btn = this.el('btn-delete-wall') as HTMLButtonElement;
    btn.disabled = !this.selectedWallId;
  }

  private updateSampleList(): void {
    const host = this.el('sample-list');
    host.innerHTML = '';
    if (!this.world.samples.length) {
      host.innerHTML = '<div class="hint">尚无取样点，切换到“加取样点”工具点击地面。</div>';
      return;
    }
    for (const s of this.world.samples) {
      const row = document.createElement('div');
      row.className = 'srow';
      const label = document.createElement('span');
      label.textContent = `${s.id.replace(/^sample-/, '')} (${s.pos.x.toFixed(2)}, ${s.pos.y.toFixed(2)})`;
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => {
        this.selectedSampleId = s.id;
        this.probePos = { ...s.pos };
        this.hypothetical.clear();
        this.refreshAnalysis();
        this.draw();
      });
      const actions = document.createElement('span');
      const locate = document.createElement('button');
      locate.textContent = '定位';
      locate.addEventListener('click', () => {
        this.selectedSampleId = s.id;
        this.probePos = { ...s.pos };
        this.refreshAnalysis();
        this.draw();
      });
      const del = document.createElement('button');
      del.textContent = '删';
      del.className = 'danger';
      del.addEventListener('click', () => {
        this.world.samples = this.world.samples.filter((x) => x.id !== s.id);
        if (this.selectedSampleId === s.id) {
          this.selectedSampleId = null;
          this.probePos = this.world.samples[0] ? { ...this.world.samples[0].pos } : null;
        }
        this.refreshAnalysis();
        this.updateSampleList();
        this.draw();
        this.saveWorldDebounced();
      });
      actions.append(locate, del);
      row.append(label, actions);
      host.appendChild(row);
    }
  }

  private updateProbePanel(): void {
    if (!this.analysis || !this.probePos) {
      this.el('probe-coord').textContent = '';
      this.el('probe-summary').innerHTML = '<div class="hint">点击地面放置探针。</div>';
      this.el('probe-contribs').innerHTML = '';
      return;
    }
    const a = this.analysis;
    this.el('probe-coord').textContent =
      `@(${this.probePos.x.toFixed(2)}, ${this.probePos.y.toFixed(2)}) m · ${a.raysUsed} 射线`;

    const sum = this.el('probe-summary');
    const directL = rgbLuma(a.direct);
    const reflL = rgbLuma(a.reflected);
    const totalL = rgbLuma(a.total);
    const hypo = this.hypoAnalysis;
    const delta = hypo ? totalL - rgbLuma(hypo.total) : 0;
    sum.innerHTML = `
      <table class="kv">
        <tr><td><span class="swatch direct"></span> 直射亮度</td><td>${directL.toFixed(4)}</td></tr>
        <tr><td><span class="swatch reflect"></span> 一次反射亮度</td><td>${reflL.toFixed(4)} (${(totalL > 0 ? (100 * reflL) / totalL : 0).toFixed(1)}%)</td></tr>
        <tr><td>合计</td><td>${totalL.toFixed(4)}</td></tr>
        ${hypo ? `<tr><td>假设关闭后合计</td><td>${rgbLuma(hypo.total).toFixed(4)}</td></tr>
        <tr><td>差值（当前−关闭）</td><td class="${delta >= 0 ? 'delta-up' : 'delta-down'}">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td></tr>` : ''}
      </table>`;

    const host = this.el('probe-contribs');
    host.innerHTML = '';
    if (!a.contributions.length) {
      host.innerHTML = '<div class="hint">该点看不到任何墙段（无反射贡献）。</div>';
    }
    a.contributions.forEach((c) => {
      const w = this.findWall(c.wallId);
      if (!w) return;
      const row = document.createElement('div');
      row.className = 'contrib-row';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = rgbToHex(w.color);
      const name = document.createElement('span');
      name.textContent = `${w.id.replace(/^wall-/, '')} · 张角 ${(c.angle * 180 / Math.PI).toFixed(1)}°`;
      const right = document.createElement('span');
      right.className = 'mono';
      const l = rgbLuma(c.irradiance);
      const pct = totalL > 0 ? (100 * l) / totalL : 0;
      right.textContent = `${l.toFixed(4)} (${pct.toFixed(1)}%)`;

      const hypoCb = document.createElement('input');
      hypoCb.type = 'checkbox';
      hypoCb.checked = this.hypothetical.has(w.id);
      hypoCb.title = '假设关闭该墙段（不改动场景）对比读数';
      hypoCb.addEventListener('change', () => {
        if (hypoCb.checked) this.hypothetical.add(w.id);
        else this.hypothetical.delete(w.id);
        this.refreshAnalysis();
        this.draw();
      });
      const wrap = document.createElement('span');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.append(right, hypoCb);
      row.append(sw, name, wrap);
      host.appendChild(row);
    });
  }

  private updateStats(): void {
    if (!this.heat) return;
    const h = this.heat;
    const spec = QUALITY_SPECS[this.quality];
    this.el('stats').innerHTML = `
      <table class="kv">
        <tr><td>档位</td><td>${spec.label}</td></tr>
        <tr><td>热图网格</td><td>${h.nx}×${h.ny} = ${h.cells.length} 点</td></tr>
        <tr><td>每点射线</td><td>${spec.floorRays}</td></tr>
        <tr><td>计算耗时</td><td>${h.elapsedMs.toFixed(0)} ms</td></tr>
        <tr><td>自动曝光基准</td><td>${h.p99Luma.toFixed(3)}</td></tr>
      </table>
      ${this.convergenceNote()}`;
    this.input('exposure').value = String(this.exposure);
    this.el('exposure-val').textContent = this.autoExposure ? '自动' : this.exposure.toFixed(2);
    this.el('lamp-power-val').textContent = this.world.lamp.power.toFixed(0);
    this.el('lamp-length').textContent =
      `${dist(this.world.lamp.a, this.world.lamp.b).toFixed(2)} m`;
  }

  private convergenceNote(): string {
    // 快预览档位下，额外用密网格在取样点上做一次对照（惰性、只算几个点）
    if (this.quality !== 'quick' || !this.heat) return '';
    const denseEngine = new LightEngine(this.world, QUALITY_SPECS.dense);
    const checks = this.world.samples.slice(0, 4);
    const rows = checks
      .map((s) => {
        const q = this.engine.analyzeFloor(s.pos, false);
        const d = denseEngine.analyzeFloor(s.pos, false);
        const diff = Math.abs(rgbLuma(q.total) - rgbLuma(d.total));
        const rel = rgbLuma(d.total) > 1e-9 ? (100 * diff) / rgbLuma(d.total) : 0;
        return `<tr><td>${s.id.replace(/^sample-/, '')}</td><td class="mono">${rel.toFixed(1)}%</td></tr>`;
      })
      .join('');
    return `<div class="hint" style="margin-top:6px">快预览 vs 密集取样（同点相对差）</div>
      <table class="kv">${rows}</table>`;
  }

  // ---------------- 持久化 / 导入导出 ----------------
  private saveTimer: number | undefined;
  private saveWorldDebounced(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveWorld(), 400);
  }

  private saveWorld(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.world));
    } catch {
      /* 存储不可用时静默 */
    }
  }

  private loadWorld(): World | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as World;
      if (!parsed.room || !Array.isArray(parsed.walls) || !parsed.lamp) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private exportJson(): void {
    const blob = new Blob([JSON.stringify(this.world, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diffuse-lab-world.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  private importJson(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as World;
        if (!parsed.room || !Array.isArray(parsed.walls) || !parsed.lamp)
          throw new Error('bad shape');
        this.loadPreset(parsed);
      } catch {
        this.setStatusHint('导入失败：JSON 结构不符合场景格式');
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  // ---------------- 杂项 ----------------
  private clampToRoom(p: Vec2): Vec2 {
    const r = this.world.room;
    return {
      x: Math.min(r.x + r.w, Math.max(r.x, p.x)),
      y: Math.min(r.y + r.h, Math.max(r.y, p.y)),
    };
  }

  private setStatusCoord(wp: Vec2): void {
    this.el('status-coord').textContent =
      `世界坐标: ${wp.x.toFixed(3)}, ${wp.y.toFixed(3)} m`;
  }
  private setStatusHint(text: string): void {
    this.el('status-hint').textContent = text;
  }

  // 供调试/测试读取
  getWorld(): World {
    return this.world;
  }
  getHeat(): HeatMap | null {
    return this.heat;
  }
  /** 供自动化测试访问相机 */
  cameraRef(): Camera {
    return this.camera;
  }
  cssForIrrad(c: IrradianceRGB): string {
    return mapIrradToCss(c, this.exposure);
  }
}
