import * as THREE from 'three';
import { FogParams, boxMinMax, sunDirection } from './fog';
import { fogFragmentShader, fogVertexShader } from './shaders';

/**
 * 雾后处理 pass：
 * - 持有场景离屏 RT（颜色 + 深度纹理），窗口 resize 时同步重建
 * - 全屏四边形用 fog shader 合成最终画面
 */
export class FogPass {
  readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly tmpMin = new THREE.Vector3();
  private readonly tmpMax = new THREE.Vector3();
  private readonly tmpSun = new THREE.Vector3();

  constructor(width: number, height: number) {
    this.renderTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // 深度纹理是「深度/雾/原画面三者像素级对齐」的关键
    this.renderTarget.depthTexture = new THREE.DepthTexture(width, height);
    this.renderTarget.depthTexture.type = THREE.UnsignedShortType;
    this.renderTarget.depthTexture.format = THREE.DepthFormat;

    this.material = new THREE.ShaderMaterial({
      vertexShader: fogVertexShader,
      fragmentShader: fogFragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.renderTarget.texture },
        tDepth: { value: this.renderTarget.depthTexture },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uBoxMin: { value: new THREE.Vector3() },
        uBoxMax: { value: new THREE.Vector3() },
        uDensity: { value: 0 },
        uFalloff: { value: 1 },
        uFogTint: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uSunIntensity: { value: 1 },
        uAmbient: { value: new THREE.Color() },
        uAnisotropy: { value: 0 },
        uFogEnabled: { value: 1 },
      },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** 渲染场景到 RT，再用雾 shader 输出到屏幕 */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    params: FogParams,
  ): void {
    camera.updateMatrixWorld();
    const invViewProj = this.material.uniforms.uInvViewProj.value as THREE.Matrix4;
    invViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();

    boxMinMax(params, this.tmpMin, this.tmpMax);
    sunDirection(params.sunAzimuth, params.sunElevation, this.tmpSun);

    const u = this.material.uniforms;
    (u.uCameraPos.value as THREE.Vector3).copy(camera.position);
    (u.uBoxMin.value as THREE.Vector3).copy(this.tmpMin);
    (u.uBoxMax.value as THREE.Vector3).copy(this.tmpMax);
    u.uDensity.value = params.density;
    u.uFalloff.value = params.falloff;
    (u.uFogTint.value as THREE.Color).copy(params.fogTint);
    (u.uSunDir.value as THREE.Vector3).copy(this.tmpSun);
    (u.uSunColor.value as THREE.Color).copy(params.sunColor);
    u.uSunIntensity.value = params.sunIntensity;
    (u.uAmbient.value as THREE.Color).copy(params.ambient);
    u.uAnisotropy.value = params.anisotropy;
    u.uFogEnabled.value = params.fogEnabled ? 1 : 0;

    // 1) 场景 → 离屏 RT（带深度）
    renderer.setRenderTarget(this.renderTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // 2) 雾合成 → 默认帧缓冲
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
  }

  resize(width: number, height: number): void {
    // RenderTarget.setSize 只同步颜色纹理，depthTexture 的 image 尺寸要手动更新，
    // 否则深度会按旧分辨率采样，和颜色/雾错位
    this.renderTarget.setSize(width, height);
    const depthTexture = this.renderTarget.depthTexture;
    if (depthTexture) {
      depthTexture.image.width = width;
      depthTexture.image.height = height;
      depthTexture.needsUpdate = true;
    }
  }

  dispose(): void {
    this.renderTarget.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
