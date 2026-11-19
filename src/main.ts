/**
 * main.ts — 应用主控
 *
 * 职责：
 *  - 持有场景状态（光源、挡板、预设、检查点），所有参数以 900×600 逻辑坐标存储
 *  - 面积/点光源两个视图各持一个渲染器（WebGL，失败回退 CPU 栅格）
 *  - 拖动光源与挡板；非法位置拒绝并保留上次有效状态，红色虚像提示
 *  - 自动扫动、检查点定位、检查点可见比例读数（解析 + 光线 + GPU 读回三方一致）
 *  - 运行独立核对并渲染结果表
 */

import { Circle, Poly, Vec2 } from './core/geometry';
import {
  Checkpoint,
  MAX_POLYS,
  Preset,
  ROOM_H,
  ROOM_W,
  WALL,
  lightPlacementInvalid,
  makePresets,
  polyPlacementInvalid,
} from './core/presets';
import {
  Scene,
  analyticVisibility,
  pointVisibility,
  rangeFactor,
  sampledVisibility,
} from './core/visibility';
import { runVerification } from './core/verifier';
import { createGlRenderer, GlHandles, readPixelGl, renderGl } from './render/glRenderer';
import { createCpuRenderer, CpuRenderer } from './render/cpuRenderer';
import {
  OverlayState,
  ViewMap,
  computeViewMap,
  drawOverlay,
  screenToWorld,
  worldToScreen,
} from './render/overlay';

interface FieldRenderer {
  kind: 'webgl' | 'cpu';
  render: (p: {
    light: Circle;
    polys: Poly[];
    range: number;
    brightness: number;
    pointMode: boolean;
    viewW: number;
    viewH: number;
  }) => void;
  readPixel: (world: Vec2, viewW: number, viewH: number) => [number, number, number];
}

interface AppState {
  presets: Preset[];
  presetIndex: number;
  light: Circle; // 上次有效光源
  polys: Poly[];
  range: number;
  brightness: number;
  auto: boolean;
  autoT: number;
  activeCheckpoint: number;
  ghostLight: Circle | null;
  dragPolyId: number | null;
  status: { text: string; error: boolean };
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function makeField(canvas: HTMLCanvasElement): { r: FieldRenderer; label: string } {
  try {
    const handles: GlHandles = createGlRenderer(canvas);
    const r: FieldRenderer = {
      kind: 'webgl',
      render: (p) => renderGl(handles, p),
      readPixel: (world, vw, vh) => readPixelGl(handles, world, vw, vh),
    };
    return { r, label: 'WebGL 片元着色器' };
  } catch (e) {
    const cpu: CpuRenderer = createCpuRenderer(canvas);
    const r: FieldRenderer = {
      kind: 'cpu',
      render: (p) => cpu.render(p),
      readPixel: (world) => cpu.readPixel(world),
    };
    return { r, label: `CPU 回退栅格（${(e as Error).message.slice(0, 40)}）` };
  }
}

class App {
  private state!: AppState;
  private area!: FieldRenderer;
  private point!: FieldRenderer;
  private areaCanvas: HTMLCanvasElement;
  private pointCanvas: HTMLCanvasElement;
  private areaOverlay: HTMLCanvasElement;
  private pointOverlay: HTMLCanvasElement;
  private areaMap: ViewMap = { scale: 1, offsetX: 0, offsetY: 0, cssW: 1, cssH: 1 };
  private pointMap: ViewMap = { scale: 1, offsetX: 0, offsetY: 0, cssW: 1, cssH: 1 };
  private drag:
    | { kind: 'light'; box: 'area' | 'point' }
    | { kind: 'poly'; id: number; grab: Vec2; box: 'area' | 'point' }
    | null = null;
  private dirty = true;
  private lastTime = 0;

