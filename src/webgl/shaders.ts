// GLSL ES 3.00 shaders.
// Coordinate convention throughout: pixels, origin at bottom-left (matches gl_FragCoord).

export const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Scene pass: procedurally draws three opaque, independently translating layers
 * (background / mid panel / foreground panel), all covered in dense thin hatch lines.
 * Outputs color plus a stable per-pixel layer id (0 bg, 0.5 mid, 1 fg).
 */
export const SCENE_FRAG = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec2 uCam;       // world-space position of the screen origin
uniform vec2 uMidPos;    // mid panel center, world space
uniform vec2 uFgPos;     // foreground panel center, world space
uniform float uFgVisible;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outId;

// Anti-aliased hatch: 1.0 on a line, 0.0 in gaps.
float hatch(vec2 p, vec2 dir, float spacing, float width) {
  float phase = dot(p, dir) / spacing;
  float f = fract(phase);
  float d = min(f, 1.0 - f);
  float aa = max(fwidth(phase), 1e-4);
  return 1.0 - smoothstep(width - aa, width + aa, d);
}

// Soft 1px rectangle coverage, centered on c with half extents he.
float panel(vec2 p, vec2 c, vec2 he) {
  vec2 q = 1.0 - smoothstep(he - 1.0, he + 1.0, abs(p - c));
  return q.x * q.y;
}

vec3 backgroundLayer(vec2 wp) {
  vec3 base = vec3(0.045, 0.062, 0.095);
  vec3 lineA = vec3(0.55, 0.66, 0.88);
  vec3 lineB = vec3(0.30, 0.40, 0.58);
  vec2 d1 = normalize(vec2(0.38, 1.0));
  vec2 d2 = normalize(vec2(1.0, -0.30));
  float h1 = hatch(wp, d1, 8.0, 0.11);
  float h2 = 0.45 * hatch(wp + 13.7, d2, 13.0, 0.08);
  return base + lineA * h1 * 0.75 + lineB * h2;
}

vec3 midLayer(vec2 lp) {
  vec3 base = vec3(0.09, 0.115, 0.17);
  vec3 lineA = vec3(0.92, 0.58, 0.32);
  vec3 lineB = vec3(0.55, 0.38, 0.28);
  vec2 d1 = normalize(vec2(-0.62, 1.0));
  vec2 d2 = normalize(vec2(0.85, 1.0));
  float h1 = hatch(lp, d1, 7.0, 0.11);
  float h2 = 0.4 * hatch(lp + 7.1, d2, 11.0, 0.08);
  return base + lineA * h1 * 0.78 + lineB * h2;
}

vec3 fgLayer(vec2 lp) {
  vec3 base = vec3(0.135, 0.085, 0.17);
  vec3 lineA = vec3(0.80, 0.48, 0.78);
  vec3 lineB = vec3(0.48, 0.34, 0.60);
  vec2 d1 = normalize(vec2(0.20, 1.0));
  vec2 d2 = normalize(vec2(1.0, 0.25));
  float h1 = hatch(lp, d1, 6.0, 0.12);
  float h2 = 0.4 * hatch(lp + 3.3, d2, 9.5, 0.08);
  return base + lineA * h1 * 0.8 + lineB * h2;
}

void main() {
  vec2 sp = gl_FragCoord.xy;
  vec2 wp = sp + uCam;   // screen -> world

  vec3 color = backgroundLayer(wp);
  float id = 0.0;

  vec2 midHE = vec2(0.44, 0.58) * uResolution;
  float midCov = panel(wp, uMidPos, midHE);
  if (midCov > 0.001) {
    vec3 mc = midLayer(wp - uMidPos);
    color = mix(color, mc, midCov);
    id = mix(id, 0.5, midCov);
  }

  vec2 fgHE = vec2(0.32, 0.46) * uResolution;
  float fgCov = panel(wp, uFgPos, fgHE) * uFgVisible;
  if (fgCov > 0.001) {
    vec3 fc = fgLayer(wp - uFgPos);
    color = mix(color, fc, fgCov);
    id = mix(id, 1.0, fgCov);
  }

  outColor = vec4(color, 1.0);
  outId = id;
}`;

/**
 * Temporal pass. History is reprojected by the camera delta only:
 * a world point seen last frame at screen p is now at p + camDelta,
 * so history for current pixel uv lives at uv - camDelta/resolution.
 * Layer ids must match after reprojection, otherwise the pixel is a
 * disocclusion / cut and is taken from the fresh current frame.
 */
export const TEMPORAL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurColor;
uniform sampler2D uCurId;
uniform sampler2D uHistColor;
uniform sampler2D uHistId;
uniform vec2 uResolution;
uniform vec2 uCamDelta;
uniform float uCurW;
uniform float uHistW;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outId;
layout(location = 2) out float outMask;   // effective fraction taken from history this frame

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 huv = uv - uCamDelta / uResolution;

  float inBounds =
      step(0.0, huv.x) * step(huv.x, 1.0) *
      step(0.0, huv.y) * step(huv.y, 1.0);

  float curId = texture(uCurId, uv).r;
  float histId = texture(uHistId, huv).r;
  float idOk = abs(curId - histId) < 0.25 ? 1.0 : 0.0;
  float reuse = inBounds * idOk;

  vec3 cur = texture(uCurColor, uv).rgb;
  vec3 hist = texture(uHistColor, huv).rgb;

  float hw = uHistW * reuse;
  float sum = uCurW + hw;
  vec3 col;
  float effReuse;
  if (sum < 1e-5) {
    col = cur;
    effReuse = 0.0;
  } else {
    col = (cur * uCurW + hist * hw) / sum;
    effReuse = hw / sum;
  }

  outColor = vec4(col, 1.0);
  outId = curId;
  outMask = effReuse;
}`;

/**
 * Display pass: uMode 0 = plain color texture, 1 = history-reuse heat map
 * (orange = fresh current frame, teal = reused history). Draws the ROI border.
 */
export const DISPLAY_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform sampler2D uSceneTex; // current-frame color, used only in mask mode
uniform int uHasScene;
uniform int uMode;
uniform vec2 uResolution;
uniform vec4 uROI;   // x0, y0, x1, y1 in viewport pixels

layout(location = 0) out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 col;
  if (uMode == 1) {
    float m = texture(uTex, uv).r;
    vec3 fresh = vec3(0.85, 0.35, 0.15);
    vec3 reused = vec3(0.10, 0.70, 0.62);
    vec3 tint = mix(fresh, reused, m);
    if (uHasScene == 1) {
      // Luma of the current scene modulates the tint so layer structure stays
      // visible while the hue still says fresh (orange) vs reused (teal).
      float l = dot(texture(uSceneTex, uv).rgb, vec3(0.299, 0.587, 0.114));
      col = tint * (0.5 + 1.0 * l);
    } else {
      col = tint;
    }
  } else {
    col = texture(uTex, uv).rgb;
  }

  // ROI outline (2px), yellow.
  vec2 p = gl_FragCoord.xy;
  vec2 d0 = p - uROI.xy;
  vec2 d1 = uROI.zw - p;
  float inside =
      step(0.0, d0.x) * step(0.0, d0.y) *
      step(0.0, d1.x) * step(0.0, d1.y);
  vec2 edge = min(d0, d1);
  float border = inside * step(edge.x, 2.0) * step(0.0, min(edge.y, 2.0))
               + inside * step(edge.y, 2.0) * step(0.0, min(edge.x, 2.0));
  col = mix(col, vec3(1.0, 0.84, 0.15), clamp(border, 0.0, 1.0));

  outColor = vec4(col, 1.0);
}`;
