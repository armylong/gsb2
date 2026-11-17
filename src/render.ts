import * as THREE from 'three';
import type { SceneMeshes } from './geometry';

export type CompositeMode = 'correct' | 'naive' | 'manual';

export const MAX_LAYERS = 4;

const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 正确模式的合成 shader。
 *
 * 输入:
 * - baseColor/baseDepth: 只含不透明挡板(与背景清屏色)的颜色与深度;
 * - layerColor[i]/layerDepth[i]: 第 i 个透明面单独渲染后的颜色与深度
 *   (挡板仍然参与深度测试,所以透明面落在挡板之后的片元写不进来)。
 *
 * 逐像素逻辑:
 * 1. 深度比挡板更浅(更近)的层,才是该像素上真实可见的透明片元;
 * 2. 按深度从近到远排序,再从后向前做 source-over;
 * 3. 没有任何透明片元时直接取 baseColor(挡板色或背景色)。
 *
 * 因为排序发生在每个像素内部,交叉面交线两侧的深度翻转可以被逐像素正确处理,
 * 与物体的添加/绘制顺序完全无关。
 */
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D baseColor;
uniform sampler2D baseDepth;
uniform sampler2D layerColor[${MAX_LAYERS}];
uniform sampler2D layerDepth[${MAX_LAYERS}];
uniform float layerValid[${MAX_LAYERS}];
uniform int layerCount;

