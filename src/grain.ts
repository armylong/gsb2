import * as THREE from 'three';

/**
 * 拉丝方向场（grain direction field）的唯一定义来源。
 *
 * 同一份数学同时用于：
 *  - GLSL 片元着色器里的各向异性 BRDF（见 buildGrainGLSL）
 *  - 点击拾取时在物体空间计算方向线（见 grainTangentAt）
 *  - 方向场示意网格（见 buildFieldArrows）
 *
 * 约定：
 *  - 直线纹：纹路沿物体局部 Y 轴，grainAngle 绕表面法线（局部 +Z）旋转
 *  - 环形纹：纹路是绕 grainCenter 的同心圆，中心处方向不明确，权重平滑降到 0
 *  - 所有方向都在「物体局部空间」定义，跟随 modelMatrix（即物体转动）一起走
 */

export type GrainMode = 'linear' | 'circular';

/** 环形纹中心附近的退化半径（物体局部单位），低于该半径各向异性权重平滑收敛 */
export const CIRCULAR_EPS = 0.08;

export interface GrainConfig {
  mode: GrainMode;
  /** 纹路相对默认方向的转角（弧度，绕局部法线） */
  angle: number;
  /** 环形纹圆心（物体局部空间） */
  center: THREE.Vector3;
}

export const GRAIN_UNIFORMS = {
  uGrainMode: { value: 0 }, // 0 = 直线纹, 1 = 环形纹
  uGrainAngle: { value: 0 },
  uGrainCenter: { value: new THREE.Vector3(0, 0, 0) },
  uRoughAlong: { value: 0.25 },
  uRoughAcross: { value: 0.6 },
  // three 的片元着色器没有内建 modelMatrix，由 JS 每帧从 mesh 同步
  uGrainModelMatrix: { value: new THREE.Matrix4() },
};

export type GrainUniforms = typeof GRAIN_UNIFORMS;

/**
 * 物体局部空间的拉丝切向量（纹路方向）。
 * position/localNormal 均为物体局部坐标。
 */
export function grainTangentAt(
  config: GrainConfig,
  position: THREE.Vector3,
  localNormal: THREE.Vector3,
  target: THREE.Vector3,
): THREE.Vector3 {
  if (config.mode === 'linear') {
    // 默认纹路沿局部 Y，绕局部法线旋转 angle
    target.set(0, 1, 0).applyAxisAngle(localNormal, config.angle);
    return target;
  }

  // 环形纹：径向 = position - center 投影到切平面，纹路切向 = 法线 × 径向
  const radial = target.copy(position).sub(config.center);
  radial.addScaledVector(localNormal, -radial.dot(localNormal));
  const r = radial.length();
  if (r < 1e-7) {
    // 圆心：方向不明确，回退到局部 Y（权重此时为 0，仅保证归一化稳定）
    target.set(0, 1, 0);
    return target;
  }
  radial.multiplyScalar(1 / r);
  target.crossVectors(localNormal, radial).normalize();
  // 旋转 angle：仍在切平面内绕法线转
  target.applyAxisAngle(localNormal, config.angle);
  return target;
}

