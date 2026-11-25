import * as THREE from 'three';
import { buildGrainGLSL, GRAIN_UNIFORMS, type GrainUniforms } from './grain';

export interface GrainMaterialOptions {
  color?: number;
  metalness?: number;
}

/**
 * 在 MeshPhysicalMaterial 上注入「逐点变化」的各向异性 GGX。
 * three 内置 anisotropy 的切向在整张表面上是常量，无法表达环形纹，
 * 因此这里替换 BRDF_GGX，方向场在片元着色器中按物体空间位置解析。
 *
 * 环境光/漫反射/清漆等其余物理材质逻辑保持不变；场景用均匀弱环境贴图提供金属底色，
 * 方向性镜面高光全部来自可移动的聚光灯。
 */
export function createGrainMaterial(options: GrainMaterialOptions = {}): THREE.MeshPhysicalMaterial {
  const { vertexPars, vertexBody, fragmentPars, brdfReplacement } = buildGrainGLSL();
  const uniforms: GrainUniforms = THREE.UniformsUtils.clone(GRAIN_UNIFORMS);

  const material = new THREE.MeshPhysicalMaterial({
    color: options.color ?? 0xb8bcc2,
    metalness: options.metalness ?? 1.0,
    roughness: 0.35, // 实际粗糙度由 uniform 决定，这里仅给一个合理初值
    envMapIntensity: 0.55, // 弱环境反射只负责金属底色，方向性高光仍由聚光灯主导
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrainMode = uniforms.uGrainMode;
    shader.uniforms.uGrainAngle = uniforms.uGrainAngle;
    shader.uniforms.uGrainCenter = uniforms.uGrainCenter;
    shader.uniforms.uRoughAlong = uniforms.uRoughAlong;
    shader.uniforms.uRoughAcross = uniforms.uRoughAcross;
    shader.uniforms.uGrainModelMatrix = uniforms.uGrainModelMatrix;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexBody}`);

    // r160 的 onBeforeCompile 发生在 #include 展开（resolveIncludes）之前。
    // BRDF_GGX 的定义和调用点在同一个 chunk（lights_physical_pars_fragment）里，
    // 用宏重命名会把调用点一起改掉。因此直接取该 chunk 原文，只替换函数定义、
    // 保留同 chunk 内的调用点 BRDF_GGX(...)，再把整段文本替换那行 include。
    const includeGuard = '#include <lights_physical_pars_fragment>';
    const chunk = THREE.ShaderChunk['lights_physical_pars_fragment'];
    if (!chunk || !shader.fragmentShader.includes(includeGuard)) {
      throw new Error('lights_physical_pars_fragment 注入点未找到，three 版本可能不是 0.160.x');
    }
    // 匹配从 BRDF_GGX 函数签名到其首个独占一行的右花括号（非贪婪，不会碰到后面的调用点）
    const defRegex = /vec3 BRDF_GGX\( const in vec3 lightDir[\s\S]*?\n\}/;
    if (!defRegex.test(chunk)) {
      throw new Error('BRDF_GGX 函数定义未找到，three 版本可能不是 0.160.x');
    }
    const patchedChunk = chunk.replace(defRegex, brdfReplacement.trimEnd());
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace(includeGuard, patchedChunk);
  };

  // 让 onBeforeCompile 生成的程序独立缓存，两块样板可以分别调 uniform
  material.customProgramCacheKey = () => 'grain-aniso-v1';

  // 每次绘制前把当前 mesh 的模型矩阵灌进 uniform（片元着色器无内建 modelMatrix）。
  // r160 运行时有该钩子，但 @types 未声明，这里做显式类型扩展。
  type MaterialWithRenderHook = THREE.MeshPhysicalMaterial & {
    onBeforeRender: (
      renderer: THREE.WebGLRenderer,
      scene: THREE.Scene,
      camera: THREE.Camera,
      geometry: THREE.BufferGeometry,
      object: THREE.Object3D,
    ) => void;
  };
  (material as MaterialWithRenderHook).onBeforeRender = (
    _renderer,
    _scene,
    _camera,
    _geometry,
    object,
  ) => {
    const u = material.userData.grain as GrainUniforms;
    u.uGrainModelMatrix.value.copy(object.matrixWorld);
  };

  // 把 grain uniform 挂到材质上，外部通过 material.userData.grain 更新
  material.userData.grain = uniforms;
  return material;
}

export function setGrainUniforms(
  material: THREE.MeshPhysicalMaterial,
  values: Partial<{
    mode: number;
    angle: number;
    center: THREE.Vector3;
    roughAlong: number;
    roughAcross: number;
  }>,
): void {
  const u = material.userData.grain as GrainUniforms;
  if (values.mode !== undefined) u.uGrainMode.value = values.mode;
  if (values.angle !== undefined) u.uGrainAngle.value = values.angle;
  if (values.center) u.uGrainCenter.value.copy(values.center);
  if (values.roughAlong !== undefined) u.uRoughAlong.value = values.roughAlong;
  if (values.roughAcross !== undefined) u.uRoughAcross.value = values.roughAcross;
}
