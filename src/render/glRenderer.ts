/**
 * glRenderer.ts — WebGL2（GLSL ES 3.00）片元着色器渲染光照场
 *
 * 着色器内逐像素复现 visibility.ts 的解析模型：
 * 每个挡板取切线楔形 → 与光源角度区间求交 → 合并遮挡并集 → 可见比例。
 * 半径 r=0 走点光源分支（线段求交，0/1 硬阴影），保证退化行为一致。
 * 挡板内部像素直接绘制挡板本色，不参与光照。
 * WebGL2 不可用时由 main.ts 回退到 CPU 栅格渲染器（同一套数学）。
 */

import { Circle, Poly, ROOM_CONST } from './renderTypes';
import { MAX_POLYS, ROOM_H, ROOM_W, WALL } from '../core/presets';

const MAX_VERTS = 6; // 每个挡板补齐到 6 顶点

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 aPos;
uniform vec2 uRoom;
out vec2 vWorld;
void main() {
  vWorld = vec2(aPos.x * uRoom.x * 0.5 + uRoom.x * 0.5,
                aPos.y * uRoom.y * 0.5 + uRoom.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vWorld;
out vec4 fragColor;

uniform vec2 uLight;
uniform float uRadius;
uniform float uRange;
uniform float uBrightness;
uniform float uPointMode;
uniform int uPolyCount;
uniform vec2 uPolyVerts[${MAX_POLYS * MAX_VERTS}];
uniform int uPolyN[${MAX_POLYS}];

const float TAU = 6.283185307179586;
const float EPS = 1e-7;

float norm2pi(float a) {
  float r = mod(a, TAU);
  if (r < 0.0) r += TAU;
  return r;
}
float wrapPi(float a) {
  float r = mod(a + 3.141592653589793, TAU);
  if (r < 0.0) r += TAU;
  return r - 3.141592653589793;
}

// 点是否在第 idx 个 CCW 凸多边形内（GLSL3 允许动态下标）
bool insidePoly(vec2 p, int idx) {
  int base = idx * ${MAX_VERTS};
  int n = uPolyN[idx];
  for (int i = 0; i < ${MAX_VERTS}; i++) {
    if (i >= n) break;
    int j = (i + 1 < n) ? i + 1 : 0;
    vec2 a = uPolyVerts[base + i];
    vec2 b = uPolyVerts[base + j];
    float cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cr < -EPS) return false;
  }
  return true;
}

// 从 p 看多边形 idx 的楔形：vec2(中心角, 半宽)
vec2 wedgeOf(vec2 p, int idx) {
  int base = idx * ${MAX_VERTS};
  int n = uPolyN[idx];
  float minA = 1e9;
  float maxA = -1e9;
  for (int i = 0; i < ${MAX_VERTS}; i++) {
    if (i >= n) break;
    vec2 q = uPolyVerts[base + i];
    float a = norm2pi(atan(q.y - p.y, q.x - p.x));
    minA = min(minA, a);
    maxA = max(maxA, a);
  }
  float s = minA;
  float e = maxA;
  if (e - s > 3.141592653589793) {
    float lo = 1e9;
    float hi = -1e9;
    for (int i = 0; i < ${MAX_VERTS}; i++) {
      if (i >= n) break;
      vec2 q = uPolyVerts[base + i];
      float a = norm2pi(atan(q.y - p.y, q.x - p.x));
      if (a < 3.141592653589793) a += TAU;
      lo = min(lo, a);
      hi = max(hi, a);
    }
    s = lo;
    e = hi;
  }
  float width = e - s;
  return vec2(wrapPi(s + width * 0.5), width * 0.5);
}

// 线段 a-b 是否与第 idx 个 CCW 凸多边形相交
bool segBlocked(vec2 a, vec2 b, int idx) {
  if (insidePoly(a, idx) || insidePoly(b, idx)) return true;
  int base = idx * ${MAX_VERTS};
  int n = uPolyN[idx];
  vec2 d = b - a;
  for (int i = 0; i < ${MAX_VERTS}; i++) {
    if (i >= n) break;
    int j = (i + 1 < n) ? i + 1 : 0;
    vec2 c = uPolyVerts[base + i];
    vec2 e = uPolyVerts[base + j];
    vec2 edge = e - c;
    float denom = d.x * edge.y - d.y * edge.x;
    if (abs(denom) < EPS) continue;
    float t = ((c.x - a.x) * edge.y - (c.y - a.y) * edge.x) / denom;
    float u = ((c.x - a.x) * d.y - (c.y - a.y) * d.x) / denom;
    if (t >= -EPS && t <= 1.0 + EPS && u >= -EPS && u <= 1.0 + EPS) return true;
  }
  return false;
}

void main() {
  vec2 p = vWorld;
  vec3 ambient = vec3(0.10, 0.11, 0.14);
  vec3 floorCol = vec3(0.86, 0.85, 0.82);

  for (int k = 0; k < ${MAX_POLYS}; k++) {
    if (k >= uPolyCount) break;
    if (insidePoly(p, k)) {
      fragColor = vec4(vec3(0.32, 0.40, 0.52), 1.0);
      return;
    }
  }

  vec2 d = uLight - p;
  float dd = length(d);
  float vis;

  if (uPointMode > 0.5 || uRadius <= EPS) {
    // 点光源：硬 0/1
    vis = 1.0;
    for (int k = 0; k < ${MAX_POLYS}; k++) {
      if (k >= uPolyCount) break;
      if (segBlocked(p, uLight, k)) { vis = 0.0; break; }
    }
  } else {
    if (dd <= uRadius) {
      vis = 1.0; // 位于光源内部
    } else {
      float lMean = atan(d.y, d.x);
      float lHalf = asin(clamp(uRadius / dd, 0.0, 1.0));

      // 收集与光源区间相交的遮挡楔形（偏移到光源中心坐标系）
      float lo[${MAX_POLYS}];
      float hi[${MAX_POLYS}];
      int cnt = 0;
      for (int k = 0; k < ${MAX_POLYS}; k++) {
        if (k >= uPolyCount) break;
        vec2 w = wedgeOf(p, k);
        float delta = wrapPi(w.x - lMean);
        if (abs(delta) <= w.y + lHalf + EPS) {
          // 裁剪到光源区间内
          float s2 = max(-lHalf, delta - w.y);
          float e2 = min(lHalf, delta + w.y);
          if (e2 > s2) {
            // 插入排序（按 s2），数组很小
            int pos = cnt;
            for (int q = 0; q < ${MAX_POLYS}; q++) {
              if (q >= cnt) break;
              if (s2 < lo[q]) { pos = q; break; }
            }
            for (int q = cnt; q > pos; q--) {
              lo[q] = lo[q - 1];
              hi[q] = hi[q - 1];
            }
            lo[pos] = s2;
            hi[pos] = e2;
            cnt++;
          }
        }
      }
      // 合并并集并统计覆盖长度（重叠楔形只计一次）
      float covered = 0.0;
      if (cnt > 0) {
        float curLo = lo[0];
        float curHi = hi[0];
        for (int q = 1; q < ${MAX_POLYS}; q++) {
          if (q >= cnt) break;
          if (lo[q] <= curHi + EPS) {
            curHi = max(curHi, hi[q]);
          } else {
            covered += curHi - curLo;
            curLo = lo[q];
            curHi = hi[q];
          }
        }
        covered += curHi - curLo;
      }
      vis = clamp(1.0 - covered / (2.0 * lHalf), 0.0, 1.0);
    }
  }

  // 距离衰减：0.94R 起 smoothstep 到 R，范围外只剩环境光
  float start = uRange * 0.94;
  float fall = 1.0;
  if (dd > start) {
    if (dd >= uRange) fall = 0.0;
    else {
      float t = (dd - start) / (uRange - start);
      fall = 1.0 - t * t * (3.0 - 2.0 * t);
    }
  }

  float direct = vis * fall * uBrightness;
  vec3 col = floorCol * (ambient + vec3(direct) * 0.9);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export interface GlHandles {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('无法创建 shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader 编译失败: ${log}`);
  }
  return sh;
}

export function createGlRenderer(canvas: HTMLCanvasElement): GlHandles {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('当前浏览器不支持 WebGL2');

  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program 链接失败: ${gl.getProgramInfoLog(program)}`);
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const names = [
    'uRoom', 'uLight', 'uRadius', 'uRange', 'uBrightness',
    'uPointMode', 'uPolyCount', 'uPolyVerts', 'uPolyN',
  ];
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);

  return { gl, program, uniforms };
}

export interface RenderParams {
  light: Circle;
  polys: Poly[];
  range: number;
  brightness: number;
  pointMode: boolean;
  viewW: number;
  viewH: number;
}

export function renderGl(h: GlHandles, params: RenderParams): void {
  const { gl, uniforms } = h;
  gl.viewport(0, 0, params.viewW, params.viewH);
  gl.useProgram(h.program);

  gl.uniform2f(uniforms.uRoom, ROOM_W, ROOM_H);
  gl.uniform2f(uniforms.uLight, params.light.c.x, params.light.c.y);
  gl.uniform1f(uniforms.uRadius, params.light.r);
  gl.uniform1f(uniforms.uRange, params.range);
  gl.uniform1f(uniforms.uBrightness, params.brightness);
  gl.uniform1f(uniforms.uPointMode, params.pointMode ? 1 : 0);
  gl.uniform1i(uniforms.uPolyCount, params.polys.length);

  const flat = new Float32Array(MAX_POLYS * MAX_VERTS * 2);
  const ns = new Int32Array(MAX_POLYS);
  params.polys.slice(0, MAX_POLYS).forEach((poly, i) => {
    const n = Math.min(poly.verts.length, MAX_VERTS);
    ns[i] = n;
    for (let j = 0; j < MAX_VERTS; j++) {
      const q = poly.verts[Math.min(j, n - 1)];
      flat[(i * MAX_VERTS + j) * 2] = q.x;
      flat[(i * MAX_VERTS + j) * 2 + 1] = q.y;
    }
  });
  gl.uniform2fv(uniforms.uPolyVerts, flat);
  gl.uniform1iv(uniforms.uPolyN, ns);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/**
 * 读回单个逻辑坐标处的像素（用于验证读数与画面一致）。
 * 顶点着色器把 NDC 底行映射到世界 y=0，因此帧缓冲行号与世界 y 同向（无翻转）：
 * py = world.y / ROOM_H * viewH。
 * 取目标像素 2×2 邻域平均，降低半影陡梯度处的空间量化误差。
 */
export function readPixelGl(
  h: GlHandles,
  world: { x: number; y: number },
  viewW: number,
  viewH: number,
): [number, number, number] {
  const { gl } = h;
  const cx = Math.round((world.x / ROOM_W) * viewW);
  const cy = Math.round((world.y / ROOM_H) * viewH);
  const x0 = Math.max(0, cx - 1);
  const y0 = Math.max(0, cy - 1);
  const w = Math.min(2, viewW - x0);
  const hgt = Math.min(2, viewH - y0);
  const out = new Uint8Array(w * hgt * 4);
  gl.readPixels(x0, y0, w, hgt, gl.RGBA, gl.UNSIGNED_BYTE, out);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < w * hgt; i++) {
    r += out[i * 4];
    g += out[i * 4 + 1];
    b += out[i * 4 + 2];
  }
  const n = w * hgt;
  return [r / n, g / n, b / n];
}

export { ROOM_CONST, WALL };
