import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DofPass } from './dofPass';
import { SplitPresentPass } from './splitPresentPass';

function createRenderTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const depthTexture = new THREE.DepthTexture(w, h);
  depthTexture.type = THREE.UnsignedIntType;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  // UnsignedByte 颜色 RT：保证 readRenderTargetPixels 在各后端（含 SwiftShader）
  // 都能合法读回；HDR 亮点在材质侧仍超 1.0，tone mapping 阶段照常形成散景圆盘。
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType,
    depthTexture,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  });
}

/**
 * 渲染管线：
 * - 单屏：RenderPass → DofPass（可禁用）→ OutputPass
 * - 分屏：两个半宽 composer 分别渲染原画 / 景深，再由 SplitPresentPass 同屏呈现
 * 切换分屏或窗口缩放时整体重建 RT，所有缓冲尺寸一致，不保留旧帧。
 */
export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private helperScene: THREE.Scene;

  private split = false;
  private helpersVisible = true;

  // 单屏
  private composer!: EffectComposer;
  private dofPass!: DofPass;
  private rt!: THREE.WebGLRenderTarget;

  // 分屏
  private originalComposer!: EffectComposer;
  private dofComposer!: EffectComposer;
  private rtOriginal!: THREE.WebGLRenderTarget;
  private rtDof!: THREE.WebGLRenderTarget;
  private splitPass!: SplitPresentPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    helperScene: THREE.Scene,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.helperScene = helperScene;
    this.rebuild();
  }

  get isSplit(): boolean {
    return this.split;
  }

  setSplit(split: boolean): void {
    if (split === this.split) return;
    this.split = split;
    this.rebuild();
  }

  setHelpersVisible(v: boolean): void {
    this.helpersVisible = v;
  }

  setDofParams(params: { focus: number; focusRange: number; maxBlur: number }): void {
    this.dofPass.setParams(params);
  }

  /** 验证用：CoC 公式（只依赖深度） */
  computeCocPixels(depth: number): number {
    return this.dofPass.computeCocPixels(depth);
  }

  setDofEnabled(enabled: boolean): void {
    this.dofPass.enabled = enabled;
  }

  /** 相机 aspect 始终按整屏计算：分屏时两侧各渲染一份完整画面，
   *  合成阶段各取半区，保证两边比例与单屏完全相同（需求 6）。 */
  private effectiveAspect(fullWidth: number, fullHeight: number): number {
    void fullWidth;
    return fullWidth / fullHeight;
  }

  rebuild(): void {
    const dpr = this.renderer.getPixelRatio();
    const size = this.renderer.getSize(new THREE.Vector2());
    const fullW = Math.max(1, Math.round(size.width * dpr));
    const fullH = Math.max(1, Math.round(size.height * dpr));

    this.camera.aspect = this.effectiveAspect(size.width, size.height);
    this.camera.updateProjectionMatrix();

    this.dispose();

    if (!this.split) {
      this.rt = createRenderTarget(fullW, fullH);
      this.composer = new EffectComposer(this.renderer, this.rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.dofPass = new DofPass(this.camera);
      this.composer.addPass(this.dofPass);
      this.composer.addPass(new OutputPass());
    } else {
      // 两侧都用全尺寸 RT 渲染完整画面，SplitPresentPass 各取一半。
      // 注意 EffectComposer 把传入 RT 作为 writeBuffer、其 clone 作为 readBuffer；
      // RenderPass 写入 readBuffer，pass 链交换后最终内容停在 readBuffer，
      // 因此合成纹理必须取 composer.readBuffer，而不是传入的 RT。
      // 两个分屏 composer 都不加 OutputPass，输出保持线性场景数据；
      // 由 SplitPresentPass 对上屏的两半各做唯一一次 tone mapping + sRGB 转换，
      // 避免双重编码，也保证左右两侧色彩处理完全一致。
      this.rtOriginal = createRenderTarget(fullW, fullH);
      this.rtDof = createRenderTarget(fullW, fullH);

      this.originalComposer = new EffectComposer(this.renderer, this.rtOriginal);
      this.originalComposer.renderToScreen = false;
      this.originalComposer.addPass(new RenderPass(this.scene, this.camera));

      this.dofComposer = new EffectComposer(this.renderer, this.rtDof);
      this.dofComposer.renderToScreen = false;
      this.dofComposer.addPass(new RenderPass(this.scene, this.camera));
      this.dofPass = new DofPass(this.camera);
      this.dofComposer.addPass(this.dofPass);

      this.splitPass = new SplitPresentPass(
        () => this.originalComposer.readBuffer.texture,
        () => this.dofComposer.readBuffer.texture,
      );
    }
  }

  render(): void {
    if (!this.split) {
      this.composer.render();
      if (this.helpersVisible) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.helperScene, this.camera);
        this.renderer.autoClear = true;
      }
      return;
    }

    // 左：原画
    this.originalComposer.render();
    // 右：景深
    this.dofComposer.render();
    // 同屏合成
    this.splitPass.render(this.renderer);

    if (this.helpersVisible) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.helperScene, this.camera);
      this.renderer.autoClear = true;
    }
  }

  /** 供外部测试读取景深输出纹理（验证用） */
  getDofOutputTexture(): THREE.Texture {
    return this.getDofRenderTarget().texture;
  }

  /**
   * 供外部测试读取景深输出 RT（验证用）。
   * 分屏 dofComposer 链为 RenderPass(不 swap) + DofPass(swap)，
   * DoF 结果经一次交换后停在 readBuffer；
   * 单屏链末尾还有 OutputPass(再 swap 一次)，结果停在 writeBuffer。
   */
  getDofRenderTarget(): THREE.WebGLRenderTarget {
    return this.split ? this.dofComposer.readBuffer : this.composer.writeBuffer;
  }

  /** 验证用：读取原画 RT（分屏左半输入） */
  getOriginalRenderTarget(): THREE.WebGLRenderTarget {
    return this.originalComposer.readBuffer;
  }

  dispose(): void {
    const rts = [this.rt, this.rtOriginal, this.rtDof].filter(Boolean) as THREE.WebGLRenderTarget[];
    rts.forEach((rt) => rt.dispose());
    [this.composer, this.originalComposer, this.dofComposer].forEach((c) => c?.dispose());
    this.splitPass?.dispose();
  }
}
