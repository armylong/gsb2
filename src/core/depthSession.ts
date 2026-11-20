import * as THREE from 'three';
import {
  PairScene,
  GAP_RATIOS,
  TILE_LAYOUT,
  REFERENCE_DISTANCE,
  tilePixelRect,
} from './labScene';
import { type DepthMode, type StorageModel, depthStepWorld } from './depthMath';
import {
  probeStorageFor,
  readDepthAttachment,
  restoreRendererState,
  type DepthAttachmentInfo,
  type StorageProbe,
} from './capabilities';

/**
 * 深度附件类型：
 * - u16：真 16 位定点（最容易复现争抢）
 * - u24：24 位定点（许多驱动实际用 32F 实现，见设备面板实测）
 * - f32：32 位浮点
 */
export type DepthAttachmentType = 'u16' | 'u24' | 'f32';

const DEPTH_TEXTURE_TYPE: Record<DepthAttachmentType, THREE.TextureDataType> = {
  u16: THREE.UnsignedShortType,
  u24: THREE.UnsignedIntType,
  f32: THREE.FloatType,
};

const STORAGE_MODEL: Record<DepthAttachmentType, StorageModel> = {
  u16: 'fixed16',
  u24: 'fixed24',
  f32: 'f32',
};

export type OverlayMode = 'none' | 'contested' | 'delta';

export interface SessionParams {
  distance: number;
  near: number;
  far: number;
  fovDeg: number;
  keepScreenScale: boolean;
  gapScale: number;
}

export interface TileStats {
  index: number;
  gapRatio: number;
  gapWorld: number;
  coveragePx: number;
  contestedPx: number;
  ratio: number;
  /** 两表面视角距离差（世界单位）：最小值 / 中位 / 最大值 */
  deltaMin: number;
  deltaMedian: number;
  deltaMax: number;
  /** 理论：一个深度码点在该距离处对应多少世界距离 */
  predictedStep: number;
}

export interface FrameStats {
  tiles: TileStats[];
  contestedPx: number;
  coveragePx: number;
  ratio: number;
}

export interface ContentionSample {
  index: number;
  contestedPx: number;
  coveragePx: number;
  ratio: number;
}

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

interface FullscreenQuad {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  geometry: THREE.PlaneGeometry;
}

function createFullscreenQuad(material: THREE.Material): FullscreenQuad {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  return { scene, camera, geometry };
}

function makeDepthTexture(
  width: number,
  height: number,
  depthType: DepthAttachmentType,
): THREE.DepthTexture {
  const texture = new THREE.DepthTexture(width, height, DEPTH_TEXTURE_TYPE[depthType]);
  texture.format = THREE.DepthFormat;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** 带用户所选深度格式的渲染目标；用于真实的深度测试。 */
function makeDepthTarget(
  width: number,
  height: number,
  depthType: DepthAttachmentType,
  floatColor = false,
): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: floatColor ? THREE.FloatType : THREE.UnsignedByteType,
    depthTexture: makeDepthTexture(width, height, depthType),
  });
}

/**
 * 把视角距离写入浮点颜色附件。
 *
 * 为什么不直接采样深度纹理：深度纹理能否以 float 读回取决于驱动，
 * 且反向模式下深度值与距离的换算容易出错。把 viewZ 写进颜色附件，
 * 既能精确读回，也能在同一张纹理上做可视化。
 */
function makeViewZMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -viewPosition.z;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        gl_FragColor = vec4(vViewZ, 0.0, 0.0, 1.0);
      }
    `,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });
}

/**
 * 一次“深度模式 + 分析分辨率”的渲染会话。
 * 直接深度与反向深度使用完全相同的场景参数与采样点，
 * 因此横向对比时唯一变量只有深度模式（与深度附件类型）。
 */
export class DepthSession {
  readonly mode: DepthMode;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly width: number;
  readonly height: number;
  private depthType: DepthAttachmentType;
  private readonly scene: PairScene;

  /** 两遍颜色：交换绘制顺序，用于检测争抢。深度附件格式与实际渲染一致。 */
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  /** 两个表面的视角距离（float 颜色附件）。 */
  private rtZFront: THREE.WebGLRenderTarget;
  private rtZBack: THREE.WebGLRenderTarget;

  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly compositeQuad: FullscreenQuad;
  private readonly viewZMaterial: THREE.ShaderMaterial;

  private readonly colorA: Uint8Array;
  private readonly colorB: Uint8Array;
  private readonly zFront: Float32Array;
  private readonly zBack: Float32Array;
  /** 统计时剔除的边界像素；边界像素的覆盖判定受光栅化规则影响，不是深度精度问题。 */
  private readonly statsInsetPx = 2;
  /** 实测量化网格，null 表示尚未探测。 */
  private measuredStorage: StorageProbe['storage'] | null = null;

  constructor(options: {
    mode: DepthMode;
    scene: PairScene;
    width: number;
    height: number;
    depthType: DepthAttachmentType;
  }) {
    this.mode = options.mode;
    this.scene = options.scene;
    this.width = options.width;
    this.height = options.height;
    this.depthType = options.depthType;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-canvas';
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
      reversedDepthBuffer: options.mode === 'reversed',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1e5);
    this.camera.position.set(0, 0, 0);

    // 两遍颜色对比必须各自带深度缓冲，否则深度测试失效、后画的永远覆盖先画的。
    // 深度附件必须是用户选的那一种——驱动默认的 DEPTH_COMPONENT24 可能被实现成 32F，
    // 那样切换 16 位就看不到任何差别。
    this.rtA = makeDepthTarget(this.width, this.height, this.depthType);
    this.rtB = makeDepthTarget(this.width, this.height, this.depthType);
    this.rtZFront = makeDepthTarget(this.width, this.height, this.depthType, true);
    this.rtZBack = makeDepthTarget(this.width, this.height, this.depthType, true);
    this.viewZMaterial = makeViewZMaterial();

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tColorA: { value: this.rtA.texture },
        tColorB: { value: this.rtB.texture },
        tFront: { value: this.rtZFront.texture },
        tBack: { value: this.rtZBack.texture },
        uOverlay: { value: 0 },
        uGapBase: { value: 1 },
        uQuantum: { value: 1e-6 },
        uGapRatios: { value: GAP_RATIOS.map((v) => v) },
        uTileCenters: { value: TILE_LAYOUT.map((l) => l.centerNdcX) },
        uTileHalfX: { value: TILE_LAYOUT[0].halfNdcX },
        uTileHalfY: { value: TILE_LAYOUT[0].halfNdcY },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColorA;
        uniform sampler2D tColorB;
        uniform sampler2D tFront;
        uniform sampler2D tBack;
        uniform int uOverlay;
        uniform float uGapBase;
        uniform float uQuantum;
        uniform float uGapRatios[5];
        uniform float uTileCenters[5];
        uniform float uTileHalfX;
        uniform float uTileHalfY;
        varying vec2 vUv;

        int tileIndex(vec2 uv) {
          float x = uv.x * 2.0 - 1.0;
          float y = uv.y * 2.0 - 1.0;
          if (abs(y) > uTileHalfY) return -1;
          for (int i = 0; i < 5; i++) {
            if (abs(x - uTileCenters[i]) <= uTileHalfX) return i;
          }
          return -1;
        }

        void main() {
          vec3 a = texture2D(tColorA, vUv).rgb;
          vec3 b = texture2D(tColorB, vUv).rgb;
          vec3 col = a;
          float lum = a.r + a.g + a.b;
          float diff = abs(a.r - b.r) + abs(a.g - b.g) + abs(a.b - b.b);
          if (uOverlay == 1) {
            // 争抢：交换绘制顺序后颜色变化的像素。
            float mark = step(0.006, diff);
            col = mix(col * 0.35, vec3(0.815, 0.231, 0.231), mark * 0.95);
          } else if (uOverlay == 2) {
            // 深度差以“深度码点”为单位：|zFront - zBack| / quantum。
            // <1 个码点 = 两表面会被量化到同一深度，是最危险的区间。
            float zf = texture2D(tFront, vUv).r;
            float zb = texture2D(tBack, vUv).r;
            int idx = tileIndex(vUv);
            if (idx >= 0 && lum > 0.02 && zf > 0.0 && zb > 0.0) {
              float steps = abs(zf - zb) / max(uQuantum, 1e-12);
              float risk = 1.0 - clamp(steps, 0.0, 4.0) / 4.0;
              vec3 ramp = mix(vec3(0.10, 0.16, 0.24), vec3(0.82, 0.24, 0.24), risk);
              col = mix(col, ramp, 0.9);
            }
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.compositeQuad = createFullscreenQuad(this.compositeMaterial);

    const pixels = this.width * this.height;
    this.colorA = new Uint8Array(pixels * 4);
    this.colorB = new Uint8Array(pixels * 4);
    this.zFront = new Float32Array(pixels * 4);
    this.zBack = new Float32Array(pixels * 4);
  }

  get effectiveReversed(): boolean {
    return this.renderer.capabilities.reversedDepthBuffer;
  }

  get effectiveMode(): DepthMode {
    return this.effectiveReversed ? 'reversed' : 'direct';
  }

  get depthAttachmentType(): DepthAttachmentType {
    return this.depthType;
  }

  /**
   * 用于理论曲线的存储模型。
   * 优先采用“实测”结果：声明 24 位的附件在某些驱动上其实按 32F 存储，
   * 这时用 fixed24 画参考线会与实测完全对不上。
   */
  storageModel(): StorageModel {
    const measured = this.measuredStorage;
    if (measured === 'f32') return 'f32';
    if (measured === 'fixed16') return 'fixed16';
    if (measured === 'fixed24') return 'fixed24';
    return STORAGE_MODEL[this.depthType];
  }

  /** 该附件声明的存储模型（不做实测），用于 UI 显示“声称 vs 实际”。 */
  declaredStorageModel(): StorageModel {
    return STORAGE_MODEL[this.depthType];
  }

  readAttachmentInfo(): DepthAttachmentInfo {
    return readDepthAttachment(this.renderer, this.rtA);
  }

  /** 重新实测当前深度附件的真实存储行为，并缓存给理论曲线使用。 */
  probeStorage(): StorageProbe {
    const probe = probeStorageFor(this.renderer, this.depthType);
    this.measuredStorage = probe.storage;
    return probe;
  }

  /** 切换深度附件类型会重建所有带深度纹理的 RT。 */
  setDepthType(type: DepthAttachmentType): void {
    if (type === this.depthType) return;
    this.depthType = type;
    for (const target of [this.rtA, this.rtB, this.rtZFront, this.rtZBack]) target.dispose();
    this.rtA = makeDepthTarget(this.width, this.height, type);
    this.rtB = makeDepthTarget(this.width, this.height, type);
    this.rtZFront = makeDepthTarget(this.width, this.height, type, true);
    this.rtZBack = makeDepthTarget(this.width, this.height, type, true);
    this.compositeMaterial.uniforms.tColorA.value = this.rtA.texture;
    this.compositeMaterial.uniforms.tColorB.value = this.rtB.texture;
    this.compositeMaterial.uniforms.tFront.value = this.rtZFront.texture;
    this.compositeMaterial.uniforms.tBack.value = this.rtZBack.texture;
    restoreRendererState(this.renderer);
  }

  /** 只更新场景与相机，不渲染。 */
  prepare(params: SessionParams): void {
    const aspect = this.width / this.height;
    this.scene.update({
      distance: params.distance,
      keepScreenScale: params.keepScreenScale,
      gapScale: params.gapScale,
      fovDeg: params.fovDeg,
      aspect,
    });
    this.camera.fov = params.fovDeg;
    this.camera.aspect = aspect;
    this.camera.near = params.near;
    this.camera.far = params.far;
    this.camera.updateProjectionMatrix();

    const scaleZ = params.keepScreenScale ? params.distance : REFERENCE_DISTANCE;
    this.compositeMaterial.uniforms.uGapBase.value = params.gapScale * scaleZ;
    this.compositeMaterial.uniforms.uQuantum.value = depthStepWorld(
      Math.max(params.distance, params.near * 1.0001),
      params.near,
      params.far,
      this.effectiveMode,
      this.storageModel(),
    );
  }

  private renderPair(order: 'front-first' | 'back-first', target: THREE.WebGLRenderTarget): void {
    this.scene.setDrawOrder(order);
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene.scene, this.camera);
  }

  private renderViewZ(which: 'front' | 'back', target: THREE.WebGLRenderTarget): void {
    this.scene.setVisibility(which);
    this.renderer.setRenderTarget(target);
    // 清成 0 作为“未覆盖”哨兵：视角距离恒大于 0。
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, true);
    const previousOverride = this.scene.scene.overrideMaterial;
    this.scene.scene.overrideMaterial = this.viewZMaterial;
    this.renderer.render(this.scene.scene, this.camera);
    this.scene.scene.overrideMaterial = previousOverride;
    this.scene.setVisibility('both');
  }

  /** 完整一帧：两遍颜色 + 两个表面的视角距离 + 合成输出。 */
  renderFrame(params: SessionParams, overlay: OverlayMode): void {
    this.prepare(params);
    this.scene.setVisibility('both');
    this.renderPair('front-first', this.rtA);
    this.renderPair('back-first', this.rtB);
    this.renderViewZ('front', this.rtZFront);
    this.renderViewZ('back', this.rtZBack);
    this.renderer.setClearColor(0x000000, 1);

    this.compositeMaterial.uniforms.uOverlay.value =
      overlay === 'contested' ? 1 : overlay === 'delta' ? 2 : 0;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeQuad.scene, this.compositeQuad.camera);
  }

  private readColorBuffers(): void {
    this.renderer.readRenderTargetPixels(this.rtA, 0, 0, this.width, this.height, this.colorA);
    this.renderer.readRenderTargetPixels(this.rtB, 0, 0, this.width, this.height, this.colorB);
  }

  private readViewZBuffers(): void {
    this.renderer.readRenderTargetPixels(this.rtZFront, 0, 0, this.width, this.height, this.zFront);
    this.renderer.readRenderTargetPixels(this.rtZBack, 0, 0, this.width, this.height, this.zBack);
  }

  /**
   * 读回并统计当前帧（须在 renderFrame 且参数相同之后调用）。
   * 争抢 = 交换绘制顺序后颜色发生变化的像素。
   */
  measure(params: SessionParams): FrameStats {
    this.readColorBuffers();
    this.readViewZBuffers();
    const tiles: TileStats[] = [];
    let totalContested = 0;
    let totalCoverage = 0;
    const predictedStep = depthStepWorld(
      Math.max(params.distance, params.near * 1.0001),
      params.near,
      params.far,
      this.effectiveMode,
      this.storageModel(),
    );

    for (let index = 0; index < GAP_RATIOS.length; index++) {
      const rect = tilePixelRect(index, this.width, this.height, this.statsInsetPx);
      let coverage = 0;
      let contested = 0;
      let deltaMin = Number.POSITIVE_INFINITY;
      let deltaMax = 0;
      const deltas: number[] = [];
      for (let y = rect.y0; y < rect.y1; y++) {
        const row = this.height - 1 - y; // readPixels 原点在左下
        for (let x = rect.x0; x < rect.x1; x++) {
          const p = (row * this.width + x) * 4;
          const ar = this.colorA[p];
          const ag = this.colorA[p + 1];
          const ab = this.colorA[p + 2];
          const br = this.colorB[p];
          const bg = this.colorB[p + 1];
          const bb = this.colorB[p + 2];
          const zf = this.zFront[p];
          const zb = this.zBack[p];
          if (zf <= 0 || zb <= 0) continue;
          if (ar + ag + ab + br + bg + bb <= 12) continue;
          coverage++;
          if (ar !== br || ag !== bg || ab !== bb) contested++;
          const delta = Math.abs(zf - zb);
          if (delta < deltaMin) deltaMin = delta;
          if (delta > deltaMax) deltaMax = delta;
          if ((x + y) % 3 === 0) deltas.push(delta);
        }
      }
      deltas.sort((a, b) => a - b);
      tiles.push({
        index,
        gapRatio: GAP_RATIOS[index],
        gapWorld: this.scene.tiles[index].gapWorld,
        coveragePx: coverage,
        contestedPx: contested,
        ratio: coverage ? contested / coverage : 0,
        deltaMin: Number.isFinite(deltaMin) ? deltaMin : 0,
        deltaMedian: deltas.length ? deltas[deltas.length >> 1] : 0,
        deltaMax,
        predictedStep,
      });
      totalContested += contested;
      totalCoverage += coverage;
    }

    return {
      tiles,
      contestedPx: totalContested,
      coveragePx: totalCoverage,
      ratio: totalCoverage ? totalContested / totalCoverage : 0,
    };
  }

  /** 扫描专用：只比较两遍颜色，不做深度读回。 */
  sampleContention(params: SessionParams): ContentionSample[] {
    this.prepare(params);
    this.scene.setVisibility('both');
    this.renderPair('front-first', this.rtA);
    this.renderPair('back-first', this.rtB);
    this.renderer.setRenderTarget(null);
    this.readColorBuffers();

    const result: ContentionSample[] = [];
    for (let index = 0; index < GAP_RATIOS.length; index++) {
      const rect = tilePixelRect(index, this.width, this.height, this.statsInsetPx);
      let coverage = 0;
      let contested = 0;
      for (let y = rect.y0; y < rect.y1; y++) {
        const row = this.height - 1 - y;
        for (let x = rect.x0; x < rect.x1; x++) {
          const p = (row * this.width + x) * 4;
          const ar = this.colorA[p];
          const ag = this.colorA[p + 1];
          const ab = this.colorA[p + 2];
          const br = this.colorB[p];
          const bg = this.colorB[p + 1];
          const bb = this.colorB[p + 2];
          if (ar + ag + ab + br + bg + bb <= 12) continue;
          coverage++;
          if (ar !== br || ag !== bg || ab !== bb) contested++;
        }
      }
      result.push({
        index,
        contestedPx: contested,
        coveragePx: coverage,
        ratio: coverage ? contested / coverage : 0,
      });
    }
    return result;
  }

  /**
   * 读取某个像素处两个表面的视角距离。
   * 需要先渲染一帧（renderFrame），否则读到的是 0。
   */
  sampleDepthAt(x: number, y: number): { front: number; back: number } | null {
    const col = Math.min(this.width - 1, Math.max(0, Math.floor(x)));
    const row = Math.min(this.height - 1, Math.max(0, this.height - 1 - Math.floor(y)));
    const p = (row * this.width + col) * 4;
    if (this.zFront[p] <= 0 || this.zBack[p] <= 0) return null;
    return { front: this.zFront[p], back: this.zBack[p] };
  }

  /**
   * 当前帧中某个平面组实际覆盖像素的包围盒（画布像素坐标，原点左上）。
   * 用于验证“保持参考物比例”确实让屏幕占比恒定。
   * 需先 renderFrame + measure；数据来自 CPU 侧的颜色缓冲副本。
   */
  tileCoverageBounds(index: number): { x0: number; y0: number; x1: number; y1: number } | null {
    if (index < 0 || index >= GAP_RATIOS.length) return null;
    const rect = tilePixelRect(index, this.width, this.height, 0);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = -1;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = -1;
    for (let y = rect.y0; y < rect.y1; y++) {
      const row = this.height - 1 - y;
      for (let x = rect.x0; x < rect.x1; x++) {
        const p = (row * this.width + x) * 4;
        const covered =
          this.colorA[p] + this.colorA[p + 1] + this.colorA[p + 2] > 6 ||
          this.colorB[p] + this.colorB[p + 1] + this.colorB[p + 2] > 6;
        if (!covered) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
  }

  /** 导出当前帧的争抢蒙版（RGBA8），供调试与 e2e 断言使用。 */
  readContestedMask(): Uint8Array {
    const pixels = this.width * this.height;
    const out = new Uint8Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      const p = i * 4;
      const differs =
        this.colorA[p] !== this.colorB[p] ||
        this.colorA[p + 1] !== this.colorB[p + 1] ||
        this.colorA[p + 2] !== this.colorB[p + 2];
      out[p] = differs ? 255 : 0;
      out[p + 3] = 255;
    }
    return out;
  }

  dispose(): void {
    for (const target of [this.rtA, this.rtB, this.rtZFront, this.rtZBack]) target.dispose();
    this.compositeMaterial.dispose();
    this.viewZMaterial.dispose();
    this.compositeQuad.geometry.dispose();
    this.renderer.dispose();
  }
}
