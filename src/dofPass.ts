import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * 自定义景深 Pass。
 *
 * 设计要点（对应需求 2/4/5）：
 * - 深度来自 RenderTarget 上的 DepthTexture（硬件线性深度，非颜色打包），
 *   模糊量只由“相机朝向上的线性深度”决定，同一深度平面上偏离画面中心的
 *   物体 CoC 相同，不会无故失焦。
 * - 焦平面两侧各有 focusRange/2 的完全清晰区，超出后 CoC 线性增长到 maxBlur。
 * - 采样盘内区分前景 tap / 背景 tap：
 *     背景按 tap 自身 CoC 加权平均；
 *     前景按 pre-multiplied alpha 累积，最后在背景层之上合成。
 *   因此前景轮廓处不会大面积透出错误的后景颜色。
 * - 单 pass 全分辨率 gather，每帧从当前颜色/深度纹理重新计算，
 *   相机转动或参数变化后不存在旧帧残留。
 * - HalfFloat 目标下亮点保留 HDR 亮度，散景呈现为可辨认的圆盘。
 */

const dofVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const dofFragmentShader = /* glsl */ `
  #include <common>
  #include <packing>

  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float focus;        // 焦点距离（沿相机朝向，世界单位）
  uniform float focusRange;   // 清晰区全宽（世界单位）
  uniform float maxBlur;      // 最大模糊半径（像素）

  const int TAPS = 36;
  const float GOLDEN_ANGLE = 2.39996323;
  const float DEPTH_EPS = 0.03;

  float getLinearDepth(const in vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    float viewZ = perspectiveDepthToViewZ(d, cameraNear, cameraFar);
    return -viewZ;
  }

  // 离焦 CoC 半径（像素）：清晰区内为 0，之后线性增长到 maxBlur
  float cocRadius(float depth) {
    float halfRange = focusRange * 0.5;
    float dist = abs(depth - focus);
    float t = clamp((dist - halfRange) / max(halfRange, 1e-4), 0.0, 1.0);
    return t * maxBlur;
  }

  void main() {
    vec3 centerColor = texture2D(tColor, vUv).rgb;

    // maxBlur 为 0 时直接输出原画（需求 1 的关键验证点）
    if (maxBlur <= 0.0001) {
      gl_FragColor = vec4(centerColor, 1.0);
      return;
    }

    float centerDepth = getLinearDepth(vUv);
    float rc = cocRadius(centerDepth);

    // 中心像素清晰：无需任何采样
    if (rc <= 0.0001) {
      gl_FragColor = vec4(centerColor, 1.0);
      return;
    }

    // 中心像素固定作为背景层的一个全权重样本
    vec3 bgColor = centerColor;
    float bgWeight = 1.0;
    vec3 fgColor = vec3(0.0);
    float fgWeight = 0.0;

    vec2 texel = 1.0 / resolution;

    for (int i = 1; i < TAPS; i++) {
      // 黄金角螺旋 + sqrt 半径 → 近似均匀圆盘采样
      float r = sqrt((float(i) + 0.5) / float(TAPS));
      float theta = float(i) * GOLDEN_ANGLE;
      vec2 diskOffset = vec2(cos(theta), sin(theta)) * r * rc * texel;
      vec2 uv = clamp(vUv + diskOffset, vec2(0.0), vec2(1.0));

      vec3 tapColor = texture2D(tColor, uv).rgb;
      float tapDepth = getLinearDepth(uv);
      float rt = cocRadius(tapDepth);

      // tap 相对中心像素的混合强度（均在中心像素的模糊盘内）
      float alpha = clamp(rt / rc, 0.0, 1.0);

      if (tapDepth < centerDepth - DEPTH_EPS) {
        // 前景 tap：pre-multiplied alpha 累积，最后覆盖式合成
        fgColor += tapColor * alpha;
        fgWeight += alpha;
      } else {
        // 背景 / 同深度 tap：按自身 CoC 加权，清晰的背景不向模糊区渗透
        bgColor += tapColor * alpha;
        bgWeight += alpha;
      }
    }

    vec3 bg = bgColor / max(bgWeight, 1e-4);
    vec3 fg = fgWeight > 1e-4 ? fgColor / fgWeight : vec3(0.0);

    // 盘内前景 tap 占比 → 前景覆盖 alpha
    float cover = clamp(fgWeight / float(TAPS - 1), 0.0, 1.0);
    cover = smoothstep(0.0, 1.0, cover);

    vec3 finalColor = mix(bg, fg, cover);
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

export class DofPass extends Pass {
  uniforms: Record<string, THREE.IUniform>;
  private fsQuad: FullScreenQuad;
  private camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    super();
    this.camera = camera;
    this.uniforms = {
      tColor: { value: null },
      tDepth: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      cameraNear: { value: camera.near },
      cameraFar: { value: camera.far },
      focus: { value: 14 },
      focusRange: { value: 2.5 },
      maxBlur: { value: 10 },
    };

    const material = new THREE.ShaderMaterial({
      name: 'DepthAwareDofShader',
      uniforms: this.uniforms,
      vertexShader: dofVertexShader,
      fragmentShader: dofFragmentShader,
    });

    this.fsQuad = new FullScreenQuad(material);
  }

  setParams(params: { focus: number; focusRange: number; maxBlur: number }): void {
    this.uniforms.focus.value = params.focus;
    this.uniforms.focusRange.value = params.focusRange;
    this.uniforms.maxBlur.value = params.maxBlur;
  }

  /**
   * 与 shader 完全一致的 CoC 半径公式（CPU 侧镜像，供验证）。
   * 只接收线性深度，与屏幕位置无关 —— 同一深度平面上任意点 CoC 相同。
   */
  computeCocPixels(depth: number): number {
    const focus = this.uniforms.focus.value as number;
    const focusRange = this.uniforms.focusRange.value as number;
    const maxBlur = this.uniforms.maxBlur.value as number;
    const halfRange = focusRange * 0.5;
    const dist = Math.abs(depth - focus);
    const t = THREE.MathUtils.clamp((dist - halfRange) / Math.max(halfRange, 1e-4), 0, 1);
    return t * maxBlur;
  }

  setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.uniforms.tColor.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.cameraNear.value = this.camera.near;
    this.uniforms.cameraFar.value = this.camera.far;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      this.fsQuad.render(renderer);
    }
  }

  dispose(): void {
    (this.fsQuad.material as THREE.Material).dispose();
    this.fsQuad.dispose();
  }
}
