import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  PRESETS,
  clonePreset,
  hexToRgb,
  BACKGROUND_COLOR,
  type Preset,
  type CheckpointDef,
} from './presets';
import { buildMeshes, syncMeshesToParams, evaluateRay, type SceneMeshes } from './geometry';
import {
  compositeFragments,
  compositeByDrawOrder,
  colorToBytes,
  maxChannelError,
  type Fragment,
} from './blend';
import { Compositor, type CompositeMode } from './render';

const TOL_DEFAULT = 3; // 每通道容差(0..255 口径):8-bit RT 量化 ±1,亚像素采样再留余量
const TOL_TIE = 80; // 交线点:两面深度精确相等,平局归属由光栅化决定,叠色差异较大属预期

interface EvalInfo {
  cp: CheckpointDef | { id: string; name: string; ndc: [number, number]; situation: string };
  fragments: Fragment[];
  expectedBytes: [number, number, number];
  observed: [number, number, number] | null;
  error: number | null;
  tolerance: number;
  manualBytes: [number, number, number] | null;
}

export class App {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private compositor: Compositor;
  private panel = document.getElementById('panel')!;
  private hud = document.getElementById('hud')!;
  private wrap = document.getElementById('canvas-wrap')!;

  private preset: Preset = clonePreset(PRESETS[0]);
  private meshes!: SceneMeshes;
  private mode: CompositeMode = 'correct';
  private manualOrder: string[] = [];
  private selectedCpId: string | null = null;
  private customNdc: [number, number] | null = null;
  private autoRotate = true;
  private lastEvalTime = 0;
  private markerEls = new Map<string, HTMLDivElement>();
  private bgRgb: [number, number, number];

  constructor() {
    THREE.ColorManagement.enabled = false;
    this.canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = true;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.2;

    this.bgRgb = hexToRgb(BACKGROUND_COLOR);
    this.compositor = new Compositor(this.renderer, this.camera, BACKGROUND_COLOR);

    this.loadPreset(PRESETS[0].id, true);
    this.bindGlobalEvents();
    this.resize();
    this.animate();
  }

  // ---------- 场景装载 ----------

  private loadPreset(id: string, initial = false): void {
    const def = PRESETS.find((p) => p.id === id)!;
    this.preset = clonePreset(def);
    this.meshes = buildMeshes(this.preset);
    this.manualOrder = this.preset.surfaces.map((s) => s.id);
    this.customNdc = null;
    this.selectedCpId = this.preset.checkpoints[0]?.id ?? null;
    this.resetCamera();
    if (!initial) this.autoRotate = true;
    this.controls.autoRotate = this.autoRotate;
    this.buildPanel();
    this.buildMarkers();
    this.updateHud();
  }

  private resetCamera(): void {
    const c = this.preset.camera;
    this.camera.position.set(...c.position);
    this.controls.target.set(...c.target);
    this.camera.lookAt(...c.target);
    this.controls.update();
  }

  private restorePreset(): void {
    this.loadPreset(this.preset.id);
  }

  // ---------- 事件 ----------

  private bindGlobalEvents(): void {
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.canvas.addEventListener('click', (e) => this.onCanvasClick(e));
  }

