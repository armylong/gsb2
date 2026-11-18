import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene, updateMovers, ROWS } from './scene';
import { FocalPlaneHelper } from './focalPlaneHelper';
import { RenderPipeline } from './pipeline';
import './style.css';

const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 2.6, 10);
const DEFAULT_TARGET = new THREE.Vector3(0, 1.6, -4);

interface FocusParams {
  focus: number;
  focusRange: number;
  maxBlur: number;
}

class App {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private built = buildScene();
  private helper = new FocalPlaneHelper();
  private pipeline: RenderPipeline;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();

  private params: FocusParams = { focus: 14, focusRange: 2.5, maxBlur: 10 };
  private dofEnabled = true;
  private motionEnabled = true;
  private helpersVisible = true;
  private splitEnabled = false;

  private selectedPointDepth: number | null = null;
  private toastTimer: number | null = null;

  // UI
  private el!: {
    dofEnabled: HTMLInputElement;
    splitEnabled: HTMLInputElement;
    helpersEnabled: HTMLInputElement;
    motionEnabled: HTMLInputElement;
    reset: HTMLButtonElement;
    focus: HTMLInputElement;
    focusVal: HTMLOutputElement;
    range: HTMLInputElement;
    rangeVal: HTMLOutputElement;
    blur: HTMLInputElement;
    blurVal: HTMLOutputElement;
    rangeHint: HTMLParagraphElement;
    presetNear: HTMLButtonElement;
    presetFar: HTMLButtonElement;
    presetSlant: HTMLButtonElement;
    readDepth: HTMLElement;
    readFocus: HTMLElement;
    readDefocus: HTMLElement;
    readLimits: HTMLElement;
    toast: HTMLDivElement;
  };

  constructor() {
    this.canvas = document.getElementById('stage') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      120,
    );
    this.camera.position.copy(DEFAULT_CAMERA_POS);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(DEFAULT_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 40;
    this.controls.update();

    this.pipeline = new RenderPipeline(
      this.renderer,
      this.built.scene,
      this.camera,
      this.helper.scene,
    );

    this.cacheElements();
    this.bindUI();
    this.syncParamsToPipeline();
    this.updateReadout(null);
    this.bindResize();
    this.bindPicking();
    this.installDebugHooks();

    this.animate();
  }

  private cacheElements(): void {
    const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
    this.el = {
      dofEnabled: get('dof-enabled'),
      splitEnabled: get('split-enabled'),
      helpersEnabled: get('helpers-enabled'),
      motionEnabled: get('motion-enabled'),
      reset: get('btn-reset'),
      focus: get('focus-distance'),
      focusVal: get('focus-distance-val'),
      range: get('focus-range'),
      rangeVal: get('focus-range-val'),
      blur: get('max-blur'),
      blurVal: get('max-blur-val'),
      rangeHint: get('range-hint'),
      presetNear: get('preset-near'),
      presetFar: get('preset-far'),
      presetSlant: get('preset-slant'),
      readDepth: get('read-depth'),
      readFocus: get('read-focus'),
      readDefocus: get('read-defocus'),
      readLimits: get('read-limits'),
      toast: get('toast'),
    };
  }

  private bindUI(): void {
    this.el.dofEnabled.addEventListener('change', () => {
      this.dofEnabled = this.el.dofEnabled.checked;
      this.pipeline.setDofEnabled(this.dofEnabled);
    });
    this.el.splitEnabled.addEventListener('change', () => {
      this.splitEnabled = this.el.splitEnabled.checked;
      this.pipeline.setSplit(this.splitEnabled);
      document.body.classList.toggle('split', this.splitEnabled);
      this.syncParamsToPipeline();
    });
    this.el.helpersEnabled.addEventListener('change', () => {
      this.helpersVisible = this.el.helpersEnabled.checked;
      this.pipeline.setHelpersVisible(this.helpersVisible);
    });
    this.el.motionEnabled.addEventListener('change', () => {
      this.motionEnabled = this.el.motionEnabled.checked;
    });
    this.el.reset.addEventListener('click', () => this.resetCamera());

    this.el.focus.addEventListener('input', () => {
      this.params.focus = parseFloat(this.el.focus.value);
      this.syncParamsToPipeline();
    });
    this.el.range.addEventListener('input', () => {
      this.params.focusRange = parseFloat(this.el.range.value);
      this.syncParamsToPipeline();
    });
    this.el.blur.addEventListener('input', () => {
      this.params.maxBlur = parseFloat(this.el.blur.value);
      this.syncParamsToPipeline();
    });

    this.el.presetNear.addEventListener('click', () => this.applyPreset('near'));
    this.el.presetFar.addEventListener('click', () => this.applyPreset('far'));
    this.el.presetSlant.addEventListener('click', () => this.applyPreset('slant'));
  }

