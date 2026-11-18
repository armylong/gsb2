import * as THREE from 'three';
import type { SceneObject } from './types';
import type { FrameSnapshot } from './snapshot';

/**
 * 描边管线（自定义后处理，不依赖 EffectComposer）：
 *
 * Pass 1 场景颜色：正常渲染整个场景，得到颜色缓冲 + 场景深度（含挡板）。
 * Pass 2 ID 缓冲：只渲染当前可见（未隐藏）的可选对象，逐对象写入同一 ID，
 *                 深度单独渲染（不含挡板），R 通道存对象 ID、GBA 打包存该对象自身深度。
 *                 —— 同一对象的多个子网格写同一 ID，因此子网格接缝不会产生边线；
 *                    光滑曲面是连续表面，ID 一致，不会画出三角形边。
 * Pass 3 轮廓检测：在 ID 缓冲上按屏幕像素半径做邻域检测：
 *                 - 邻域出现不同 ID => 轮廓；
 *                 - 用 ID 深度与场景深度比较，区分可见轮廓 / 被挡板挡住的遮挡轮廓；
 *                 - 遮挡轮廓压暗并按屏幕像素虚线绘制。
 * Pass 4 合成：把轮廓叠加回场景颜色。
 */

const MAX_ID = 12;
const DEPTH_EPS = 2e-4;

const PACK_DEPTH = /* glsl */ `
vec4 packDepth(const in float depth) {
  const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
  const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
  vec4 res = fract(depth * bitShift);
  res -= res.xxyz * bitMask;
  return res;
}
float unpackDepth(const in vec4 rgba) {
  const vec4 bitShift = vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0);
  return dot(rgba, bitShift);
}
// ID 缓冲的 R 通道存 ID，深度只在 GBA（对应 packDepth 的后三位，最高位恒为 0）
float unpackDepthGba(const in vec4 rgba) {
  return rgba.g / (256.0 * 256.0) + rgba.b / 256.0 + rgba.a;
}
`;

