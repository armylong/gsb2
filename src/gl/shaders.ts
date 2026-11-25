/** 精灵通道：实例数据用浮点纹理按 gl_InstanceID 取，参考路径与合批路径共用同一份数据。 */
export const SPRITE_VS = `#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) in vec2 aQuad;

uniform sampler2D uInstances;
uniform int uBase;
uniform vec2 uEye;
uniform vec2 uCamera;
uniform float uZoom;

out vec2 vUv;
out vec4 vTint;
out vec3 vDebug;
out float vLayer;

void main() {
  int id = uBase + gl_InstanceID;
  vec4 t0 = texelFetch(uInstances, ivec2(0, id), 0);
  vec4 t1 = texelFetch(uInstances, ivec2(1, id), 0);
  vec4 t2 = texelFetch(uInstances, ivec2(2, id), 0);

  vec2 halfSize = t0.zw;
  vec2 world = t0.xy + aQuad * halfSize;
  vec2 eye = (world - uCamera) * uZoom + uEye * 0.5;
  vec2 clip = (eye / uEye) * 2.0 - 1.0;

  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aQuad * 0.5 + 0.5;
  vTint = t1;
  vLayer = t2.x;
  vDebug = t2.yzw;
}
`;

export const SPRITE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
uniform int uBatchColor;
uniform float uBatchAlpha;

in vec2 vUv;
in vec4 vTint;
in vec3 vDebug;
in float vLayer;

out vec4 outColor;

void main() {
  vec4 tex = texture(uAtlas, vec3(vUv, vLayer));
  if (uBatchColor == 1) {
    // 按批次着色：保留覆盖率轮廓，颜色来自批次 ID。
    float a = tex.a * vTint.a * uBatchAlpha;
    outColor = vec4(vDebug * a, a);
    return;
  }
  // 预乘：rgb 还要乘上染色 alpha。
  outColor = vec4(tex.rgb * vTint.rgb * vTint.a, tex.a * vTint.a);
}
`;

export const DISPLAY_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const DISPLAY_FS = `#version 300 es
precision highp float;

uniform sampler2D uRef;
uniform sampler2D uBatch;
uniform int uMode;      // 0=参考 1=合批 2=滑动对比 3=差异
uniform float uSplit;   // 0..1
uniform float uAmplify;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec3 ref = texture(uRef, vUv).rgb;
  vec3 bat = texture(uBatch, vUv).rgb;
  if (uMode == 0) {
    outColor = vec4(ref, 1.0);
  } else if (uMode == 1) {
    outColor = vec4(bat, 1.0);
  } else if (uMode == 2) {
    outColor = vec4(vUv.x < uSplit ? ref : bat, 1.0);
  } else {
    vec3 d = abs(ref - bat) * uAmplify;
    outColor = vec4(d, 1.0);
  }
}
`;

/** 世界网格背景：让平移/缩放有参照物，两条路径绘制完全一致。 */
export const BACKDROP_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const BACKDROP_FS = `#version 300 es
precision highp float;

uniform vec2 uEye;
uniform vec2 uCamera;
uniform float uZoom;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 eye = vec2(vUv.x, 1.0 - vUv.y) * uEye;
  vec2 world = (eye - uEye * 0.5) / uZoom + uCamera;

  vec3 base = vec3(0.055, 0.068, 0.098);
  float vignette = 1.0 - 0.38 * length(vUv - 0.5);
  base *= vignette;

  float minor = 100.0;
  vec2 grid = abs(fract(world / minor - 0.5) - 0.5) / fwidth(world / minor);
  float line = 1.0 - min(min(grid.x, grid.y), 1.0);
  base += vec3(0.045, 0.062, 0.09) * line;

  float major = 500.0;
  vec2 mgrid = abs(fract(world / major - 0.5) - 0.5) / fwidth(world / major);
  float mline = 1.0 - min(min(mgrid.x, mgrid.y), 1.0);
  base += vec3(0.05, 0.075, 0.115) * mline;

  vec2 edge = abs(world - vec2(1800.0, 1200.0)) - vec2(1800.0, 1200.0);
  float outside = max(edge.x, edge.y);
  // 世界边界外的区域压暗，便于看出拖出画面的对象。
  base *= mix(0.35, 1.0, smoothstep(20.0, -20.0, outside));

  outColor = vec4(base, 1.0);
}
`;
