import * as THREE from 'three';
import {
  HalfFloatType,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  Color,
} from 'three';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { SmoothLevel, ViewMode } from './types';

/**
 * AoPipeline：在 three 自带 SSAOPass 之上做四层定制
 *  1. 给 SSAO shader 补丁注入 uDepthBias（深度偏移，正交深度单位）
 *  2. 自带 beauty RT（与法线 RT 共享同一张深度纹理），AO 与原始光照在合成阶段混合
 *  3. 合成 shader 支持 关闭/开启/灰度 三种模式、intensity 强度、背景深度掩膜
 *  4. 合成用 gl_FragCoord 做像素精确 1:1 映射 + viewport/scissor 分块，
 *     分屏两侧共享同一相机与投影，移动分界不改变采样与透视比例
 */

const COMPOSITE_FS = /* glsl */ `
  uniform sampler2D tBeauty;
  uniform sampler2D tAo;
  uniform sampler2D tDepth;
  uniform float uIntensity;
  uniform float uMode; // 0 = off, 1 = on, 2 = gray
  uniform vec2 uResolution; // 内部全分辨率缓冲尺寸（= 画布绘图尺寸）

  void main() {
    // 内部缓冲与画布同分辨率，分屏/单画面都是 1:1 像素拷贝；
    // 用 gl_FragCoord 取像素中心对齐的源 UV，任何分界位置都不产生插值偏移，透视不变
    vec2 uv = gl_FragCoord.xy / uResolution;
    float depth = texture2D( tDepth, uv ).x;
    float ao = texture2D( tAo, uv ).r;

    // 背景（深度清屏值 1.0）永远不被当成近处表面：
    // 即使模糊把前景暗部带到了背景像素，这里也强制恢复为无遮蔽
    if ( depth >= 0.999999 ) { ao = 1.0; }

    vec3 beauty = texture2D( tBeauty, uv ).rgb;
    vec3 color;

    if ( uMode < 0.5 ) {
      color = beauty;
    } else if ( uMode < 1.5 ) {
      // 强度 0 时 factor 恒为 1，与关闭遮蔽完全一致；强度 >1 允许压得更黑
      float occlusion = clamp( uIntensity, 0.0, 4.0 ) * ( 1.0 - ao );
      float factor = clamp( 1.0 - occlusion, 0.0, 1.0 );
      color = beauty * factor;
    } else {
      color = vec3( ao );
    }

    gl_FragColor = vec4( color, 1.0 );
    #include <colorspace_fragment>
  }
`;

const COMPOSITE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/** 深度感知双边模糊：7x7，深度突变处权重趋零，降噪同时保住轮廓、不向背景扩散 */
const BILATERAL_FS = /* glsl */ `
  uniform sampler2D tAo;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  varying vec2 vUv;

  void main() {
    float centerDepth = texture2D( tDepth, vUv ).x;
    float sum = 0.0;
    float wsum = 0.0;

    for ( int x = -3; x <= 3; x ++ ) {
      for ( int y = -3; y <= 3; y ++ ) {
        vec2 uv = vUv + vec2( float( x ), float( y ) ) * uTexel;
        float d = texture2D( tDepth, uv ).x;
        float spatial = exp( - float( x * x + y * y ) / 9.0 );
        float depthW = exp( - abs( d - centerDepth ) * 300.0 );
        float w = spatial * depthW;
        sum += texture2D( tAo, uv ).r * w;
        wsum += w;
      }
    }

    gl_FragColor = vec4( vec3( sum / wsum ), 1.0 );
  }
`;

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BG_COLOR = new Color('#e8ebf0');

export class AoPipeline {
  readonly ssaoPass: SSAOPass;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private beautyRT: WebGLRenderTarget;
  private bilateralRT: WebGLRenderTarget;
  private bilateralMat: ShaderMaterial;
  private compositeMat: ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private width: number;
  private height: number;
  private radius = 8;
  private depthBias = 0.02;
  private smooth: SmoothLevel = 'standard';
  private depthProbeMat: ShaderMaterial | null = null;
  private depthProbeRT: WebGLRenderTarget | null = null;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.width = width;
    this.height = height;

    const pass = new SSAOPass(scene, camera, width, height, 32);
    this.ssaoPass = pass;

    // ---- 0. 确定性随机：重生成固定种子的采样核与旋转噪声，保证验证可重复 ----
    this.seedKernelAndNoise(pass, 13702);