  private onCanvasClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.customNdc = [ndcX, ndcY];
    this.selectedCpId = '__custom';
    this.buildMarkers();
    this.refreshEval(true);
  }

  private resize(): void {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.compositor.setSize(buf.x, buf.y);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.positionMarkers();
  }

  // ---------- 渲染循环 ----------

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.autoRotate = this.autoRotate;
    this.controls.update();
    syncMeshesToParams(this.preset, this.meshes);

    this.compositor.mode = this.mode;
    this.compositor.manualOrder = this.manualOrder;
    this.compositor.render(this.meshes);
    this.compositor.blitToScreen();

    const now = performance.now();
    if (now - this.lastEvalTime > 250) {
      this.lastEvalTime = now;
      this.refreshEval(false);
      this.positionMarkers();
    }
  };

  // ---------- 检查点 ----------

  private readPixel(ndcX: number, ndcY: number): [number, number, number] {
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = Math.min(buf.x - 1, Math.max(0, Math.floor(((ndcX + 1) / 2) * buf.x)));
    // readRenderTargetPixels 与 NDC 的原点都在左下、+y 朝上,直接线性映射即可,
    // 不能再做高度翻转(屏幕 CSS 坐标→NDC 的翻转已在 onCanvasClick 里处理)。
    const py = Math.min(buf.y - 1, Math.max(0, Math.floor(((ndcY + 1) / 2) * buf.y)));
    const data = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(
      this.compositor.outputTarget,
      px,
      py,
      1,
      1,
      data,
    );
    // 显式取 RGB 三元组,不能把 4 字节(RGBA)数组直接当成三元组
    return [data[0], data[1], data[2]] as [number, number, number];
  }

  private evaluate(cpNdc: [number, number]): {
    fragments: Fragment[];
    expectedBytes: [number, number, number];
    manualBytes: [number, number, number] | null;
  } {
    this.camera.updateMatrixWorld(true);
    this.meshes.transparent.forEach((m) => m.updateMatrixWorld(true));
    this.meshes.occluder?.updateMatrixWorld(true);

    const fragments = evaluateRay(this.camera, this.meshes, cpNdc[0], cpNdc[1]);
    const expected = compositeFragments(fragments, this.bgRgb);

    let manualBytes: [number, number, number] | null = null;
    if (this.mode === 'manual') {
      const r = compositeByDrawOrder(fragments, this.manualOrder, this.bgRgb);
      manualBytes = colorToBytes(r.color);
    }
    return { fragments, expectedBytes: colorToBytes(expected.color), manualBytes };
  }

  private collectEval(): EvalInfo[] {
    const infos: EvalInfo[] = [];
    for (const cp of this.preset.checkpoints) {
      const { fragments, expectedBytes, manualBytes } = this.evaluate(cp.ndc);
      const observed = this.readPixel(cp.ndc[0], cp.ndc[1]);
      const tolerance = cp.id === 'cp-line' ? TOL_TIE : TOL_DEFAULT;
      infos.push({
        cp,
        fragments,
        expectedBytes,
        observed,
        error: maxChannelError(observed, expectedBytes),
        tolerance,
        manualBytes,
      });
    }
    if (this.customNdc) {
      const { fragments, expectedBytes, manualBytes } = this.evaluate(this.customNdc);
      const observed = this.readPixel(this.customNdc[0], this.customNdc[1]);
      infos.push({
        cp: {
          id: '__custom',
          name: '临时检查点(单击画面)',
          ndc: this.customNdc,
          situation: '用户在画面上选取的像素',
        },
        fragments,
        expectedBytes,
        observed,
        error: maxChannelError(observed, expectedBytes),
        tolerance: TOL_DEFAULT,
        manualBytes,
      });
    }
    return infos;
  }

  private refreshEval(forceDom: boolean): void {
    const list = this.collectEval();
    const container = document.getElementById('cp-results');
    if (!container) return;
    // 节流刷新:结果数字每帧级更新直接重建(节点很少,开销可忽略)
    container.innerHTML = list.map((info) => this.renderEval(info)).join('');
    if (forceDom) this.positionMarkers();
  }

  private renderEval(info: EvalInfo): string {
    const pass = info.error !== null && info.error <= info.tolerance;
    const sel = this.selectedCpId === info.cp.id ? 'selected' : '';
    const surfRows = info.fragments.length
      ? info.fragments
          .map((f, i) => {
            const rgb = colorToBytes(f.color);
            return `<tr>
              <td>${i + 1}${f.opaque ? ' ·挡板' : ''}</td>
              <td><span class="swatch" style="background:rgb(${rgb.join(',')})"></span>${f.name}</td>
              <td>${f.depth.toFixed(3)}</td>
              <td>${f.alpha.toFixed(2)}</td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="4" class="muted">该视线上没有表面(背景)</td></tr>`;

    const verdictCls = pass ? 'pass' : 'fail';
    const modeNote =
      this.mode !== 'correct' && !pass
        ? `<div class="small fail">与正确口径不一致 —— 这正是${
            this.mode === 'naive' ? '物体级排序' : '手动绘制顺序'
          }的局限,切回"正确合成"应对齐</div>`
        : '';
    const manualLine =
      info.manualBytes !== null
        ? `<div class="small">手动顺序解析值:rgb(${info.manualBytes.join(', ')})(应与画面读回一致)</div>`
        : '';

    return `<div class="cp-item ${sel}" data-cp="${info.cp.id}">
      <div class="cp-title">${info.cp.name}</div>
      <div class="cp-sit">${info.cp.situation}</div>
      <table class="cp-table">
        <tr><th>次序</th><th>表面(近→远)</th><th>深度</th><th>α</th></tr>
        ${surfRows}
      </table>
      <table class="cp-table" style="margin-top:6px">
        <tr><th>正确口径预期</th><td>rgb(${info.expectedBytes.join(', ')})</td></tr>
        <tr><th>画面读回</th><td>rgb(${info.observed?.join(', ') ?? '—'})</td></tr>
        <tr><th>最大通道误差</th><td class="${verdictCls}">${info.error ?? '—'} / 容差 ±${info.tolerance} ${pass ? '✓ 对齐' : '✗ 偏离'}</td></tr>
      </table>
      ${manualLine}
      ${modeNote}
    </div>`;
  }

  // ---------- 屏幕标记 ----------

  private buildMarkers(): void {
    document.querySelectorAll('.cp-marker').forEach((el) => el.remove());
    this.markerEls.clear();
    for (const cp of this.preset.checkpoints) {
      const el = document.createElement('div');
      el.className = 'cp-marker';
      el.title = cp.name;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.selectedCpId = cp.id;
        this.refreshEval(true);
      });
      this.wrap.appendChild(el);
      this.markerEls.set(cp.id, el);
    }
    if (this.customNdc) {
      const el = document.createElement('div');
      el.className = 'cp-marker custom';
      el.title = '临时检查点';
      this.wrap.appendChild(el);
      this.markerEls.set('__custom', el);
    }
    this.positionMarkers();
  }

  private positionMarkers(): void {
    const place = (id: string, ndc: [number, number]) => {
      const el = this.markerEls.get(id);
      if (!el) return;
      const left = ((ndc[0] + 1) / 2) * 100;
      const top = ((1 - ndc[1]) / 2) * 100;
      el.style.left = `calc(${left}% - 7px)`;
      el.style.top = `calc(${top}% - 7px)`;
      el.classList.toggle('selected', this.selectedCpId === id);
    };
    this.preset.checkpoints.forEach((cp) => place(cp.id, cp.ndc));
    if (this.customNdc) place('__custom', this.customNdc);
  }

  // ---------- HUD ----------

  private updateHud(): void {
    const modeLabel: Record<CompositeMode, string> = {
      correct: '正确合成(逐像素深度排序)',
      naive: '普通物体排序(three.js 距离排序)',
      manual: '手动交换绘制顺序',
    };
    const order =
      this.mode === 'manual'
        ? this.manualOrder
            .map((id, i) => `${i + 1}.${this.nameOf(id)}`)
            .join(' → ')
        : this.mode === 'naive'
          ? 'three.js 按相机空间距离自动排序'
          : '逐像素独立排序,与物体顺序无关';
    this.hud.innerHTML =
      `<span class="mode-${this.mode}">模式:${modeLabel[this.mode]}</span>\n` +
      `场景:${this.preset.name}\n绘制顺序:${order}`;
  }

  private nameOf(id: string): string {
    return this.preset.surfaces.find((s) => s.id === id)?.name ?? id;
  }

  // ---------- 右侧面板 ----------

  private buildPanel(): void {
    this.panel.innerHTML = `
      <div class="card">
        <h2>预设场景(可重置)</h2>
        <div class="preset-btns">
          ${PRESETS.map(
            (p) =>
              `<button data-preset="${p.id}" class="${p.id === this.preset.id ? 'active' : ''}">${p.name}</button>`,
          ).join('')}
        </div>
        <p class="desc">${this.preset.description}</p>
        <div class="row">
          <button id="btn-restore" class="primary">恢复预设参数</button>
          <button id="btn-camera">切回指定视角</button>
          <button id="btn-rotate">${this.autoRotate ? '暂停自动旋转' : '恢复自动旋转'}</button>
        </div>
      </div>

      <div class="card">
        <h2>合成模式(共用同一相机与场景状态)</h2>
        <div class="mode-btns">
          <button data-mode="correct" class="${this.mode === 'correct' ? 'active' : ''}">正确合成</button>
          <button data-mode="naive" class="${this.mode === 'naive' ? 'active' : ''}">普通物体排序</button>
          <button data-mode="manual" class="${this.mode === 'manual' ? 'active' : ''}">手动顺序</button>
        </div>
        <div id="manual-box"></div>
      </div>

      <div class="card">
        <h2>透明物体参数</h2>
        <div id="param-box"></div>
      </div>

      <div class="card">
        <h2>检查点(表面次序 / 预期叠色 / 读回核对)</h2>
        <p class="small">口径:颜色为直色 0..255,source-over 混合,关闭颜色管理;
        容差 ±${TOL_DEFAULT}(交线点 ±${TOL_TIE})。单击画面可加临时检查点。</p>
        <div id="cp-results"></div>
      </div>
    `;

    this.panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => this.loadPreset(b.dataset.preset!)),
    );
    this.panel.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode as CompositeMode;
        this.buildPanel();
        this.updateHud();
      }),
    );
    document.getElementById('btn-restore')!.addEventListener('click', () => this.restorePreset());
    document.getElementById('btn-camera')!.addEventListener('click', () => this.resetCamera());
    document.getElementById('btn-rotate')!.addEventListener('click', () => {
      this.autoRotate = !this.autoRotate;
      this.buildPanel();
    });

    this.buildManualBox();
    this.buildParamBox();
    this.updateHud();
  }

  private buildManualBox(): void {
    const box = document.getElementById('manual-box')!;
    if (this.mode !== 'manual') {
      box.innerHTML = `<p class="small" style="margin-top:8px">当前模式不使用手动顺序。切到"手动顺序"后可调整。</p>`;
      return;
    }
    box.innerHTML = `
      <p class="small" style="margin:8px 0 4px">先绘制(底层)→ 后绘制(顶层),调整后正确模式结果不变、本模式画面改变:</p>
      ${this.manualOrder
        .map(
          (id, i) => `
        <div class="order-line">
          <span class="name"><span class="swatch" style="background:#${this.preset.surfaces
            .find((s) => s.id === id)!
            .color.toString(16)
            .padStart(6, '0')}"></span>${i + 1}. ${this.nameOf(id)}</span>
          <button data-move="${id}" data-dir="up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-move="${id}" data-dir="down" ${
            i === this.manualOrder.length - 1 ? 'disabled' : ''}
          >↓</button>
        </div>`,
        )
        .join('')}
      <div class="row"><button id="btn-swap">交换两个面的顺序</button></div>
    `;
    box.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = this.manualOrder.indexOf(b.dataset.move!);
        const j = b.dataset.dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= this.manualOrder.length) return;
        [this.manualOrder[i], this.manualOrder[j]] = [this.manualOrder[j], this.manualOrder[i]];
        this.buildManualBox();
        this.updateHud();
      }),
    );
    document.getElementById('btn-swap')!.addEventListener('click', () => {
      if (this.manualOrder.length >= 2) {
        [this.manualOrder[0], this.manualOrder[1]] = [this.manualOrder[1], this.manualOrder[0]];
        this.buildManualBox();
        this.updateHud();
      }
    });
  }

  private buildParamBox(): void {
    const box = document.getElementById('param-box')!;
    box.innerHTML = this.preset.surfaces
      .map((s) => {
        const hex = '#' + s.color.toString(16).padStart(6, '0');
        return `
        <h3><span class="swatch" style="background:${hex}"></span>${s.name}</h3>
        <div class="row">
          <label>颜色</label>
          <input type="color" data-color="${s.id}" value="${hex}" />
          <label style="min-width:auto">透明度</label>
          <input type="range" min="0" max="1" step="0.01" data-opacity="${s.id}" value="${s.opacity}" />
          <span class="value" id="val-${s.id}-opacity">${s.opacity.toFixed(2)}</span>
        </div>
        <div class="row">
          <label>位置 X</label><input type="range" min="-2" max="2" step="0.05" data-pos="${s.id}" data-axis="0" value="${s.position[0]}" /><span class="value">${s.position[0].toFixed(2)}</span>
        </div>
        <div class="row">
          <label>位置 Y</label><input type="range" min="-2" max="2" step="0.05" data-pos="${s.id}" data-axis="1" value="${s.position[1]}" /><span class="value">${s.position[1].toFixed(2)}</span>
        </div>
        <div class="row">
          <label>位置 Z</label><input type="range" min="-2" max="2" step="0.05" data-pos="${s.id}" data-axis="2" value="${s.position[2]}" /><span class="value">${s.position[2].toFixed(2)}</span>
        </div>`;
      })
      .join('') +
      (this.preset.occluder
        ? `<h3>${this.preset.occluder.name}(不透明,不可调透明)</h3>
           <p class="small">位置 (${this.preset.occluder.position.join(', ')}) ·
           颜色 #${this.preset.occluder.color.toString(16).padStart(6, '0')} ·
           始终写深度并截断后方透明面</p>`
        : '');

    box.querySelectorAll<HTMLInputElement>('[data-color]').forEach((el) =>
      el.addEventListener('input', () => {
        const s = this.preset.surfaces.find((x) => x.id === el.dataset.color)!;
        s.color = parseInt(el.value.slice(1), 16);
      }),
    );
    box.querySelectorAll<HTMLInputElement>('[data-opacity]').forEach((el) =>
      el.addEventListener('input', () => {
        const s = this.preset.surfaces.find((x) => x.id === el.dataset.opacity)!;
        s.opacity = parseFloat(el.value);
        document.getElementById(`val-${s.id}-opacity`)!.textContent = s.opacity.toFixed(2);
      }),
    );
    box.querySelectorAll<HTMLInputElement>('[data-pos]').forEach((el) =>
      el.addEventListener('input', () => {
        const s = this.preset.surfaces.find((x) => x.id === el.dataset.pos)!;
        const axis = Number(el.dataset.axis) as 0 | 1 | 2;
        s.position[axis] = parseFloat(el.value);
        el.nextElementSibling!.textContent = s.position[axis].toFixed(2);
      }),
    );
  }
}
