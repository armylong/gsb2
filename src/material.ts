import * as THREE from 'three';
import { THIN_FILM_GLSL } from './glsl';

/**
 * 每块样片一份独立的材质实例（独立的 uniform 组），
 * 保证两块样片的膜厚 / 渐变设置互不串扰。
 */

export interface FilmUniforms {
  uThickness: THREE.IUniform<number>; // 基础膜厚 nm
  uGradientOn: THREE.IUniform<number>; // 0/1：是否沿曲面参数 u 渐变
  uGradientSpan: THREE.IUniform<number>; // 渐变末端额外增加的膜厚 nm
  uFilmOn: THREE.IUniform<number>; // 0/1：关闭时等同 d=0（裸基底）
  uLightDir: THREE.IUniform<THREE.Vector3>; // 指向光源的方向（世界系）
  uBaseColor: THREE.IUniform<THREE.Color>; // 基底漫反射色（深色）
}

export interface FilmMaterial {
  material: THREE.ShaderMaterial;
  uniforms: FilmUniforms;
}

const VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uThickness;
  uniform float uGradientOn;
  uniform float uGradientSpan;
  uniform float uFilmOn;
  uniform vec3 uLightDir;
  uniform vec3 uBaseColor;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  ${THIN_FILM_GLSL}

  void main() {
    vec3 N = normalize(vWorldNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorldPos);
    float cosV = clamp(dot(N, V), 0.0, 1.0);

    // 本样片自己的膜厚：统一值 + 可选沿 u 的线性渐变
    float d = uThickness + uGradientOn * uGradientSpan * vUv.x;
    d *= uFilmOn;

    // 薄膜镜面反射色（视角相关，物理核心）
    vec3 filmRGB = filmColorSrgb(cosV, d);

    // 照明：方向光漫射包络 + 镜面高光，高光同样被薄膜反射率调色
    vec3 L = normalize(uLightDir);
    float ndl = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 90.0);

    vec3 col = filmRGB * (0.18 + 0.9 * ndl)   // 环境 + 方向光下的薄膜反射
             + filmRGB * spec * 0.8            // 光源高光（随薄膜干涉变色）
             + uBaseColor * ndl * 0.25;        // 基底微弱漫反射

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createFilmMaterial(): FilmMaterial {
  const uniforms: FilmUniforms = {
    uThickness: { value: 500 },
    uGradientOn: { value: 0 },
    uGradientSpan: { value: 400 },
    uFilmOn: { value: 1 },
    uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
    uBaseColor: { value: new THREE.Color(0.05, 0.05, 0.06) },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    side: THREE.DoubleSide,
  });
  return { material, uniforms };
}
