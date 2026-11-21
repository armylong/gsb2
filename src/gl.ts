// WebGL2 渲染层：同一平面、同一相机，三种纹理采样模式并排比较。
import { TEX_BASE, TEX_LEVELS, TILE_WORLD, generateTexture, type GeneratedTexture } from './texture';

/** 无硬件扩展时，shader 手动回退路径支持的最大各向异性采样次数（循环上界）。 */
export const MANUAL_ANISO_MAX = 16;
/** 手动回退路径的默认采样次数。 */
export const MANUAL_ANISO_DEFAULT = 8;

const VERT = `#version 300 es
layout(location=0) in vec2 aXZ;
layout(location=1) in vec2 aUV;
uniform mat4 uVP;
out vec2 vUV;
out vec3 vWorld;
void main() {
  vUV = aUV;
  vWorld = vec3(aXZ.x, 0.0, aXZ.y);
  gl_Position = uVP * vec4(vWorld, 1.0);
}`;

// 与 texture.ts 的 lodDebugColor 保持一致的 9 级伪色
const LOD_PALETTE_GLSL = `
vec3 lodColor(float l) {
  float c = clamp(l, 0.0, 8.0);
  vec3 lo = vec3(0.0);
  vec3 hi = vec3(0.0);
  if (c < 1.0)      { lo = vec3(0.25,0.55,1.00); hi = vec3(0.20,0.85,0.90); }
  else if (c < 2.0) { lo = vec3(0.20,0.85,0.90); hi = vec3(0.20,0.90,0.55); }
  else if (c < 3.0) { lo = vec3(0.20,0.90,0.55); hi = vec3(0.55,0.90,0.25); }
  else if (c < 4.0) { lo = vec3(0.55,0.90,0.25); hi = vec3(0.90,0.90,0.20); }
  else if (c < 5.0) { lo = vec3(0.90,0.90,0.20); hi = vec3(1.00,0.70,0.20); }
  else if (c < 6.0) { lo = vec3(1.00,0.70,0.20); hi = vec3(1.00,0.45,0.20); }
  else if (c < 7.0) { lo = vec3(1.00,0.45,0.20); hi = vec3(0.95,0.30,0.35); }
  else              { lo = vec3(0.95,0.30,0.35); hi = vec3(0.85,0.45,0.95); }
  return mix(lo, hi, fract(c));
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform int uMode;      // 0=无缩小层 1=三线性缩小层 2=沿倾斜方向改善
uniform int uHwAniso;   // 1=硬件各向异性扩展可用
uniform int uMaxAniso;  // 手动回退路径的最大采样次数
uniform int uLodDebug;
in vec2 vUV;
in vec3 vWorld;
out vec4 frag;

${LOD_PALETTE_GLSL}

// 与硬件自动 LOD 同公式：lambda = log2(max(|dUVdx|,|dUVdy|) * 基础纹素数)
float computedLod(vec2 dx, vec2 dy) {
  float delta = max(dot(dx, dx), dot(dy, dy));
  return 0.5 * log2(delta * float(${TEX_BASE}) * float(${TEX_BASE}));
}

// 扩展缺失时的手动各向异性：沿长轴多次采样，每次用短轴导数决定缩小层
vec4 sampleAnisoManual(vec2 uv, int maxAniso) {
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  float px = dot(dx, dx);
  float py = dot(dy, dy);
  vec2 minor = px <= py ? dx : dy;
  vec2 major = px <= py ? dy : dx;
  float ratio = length(major) / max(length(minor), 1e-8);
  float n = clamp(floor(ratio + 1.0), 1.0, float(maxAniso));
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MANUAL_ANISO_MAX}; i++) {
    if (float(i) >= n) break;
    float t = n > 1.0 ? float(i) / (n - 1.0) - 0.5 : 0.0;
    acc += textureGrad(uTex, uv + major * t, minor, minor);
  }
  return acc / n;
}

void main() {
  vec4 c;
  if (uMode == 0) {
    c = textureLod(uTex, vUV, 0.0);           // 永远只采第 0 层
  } else if (uMode == 1) {
    c = texture(uTex, vUV);                    // 硬件自动选层，三线性
  } else {
    c = uHwAniso == 1 ? texture(uTex, vUV)    // 硬件各向异性
                      : sampleAnisoManual(vUV, uMaxAniso);
  }
  if (uLodDebug == 1) {
    float lod = computedLod(dFdx(vUV), dFdy(vUV));
    c = vec4(lodColor(lod), 1.0);
  }
  frag = c;
}`;

export type SampleMode = 0 | 1 | 2;