  constructor() {
    this.areaCanvas = $<HTMLCanvasElement>('areaCanvas');
    this.pointCanvas = $<HTMLCanvasElement>('pointCanvas');
    this.areaOverlay = $<HTMLCanvasElement>('areaOverlay');
    this.pointOverlay = $<HTMLCanvasElement>('pointOverlay');

    const a = makeField(this.areaCanvas);
    const b = makeField(this.pointCanvas);
    this.area = a.r;
    this.point = b.r;
    $('engineBadge').textContent = `面积视图: ${a.label} ｜ 对照视图: ${b.label}`;

    const presets = makePresets();
    this.state = {
      presets,
      presetIndex: 0,
      light: { ...presets[0].light, c: { ...presets[0].light.c } },
      polys: presets[0].polys.map((p) => ({ id: p.id, verts: p.verts.map((q) => ({ ...q })) })),
      range: presets[0].range,
      brightness: presets[0].brightness,
      auto: true,
      autoT: 0,
      activeCheckpoint: 0,
      ghostLight: null,
      dragPolyId: null,
      status: { text: '就绪：拖动光源圆盘或挡板试试', error: false },
    };

    this.bindUi();
    this.bindPointer($('areaBox'), 'area');
    this.bindPointer($('pointBox'), 'point');

    const ro = new ResizeObserver(() => this.resize());
    ro.observe($('areaBox'));
    ro.observe($('pointBox'));
    this.resize();
    this.syncSliders();
    this.buildPresetButtons();
    this.buildCheckpointButtons();

    this.lastTime = performance.now();
    const loop = (t: number): void => {
      const dt = Math.min(0.05, (t - this.lastTime) / 1000);
      this.lastTime = t;
      if (this.state.auto && !this.drag) this.stepAuto(dt);
      if (this.dirty) {
        this.renderBoth();
        this.updateReadout();
        this.dirty = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    // 调试/自动化钩子：暴露逻辑坐标→画布盒 CSS 坐标的精确映射与当前状态
    (window as unknown as { __softShadow: unknown }).__softShadow = {
      worldToCss: (p: Vec2, which: 'area' | 'point'): Vec2 => {
        const m = which === 'area' ? this.areaMap : this.pointMap;
        return worldToScreen(p, m);
      },
      getState: () => ({
        light: this.state.light,
        polys: this.state.polys,
        auto: this.state.auto,
        ghost: this.state.ghostLight,
      }),
      pause: (): void => {
        this.state.auto = false;
        $('autoBtn').textContent = '开始自动移动';
      },
    };
  }

  // ---------- UI 绑定 ----------

  private bindUi(): void {
    $('radiusSlider').addEventListener('input', (e) => {
      const r = Number((e.target as HTMLInputElement).value);
      this.applyLight({ ...this.state.light, r });
    });
    $('brightnessSlider').addEventListener('input', (e) => {
      this.state.brightness = Number((e.target as HTMLInputElement).value);
      $('brightnessVal').textContent = this.state.brightness.toFixed(2);
      this.dirty = true;
    });
    $('rangeSlider').addEventListener('input', (e) => {
      this.state.range = Number((e.target as HTMLInputElement).value);
      $('rangeVal').textContent = String(Math.round(this.state.range));
      this.dirty = true;
    });
    $('autoBtn').addEventListener('click', () => {
      this.state.auto = !this.state.auto;
      $('autoBtn').textContent = this.state.auto ? '暂停自动移动' : '开始自动移动';
      this.setStatus(this.state.auto ? '自动移动已开启' : '自动移动已暂停，可定位检查点或手动拖动', false);
    });
    $('resetBtn').addEventListener('click', () => this.loadPreset(this.state.presetIndex));
    $('verifyBtn').addEventListener('click', () => this.runVerify());
  }

  private buildPresetButtons(): void {
    const row = $('presetRow');
    row.innerHTML = '';
    this.state.presets.forEach((p, i) => {
      const btn = document.createElement('button');
      btn.textContent = p.label;
      if (i === this.state.presetIndex) btn.classList.add('active');
      btn.addEventListener('click', () => this.loadPreset(i));
      row.appendChild(btn);
    });
    $('presetDesc').textContent = this.state.presets[this.state.presetIndex].desc;
  }

  private buildCheckpointButtons(): void {
    const row = $('checkpointRow');
    row.innerHTML = '';
    this.currentPreset().checkpoints.forEach((cp, i) => {
      const btn = document.createElement('button');
      btn.textContent = cp.name;
      if (i === this.state.activeCheckpoint) btn.classList.add('active');
      btn.addEventListener('click', () => {
        // 定位检查点前先暂停自动移动，避免位置被扫动覆盖
        this.state.auto = false;
        $('autoBtn').textContent = '开始自动移动';
        this.state.activeCheckpoint = i;
        this.buildCheckpointButtons();
        this.dirty = true;
        this.setStatus(`已定位检查点 ${cp.name}（自动移动已暂停）`, false);
      });
      row.appendChild(btn);
    });
  }

  private syncSliders(): void {
    const s = $('radiusSlider') as HTMLInputElement;
    s.value = String(this.state.light.r);
    $('radiusVal').textContent = String(Math.round(this.state.light.r));
    const b = $('brightnessSlider') as HTMLInputElement;
    b.value = String(this.state.brightness);
    $('brightnessVal').textContent = this.state.brightness.toFixed(2);
    const rg = $('rangeSlider') as HTMLInputElement;
    rg.value = String(this.state.range);
    $('rangeVal').textContent = String(Math.round(this.state.range));
  }

  private loadPreset(index: number): void {
    const p = this.state.presets[index];
    this.state.presetIndex = index;
    this.state.light = { ...p.light, c: { ...p.light.c } };
    this.state.polys = p.polys.map((q) => ({ id: q.id, verts: q.verts.map((z) => ({ ...z })) }));
    this.state.range = p.range;
    this.state.brightness = p.brightness;
    this.state.autoT = 0;
    this.state.ghostLight = null;
    this.state.activeCheckpoint = 0;
    this.buildPresetButtons();
    this.buildCheckpointButtons();
    this.syncSliders();
    $('presetDesc').textContent = p.desc;
    this.setStatus(`已载入样例「${p.label}」`, false);
    this.dirty = true;
  }

  // ---------- 光源合法性 ----------

  /** 尝试应用新光源；非法时保留上次有效状态并挂虚像 */
  private applyLight(candidate: Circle): void {
    const reason = lightPlacementInvalid(candidate, this.state.polys);
    if (reason) {
      this.state.ghostLight = candidate;
      this.setStatus(`${reason}：暂停应用，保留上次有效光照`, true);
      this.dirty = true;
      return;
    }
    this.state.light = candidate;
    this.state.ghostLight = null;
    $('radiusVal').textContent = String(Math.round(candidate.r));
    ($('radiusSlider') as HTMLInputElement).value = String(candidate.r);
    this.setStatus('光源位置有效', false);
    this.dirty = true;
  }

  private setStatus(text: string, error: boolean): void {
    this.state.status = { text, error };
    const el = $('statusMsg');
    el.textContent = text;
    el.className = `status ${error ? 'err' : 'ok'}`;
  }

  // ---------- 自动移动 ----------

  private stepAuto(dt: number): void {
    const p = this.currentPreset();
    this.state.autoT += dt * 0.5;
    const t = (Math.sin(this.state.autoT * Math.PI) + 1) / 2; // 0..1 来回
    const x = p.auto.x0 + (p.auto.x1 - p.auto.x0) * t;
    const candidate: Circle = { c: { x, y: p.auto.y }, r: this.state.light.r };
    const reason = lightPlacementInvalid(candidate, this.state.polys);
    if (reason) {
      // 扫动途中遇到非法位置：冻结在当前有效位置，不刷新光照
      this.state.ghostLight = candidate;
      this.setStatus(`自动移动遇阻（${reason}），保持上次有效位置`, true);
      this.dirty = true;
    } else {
      this.state.light = candidate;
      this.state.ghostLight = null;
      this.dirty = true;
    }
  }

  private currentPreset(): Preset {
    return this.state.presets[this.state.presetIndex];
  }

  // ---------- 指针交互 ----------

  private bindPointer(box: HTMLElement, which: 'area' | 'point'): void {
    const map = (): ViewMap => (which === 'area' ? this.areaMap : this.pointMap);
    box.addEventListener('pointerdown', (ev) => {
      const rect = box.getBoundingClientRect();
      const sp = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      const wp = screenToWorld(sp, map());
      // 优先命中光源（含虚像圆心，便于把非法位置拖回合法区）
      const target = this.state.ghostLight ?? this.state.light;
      if (Math.hypot(wp.x - target.c.x, wp.y - target.c.y) <= Math.max(target.r, 14)) {
        this.drag = { kind: 'light', box: which };
        box.setPointerCapture(ev.pointerId);
        return;
      }
      // 命中挡板
      for (let i = this.state.polys.length - 1; i >= 0; i--) {
        const poly = this.state.polys[i];
        if (this.hitPoly(wp, poly)) {
          const c = this.polyCenter(poly);
          this.drag = { kind: 'poly', id: poly.id, grab: { x: wp.x - c.x, y: wp.y - c.y }, box: which };
          this.state.dragPolyId = poly.id;
          box.setPointerCapture(ev.pointerId);
          this.dirty = true;
          return;
        }
      }
    });

    box.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      const rect = box.getBoundingClientRect();
      const sp = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      const wp = screenToWorld(sp, map());
      if (this.drag.kind === 'light') {
        const c = this.clampRoom(wp, this.state.light.r);
        this.applyLight({ ...this.state.light, c });
      } else {
        this.movePoly(this.drag.id, { x: wp.x - this.drag.grab.x, y: wp.y - this.drag.grab.y });
      }
    });

    const end = (): void => {
      if (this.drag?.kind === 'poly') this.state.dragPolyId = null;
      this.drag = null;
      this.dirty = true;
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  private clampRoom(p: Vec2, r: number): Vec2 {
    return {
      x: Math.max(WALL + r, Math.min(ROOM_W - WALL - r, p.x)),
      y: Math.max(WALL + r, Math.min(ROOM_H - WALL - r, p.y)),
    };
  }

  private hitPoly(p: Vec2, poly: Poly): boolean {
    let inside = true;
    for (let i = 0; i < poly.verts.length; i++) {
      const a = poly.verts[i];
      const b = poly.verts[(i + 1) % poly.verts.length];
      const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cr < -1e-9) {
        inside = false;
        break;
      }
    }
    if (inside) return true;
    // 边缘容错：距某条边 8 逻辑单位内也算命中
    for (let i = 0; i < poly.verts.length; i++) {
      const a = poly.verts[i];
      const b = poly.verts[(i + 1) % poly.verts.length];
      const ab = { x: b.x - a.x, y: b.y - a.y };
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2)));
      const near = { x: a.x + ab.x * t, y: a.y + ab.y * t };
      if (Math.hypot(near.x - p.x, near.y - p.y) <= 8) return true;
    }
    return false;
  }

  private polyCenter(poly: Poly): Vec2 {
    const c = { x: 0, y: 0 };
    for (const q of poly.verts) {
      c.x += q.x;
      c.y += q.y;
    }
    c.x /= poly.verts.length;
    c.y /= poly.verts.length;
    return c;
  }

  private movePoly(id: number, newCenter: Vec2): void {
    const poly = this.state.polys.find((q) => q.id === id);
    if (!poly) return;
    const old = this.polyCenter(poly);
    const dx = newCenter.x - old.x;
    const dy = newCenter.y - old.y;
    const moved = poly.verts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    const reason = polyPlacementInvalid(moved, poly, this.state.polys, this.state.light);
    if (reason) {
      this.setStatus(reason, true);
      return; // 保留上次有效位置
    }
    poly.verts = moved;
    this.setStatus('挡板位置有效', false);
    this.dirty = true;
  }

  // ---------- 尺寸与渲染 ----------

  private resize(): void {
    // GL 画布按逻辑房间保持最小分辨率，避免小窗口下粗像素吞掉半影梯度；
    // 上限 1400 兼顾高分屏性能。覆盖层仍跟随 CSS/DPR，保证标注清晰。
    const MIN_GL = 900;
    const MAX_GL = 1400;
    const fit = (
      box: HTMLElement,
      canvas: HTMLCanvasElement,
      overlay: HTMLCanvasElement,
    ): ViewMap => {
      const cssW = box.clientWidth;
      const cssH = box.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const map = computeViewMap(cssW, cssH);
      const glScale = Math.max(MIN_GL / ROOM_W, Math.min(MAX_GL / ROOM_W, (cssW * dpr) / ROOM_W));
      canvas.width = Math.round(ROOM_W * glScale);
      canvas.height = Math.round(ROOM_H * glScale);
      overlay.width = Math.round(cssW * dpr);
      overlay.height = Math.round(cssH * dpr);
      const octx = overlay.getContext('2d');
      octx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      return map;
    };
    this.areaMap = fit($('areaBox'), this.areaCanvas, this.areaOverlay);
    this.pointMap = fit($('pointBox'), this.pointCanvas, this.pointOverlay);
    this.dirty = true;
  }

  private sceneParams(pointMode: boolean) {
    return {
      light: this.state.light,
      polys: this.state.polys.slice(0, MAX_POLYS),
      range: this.state.range,
      brightness: this.state.brightness,
      pointMode,
    };
  }

  private renderBoth(): void {
    this.area.render({ ...this.sceneParams(false), viewW: this.areaCanvas.width, viewH: this.areaCanvas.height });
    this.point.render({ ...this.sceneParams(true), viewW: this.pointCanvas.width, viewH: this.pointCanvas.height });

    const drawOne = (
      overlay: HTMLCanvasElement,
      map: ViewMap,
      pointMode: boolean,
    ): void => {
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      const cps: Checkpoint[] = this.currentPreset().checkpoints;
      const ostate: OverlayState = {
        light: this.state.light,
        range: this.state.range,
        ghostLight: this.state.ghostLight,
        polys: this.state.polys,
        dragPolyId: this.state.dragPolyId,
        checkpoints: cps,
        activeCheckpoint: this.state.activeCheckpoint,
        pointMode,
        hover: null,
      };
      drawOverlay(ctx, map, ostate);
    };
    drawOne(this.areaOverlay, this.areaMap, false);
    drawOne(this.pointOverlay, this.pointMap, true);
  }

  // ---------- 检查点读数 ----------

  private updateReadout(): void {
    const cp = this.currentPreset().checkpoints[this.state.activeCheckpoint];
    const scene: Scene = {
      light: this.state.light,
      polys: this.state.polys,
      range: this.state.range,
      brightness: this.state.brightness,
    };
    const areaVis = analyticVisibility(cp.p, scene);
    const sample = sampledVisibility(cp.p, scene, 64, true);
    const pointVis = pointVisibility(cp.p, scene);
    const fall = rangeFactor(cp.p, scene);
    const [pr] = this.area.readPixel(cp.p, this.areaCanvas.width, this.areaCanvas.height);
    // 反推 GPU 像素中的直射分量：col = floor * (amb + direct*0.9)
    const gpuDirect = (pr / 255 / 0.86 - 0.1) / 0.9;
    // 仅当直射项在画面中可分辨时反推可见度；范围外只剩环境光，读数无意义
    const denom = fall * this.state.brightness;
    const gpuVis = denom > 0.05 ? Math.max(0, Math.min(1, gpuDirect / denom)) : null;

    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    $('readout').innerHTML = `
      <div class="row"><span class="k">检查点</span><span class="b">${cp.name}（${cp.expect}）</span></div>
      <div class="row"><span class="k">逻辑坐标</span><span class="b">(${cp.p.x.toFixed(0)}, ${cp.p.y.toFixed(0)})</span></div>
      <div class="row"><span class="k">面积光源可见比例（解析）</span><span class="b">${pct(areaVis)}</span></div>
      <div class="row"><span class="k">64 条光线采样</span><span class="b">${pct(sample.vis)}（偏差 ${Math.abs(sample.vis - areaVis).toFixed(4)}）</span></div>
      <div class="row"><span class="k">点光源对照可见度</span><span class="b">${pointVis === 1 ? '100%（亮）' : '0%（硬阴影）'}</span></div>
      <div class="row"><span class="k">距离衰减系数</span><span class="b">${fall.toFixed(3)}</span></div>
      <div class="row"><span class="k">画面像素反推可见度</span><span class="b">${gpuVis === null ? '范围外，仅环境光' : pct(gpuVis)}</span></div>
    `;
  }

  // ---------- 核对 ----------

  private runVerify(): void {
    const { rows, allPass } = runVerification(256);
    const tbody = $('verifyTable').querySelector('tbody') as HTMLTableSectionElement;
    tbody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      const bound = Math.max(r.detBound, r.mc95);
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${r.expected.toFixed(3)}</td>
        <td>${r.analytic.toFixed(4)}</td>
        <td>${r.sampled.toFixed(4)}<br><span style="color:var(--muted)">${r.hits}/${r.rays}</span></td>
        <td>${r.actualDiff.toFixed(4)}</td>
        <td>±${bound.toFixed(4)}</td>
        <td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '通过' : '失败'}</td>
      `;
      tbody.appendChild(tr);
    }
    $('verifySummary').textContent = allPass
      ? `全部 ${rows.length} 项通过。采样确定性误差界 2/N=${(2 / 256).toFixed(4)}，MC 95% 半宽按二项分布逐项计算；实际偏差均在界内。`
      : '存在未通过项，请查看标红行。';
    this.setStatus(allPass ? '独立核对全部通过' : '独立核对存在失败项', !allPass);
  }
}

new App();