  private syncParamsToPipeline(): void {
    this.pipeline.setDofParams(this.params);
    this.pipeline.setDofEnabled(this.dofEnabled);
    this.el.focusVal.textContent = `${this.params.focus.toFixed(1)} m`;
    this.el.rangeVal.textContent = `${this.params.focusRange.toFixed(1)} m`;
    this.el.blurVal.textContent = `${this.params.maxBlur.toFixed(1)} px`;
    const near = Math.max(0, this.params.focus - this.params.focusRange / 2);
    const far = this.params.focus + this.params.focusRange / 2;
    this.el.rangeHint.textContent = `完全清晰区：${near.toFixed(1)} m ~ ${far.toFixed(1)} m`;
    this.updateReadout(this.selectedPointDepth);
  }

  private updateReadout(pointDepth: number | null): void {
    this.selectedPointDepth = pointDepth;
    this.el.readFocus.textContent = `${this.params.focus.toFixed(2)} m`;
    const near = Math.max(0, this.params.focus - this.params.focusRange / 2);
    const far = this.params.focus + this.params.focusRange / 2;
    this.el.readLimits.textContent = `${near.toFixed(2)} m / ${far.toFixed(2)} m`;

    if (pointDepth === null) {
      this.el.readDepth.textContent = '—';
      this.el.readDefocus.textContent = '—';
      return;
    }
    this.el.readDepth.textContent = `${pointDepth.toFixed(2)} m`;
    const delta = Math.abs(pointDepth - this.params.focus);
    const half = this.params.focusRange / 2;
    if (delta <= half) {
      this.el.readDefocus.textContent = '0（清晰区内）';
    } else {
      const amount = Math.min(1, (delta - half) / half);
      this.el.readDefocus.textContent = `${delta.toFixed(2)} m（模糊量 ${(amount * 100).toFixed(0)}%）`;
    }
  }

  private setFocusDistance(d: number): void {
    this.params.focus = THREE.MathUtils.clamp(d, parseFloat(this.el.focus.min), parseFloat(this.el.focus.max));
    this.el.focus.value = String(this.params.focus);
    this.syncParamsToPipeline();
  }

