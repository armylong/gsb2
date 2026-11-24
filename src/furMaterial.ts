import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute vec3 furDir;   // 物体空间毛方向
  attribute float furLen;  // 长度系数(压痕区 < 1)

  uniform float uLayer;      // 本壳层高度 0..1
  uniform float uFurLength;
  uniform float uUvScale;

  varying vec2 vUv;
  varying float vT;
  varying vec3 vNormalW;
  varying vec3 vFurDirW;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv * uUvScale;
    vT = uLayer;
    vec3 p = position + furDir * (uFurLength * furLen) * uLayer;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vFurDirW = normalize(mat3(modelMatrix) * furDir);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uFurTex;
  uniform vec3 uLightDir;    // 指向光源
  uniform vec3 uRootColor;
  uniform vec3 uTipColor;

  varying vec2 vUv;
  varying float vT;
  varying vec3 vNormalW;
  varying vec3 vFurDirW;
  varying vec3 vWorldPos;

  void main() {
    float h = texture2D(uFurTex, vUv).r;
    if (vT > h) discard;   // 该像素处毛束到不了这一层

    // Kajiya-Kay 式各向异性: 明暗由毛束切线决定,
    // 压倒区毛方向变了,高光/明暗跟着变。
    vec3 T = normalize(mix(vNormalW, vFurDirW, 0.8));
    vec3 L = normalize(uLightDir);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);

    float sinTL = clamp(dot(T, L), -1.0, 1.0);
    float diff = sqrt(max(0.0, 1.0 - sinTL * sinTL));
    float sinTH = clamp(dot(T, H), -1.0, 1.0);
    float spec = pow(sqrt(max(0.0, 1.0 - sinTH * sinTH)), 28.0);

    vec3 col = mix(uRootColor, uTipColor, vT);
    float ao = mix(0.45, 1.0, vT);            // 根部遮蔽
    col *= (0.32 + 0.68 * diff) * ao;
    col += spec * 0.45 * (0.3 + 0.7 * vT);    // 毛尖高光更明显

    gl_FragColor = vec4(col, 1.0);
  }
`;

/** 跨层共享的 uniform(同一 {value} 引用,改一处全部生效) */
export interface FurSharedUniforms {
  uFurTex: THREE.IUniform<THREE.Texture | null>;
  uFurLength: THREE.IUniform<number>;
  uLightDir: THREE.IUniform<THREE.Vector3>;
  uRootColor: THREE.IUniform<THREE.Color>;
  uTipColor: THREE.IUniform<THREE.Color>;
}

export function createSharedUniforms(): FurSharedUniforms {
  return {
    uFurTex: { value: null },
    uFurLength: { value: 0.16 },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uRootColor: { value: new THREE.Color('#3d2c1e') },
    uTipColor: { value: new THREE.Color('#caa26b') },
  };
}

export function createFurMaterial(
  shared: FurSharedUniforms,
  uvScale: number,
  layerT: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      ...shared,
      uUvScale: { value: uvScale },
      uLayer: { value: layerT },
    },
  });
}