/** Pass 2：把网格编码成 ID + 打包深度。R 通道存 ID，GBA 三通道打包窗口深度。 */
class IdMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        // id/255 在字节量化点上可精确还原（id 为 1..12 的小整数）
        uId: { value: 1 / 255 },
      },
      vertexShader: /* glsl */ `
        varying float vDepth;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vec4 clip = projectionMatrix * mvPosition;
          vDepth = clip.z / clip.w * 0.5 + 0.5; // [0,1] 窗口深度
          gl_Position = clip;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uId;
        varying float vDepth;
        ${PACK_DEPTH}
        void main() {
          vec4 packed = packDepth(vDepth);
          // R 通道被 ID 占用，深度只用 GBA（24 位精度足够本场景的前后比较）
          gl_FragColor = vec4(uId, packed.gba);
        }
      `,
      // 让 ID 深度比常规深度略微靠近相机，避免共面处的自遮挡抖动
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }
}

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Pass 3：ID 缓冲邻域轮廓检测 + 深度可见性分类。 */
const OUTLINE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tId;
  uniform sampler2D tSceneDepth;
  uniform vec2 uResolution;
  uniform float uRadius;
  uniform int uMode; // 0 = 仅可见, 1 = 可见 + 遮挡
  uniform vec3 uColors[${MAX_ID}];
  varying vec2 vUv;
  ${PACK_DEPTH}

  int decodeId(vec4 s) {
    return int(floor(s.r * 255.0 + 0.5));
  }

  void main() {
    vec2 texel = 1.0 / uResolution;
    vec4 center = texture2D(tId, vUv);
    int cid = decodeId(center);

    int radius = int(uRadius + 0.5);
    vec3 visSum = vec3(0.0);
    float visHits = 0.0;
    vec3 hidSum = vec3(0.0);
    float hidHits = 0.0;

    // radius==1 时只检查四邻域：描边落在边界本侧，宽度接近 1 设备像素；
    // radius>=2 时在圆盘内采样，环带随半径外扩加粗
    if (radius <= 1) {
      for (int k = 0; k < 4; k++) {
        vec2 off = vec2(0.0);
        if (k == 0) off = vec2(texel.x, 0.0);
        else if (k == 1) off = vec2(-texel.x, 0.0);
        else if (k == 2) off = vec2(0.0, texel.y);
        else off = vec2(0.0, -texel.y);
        vec4 ns = texture2D(tId, vUv + off);
        int nid = decodeId(ns);
        if (nid == cid) continue;
        float idDepth = unpackDepthGba(nid == 0 ? center : ns);
        float sceneDepth = texture2D(tSceneDepth, vUv + off).r;
        bool visible = idDepth <= sceneDepth + ${DEPTH_EPS.toFixed(6)};
        int edgeObj = nid == 0 ? cid : nid;
        vec3 base = uColors[edgeObj - 1];
        if (visible) {
          visSum += base;
          visHits += 1.0;
        } else if (uMode == 1) {
          hidSum += base * 0.42;
          hidHits += 1.0;
        }
      }
    } else {
      // 循环边界必须为常量；最大支持 6 像素
      for (int x = -6; x <= 6; x++) {
        for (int y = -6; y <= 6; y++) {
          if (x * x + y * y > radius * radius) continue;
          vec2 offset = vec2(float(x), float(y)) * texel;
          vec2 sampleUv = vUv + offset;
          vec4 ns = texture2D(tId, sampleUv);
          int nid = decodeId(ns);
          if (nid == cid) continue;

          // 背景邻域没有自身深度，借用中心像素（对象表面）的 ID 深度
          float idDepth = unpackDepthGba(nid == 0 ? center : ns);
          float sceneDepth = texture2D(tSceneDepth, sampleUv).r;
          bool visible = idDepth <= sceneDepth + ${DEPTH_EPS.toFixed(6)};

          // 轮廓归属：与背景相邻时归属中心对象，两个对象相邻时各自画自己一侧
          int edgeObj = nid == 0 ? cid : nid;
          vec3 base = uColors[edgeObj - 1];

          if (visible) {
            visSum += base;
            visHits += 1.0;
          } else if (uMode == 1) {
            hidSum += base * 0.42;
            hidHits += 1.0;
          }
        }
      }
    }

    // 遮挡轮廓虚线：沿屏幕对角线方向每 12 设备像素一段（段长随半径加粗仍保持可辨）
    float dash = mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 12.0), 2.0);

    if (visHits > 0.0) {
      // 固定 alpha：描边是实心环带，不随命中数累积，避免外圈过曝或透出错误填充色
      gl_FragColor = vec4(visSum / visHits, 0.92);
    } else if (uMode == 1 && hidHits > 0.0 && dash > 0.5) {
      gl_FragColor = vec4(hidSum / hidHits, 0.85);
    } else {
      gl_FragColor = vec4(0.0);
    }
  }
`;

/** Pass 4：场景颜色 + 轮廓合成（线性工作空间 -> sRGB 输出）。 */
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tOutline;
  varying vec2 vUv;
  vec3 linearToSrgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
  }
  void main() {
    vec4 scene = texture2D(tScene, vUv);
    vec4 outline = texture2D(tOutline, vUv);
    vec3 linear = mix(scene.rgb, outline.rgb, outline.a);
    gl_FragColor = vec4(linearToSrgb(linear), 1.0);
  }
`;

/** 验证辅助：把场景深度打包进 RGBA 颜色，避免直接 readPixels 深度附件的兼容性问题。 */
const DEPTH_COPY_FRAG = /* glsl */ `
  uniform sampler2D tSceneDepth;
  varying vec2 vUv;
  ${PACK_DEPTH}
  void main() {
    gl_FragColor = packDepth(texture2D(tSceneDepth, vUv).r);
  }
`;

function makeRenderTarget(width: number, height: number, nearest = false): THREE.WebGLRenderTarget {
  const depthTexture = new THREE.DepthTexture(width, height);
  depthTexture.type = THREE.UnsignedIntType;
  const filter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  return new THREE.WebGLRenderTarget(width, height, {
    minFilter: filter,
    magFilter: filter,
    type: THREE.UnsignedByteType,
    depthTexture,
  });
}