  private showToast(message: string): void {
    this.el.toast.textContent = message;
    this.el.toast.classList.remove('hidden');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.add('hidden'), 2200);
  }

  // ---- 点选 -------------------------------------------------------------

  private bindPicking(): void {
    let downX = 0;
    let downY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      // 拖动轨道时不触发拾取
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
      this.pick(e.clientX, e.clientY);
    });
  }

  private pick(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // 显式白名单：只有场景 pickables 可命中，焦平面辅助物在独立场景中且不在此列
    const hits = this.raycaster.intersectObjects(this.built.pickables, true);
    if (hits.length === 0) {
      this.showToast('未点到可见表面，保留上一次焦点设置');
      return;
    }

    const hit = hits[0];
    const depthAlongView = hit.point.clone().sub(this.camera.position)
      .dot(this.camera.getWorldDirection(new THREE.Vector3()));
    this.setFocusDistance(depthAlongView);

    const obj = this.findPickableRoot(hit.object);
    const name = obj?.userData.kind === 'board'
      ? `${obj.userData.rowName} 第 ${obj.userData.index} 块`
      : obj?.userData.kind === 'dot'
        ? obj.userData.name
        : '地面';
    this.showToast(`已对焦：${name}，深度 ${depthAlongView.toFixed(2)} m`);
    this.updateReadout(depthAlongView);
  }

  private findPickableRoot(obj: THREE.Object3D): THREE.Object3D | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData && cur.userData.kind) return cur;
      cur = cur.parent;
    }
    return null;
  }

  // ---- 预设与复位 --------------------------------------------------------

  private resetCamera(): void {
    this.camera.position.copy(DEFAULT_CAMERA_POS);
    this.controls.target.copy(DEFAULT_TARGET);
    this.controls.update();
  }

  private applyPreset(kind: 'near' | 'far' | 'slant'): void {
    // 确保景深与辅助物可见，现场才有意义
    this.dofEnabled = true;
    this.el.dofEnabled.checked = true;
    this.pipeline.setDofEnabled(true);
    this.helpersVisible = true;
    this.el.helpersEnabled.checked = true;
    this.pipeline.setHelpersVisible(true);

    if (kind === 'near') {
      this.camera.position.copy(DEFAULT_CAMERA_POS);
      this.controls.target.copy(DEFAULT_TARGET);
      this.controls.update();
      this.setFocusDistance(ROWS[0].depth);
      this.params.focusRange = 2;
      this.params.maxBlur = 12;
      this.showToast('现场：对焦近排（8 m），中/远排应明显模糊');
    } else if (kind === 'far') {
      this.camera.position.copy(DEFAULT_CAMERA_POS);
      this.controls.target.copy(DEFAULT_TARGET);
      this.controls.update();
      this.setFocusDistance(ROWS[2].depth);
      this.params.focusRange = 2;
      this.params.maxBlur = 12;
      this.showToast('现场：对焦远排（20 m），近/中排应明显模糊');
    } else {
      // 斜看：相机平移到一侧并转向，焦平面仍垂直于视线，斜着切开三排
      this.camera.position.set(7.5, 3.4, 10);
      this.controls.target.set(-1.5, 1.6, -4);
      this.controls.update();
      this.setFocusDistance(14);
      this.params.focusRange = 2.5;
      this.params.maxBlur = 12;
      this.showToast('现场：斜看同一焦平面，平面上各点深度一致');
    }
    this.el.range.value = String(this.params.focusRange);
    this.el.blur.value = String(this.params.maxBlur);
    this.syncParamsToPipeline();
  }

  // ---- resize ------------------------------------------------------------

  private bindResize(): void {
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.pipeline.rebuild();
      this.syncParamsToPipeline();
    });
  }

  // ---- 主循环 ------------------------------------------------------------

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const t = this.clock.getElapsedTime();
    updateMovers(this.built.movers, t, this.motionEnabled);
    this.controls.update();
    this.helper.update(this.camera, this.params.focus);
    this.pipeline.render();
  };

  // ---- 自动化验证钩子（仅本地测试使用）------------------------------------

  private installDebugHooks(): void {
    interface DebugApi {
      getState: () => Record<string, unknown>;
      setParams: (p: Partial<FocusParams>) => void;
      pickAt: (x: number, y: number) => void;
      setSplit: (v: boolean) => void;
      resetCamera: () => void;
      getCanvasDataUrl: () => string;
      getDofPixel: (u: number, v: number) => [number, number, number];
      getViewDepthAt: (ndcX: number, ndcY: number) => number | null;
      projectWorld: (x: number, y: number, z: number) => { x: number; y: number; ndcX: number; ndcY: number; visible: boolean };
      getMoverPositions: () => Array<{ x: number; y: number; z: number }>;
      computeCoc: (depth: number) => number;
      getOriginalPixel: (u: number, v: number) => [number, number, number];
    }
    const api: DebugApi = {
      getState: () => ({
        params: { ...this.params },
        dofEnabled: this.dofEnabled,
        split: this.splitEnabled,
        motion: this.motionEnabled,
        helpers: this.helpersVisible,
        cameraPos: this.camera.position.toArray(),
        cameraTarget: this.controls.target.toArray(),
        aspect: this.camera.aspect,
        selectedDepth: this.selectedPointDepth,
      }),
      setParams: (p) => {
        if (p.focus !== undefined) this.setFocusDistance(p.focus);
        if (p.focusRange !== undefined) {
          this.params.focusRange = p.focusRange;
          this.el.range.value = String(p.focusRange);
        }
        if (p.maxBlur !== undefined) {
          this.params.maxBlur = p.maxBlur;
          this.el.blur.value = String(p.maxBlur);
        }
        this.syncParamsToPipeline();
      },
      pickAt: (x, y) => this.pick(x, y),
      setSplit: (v) => {
        this.el.splitEnabled.checked = v;
        this.el.splitEnabled.dispatchEvent(new Event('change'));
      },
      resetCamera: () => this.resetCamera(),
      getCanvasDataUrl: () => this.canvas.toDataURL('image/png'),
      /** 读取景深输出 RT 的像素（uv 0..1，分屏时为右半区局部坐标） */
      getDofPixel: (u, v) => {
        const target = this.pipeline.getDofRenderTarget();
        const x = Math.max(0, Math.min(target.width - 1, Math.floor(u * target.width)));
        const y = Math.max(0, Math.min(target.height - 1, Math.floor((1 - v) * target.height)));
        const buf = new Uint8Array(4);
        this.renderer.readRenderTargetPixels(target, x, y, 1, 1, buf);
        // 归一化到 0..1
        return [buf[0] / 255, buf[1] / 255, buf[2] / 255] as [number, number, number];
      },
      getViewDepthAt: (ndcX, ndcY) => {
        this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
        const hits = this.raycaster.intersectObjects(this.built.pickables, true);
        if (hits.length === 0) return null;
        return hits[0].point.clone().sub(this.camera.position)
          .dot(this.camera.getWorldDirection(new THREE.Vector3()));
      },
      projectWorld: (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(this.camera);
        return {
          x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth,
          y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight,
          ndcX: v.x,
          ndcY: v.y,
          visible: v.z < 1,
        };
      },
      /** 验证用：返回三个自动移动物体的当前世界位置 */
      getMoverPositions: () =>
        this.built.movers.map((m) => ({ x: m.position.x, y: m.position.y, z: m.position.z })),
      /** 验证用：CoC 只由深度决定 */
      computeCoc: (depth: number) => this.pipeline.computeCocPixels(depth),
      /** 验证用：读原画 RT 像素（分屏左半） */
      getOriginalPixel: (u: number, v: number) => {
        const target = this.pipeline.getOriginalRenderTarget();
        const x = Math.max(0, Math.min(target.width - 1, Math.floor(u * target.width)));
        const y = Math.max(0, Math.min(target.height - 1, Math.floor((1 - v) * target.height)));
        const buf = new Uint8Array(4);
        this.renderer.readRenderTargetPixels(target, x, y, 1, 1, buf);
        return [buf[0] / 255, buf[1] / 255, buf[2] / 255] as [number, number, number];
      },
    };
    (window as unknown as { __dofApp: DebugApi }).__dofApp = api;
  }
}

new App();