void main() {
  vec3 bg = texture2D(baseColor, vUv).rgb;
  float opaqueDepth = texture2D(baseDepth, vUv).x;

  vec3 colors[${MAX_LAYERS}];
  float alphas[${MAX_LAYERS}];
  float depths[${MAX_LAYERS}];
  int cnt = 0;

  // GLSL ES 1.00 不允许用循环变量动态索引 sampler 数组,
  // 这里按 MAX_LAYERS 展开成常量索引(本演示最多 4 层,开销可忽略)。
  for (int i = 0; i < ${MAX_LAYERS}; i++) {
    if (i >= layerCount) break;
    if (layerValid[i] < 0.5) continue;
    float d = 0.0;
    vec4 c = vec4(0.0);
    if (i == 0) { d = texture2D(layerDepth[0], vUv).x; c = texture2D(layerColor[0], vUv); }
    if (i == 1) { d = texture2D(layerDepth[1], vUv).x; c = texture2D(layerColor[1], vUv); }
    if (i == 2) { d = texture2D(layerDepth[2], vUv).x; c = texture2D(layerColor[2], vUv); }
    if (i == 3) { d = texture2D(layerDepth[3], vUv).x; c = texture2D(layerColor[3], vUv); }
    // 未命中的层清屏为远平面深度 1.0、alpha=0,必须丢弃,
    // 否则它会被当成"极远但有效"的片元参与混合,污染结果。
    if (d >= 0.999999 || c.a <= 0.0001) continue;
    // 透明片元必须比不透明深度更近;1e-5 规避同深度抖动
    if (d < opaqueDepth - 1e-5) {
      colors[cnt] = c.rgb;
      alphas[cnt] = c.a;
      depths[cnt] = d;
      cnt++;
    }
  }

  // 插入排序:深度小(近)在前,深度相等时保持层序号稳定
  for (int i = 1; i < ${MAX_LAYERS}; i++) {
    if (i >= cnt) break;
    for (int j = i; j >= 1; j--) {
      if (depths[j] < depths[j - 1]) {
        float td = depths[j]; depths[j] = depths[j - 1]; depths[j - 1] = td;
        float ta = alphas[j]; alphas[j] = alphas[j - 1]; alphas[j - 1] = ta;
        vec3 tc = colors[j]; colors[j] = colors[j - 1]; colors[j - 1] = tc;
      } else {
        break;
      }
    }
  }

  vec3 outColor = bg;
  for (int i = ${MAX_LAYERS} - 1; i >= 0; i--) {
    if (i >= cnt) continue;
    outColor = alphas[i] * colors[i] + (1.0 - alphas[i]) * outColor;
  }

  // alpha=1 的透明面同样完全遮住后方:只保留它之前(更近)的片元,
  // 再以其颜色为不透明底色从后向前叠一遍,与参考实现 compositeFragments 一致。
  int cut = -1;
  for (int i = 0; i < ${MAX_LAYERS}; i++) {
    if (i >= cnt) break;
    if (alphas[i] >= 1.0) { cut = i; break; }
  }
  if (cut >= 0) {
    vec3 oc = colors[cut];
    for (int i = cut - 1; i >= 0; i--) {
      oc = alphas[i] * colors[i] + (1.0 - alphas[i]) * oc;
    }
    outColor = oc;
  }
  gl_FragColor = vec4(outColor, 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
`;

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  rt.depthTexture = new THREE.DepthTexture(w, h);
  rt.depthTexture.type = THREE.UnsignedIntType;
  rt.depthTexture.minFilter = THREE.NearestFilter;
  rt.depthTexture.magFilter = THREE.NearestFilter;
  return rt;
}

interface TargetSet {
  base: THREE.WebGLRenderTarget;
  layers: THREE.WebGLRenderTarget[];
  output: THREE.WebGLRenderTarget;
}

export class Compositor {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private fullScene: THREE.Scene;
  private targets: TargetSet;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private compositeMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private bgColor: THREE.Color;
  mode: CompositeMode = 'correct';
  /** 手动模式下的绘制顺序(先绘制 = 最底层) */
  manualOrder: string[] = [];

  constructor(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    background: number,
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.bgColor = new THREE.Color(background);
    this.fullScene = new THREE.Scene();
    this.fullScene.background = this.bgColor;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const base = makeTarget(size.x, size.y);
    const layers = Array.from({ length: MAX_LAYERS }, () => makeTarget(size.x, size.y));
    const output = makeTarget(size.x, size.y);
    this.targets = { base, layers, output };

    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        baseColor: { value: base.texture },
        baseDepth: { value: base.depthTexture },
        layerColor: { value: layers.map((t) => t.texture) },
        layerDepth: { value: layers.map((t) => t.depthTexture) },
        layerValid: { value: new Array(MAX_LAYERS).fill(0) },
        layerCount: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COPY_FRAG,
      uniforms: { tDiffuse: { value: output.texture } },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(w: number, h: number): void {
    const all = [this.targets.base, ...this.targets.layers, this.targets.output];
    for (const rt of all) rt.setSize(w, h);
  }

  private clearRt(rt: THREE.WebGLRenderTarget): void {
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(this.bgColor, 1);
    this.renderer.clear(true, true, true);
  }

  private renderCorrect(meshes: SceneMeshes): void {
    const { transparent, occluder } = meshes;
    const layerCount = Math.min(transparent.length, MAX_LAYERS);

    // 1) base:仅不透明挡板
    this.clearRt(this.targets.base);
    if (occluder) {
      this.renderer.setRenderTarget(this.targets.base);
      this.renderer.render(
        this.wrapOne(occluder, THREE.NormalBlending, true),
        this.camera,
      );
    }

    // 2) 每个透明面一层:NoBlending 直写颜色/alpha。
    //    关键:层里只放该透明面、不做挡板深度测试——否则挡板后方的片元会在
    //    光栅化阶段被直接剔除,合成 shader 就拿不到它们。挡板遮挡统一在第 3 步
    //    用 baseDepth 逐像素比较处理(不透明深度之后的透明片元被丢弃)。
    transparent.forEach((mesh, i) => {
      if (i >= MAX_LAYERS) return;
      const rt = this.targets.layers[i];
      this.clearRt(rt);
      const pass = new THREE.Scene();
      pass.background = this.bgColor;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const saved = {
        blending: mat.blending,
        depthWrite: mat.depthWrite,
        transparent: mat.transparent,
      };
      mat.blending = THREE.NoBlending;
      mat.depthWrite = true;
      mat.transparent = true;
      pass.add(mesh);
      this.renderer.setRenderTarget(rt);
      this.renderer.render(pass, this.camera);
      mat.blending = saved.blending;
      mat.depthWrite = saved.depthWrite;
      mat.transparent = saved.transparent;
    });

    // 3) 逐像素深度排序合成
    const u = this.compositeMat.uniforms;
    (u.layerValid.value as number[]).fill(0);
    for (let i = 0; i < layerCount; i++) (u.layerValid.value as number[])[i] = 1;
    u.layerCount.value = layerCount;
    this.quad.material = this.compositeMat;
    this.renderer.setRenderTarget(this.targets.output);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  private wrapOne(mesh: THREE.Mesh, blending: THREE.Blending, depthWrite: boolean): THREE.Scene {
    const pass = new THREE.Scene();
    pass.background = this.bgColor;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.blending = blending;
    mat.depthWrite = depthWrite;
    pass.add(mesh);
    return pass;
  }

  /**
   * 对照模式:three.js 原生单次渲染。
   * - 不透明挡板先画并写深度,天然截断后方透明面;
   * - 透明面 NormalBlending、depthWrite=false,按 renderOrder + 相机空间距离排序;
   * - naive:renderOrder 全 0,走 three.js 自带物体排序(交叉面必有一侧错);
   * - manual:按面板上的手动顺序赋 renderOrder。
   */
  private renderOrdered(meshes: SceneMeshes, mode: 'naive' | 'manual'): void {
    const { transparent, occluder } = meshes;
    this.fullScene.clear();
    this.fullScene.background = this.bgColor;
    if (occluder) {
      const mat = occluder.material as THREE.MeshBasicMaterial;
      mat.transparent = false;
      mat.depthWrite = true;
      occluder.renderOrder = 0;
      this.fullScene.add(occluder);
    }

    const orderRank = new Map(this.manualOrder.map((id, i) => [id, i]));
    transparent.forEach((mesh, idx) => {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.transparent = true;
      mat.blending = THREE.NormalBlending;
      mat.depthWrite = false;
      if (mode === 'manual') {
        mesh.renderOrder = orderRank.get(mesh.name) ?? idx;
      } else {
        mesh.renderOrder = 0; // 交给 three.js 按距离排序
      }
      this.fullScene.add(mesh);
    });

    this.renderer.setRenderTarget(this.targets.output);
    this.renderer.setClearColor(this.bgColor, 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.fullScene, this.camera);
  }

  render(meshes: SceneMeshes): void {
    if (this.mode === 'correct') this.renderCorrect(meshes);
    else this.renderOrdered(meshes, this.mode);
  }

  /** 把合成结果 blit 到默认帧缓冲(屏幕) */
  blitToScreen(): void {
    this.quad.material = this.copyMat;
    this.copyMat.uniforms.tDiffuse.value = this.targets.output.texture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  get outputTarget(): THREE.WebGLRenderTarget {
    return this.targets.output;
  }

  dispose(): void {
    [...Object.values(this.targets.layers), this.targets.base, this.targets.output].forEach((t) =>
      t.dispose(),
    );
    this.compositeMat.dispose();
    this.copyMat.dispose();
    this.quad.geometry.dispose();
  }
}
