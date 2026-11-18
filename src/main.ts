import { PerspectiveCamera, Scene, WebGLRenderer, Color, Mesh } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import { AoPipeline } from './aoPipeline';
import { buildScene, type BuiltScene } from './scenes';
import { Validator, type CheckResult } from './validator';
import {
  DEFAULT_STATE,
  MODE_LABEL,
  VERIFY_VIEW,
  type AppState,
  type SceneId,
  type SmoothLevel,
  type ViewMode,
} from './types';

const BG = new Color('#e8ebf0');

export class App {
  private state: AppState = structuredClone(DEFAULT_STATE);
  private savedVerifyState: AppState | null = null;
  private savedCamera: { position: number[]; target: number[] } | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly scene = new Scene();
  private built: BuiltScene | null = null;
  private pipeline: AoPipeline;
  private readonly validator: Validator;
  private drawingW = 1;
  private drawingH = 1;

  constructor() {
    this.canvas = document.getElementById('canvas') as HTMLCanvasElement;
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true, // 验证 readPixels 稳定
    });
    this.renderer.setClearColor(BG, 1);
    this.renderer.autoClear = false;

    this.camera = new PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(...VERIFY_VIEW.position);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(...VERIFY_VIEW.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    const stage = document.getElementById('stage')!;
    const rect = stage.getBoundingClientRect();
    this.resize(rect.width, rect.height);

    this.loadScene(this.state.scene);
    this.pipeline = new AoPipeline(this.renderer, this.scene, this.camera, this.drawingW, this.drawingH);
    this.validator = new Validator(this, this.pipeline);

    this.bindUi();
    this.syncUi();
    this.applyGap();

    new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      this.resize(r.width, r.height);
    }).observe(stage);

    this.loop();

    // 自动化验证钩子（仅暴露只读采样能力）
    (window as unknown as { __ssaoDebug: unknown }).__ssaoDebug = {
      readPixel: (ndcX: number, ndcY: number) => Array.from(this.pipeline.readPixel(ndcX, ndcY)),
      getState: () => this.getState(),
      getDrawingSize: () => this.getDrawingSize(),
    };
  }

  // ---------- 场景 ----------

  private loadScene(id: SceneId): void {
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((o) => {
        // 几何在场景内独立创建，释放；材质是共享的，不释放
        const mesh = o as Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.built = buildScene(id);
    this.scene.add(this.built.group);
    this.applyGap();
    const countEl = document.getElementById('sceneCount');
    if (countEl) {
      countEl.textContent = `当前场景物体数：${this.built.objectCount}（含地面，要求 ≤ 30）`;
    }
  }

  getSphereMesh(): Mesh | null {
    return this.built?.getSphere() ?? null;
  }

  private applyGap(): void {
    const sphere = this.built?.getSphere();
    if (!sphere) return;
    const r = sphere.userData.radius as number;
    sphere.position.set(0, r + this.state.params.gap, 0);
  }

  // ---------- 尺寸 ----------

  private resize(cssW: number, cssH: number): void {
    // 窗口最小化/布局过渡时可能出现零尺寸，跳过以免产生不完整 framebuffer
    if (!Number.isFinite(cssW) || !Number.isFinite(cssH) || cssW < 2 || cssH < 2) return;
    // headless 软件渲染（SwiftShader）纹理上限小，DPR 限制到 1；普通浏览器最多 2
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') as string;
    const dprCap = /SwiftShader|llvmpipe|software/i.test(rendererName) ? 1 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    this.drawingW = w;
    this.drawingH = h;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    // 相机始终按整块画布的宽高比投影：分屏两侧共享同一透视，移动分界不变形
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.pipeline?.setSize(w, h);
  }

  getDrawingSize(): { width: number; height: number } {
    return { width: this.drawingW, height: this.drawingH };
  }

  // ---------- 相机 ----------

  setViewpoint(position: readonly number[], target: readonly number[]): void {
    this.camera.position.set(position[0], position[1], position[2]);
    this.controls.target.set(target[0], target[1], target[2]);
    this.controls.update();
  }

  // ---------- 状态访问（供 Validator 使用） ----------

  getState(): AppState {
    return structuredClone(this.state);
  }

  getParams(): AppState['params'] {
    return { ...this.state.params };
  }

  /** 验证临时状态：切到悬空球场景 + 单画面，gap 可单独覆盖 */
  applyVerifyState(opts: { mode: ViewMode; intensity: number; gap: number }): void {
    if (!this.savedVerifyState) {
      this.savedVerifyState = this.getState();
      this.savedCamera = {
        position: this.camera.position.toArray(),
        target: this.controls.target.toArray(),
      };
    }
    this.controls.enabled = false;
    if (this.state.scene !== 'sphere') {
      this.state.scene = 'sphere';
      this.loadScene('sphere');
    }
    this.state.layout = opts.mode;
    this.state.params.intensity = opts.intensity;
    this.state.params.gap = opts.gap;
    this.applyGap();
    this.setViewpoint(VERIFY_VIEW.position, VERIFY_VIEW.target);
  }

  restoreVerifyState(prev: AppState): void {
    this.state = structuredClone(prev);
    this.savedVerifyState = null;
    this.controls.enabled = true;
    this.loadScene(this.state.scene);
    this.pipeline.setParams(
      this.state.params.radius,
      this.state.params.depthBias,
      this.state.params.smooth,
    );
    if (this.savedCamera) {
      this.setViewpoint(this.savedCamera.position, this.savedCamera.target);
      this.savedCamera = null;
    }
    this.syncUi();
  }

  // ---------- 渲染 ----------

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    this.controls.update();

    const p = this.state.params;
    this.pipeline.setParams(p.radius, p.depthBias, p.smooth);
    this.pipeline.prepare();

    const W = this.drawingW;
    const H = this.drawingH;
    if (this.state.layout === 'split') {
      const splitX = Math.floor(W * this.state.split);
      this.pipeline.blit(this.state.leftMode, p.intensity, { x: 0, y: 0, w: splitX, h: H });
      this.pipeline.blit(this.state.rightMode, p.intensity, {
        x: splitX,
        y: 0,
        w: W - splitX,
        h: H,
      });
    } else {
      this.pipeline.blit(this.state.layout, p.intensity, { x: 0, y: 0, w: W, h: H });
    }
    this.updateStatus();
  };

  // ---------- UI ----------

  private bindUi(): void {
    const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

    document.querySelectorAll<HTMLButtonElement>('#sceneRow .seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.scene as SceneId;
        this.state.scene = id;
        this.loadScene(id);
        document.querySelectorAll('#sceneRow .seg').forEach((b) => b.classList.toggle('active', b === btn));
        this.updateStatus();
      });
    });

    document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        this.state.layout = radio.value as AppState['layout'];
        this.updateTags();
        this.updateStatus();
      });
    });

    const leftMode = $<HTMLSelectElement>('leftMode');
    const rightMode = $<HTMLSelectElement>('rightMode');
    leftMode.addEventListener('change', () => {
      this.state.leftMode = leftMode.value as ViewMode;
      this.updateTags();
    });
    rightMode.addEventListener('change', () => {
      this.state.rightMode = rightMode.value as ViewMode;
      this.updateTags();
    });

    const split = $<HTMLInputElement>('split');
    split.addEventListener('input', () => {
      this.state.split = Number(split.value) / 100;
      this.positionDivider();
      this.updateStatus();
    });

    const bindSlider = (id: string, key: 'radius' | 'intensity' | 'depthBias' | 'gap', fmt: (v: number) => string) => {
      const el = $<HTMLInputElement>(id);
      const label = $<HTMLElement>(id + 'Val');
      el.addEventListener('input', () => {
        const v = Number(el.value);
        this.state.params[key] = v;
        label.textContent = fmt(v);
        if (key === 'gap') this.applyGap();
        this.updateStatus();
      });
    };
    bindSlider('radius', 'radius', (v) => v.toFixed(1));
    bindSlider('intensity', 'intensity', (v) => v.toFixed(2));
    bindSlider('bias', 'depthBias', (v) => v.toFixed(3));
    bindSlider('gap', 'gap', (v) => v.toFixed(2));

    $<HTMLSelectElement>('smooth').addEventListener('change', (e) => {
      this.state.params.smooth = (e.target as HTMLSelectElement).value as SmoothLevel;
      this.updateStatus();
    });

    $<HTMLButtonElement>('viewpointBtn').addEventListener('click', () => {
      this.setViewpoint(VERIFY_VIEW.position, VERIFY_VIEW.target);
    });

    $<HTMLButtonElement>('resetBtn').addEventListener('click', () => this.resetAll());
    $<HTMLButtonElement>('verifyBtn').addEventListener('click', () => this.runVerify());

    this.setupDividerDrag();
  }

  private setupDividerDrag(): void {
    const divider = document.getElementById('divider')!;
    const stage = document.getElementById('stage')!;
    let dragging = false;

    const onMove = (clientX: number) => {
      const r = stage.getBoundingClientRect();
      const ratio = Math.min(0.85, Math.max(0.15, (clientX - r.left) / r.width));
      this.state.split = ratio;
      this.syncUi();
      this.positionDivider();
    };

    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      divider.setPointerCapture(e.pointerId);
    });
    divider.addEventListener('pointermove', (e) => {
      if (dragging) onMove(e.clientX);
    });
    divider.addEventListener('pointerup', () => {
      dragging = false;
    });
  }

  private positionDivider(): void {
    const divider = document.getElementById('divider')!;
    const label = document.getElementById('divLabel')!;
    if (this.state.layout !== 'split') {
      divider.style.display = 'none';
      return;
    }
    divider.style.display = 'block';
    divider.style.left = `${this.state.split * 100}%`;
    label.textContent = `分界 ${(this.state.split * 100).toFixed(0)}%`;
  }

  private updateTags(): void {
    const tagL = document.getElementById('tagLeft')!;
    const tagR = document.getElementById('tagRight')!;
    if (this.state.layout === 'split') {
      tagL.classList.remove('hidden');
      tagR.classList.remove('hidden');
      tagL.textContent = '左：' + MODE_LABEL[this.state.leftMode];
      tagR.textContent = '右：' + MODE_LABEL[this.state.rightMode];
    } else {
      tagL.classList.remove('hidden');
      tagR.classList.add('hidden');
      tagL.textContent = MODE_LABEL[this.state.layout as ViewMode];
    }
    this.positionDivider();
  }

  private syncUi(): void {
    const s = this.state;
    document.querySelectorAll<HTMLButtonElement>('#sceneRow .seg').forEach((b) => {
      b.classList.toggle('active', b.dataset.scene === s.scene);
    });
    document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((r) => {
      r.checked = r.value === s.layout;
    });
    (document.getElementById('leftMode') as HTMLSelectElement).value = s.leftMode;
    (document.getElementById('rightMode') as HTMLSelectElement).value = s.rightMode;
    (document.getElementById('split') as HTMLInputElement).value = String(Math.round(s.split * 100));
    document.getElementById('splitVal')!.textContent = `${Math.round(s.split * 100)}%`;
    (document.getElementById('radius') as HTMLInputElement).value = String(s.params.radius);
    document.getElementById('radiusVal')!.textContent = s.params.radius.toFixed(1);
    (document.getElementById('intensity') as HTMLInputElement).value = String(s.params.intensity);
    document.getElementById('intensityVal')!.textContent = s.params.intensity.toFixed(2);
    (document.getElementById('bias') as HTMLInputElement).value = String(s.params.depthBias);
    document.getElementById('biasVal')!.textContent = s.params.depthBias.toFixed(3);
    (document.getElementById('smooth') as HTMLSelectElement).value = s.params.smooth;
    (document.getElementById('gap') as HTMLInputElement).value = String(s.params.gap);
    document.getElementById('gapVal')!.textContent = s.params.gap.toFixed(2);
    // gap 只在悬空球场景有对应物体，其他场景禁用以免误导
    const gapSlider = document.getElementById('gap') as HTMLInputElement;
    gapSlider.disabled = s.scene !== 'sphere';
    document.getElementById('sceneCount')!.textContent =
      `当前场景物体数：${this.built?.objectCount ?? 0}（含地面，要求 ≤ 30）`;
    this.updateTags();
    this.updateStatus();
  }

  private updateStatus(): void {
    const el = document.getElementById('status');
    if (!el) return;
    const p = this.state.params;
    const rows: Array<[string, string]> = [
      ['场景', this.state.scene],
      ['布局', this.state.layout === 'split' ? `分屏 ${(this.state.split * 100).toFixed(0)}%` : '单画面'],
      ['radius', p.radius.toFixed(2)],
      ['intensity', p.intensity.toFixed(2)],
      ['depthBias', p.depthBias.toFixed(3)],
      ['平滑', p.smooth],
      ['gap', p.gap.toFixed(2)],
      ['CSS 尺寸', `${this.canvas.clientWidth}×${this.canvas.clientHeight}`],
      ['实际渲染', `${this.drawingW}×${this.drawingH} (dpr ${Math.min(window.devicePixelRatio || 1, 2).toFixed(2)})`],
    ];
    el.innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('');
  }

  private resetAll(): void {
    this.state = structuredClone(DEFAULT_STATE);
    this.loadScene(this.state.scene);
    this.pipeline.setParams(
      this.state.params.radius,
      this.state.params.depthBias,
      this.state.params.smooth,
    );
    this.setViewpoint(VERIFY_VIEW.position, VERIFY_VIEW.target);
    this.syncUi();
  }

  private runVerify(): void {
    const box = document.getElementById('verifyResult')!;
    box.innerHTML = '<div class="summary">验证中……</div>';
    // 让提示先绘制，再同步执行 GPU 验证
    requestAnimationFrame(() => {
      let results: CheckResult[];
      try {
        results = this.validator.run();
      } catch (err) {
        box.innerHTML = `<div class="summary fail">验证异常：${String(err)}</div>`;
        return;
      }
      const passed = results.filter((r) => r.pass).length;
      const cls = passed === results.length ? 'pass' : 'fail';
      box.innerHTML =
        `<div class="summary ${cls}">${passed}/${results.length} 通过（固定观察点，悬空球场景）</div>` +
        '<table>' +
        results
          .map(
            (r) =>
              `<tr><td><span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span></td>` +
              `<td><span class="name">${r.id} ${r.name}</span><br><span class="detail">${r.detail}</span></td></tr>`,
          )
          .join('') +
        '</table>';
      // 控制台同步输出，便于自动化抓取
      console.log('SSAO_VERIFY', JSON.stringify(results));
    });
  }
}

new App();
