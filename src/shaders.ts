/**
 * Triplanar 投影 ShaderMaterial。
 *
 * 权重公式与 src/triplanar.ts 的 CPU 参考实现严格一致：
 *   lin_i  = |n_i| * bias_i
 *   shape_i = (lin_i / (lin_x+lin_y+lin_z)) ^ sharpness
 *   w_i    = shape_i / (shape_x+shape_y+shape_z)
 * sharpness=1 时退化为普通线性归一化混合。
 *
 * 投影平面（与 planeUV() 对应）：
 *   X 平面: uv = (n.x<0 ? z : -z, y)
 *   Y 平面: uv = (x, n.y<0 ? -z : z)
 *   Z 平面: uv = (x, y)
 */

export const VIEW_MODES = {
  BLEND: 0,
  AXIS_X: 1,
  AXIS_Y: 2,
  AXIS_Z: 3,
  WEIGHTS: 4,
  NORMALS: 5,
} as const;

export const SPACE_MODES = {
  WORLD: 0,
  OBJECT: 1,
} as const;

export const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vObjectPos;
varying vec3 vWorldNormal;
varying vec3 vObjectNormal;

void main() {
  vObjectPos = position;
  vObjectNormal = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D texX;
uniform sampler2D texY;
uniform sampler2D texZ;
uniform sampler2D weightLUT;

uniform float sharpness;     // 过渡陡度 (1=线性, 越大越锐)
uniform vec3  biases;        // 三轴额外权重乘子
uniform float uvScale;       // 纹理缩放
uniform vec2  uvOffset;      // 纹理平移 (u, v)
uniform int   spaceMode;     // 0=世界固定 1=物体固定
uniform int   viewMode;      // 见 VIEW_MODES
uniform float bandThreshold; // 权重低于该值视为“接近轴界面”混合区
uniform bool  showBand;      // 是否高亮混合区
uniform bool  showBackface;  // 是否高亮反向法线面
uniform vec3  tintX;
uniform vec3  tintY;
uniform vec3  tintZ;

varying vec3 vWorldPos;
varying vec3 vObjectPos;
varying vec3 vWorldNormal;
varying vec3 vObjectNormal;

// 屏幕空间斜纹，用来标记异常区域
float hatch(float spacing, float slope) {
  return step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y * slope) / spacing));
}

void main() {
  vec3 p = spaceMode == 0 ? vWorldPos : vObjectPos;
  vec3 n = normalize(spaceMode == 0 ? vWorldNormal : vObjectNormal);

  // ---- 线性分量 → 归一化 → 陡度锐化 → 二次归一化（与 CPU triplanarWeights 同公式）----
  float rx = abs(n.x) * biases.x;
  float ry = abs(n.y) * biases.y;
  float rz = abs(n.z) * biases.z;
  float linSum = rx + ry + rz;
  float sx = linSum > 0.0 ? pow(rx / linSum, sharpness) : 0.3333333;
  float sy = linSum > 0.0 ? pow(ry / linSum, sharpness) : 0.3333333;
  float sz = linSum > 0.0 ? pow(rz / linSum, sharpness) : 0.3333333;
  float shapeSum = sx + sy + sz;
  float wx = sx / shapeSum;
  float wy = sy / shapeSum;
  float wz = sz / shapeSum;
  float maxW = max(wx, max(wy, wz));

  // ---- 三个投影平面的采样坐标 ----
  vec2 sX = vec2(n.x < 0.0 ? p.z : -p.z, p.y) * uvScale + uvOffset;
  vec2 sY = vec2(p.x, n.y < 0.0 ? -p.z : p.z) * uvScale + uvOffset;
  vec2 sZ = vec2(p.x, p.y) * uvScale + uvOffset;

  vec3 cX = texture2D(texX, sX).rgb * tintX;
  vec3 cY = texture2D(texY, sY).rgb * tintY;
  vec3 cZ = texture2D(texZ, sZ).rgb * tintZ;

  vec3 color;
  if (viewMode == 0) {
    // 三向混合
    color = wx * cX + wy * cY + wz * cZ;
  } else if (viewMode == 1) {
    color = cX;
  } else if (viewMode == 2) {
    color = cY;
  } else if (viewMode == 3) {
    color = cZ;
  } else if (viewMode == 4) {
    // 权重可视化：每个轴按自己的最终归一化权重查 LUT，再按该权重混合。
    // 轴对齐主导面（w≈1）显红，混合区沿 LUT 呈黄/绿/青，转角过渡一目了然。
    vec3 lcx = texture2D(weightLUT, vec2(clamp(wx, 0.0, 1.0), 0.5)).rgb;
    vec3 lcy = texture2D(weightLUT, vec2(clamp(wy, 0.0, 1.0), 0.5)).rgb;
    vec3 lcz = texture2D(weightLUT, vec2(clamp(wz, 0.0, 1.0), 0.5)).rgb;
    color = wx * lcx + wy * lcy + wz * lcz;
  } else {
    // 法线可视化（带符号），世界/物体空间随 spaceMode 切换
    color = n * 0.5 + 0.5;
  }

  // ---- 接近轴界面的混合区：品红斜纹 + 轻微整体染色 ----
  bool inBand = showBand && maxW < bandThreshold;
  if (inBand) {
    color = mix(color, vec3(1.0, 0.0, 1.0), 0.15 + 0.4 * hatch(11.0, 1.0));
  }

  // ---- 反向法线（背面）：红色反向斜纹 ----
  if (showBackface && !gl_FrontFacing) {
    color = mix(color, vec3(1.0, 0.15, 0.1), 0.25 + 0.45 * hatch(15.0, -1.0));
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface ShaderParams {
  sharpness: number;
  biases: [number, number, number];
  uvScale: number;
  uvOffset: [number, number];
  spaceMode: number;
  viewMode: number;
  bandThreshold: number;
  showBand: boolean;
  showBackface: boolean;
}

export const DEFAULT_PARAMS: ShaderParams = {
  sharpness: 1,
  biases: [1, 1, 1],
  uvScale: 1,
  uvOffset: [0, 0],
  spaceMode: SPACE_MODES.WORLD,
  viewMode: VIEW_MODES.BLEND,
  bandThreshold: 0.8,
  showBand: true,
  showBackface: true,
};
