/**
 * 雾后处理的 GLSL 着色器。
 *
 * 管线：three.js 先把场景渲染到带深度纹理的离屏 RT（线性工作空间），
 * 本 pass 用全屏三角形读取颜色 + 深度：
 *   1. 由深度与逆视图投影矩阵重建世界坐标
 *   2. 与雾盒做射线 slab 求交；不相交或相交长度为 0 → 原色输出（边界严格）
 *   3. 光学厚度 τ 沿射线对 ρ(y)=ρ0·exp(-(y-yMin)/h) 做解析积分
 *   4. 内散射沿雾内区间做 24 步积分，方向性由 HG 相位函数给出
 *   5. 最终色 = 原色·exp(-τ) + 内散射积分
 *
 * CPU 端 fog.ts 是同一套数学的镜像实现，点选读数必须与画面一致。
 */

export const fogVertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  // PlaneGeometry(2, 2) 直接就是裁剪空间全屏三角形用的两个三角形
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const fogFragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;

// 雾盒 AABB
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;

// 雾参数
uniform float uDensity;      // 底层密度 ρ0（世界单位倒数）
uniform float uFalloff;      // 高度衰减尺度 h，单位米；越大随高度变稀越慢
uniform vec3  uFogTint;      // 雾本体颜色（环境照亮的雾）

// 平行光
uniform vec3  uSunDir;       // 指向光源的单位向量
uniform vec3  uSunColor;     // 平行光颜色×强度
uniform float uSunIntensity;
uniform vec3  uAmbient;      // 环境亮度
uniform float uAnisotropy;   // HG 相位 g：0 = 无方向，两侧一致
uniform int   uFogEnabled;   // 0 时直接输出原画面（对照）

const int   MARCH_STEPS = 24;
const float EPS = 1e-4;

// ---------- 深度 → 世界坐标 ----------
vec3 reconstructWorldPos(float depth, vec2 uv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  return world.xyz / world.w;
}

// ---------- 射线 vs AABB（slab），返回 x=进入距离 y=离开距离；不相交返回 vec2(-1.0) ----------
vec2 rayBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax) {
  vec3 invRd = 1.0 / rd;
  vec3 t0 = (bMin - ro) * invRd;
  vec3 t1 = (bMax - ro) * invRd;
  vec3 tSmall = min(t0, t1);
  vec3 tLarge = max(t0, t1);
  float tNear = max(max(tSmall.x, tSmall.y), tSmall.z);
  float tFar  = min(min(tLarge.x, tLarge.y), tLarge.z);
  tNear = max(tNear, 0.0);
  if (tFar < tNear - EPS) return vec2(-1.0);
  return vec2(tNear, max(tFar, tNear));
}

// ---------- 高度密度模型 ----------
float densityAt(vec3 p) {
  float h = (p.y - uBoxMin.y) / max(uFalloff, 0.05);
  return uDensity * exp(-h);
}

// ---------- 光学厚度解析积分（与 CPU fog.ts 完全对应） ----------
// ∫[ta..tb] ρ0·exp(-(y-yMin)/h) dt
float opticalDepth(vec3 ro, vec3 rd, float ta, float tb) {
  float h = max(uFalloff, 0.05);
  float da = densityAt(ro + rd * ta);
  float db = densityAt(ro + rd * tb);
  if (abs(rd.y) < EPS) {
    return da * (tb - ta);
  }
  return h * (da - db) / rd.y;
}

// ---------- Henyey-Greenstein 相位 ----------
float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(denom, 1e-4), 1.5));
}

// ---------- 内散射积分 ----------
// 关键性质：平行光在整条射线上方向恒定，相位函数与位置无关，可移到积分外；
// 积分内部只做「密度 × 相机到该点的衰减」的高度加权步进。
// 常数密度极限下 weighted 解析地等于 (1-exp(-τ))/ρ₀，
// 因此内散射 = 雾亮度·(1-exp(-τ))，能量守恒且 HG 方向性完整保留。
vec3 integrateInscatter(vec3 ro, vec3 rd, float ta, float tb) {
  float dt = (tb - ta) / float(MARCH_STEPS);
  vec3 sun = uSunColor * uSunIntensity;
  float cosTheta = dot(rd, uSunDir);
  float phase = hgPhase(cosTheta, uAnisotropy);
  vec3 pointLight = uAmbient + sun * phase;

  float weighted = 0.0;
  for (int i = 0; i < MARCH_STEPS; i++) {
    float t = ta + (float(i) + 0.5) * dt;
    vec3 p = ro + rd * t;
    float rho = densityAt(p);
    float tauCam = opticalDepth(ro, rd, ta, t);
    weighted += rho * exp(-tauCam) * dt;
  }
  return uFogTint * pointLight * weighted;
}

void main() {
  vec4 sceneColor = texture2D(tColor, vUv);
  if (uFogEnabled == 0) {
    gl_FragColor = sceneColor;
    #include <colorspace_fragment>
    return;
  }

  float depth = texture2D(tDepth, vUv).x;
  vec3 endPos = reconstructWorldPos(depth, vUv);
  vec3 ro = uCameraPos;
  vec3 rd = normalize(endPos - ro);
  float surfaceDist = length(endPos - ro); // 到物体表面（或远平面）的距离

  vec2 seg = rayBox(ro, rd, uBoxMin, uBoxMax);
  if (seg.x < 0.0) {
    // 射线根本没碰到盒子：保持原颜色（背景也遵守边界）
    gl_FragColor = sceneColor;
    #include <colorspace_fragment>
    return;
  }

  float tEnter = seg.x;
  float tLeave = min(seg.y, surfaceDist); // 表面截断：只算到柱子表面为止经过的雾
  if (tLeave <= tEnter + EPS) {
    gl_FragColor = sceneColor;
    #include <colorspace_fragment>
    return;
  }

  float tau = opticalDepth(ro, rd, tEnter, tLeave);
  vec3 transmittance = exp(-vec3(tau));
  vec3 inscatter = integrateInscatter(ro, rd, tEnter, tLeave);

  vec3 outColor = sceneColor.rgb * transmittance + inscatter;
  gl_FragColor = vec4(outColor, sceneColor.a);
  #include <colorspace_fragment>
}
`;
