/**
 * WebGL2 预览渲染器。
 *
 * 与 src/lut/applyLut.ts（CPU 参考实现）语义完全一致：
 * - 图片纹理为 RGBA8,采样得到的就是 sRGB 编码值,不做隐式色彩转换;
 * - 色表存为 RGBA16F 三维纹理(NEAREST),三线性插值在着色器内手动完成,
 *   不依赖硬件过滤,保证"三线性"是真 8 点加权,最近点模式是单次取点;
 * - 线性光模式在着色器内做 sRGB<->线性光转换,强度混合发生在色表工作空间;
 * - alpha 原样输出,画布上下文 premultipliedAlpha:false,不做预乘,透明边沿无黑边;
 * - 结果截断到 [0,1]。
 */

import type { Lut3D } from '../lut/cubeParser';

export interface RenderParams {
  mode: 'srgb' | 'linear';
  interpolation: 'trilinear' | 'nearest';
  strength: number;
  /** 分界线位置(画面宽度的 0..1) */
  divider: number;
  /** 屏幕(0..1)到图片 uv 的映射 */
  uvScale: [number, number];
  uvOffset: [number, number];
}

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec2 uUvScale;
uniform vec2 uUvOffset;
out vec2 vUV;
void main() {
  vec2 uv01 = aPos * 0.5 + 0.5;                 // 屏幕坐标,y 向上
  vUV = vec2(uv01.x, 1.0 - uv01.y) * uUvScale + uUvOffset; // 图片 uv,y 向下(纹理首行是图片顶行)
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;
uniform sampler3D uLut;
uniform int uHasLut;
uniform int uInterp;    // 0 = 三线性, 1 = 最近点
uniform int uMode;      // 0 = sRGB 编码值, 1 = 线性光
uniform float uStrength;
uniform vec3 uDomMin;
uniform vec3 uDomScale; // 1 / (domainMax - domainMin)
uniform float uLutSize;
uniform float uDivider;
uniform vec2 uCanvas;
in vec2 vUV;
out vec4 fragColor;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 lutFetch(vec3 idx) {
  return texture(uLut, (idx + 0.5) / uLutSize).rgb;
}

vec3 sampleLut(vec3 t) {
  vec3 x = t * (uLutSize - 1.0);
  if (uInterp == 1) {
    return lutFetch(floor(x + 0.5)); // 最近网格点
  }
  // 真三线性:8 个网格点加权
  vec3 i0 = floor(x);
  vec3 f = x - i0;
  vec3 i1 = min(i0 + 1.0, vec3(uLutSize - 1.0));
  vec3 c000 = lutFetch(vec3(i0.x, i0.y, i0.z));
  vec3 c100 = lutFetch(vec3(i1.x, i0.y, i0.z));
  vec3 c010 = lutFetch(vec3(i0.x, i1.y, i0.z));
  vec3 c110 = lutFetch(vec3(i1.x, i1.y, i0.z));
  vec3 c001 = lutFetch(vec3(i0.x, i0.y, i1.z));
  vec3 c101 = lutFetch(vec3(i1.x, i0.y, i1.z));
  vec3 c011 = lutFetch(vec3(i0.x, i1.y, i1.z));
  vec3 c111 = lutFetch(vec3(i1.x, i1.y, i1.z));
  vec3 c00 = mix(c000, c100, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c11 = mix(c011, c111, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

vec3 process(vec3 c) {
  vec3 w = uMode == 1 ? srgbToLinear(c) : c;
  vec3 t = clamp((w - uDomMin) * uDomScale, 0.0, 1.0); // 超范围截断
  vec3 l = sampleLut(t);
  vec3 o = mix(w, l, uStrength);                       // 在工作空间内混合
  o = clamp(o, 0.0, 1.0);
  if (uMode == 1) o = linearToSrgb(o);
  return clamp(o, 0.0, 1.0);
}

void main() {
  vec4 src = texture(uImage, vUV);
  float sx = gl_FragCoord.x / uCanvas.x;
  vec3 c = src.rgb;
  if (uHasLut == 1 && sx >= uDivider) {
    c = process(src.rgb);
  }
  fragColor = vec4(c, src.a);
  float d = abs(gl_FragCoord.x - uDivider * uCanvas.x);
  if (d < 1.0) {
    fragColor = vec4(1.0, 1.0, 1.0, 1.0); // 分界线
  }
}`;

const floatView = new Float32Array(1);
const int32View = new Uint32Array(floatView.buffer);

/** float32 -> float16(半精度)位模式 */
function toHalf(value: number): number {
  floatView[0] = value;
  const x = int32View[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建着色器');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return shader;
}

const UNIFORMS = [
  'uImage',
  'uLut',
  'uHasLut',
  'uInterp',
  'uMode',
  'uStrength',
  'uDomMin',
  'uDomScale',
  'uLutSize',
  'uDivider',
  'uCanvas',
  'uUvScale',
  'uUvOffset',
] as const;

export class LutRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private imgTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private hasLut = false;
  private lutSize = 2;
  private domMin: [number, number, number] = [0, 0, 0];
  private domScale: [number, number, number] = [1, 1, 1];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false, // 不做预乘,透明边沿的 RGB 原样保留
      antialias: false,
      alpha: true,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error('无法创建着色程序');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`着色程序链接失败: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new Error('无法创建顶点缓冲');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;

    const imgTex = gl.createTexture();
    const lutTex = gl.createTexture();
    if (!imgTex || !lutTex) throw new Error('无法创建纹理');
    this.imgTex = imgTex;
    this.lutTex = lutTex;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

    for (const name of UNIFORMS) {
      this.u[name] = gl.getUniformLocation(program, name);
    }
    gl.disable(gl.BLEND);
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  setImage(data: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setLut(lut: Lut3D): void {
    const gl = this.gl;
    const n = lut.size;
    const half = new Uint16Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) {
      half[i * 4] = toHalf(lut.data[i * 3]);
      half[i * 4 + 1] = toHalf(lut.data[i * 3 + 1]);
      half[i * 4 + 2] = toHalf(lut.data[i * 3 + 2]);
      half[i * 4 + 3] = toHalf(1);
    }
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, half);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.hasLut = true;
    this.lutSize = n;
    this.domMin = [...lut.domainMin];
    this.domScale = [
      1 / (lut.domainMax[0] - lut.domainMin[0]),
      1 / (lut.domainMax[1] - lut.domainMin[1]),
      1 / (lut.domainMax[2] - lut.domainMin[2]),
    ];
  }

  clearLut(): void {
    this.hasLut = false;
  }

  render(p: RenderParams): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);

    gl.uniform1i(this.u.uImage, 0);
    gl.uniform1i(this.u.uLut, 1);
    gl.uniform1i(this.u.uHasLut, this.hasLut ? 1 : 0);
    gl.uniform1i(this.u.uInterp, p.interpolation === 'nearest' ? 1 : 0);
    gl.uniform1i(this.u.uMode, p.mode === 'linear' ? 1 : 0);
    gl.uniform1f(this.u.uStrength, p.strength);
    gl.uniform3fv(this.u.uDomMin, this.domMin);
    gl.uniform3fv(this.u.uDomScale, this.domScale);
    gl.uniform1f(this.u.uLutSize, this.lutSize);
    gl.uniform1f(this.u.uDivider, p.divider);
    gl.uniform2f(this.u.uCanvas, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.uUvScale, p.uvScale[0], p.uvScale[1]);
    gl.uniform2f(this.u.uUvOffset, p.uvOffset[0], p.uvOffset[1]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