    // ---- 1. 深度偏移补丁 ----
    const ssaoMat = pass.ssaoMaterial;
    ssaoMat.fragmentShader = ssaoMat.fragmentShader
      .replace(
        'uniform float maxDistance; // avoid the influence of fragments which are too far away',
        'uniform float maxDistance; // avoid the influence of fragments which are too far away\n\t\tuniform float uDepthBias; // patched: 深度偏移，抑制自遮蔽噪点',
      )
      .replace(
        'if ( delta > minDistance && delta < maxDistance )',
        'if ( delta > minDistance + uDepthBias && delta < maxDistance )',
      );
    ssaoMat.uniforms.uDepthBias = { value: this.depthBias };
    ssaoMat.needsUpdate = true;

    // ---- 2. beauty RT，复用法线 RT 的深度纹理 ----
    this.beautyRT = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      depthTexture: pass.normalRenderTarget.depthTexture,
    });

    this.bilateralRT = new WebGLRenderTarget(width, height, { type: HalfFloatType });

    this.bilateralMat = new ShaderMaterial({
      vertexShader: COMPOSITE_VS,
      fragmentShader: BILATERAL_FS,
      uniforms: {
        tAo: { value: pass.ssaoRenderTarget.texture },
        tDepth: { value: pass.normalRenderTarget.depthTexture },
        uTexel: { value: new Vector2(1 / width, 1 / height) },
      },
    });

    this.compositeMat = new ShaderMaterial({
      vertexShader: COMPOSITE_VS,
      fragmentShader: COMPOSITE_FS,
      uniforms: {
        tBeauty: { value: this.beautyRT.texture },
        tAo: { value: pass.blurRenderTarget.texture },
        tDepth: { value: pass.normalRenderTarget.depthTexture },
        uIntensity: { value: 1 },
        uMode: { value: 1 },
        uResolution: { value: new Vector2(width, height) },
      },
    });

    this.fsQuad = new FullScreenQuad(this.compositeMat);
  }

  setSize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.width = width;
    this.height = height;
    this.ssaoPass.setSize(width, height);
    this.beautyRT.setSize(width, height);
    this.bilateralRT.setSize(width, height);
    this.bilateralMat.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.compositeMat.uniforms.uResolution.value.set(width, height);
  }

  setParams(radius: number, depthBias: number, smooth: SmoothLevel): void {
    this.radius = radius;
    this.depthBias = depthBias;
    this.smooth = smooth;
  }

  /** mulberry32：轻量确定性 PRNG，替代 Math.random，让 SSAO 核与噪声在每次加载时完全一致 */
  private mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private seedKernelAndNoise(pass: SSAOPass, seed: number): void {
    const rand = this.mulberry32(seed);
    // 重生成采样核（逻辑与 SSAOPass.generateSampleKernel 一致，仅替换随机源）
    pass.kernel.length = 0;
    for (let i = 0; i < 32; i++) {
      const sample = new THREE.Vector3();
      sample.x = rand() * 2 - 1;
      sample.y = rand() * 2 - 1;
      sample.z = rand();
      sample.normalize();
      let scale = i / 32;
      scale = THREE.MathUtils.lerp(0.1, 1, scale * scale);
      sample.multiplyScalar(scale);
      pass.kernel.push(sample);
    }
    // 重生成 4x4 旋转噪声（simplex 输入改为确定性坐标）
    const data = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      const x = rand() * 2 - 1;
      const y = rand() * 2 - 1;
      // 与原实现保持相同的噪声形态，只把随机源种子化
      data[i] = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1;
    }
    pass.noiseTexture.image.data.set(data);
    pass.noiseTexture.needsUpdate = true;
    pass.ssaoMaterial.uniforms.kernel.value = pass.kernel;
    pass.ssaoMaterial.uniforms.tNoise.value = pass.noiseTexture;
  }

  /** 内部全分辨率 pass：法线/深度 -> SSAO -> 平滑 -> beauty，每帧重算，无任何烘焙贴图 */
  prepare(): void {
    const { renderer, ssaoPass: pass } = this;
    const internals = pass as unknown as {
      overrideVisibility: () => void;
      restoreVisibility: () => void;
    };
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.width, this.height);

    // 法线 + 深度
    internals.overrideVisibility();
    pass.renderOverride(renderer, pass.normalMaterial, pass.normalRenderTarget, 0x7777ff, 1.0);
    internals.restoreVisibility();

    // 原始 SSAO（半径/偏移在这里真正进入采样循环）
    pass.ssaoMaterial.uniforms.kernelRadius.value = this.radius;
    pass.ssaoMaterial.uniforms.uDepthBias.value = this.depthBias;
    pass.renderPass(renderer, pass.ssaoMaterial, pass.ssaoRenderTarget);

    // 平滑档位
    if (this.smooth === 'standard') {
      pass.renderPass(renderer, pass.blurMaterial, pass.blurRenderTarget);
    } else if (this.smooth === 'high') {
      pass.renderPass(renderer, this.bilateralMat, this.bilateralRT);
    }

    // 原始光照 beauty（深度纹理与法线 pass 共享）
    renderer.setRenderTarget(this.beautyRT);
    renderer.setClearColor(BG_COLOR, 1);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  /** 把指定模式合成到画布的一个矩形区域（分屏或单画面） */
  blit(mode: ViewMode, intensity: number, rect: ScreenRect): void {
    const { renderer, ssaoPass: pass } = this;
    let aoTex;
    if (this.smooth === 'high') {
      aoTex = this.bilateralRT.texture;
    } else if (this.smooth === 'standard') {
      aoTex = pass.blurRenderTarget.texture;
    } else {
      aoTex = pass.ssaoRenderTarget.texture;
    }

    const u = this.compositeMat.uniforms;
    u.tAo.value = aoTex;
    u.uMode.value = mode === 'off' ? 0 : mode === 'on' ? 1 : 2;
    u.uIntensity.value = intensity;
    // 源纹理按像素中心 1:1 采样，UV 由 fragment shader 用 gl_FragCoord 计算；
    // 这里只通过 viewport+scissor 限制输出矩形，移动分界不改变任何采样/透视

    renderer.setRenderTarget(null);
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissorTest(true);
    this.fsQuad.material = this.compositeMat;
    this.fsQuad.render(renderer);
  }

  /** 验证用：按 NDC 坐标（-1..1，y 向上）读画布像素 */
  readPixel(ndcX: number, ndcY: number): Uint8Array {
    const px = Math.floor(((ndcX + 1) / 2) * this.width);
    const py = Math.floor(((ndcY + 1) / 2) * this.height);
    const buf = new Uint8Array(4);
    const gl = this.renderer.getContext();
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  /** 验证用：按 NDC 读设备深度（1.0 = 空背景清屏值） */
  readDepth(ndcX: number, ndcY: number): number {
    const px = Math.floor(((ndcX + 1) / 2) * this.width);
    const py = Math.floor(((ndcY + 1) / 2) * this.height);
    if (!this.depthProbeMat) {
      this.depthProbeRT = new WebGLRenderTarget(1, 1, { depthBuffer: false });
      this.depthProbeMat = new ShaderMaterial({
        vertexShader: COMPOSITE_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDepth;
          uniform vec2 uUv;
          varying vec2 vUv;
          void main() {
            float d = texture2D( tDepth, uUv ).x;
            gl_FragColor = vec4( d, d, d, 1.0 );
          }
        `,
        uniforms: {
          tDepth: { value: this.ssaoPass.normalRenderTarget.depthTexture },
          uUv: { value: new Vector2() },
        },
        depthTest: false,
        depthWrite: false,
      });
    }
    const u = this.depthProbeMat.uniforms.uUv.value as Vector2;
    u.set(px / this.width, py / this.height);
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.depthProbeRT);
    this.fsQuad.material = this.depthProbeMat;
    this.fsQuad.render(this.renderer);
    const buf = new Uint8Array(4);
    const gl = this.renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.renderer.setRenderTarget(prevTarget);
    this.fsQuad.material = this.compositeMat;
    return buf[0] / 255;
  }

  /** 把世界坐标投影为 NDC，验证探针用 */
  projectToNdc(point: THREE.Vector3): { x: number; y: number } {
    const p = point.clone().project(this.camera);
    return { x: p.x, y: p.y };
  }

  dispose(): void {
    this.ssaoPass.dispose();
    this.beautyRT.dispose();
    this.bilateralRT.dispose();
    this.bilateralMat.dispose();
    this.compositeMat.dispose();
    this.depthProbeMat?.dispose();
    this.depthProbeRT?.dispose();
    this.fsQuad.dispose();
  }
}