/** 环形纹在局部位置处的各向异性权重（圆心平滑降为 0） */
export function grainWeightAt(config: GrainConfig, position: THREE.Vector3, localNormal: THREE.Vector3): number {
  if (config.mode === 'linear') return 1;
  const radial = position.clone().sub(config.center);
  radial.addScaledVector(localNormal, -radial.dot(localNormal));
  return smoothstep(CIRCULAR_EPS, CIRCULAR_EPS * 3.0, radial.length());
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 生成注入 MeshPhysicalMaterial 的 GLSL：
 * 顶点侧传递物体空间位置/法线/参数切向量，片元侧计算纹路切向 + 各向异性 GGX。
 */
export function buildGrainGLSL(): {
  vertexPars: string;
  vertexBody: string;
  fragmentPars: string;
  brdfReplacement: string;
} {
  const vertexPars = /* glsl */ `
#ifndef GRAIN_PARS_VERTEX
#define GRAIN_PARS_VERTEX
attribute vec3 aTanU;
attribute vec3 aTanV;
varying vec3 vGrainPos;
varying vec3 vGrainNormal;
varying vec3 vGrainTanU;
varying vec3 vGrainTanV;
#endif
`;

  const vertexBody = /* glsl */ `
#ifndef GRAIN_BODY_VERTEX
#define GRAIN_BODY_VERTEX
vGrainPos = position;
vGrainNormal = objectNormal;
vGrainTanU = aTanU;
vGrainTanV = aTanV;
#endif
`;

  const fragmentPars = /* glsl */ `
#ifndef GRAIN_PARS_FRAGMENT
#define GRAIN_PARS_FRAGMENT
uniform int uGrainMode;
uniform float uGrainAngle;
uniform vec3 uGrainCenter;
uniform float uRoughAlong;
uniform float uRoughAcross;
uniform mat4 uGrainModelMatrix;
varying vec3 vGrainPos;
varying vec3 vGrainNormal;
varying vec3 vGrainTanU;
varying vec3 vGrainTanV;

// 与 grain.ts 的 grainTangentAt / grainWeightAt 保持同一套数学
vec3 grainTangentLocal() {
  vec3 n = normalize(vGrainNormal);
  if (uGrainMode == 0) {
    return normalize(vec3(sin(uGrainAngle), cos(uGrainAngle), 0.0)
      - n * dot(vec3(sin(uGrainAngle), cos(uGrainAngle), 0.0), n));
  }
  vec3 radial = vGrainPos - uGrainCenter;
  radial = radial - n * dot(radial, n);
  float r = length(radial);
  if (r < 1e-6) {
    return normalize(vec3(0.0, 1.0, 0.0) - n * dot(vec3(0.0, 1.0, 0.0), n));
  }
  radial /= r;
  vec3 t = normalize(cross(n, radial));
  float ca = cos(uGrainAngle);
  float sa = sin(uGrainAngle);
  return normalize(t * ca + cross(n, t) * sa);
}

float grainWeightLocal() {
  if (uGrainMode == 0) return 1.0;
  vec3 n = normalize(vGrainNormal);
  vec3 radial = vGrainPos - uGrainCenter;
  radial = radial - n * dot(radial, n);
  float r = length(radial);
  float w = smoothstep(${CIRCULAR_EPS.toFixed(4)}, ${(CIRCULAR_EPS * 3).toFixed(4)}, r);
  return w;
}
#endif
`;

  // 替换 three r160 内置的 BRDF_GGX（仅直光镜面项；环境光/清漆不受影响）
  const brdfReplacement = /* glsl */ `
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {

  vec3 f0 = material.specularColor;
  float f90 = material.specularF90;

  vec3 tLocal = grainTangentLocal();
  float w = grainWeightLocal();

  // 物体空间 -> 世界空间：本项目只用旋转+平移（无缩放），mat3(modelMatrix) 为正交基
  vec3 tWorld = normalize(mat3(uGrainModelMatrix) * tLocal);
  vec3 nWorld = normalize(mat3(uGrainModelMatrix) * normalize(vGrainNormal));
  // 正交化，保证 T/B/N 构成正交基
  vec3 T = normalize(tWorld - nWorld * dot(tWorld, nWorld));
  vec3 B = normalize(cross(nWorld, T));

  // w=0（环形纹圆心）时两个方向粗糙度相等，自动退化为各向同性，无方向性跳变
  float rAlong = clamp(uRoughAlong, 0.04, 1.0);
  float rAcross = mix(rAlong, clamp(uRoughAcross, 0.04, 1.0), w);
  float alphaT = rAlong * rAlong;
  float alphaB = rAcross * rAcross;

  vec3 halfDir = normalize( lightDir + viewDir );

  float dotNL = saturate( dot( normal, lightDir ) );
  float dotNV = saturate( dot( normal, viewDir ) );
  float dotNH = saturate( dot( normal, halfDir ) );
  float dotVH = saturate( dot( viewDir, halfDir ) );
  float dotTH = dot( T, halfDir );
  float dotBH = dot( B, halfDir );
  float dotTL = dot( T, lightDir );
  float dotBL = dot( B, lightDir );
  float dotTV = dot( T, viewDir );
  float dotBV = dot( B, viewDir );

  vec3 F = F_Schlick( f0, f90, dotVH );

  float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
  float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
  float V = saturate( 0.5 / ( gv + gl ) );

  float a2 = alphaT * alphaB;
  highp vec3 dv = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
  highp float dv2 = dot( dv, dv );
  float D = RECIPROCAL_PI * a2 * pow2( a2 / dv2 );

  return F * ( V * D );
}
`;

  return { vertexPars, vertexBody, fragmentPars, brdfReplacement };
}