export class OutlinePipeline {
  private renderer: THREE.WebGLRenderer;
  private sceneTarget: THREE.WebGLRenderTarget;
  private idTarget: THREE.WebGLRenderTarget;
  private outlineTarget: THREE.WebGLRenderTarget;
  private compositeTarget: THREE.WebGLRenderTarget;
  private idMaterial = new IdMaterial();
  private fullscreenGeo: THREE.BufferGeometry;
  private fullscreenMesh: THREE.Mesh;
  private outlineMaterial: THREE.ShaderMaterial;
  private compositeMaterial: THREE.ShaderMaterial;
  private depthCopyMaterial: THREE.ShaderMaterial;
  private quadCamera = new THREE.Camera();
  private colorArray: THREE.Vector3[] = Array.from({ length: MAX_ID }, () => new THREE.Vector3());
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer, allObjects: SceneObject[]) {
    this.renderer = renderer;
    this.sceneTarget = makeRenderTarget(1, 1, false);
    // ID 缓冲必须用最近邻过滤：线性插值会把相邻像素的 ID/深度混合成错误编码
    this.idTarget = makeRenderTarget(1, 1, true);
    this.outlineTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
    });
    this.compositeTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
    });

    for (const obj of allObjects) {
      this.colorArray[obj.id - 1].set(obj.color.r, obj.color.g, obj.color.b);
    }

    this.fullscreenGeo = new THREE.BufferGeometry();
    this.fullscreenGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.fullscreenGeo.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2),
    );

    this.outlineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tId: { value: this.idTarget.texture },
        tSceneDepth: { value: this.sceneTarget.depthTexture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 2 },
        uMode: { value: 1 },
        uColors: { value: this.colorArray },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: OUTLINE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        tOutline: { value: this.outlineTarget.texture },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.depthCopyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSceneDepth: { value: this.sceneTarget.depthTexture },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DEPTH_COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.fullscreenMesh = new THREE.Mesh(this.fullscreenGeo, this.outlineMaterial);
    this.fullscreenMesh.frustumCulled = false;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneTarget.setSize(this.width, this.height);
    this.idTarget.setSize(this.width, this.height);
    this.outlineTarget.setSize(this.width, this.height);
    this.compositeTarget.setSize(this.width, this.height);
    this.outlineMaterial.uniforms.uResolution.value.set(this.width, this.height);
  }

  /**
   * CSS 像素宽度 -> 采样半径。轮廓在边界两侧各外扩约一个半径，
   * 因此环带厚度 ≈ 2*半径；取宽度的一半并保证至少 1 设备像素。
   * 随 DPR 缩放，使描边在屏幕上的 CSS 像素宽度保持一致。
   */
  setLineWidth(cssPixels: number, dpr: number): void {
    this.outlineMaterial.uniforms.uRadius.value = Math.max(
      1,
      Math.round((cssPixels * dpr) / 2),
    );
  }

  setMode(mode: 'visible' | 'hidden'): void {
    this.outlineMaterial.uniforms.uMode.value = mode === 'hidden' ? 1 : 0;
  }

  /** Pass 1：正常渲染场景（颜色 + 含挡板的场景深度）。 */
  private renderScene(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.autoClear = true;
    this.renderer.render(scene, camera);
  }

  /**
   * Pass 2：渲染 ID 缓冲。
   * 只包含未隐藏的可选对象；挡板不参与，因此被挡住的对象仍能写入自身 ID 与深度，
   * 之后再与场景深度比较来判定遮挡。
   */
  private renderId(objects: SceneObject[], camera: THREE.Camera): void {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.idTarget);
    renderer.autoClear = true;
    renderer.clear(true, true, false);
    renderer.autoClear = false;

    for (const obj of objects) {
      if (obj.hidden || !obj.group.visible) continue;
      const saved = obj.meshes.map((m) => m.material);
      this.idMaterial.uniforms.uId.value = obj.id / 255;
      for (const m of obj.meshes) m.material = this.idMaterial;
      renderer.render(obj.group, camera);
      obj.meshes.forEach((m, i) => {
        m.material = saved[i];
      });
    }
    renderer.autoClear = true;
  }

  private renderFullscreen(material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.fullscreenMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.autoClear = false;
    this.renderer.render(this.fullscreenMesh, this.quadCamera);
    this.renderer.autoClear = true;
  }

  /** 完整一帧：场景 -> ID -> 轮廓 -> 合成到屏幕。 */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    selectable: SceneObject[],
    mode: 'visible' | 'hidden',
    lineWidthCss: number,
    dpr: number,
  ): void {
    this.setMode(mode);
    this.setLineWidth(lineWidthCss, dpr);
    this.renderScene(scene, camera);
    this.renderId(selectable, camera);
    this.renderer.setRenderTarget(this.outlineTarget);
    this.renderer.clear(true, false, false);
    this.renderFullscreen(this.outlineMaterial, this.outlineTarget);
    this.renderFullscreen(this.compositeMaterial, this.compositeTarget);
    // 把合成结果 blit 到默认帧缓冲
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.fullscreenMesh, this.quadCamera);
  }

  /**
   * 屏幕拾取：渲染一次 ID 缓冲并读取像素。
   * 隐藏对象不写入 ID，因此天然不可点选；挡板也不写入 ID，点击挡板会选到其后沿。
   * 返回对象 id（1..N），未命中返回 0。
   */
  pick(
    deviceX: number,
    deviceY: number,
    objects: SceneObject[],
    camera: THREE.Camera,
  ): number {
    this.renderId(objects, camera);
    const buffer = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(
      this.idTarget,
      Math.floor(deviceX),
      Math.floor(this.height - deviceY),
      1,
      1,
      buffer,
    );
    return Math.round(buffer[0]);
  }

  /**
   * 验证用：一次回读整帧的 ID 缓冲与场景深度（仅 2 次 readPixels，
   * 避免逐像素同步回读导致的 GPU 管线停顿）。
   * 缓冲为 GL 行序（自下而上），用 sampleAt() 按屏幕坐标取像素。
   */
  captureOcclusionSnapshot(
    objects: SceneObject[],
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): FrameSnapshot {
    this.renderScene(scene, camera);
    this.renderFullscreen(this.depthCopyMaterial, this.outlineTarget);
    this.renderId(objects, camera);
    const id = new Uint8Array(this.width * this.height * 4);
    const depth = new Uint8Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.idTarget, 0, 0, this.width, this.height, id);
    this.renderer.readRenderTargetPixels(
      this.outlineTarget,
      0,
      0,
      this.width,
      this.height,
      depth,
    );
    return { width: this.width, height: this.height, id, depth, composite: new Uint8Array(0) };
  }

  /** 验证用：一次回读整帧最终合成画面（sRGB 编码 RGBA）。 */
  captureCompositeSnapshot(
    scene: THREE.Scene,
    camera: THREE.Camera,
    selectable: SceneObject[],
    mode: 'visible' | 'hidden',
    lineWidthCss: number,
    dpr: number,
  ): FrameSnapshot {
    this.render(scene, camera, selectable, mode, lineWidthCss, dpr);
    const composite = new Uint8Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(
      this.compositeTarget,
      0,
      0,
      this.width,
      this.height,
      composite,
    );
    return {
      width: this.width,
      height: this.height,
      id: new Uint8Array(0),
      depth: new Uint8Array(0),
      composite,
    };
  }

  /**
   * 测试钩子：渲染一帧并回读轮廓缓冲的 alpha 蒙版（255=轮廓像素）。
   * 直接量蒙版厚度，不受合成颜色混合与抗锯齿光晕影响。
   */
  captureOutlineMask(
    scene: THREE.Scene,
    camera: THREE.Camera,
    selectable: SceneObject[],
    mode: 'visible' | 'hidden',
    lineWidthCss: number,
    dpr: number,
  ): { width: number; height: number; alpha: Uint8Array } {
    this.setMode(mode);
    this.setLineWidth(lineWidthCss, dpr);
    this.renderScene(scene, camera);
    this.renderId(selectable, camera);
    this.renderer.setRenderTarget(this.outlineTarget);
    this.renderer.clear(true, false, false);
    this.renderFullscreen(this.outlineMaterial, this.outlineTarget);
    const rgba = new Uint8Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.outlineTarget, 0, 0, this.width, this.height, rgba);
    const alpha = new Uint8Array(this.width * this.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    return { width: this.width, height: this.height, alpha };
  }

  get drawingHeight(): number {
    return this.height;
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.idTarget.dispose();
    this.outlineTarget.dispose();
    this.compositeTarget.dispose();
    this.idMaterial.dispose();
    this.outlineMaterial.dispose();
    this.compositeMaterial.dispose();
    this.depthCopyMaterial.dispose();
    this.fullscreenGeo.dispose();
  }
}