export interface DeviceCaps {
  webgl2: boolean;
  anisoExt: boolean;
  anisoMax: number;
  maxTextureSize: number;
  renderer: string;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly caps: DeviceCaps;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private texNoMip: WebGLTexture;
  private texMip: WebGLTexture;
  private texAniso: WebGLTexture;
  private anisoExt: EXT_texture_filter_anisotropic | null;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  mode: SampleMode = 1;
  lodDebug = false;
  maxAniso: number;

  constructor(canvas: HTMLCanvasElement, gen: GeneratedTexture, caps: DeviceCaps) {
    this.canvas = canvas;
    this.caps = caps;
    const gl = canvas.getContext('webgl2', { antialias: true, depth: true })!;
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.maxAniso = caps.anisoMax || 1;
    this.anisoExt = caps.anisoExt ? gl.getExtension('EXT_texture_filter_anisotropic') : null;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program 链接失败: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    this.uniforms = {
      uVP: gl.getUniformLocation(prog, 'uVP'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uMode: gl.getUniformLocation(prog, 'uMode'),
      uHwAniso: gl.getUniformLocation(prog, 'uHwAniso'),
      uMaxAniso: gl.getUniformLocation(prog, 'uMaxAniso'),
      uLodDebug: gl.getUniformLocation(prog, 'uLodDebug'),
    };

    this.vao = this.buildPlane(gl);
    this.texNoMip = this.createTexture(gl, gen, false);
    this.texMip = this.createTexture(gl, gen, true);
    this.texAniso = this.createTexture(gl, gen, true);
    this.applyAniso();

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.07, 0.08, 0.1, 1);
  }

  /** 平面网格：XZ 平面，PLANE_TILES 块砖，每块砖 TILE_WORLD 个世界单位。 */
  private buildPlane(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
    const tiles = 32;
    const size = tiles * TILE_WORLD;
    const seg = tiles; // 每块砖一个四边形
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let z = 0; z <= seg; z++) {
      for (let x = 0; x <= seg; x++) {
        const wx = (x / seg) * size - size / 2;
        const wz = (z / seg) * size - size / 2;
        positions.push(wx, wz);
        uvs.push(wx / TILE_WORLD, wz / TILE_WORLD); // REPEAT：跨砖连续
      }
    }
    const row = seg + 1;
    for (let z = 0; z < seg; z++) {
      for (let x = 0; x < seg; x++) {
        const a = z * row + x;
        indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
      }
    }

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const pBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    const iBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, iBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    return vao;
  }

  private createTexture(gl: WebGL2RenderingContext, gen: GeneratedTexture, withMip: boolean): WebGLTexture {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const levelCount = withMip ? TEX_LEVELS : 1;
    for (let l = 0; l < levelCount; l++) {
      const img = gen.levels[l];
      gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }
    if (withMip) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, TEX_LEVELS - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /** 滑杆改变最大各向异性时，只作用于 C 模式的纹理对象。 */
  applyAniso(): void {
    const gl = this.gl;
    if (!this.anisoExt) return;
    gl.bindTexture(gl.TEXTURE_2D, this.texAniso);
    gl.texParameterf(
      gl.TEXTURE_2D,
      this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(this.maxAniso, this.caps.anisoMax),
    );
    gl.bindTexture(gl.TEXTURE_2D, this.texMip);
    gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, 1);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(vp: Float32Array): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    const tex = this.mode === 0 ? this.texNoMip : this.mode === 1 ? this.texMip : this.texAniso;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uniforms.uTex, 0);
    gl.uniform1i(this.uniforms.uMode, this.mode);
    gl.uniform1i(this.uniforms.uHwAniso, this.mode === 2 && this.anisoExt ? 1 : 0);
    gl.uniform1i(this.uniforms.uMaxAniso, this.maxAniso);
    gl.uniform1i(this.uniforms.uLodDebug, this.lodDebug ? 1 : 0);
    gl.uniformMatrix4fv(this.uniforms.uVP, false, vp);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, 32 * 32 * 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texNoMip);
    gl.deleteTexture(this.texMip);
    gl.deleteTexture(this.texAniso);
  }
}

export function queryCaps(canvas: HTMLCanvasElement): DeviceCaps {
  const gl = canvas.getContext('webgl2');
  if (!gl) return { webgl2: false, anisoExt: false, anisoMax: 1, maxTextureSize: 0, renderer: '不可用' };
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  const anisoMax = ext ? (gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1;
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  let renderer = '未知';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  const lose = gl.getExtension('WEBGL_lose_context');
  lose?.loseContext();
  return { webgl2: true, anisoExt: !!ext, anisoMax, maxTextureSize, renderer };
}

export function makeGeneratedTexture(): GeneratedTexture {
  return generateTexture();
}
