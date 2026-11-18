import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * 分屏合成 Pass：左半显示原画 RT，右半显示景深 RT。
 * 两个输入都在本 pass 内做同一套 tone mapping + sRGB 转换，
 * 与单屏模式下的 OutputPass 结果保持一致（需求 5）。
 */
const splitVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const splitFragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSource;

  void main() {
    // 输入是按整屏 aspect 渲染的完整画面，直接采样完整 UV
    vec4 color = texture2D(tSource, vUv);

    // tone mapping 与 sRGB 转换函数由 WebGLProgram 前缀按 renderer 配置自动注入
    #ifdef TONE_MAPPING
      color.rgb = toneMapping(color.rgb);
    #endif
    color = linearToOutputTexel(color);

    gl_FragColor = color;
  }
`;

export class SplitPresentPass extends Pass {
  uniforms: Record<string, THREE.IUniform>;
  private fsQuad: FullScreenQuad;
  private getOriginal: () => THREE.Texture;
  private getDof: () => THREE.Texture;

  constructor(
    getOriginal: () => THREE.Texture,
    getDof: () => THREE.Texture,
  ) {
    super();
    this.getOriginal = getOriginal;
    this.getDof = getDof;
    this.uniforms = {
      tSource: { value: getOriginal() },
    };

    // tone mapping / 输出色彩空间完全跟随 renderer，
    // 与单屏 OutputPass 使用同一份前缀配置，保证两侧观感一致。
    const material = new THREE.ShaderMaterial({
      name: 'SplitPresentShader',
      uniforms: this.uniforms,
      vertexShader: splitVertexShader,
      fragmentShader: splitFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(material);
  }

  render(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const fullW = Math.round(size.width * pr);
    const fullH = Math.round(size.height * pr);
    const halfW = Math.floor(fullW / 2);

    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    // 左半 viewport：原画。quad 在半宽 viewport 内铺满（NDC -1..1 映射到该 viewport），
    // vUv 0..1 对应完整纹理，因此显示完整构图、与整屏相同比例。
    this.uniforms.tSource.value = this.getOriginal();
    renderer.setViewport(0, 0, halfW, fullH);
    renderer.setScissor(0, 0, halfW, fullH);
    renderer.clear(true, true, true);
    this.fsQuad.render(renderer);

    // 右半 viewport：景深
    this.uniforms.tSource.value = this.getDof();
    renderer.setViewport(halfW, 0, fullW - halfW, fullH);
    renderer.setScissor(halfW, 0, fullW - halfW, fullH);
    renderer.clear(true, true, true);
    this.fsQuad.render(renderer);

    renderer.setScissorTest(false);
    renderer.autoClear = true;
    // 恢复全屏 viewport，避免影响后续 helper 渲染与下一帧
    renderer.setViewport(0, 0, fullW, fullH);
  }

  dispose(): void {
    (this.fsQuad.material as THREE.Material).dispose();
    this.fsQuad.dispose();
  }
}
