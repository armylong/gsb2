import { ClippedGeometry, ClipTriangle } from './board';

const VERT_PASS = `#version 300 es
layout(location=0) in vec2 a_ndc;
layout(location=1) in vec2 a_uvOverW;
layout(location=2) in float a_invW;
out vec2 v_uvOverW;
out float v_invW;
void main() {
  gl_Position = vec4(a_ndc, 0.0, 1.0);
  v_uvOverW = a_uvOverW;
  v_invW = a_invW;
}`;

const FRAG_PASS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_affine;
uniform vec2 u_p0; uniform vec2 u_p1; uniform vec2 u_p2;
uniform vec2 u_t0; uniform vec2 u_t1; uniform vec2 u_t2;
uniform vec2 u_viewport;
in vec2 v_uvOverW;
in float v_invW;
layout(location=0) out vec4 outColor;
layout(location=1) out vec4 outUV;

vec3 bary2D(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 v0 = b - a;
  vec2 v1 = c - a;
  vec2 v2 = p - a;
  float den = v0.x * v1.y - v1.x * v0.y;
  float w1 = (v2.x * v1.y - v1.x * v2.y) / den;
  float w2 = (v0.x * v2.y - v2.x * v0.y) / den;
  return vec3(1.0 - w1 - w2, w1, w2);
}

void main() {
  vec2 uv;
  if (u_affine == 1) {
    // 屏幕空间（NDC 与屏幕像素只差一个仿射变换，重心权重相同）直接线性插值
    vec2 ndc = gl_FragCoord.xy / u_viewport * 2.0 - 1.0;
    vec3 w = bary2D(ndc, u_p0, u_p1, u_p2);
    uv = w.x * u_t0 + w.y * u_t1 + w.z * u_t2;
  } else {
    // 透视校正：(uv/w) / (1/w)，由硬件对两个 varying 做透视插值后相除
    uv = v_uvOverW / v_invW;
  }
  outColor = texture(u_tex, uv);
  outUV = vec4(uv, 0.0, 1.0);
}`;

const VERT_LINE = `#version 300 es
layout(location=0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.999, 1.0); }`;

const FRAG_LINE = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

// 全屏四边形，把离屏颜色纹理贴到默认帧缓冲（规避部分驱动 blitFramebuffer 限制）
const VERT_BLIT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_BLIT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_uv); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'shader compile error');
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program link error');
  }
  return p;
}

export interface UVReadback {
  valid: boolean;
  uv: [number, number];
}

export class RenderView {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  private passProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private blitProg: WebGLProgram;
  private vbo: WebGLBuffer;
  private lineVbo: WebGLBuffer;
  private quadVbo: WebGLBuffer;
  private fbo: WebGLFramebuffer;
  private colorTex: WebGLTexture;
  private uvTex: WebGLTexture;
  private tex: WebGLTexture;
  private floatRenderable: boolean;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement, checker: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      preserveDrawingBuffer: true, // 允许直接导出截图
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.floatRenderable = !!gl.getExtension('EXT_color_buffer_float');

    this.passProg = link(gl, VERT_PASS, FRAG_PASS);
    this.lineProg = link(gl, VERT_LINE, FRAG_LINE);
    this.blitProg = link(gl, VERT_BLIT, FRAG_BLIT);
    this.vbo = gl.createBuffer()!;
    this.lineVbo = gl.createBuffer()!;
    this.quadVbo = gl.createBuffer()!;
    this.fbo = gl.createFramebuffer()!;
    this.colorTex = gl.createTexture()!;
    this.uvTex = gl.createTexture()!;
    this.tex = gl.createTexture()!;

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, checker);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.resize();
  }

  supportsFloatReadback(): boolean {
    return this.floatRenderable;
  }

  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl;

    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    gl.bindTexture(gl.TEXTURE_2D, this.uvTex);
    const internal = this.floatRenderable ? gl.RGBA16F : gl.RGBA8;
    const type = this.floatRenderable ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.colorTex,
      0
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      this.uvTex,
      0
    );
    const complete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (!complete) this.floatRenderable = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  private setAffineUniforms(
    loc: Record<string, WebGLUniformLocation | null>,
    tri: ClipTriangle
  ) {
    const gl = this.gl;
    const n = tri.map((v) => [v.clip[0] / v.clip[3], v.clip[1] / v.clip[3]]);
    gl.uniform2f(loc.u_p0, n[0][0], n[0][1]);
    gl.uniform2f(loc.u_p1, n[1][0], n[1][1]);
    gl.uniform2f(loc.u_p2, n[2][0], n[2][1]);
    gl.uniform2f(loc.u_t0, tri[0].uv[0], tri[0].uv[1]);
    gl.uniform2f(loc.u_t1, tri[1].uv[0], tri[1].uv[1]);
    gl.uniform2f(loc.u_t2, tri[2].uv[0], tri[2].uv[1]);
    gl.uniform2f(loc.u_viewport, this.width, this.height);
  }

  private renderToFbo(geom: ClippedGeometry, affine: boolean) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.clearColor(0.063, 0.075, 0.094, 1);
    // UV 附件用哨兵值清空：合法像素 alpha=1
    gl.clearBufferfv(gl.COLOR, 1, new Float32Array([3, 3, 3, 0]));
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.passProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const loc: Record<string, WebGLUniformLocation | null> = {
      u_tex: gl.getUniformLocation(this.passProg, 'u_tex'),
      u_affine: gl.getUniformLocation(this.passProg, 'u_affine'),
      u_p0: gl.getUniformLocation(this.passProg, 'u_p0'),
      u_p1: gl.getUniformLocation(this.passProg, 'u_p1'),
      u_p2: gl.getUniformLocation(this.passProg, 'u_p2'),
      u_t0: gl.getUniformLocation(this.passProg, 'u_t0'),
      u_t1: gl.getUniformLocation(this.passProg, 'u_t1'),
      u_t2: gl.getUniformLocation(this.passProg, 'u_t2'),
      u_viewport: gl.getUniformLocation(this.passProg, 'u_viewport'),
    };
    gl.uniform1i(loc.u_tex, 0);
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);

    if (!affine) {
      // 透视校正通道：所有裁剪后的三角形一次绘制，属性为 NDC、uv/w、1/w
      const data: number[] = [];
      for (const tri of geom.triangles) {
        for (const v of tri) {
          const invW = 1 / v.clip[3];
          data.push(
            v.clip[0] * invW,
            v.clip[1] * invW,
            v.uv[0] * invW,
            v.uv[1] * invW,
            invW
          );
        }
      }
      gl.uniform1i(loc.u_affine, 0);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
      const stride = 5 * 4;
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * 4);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 4 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, geom.triangles.length * 3);
    } else {
      // 仿射通道：逐三角形绘制，重心坐标在屏幕/NDC 空间直接计算；
      // 占位 VBO 只提供 NDC 位置（location 0），其余属性走 uniform
      gl.disableVertexAttribArray(1);
      gl.disableVertexAttribArray(2);
      gl.uniform1i(loc.u_affine, 1);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STREAM_DRAW
      );
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      for (const tri of geom.triangles) {
        this.setAffineUniforms(loc, tri);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.disable(gl.BLEND);
  }

  private blitToScreen() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.uniform1i(gl.getUniformLocation(this.blitProg, 'u_tex'), 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STREAM_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawLines(geom: ClippedGeometry) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.lineProg);
    const colorLoc = gl.getUniformLocation(this.lineProg, 'u_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const all: number[] = [];
    for (const s of geom.edges) all.push(s.a[0], s.a[1], s.b[0], s.b[1]);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(all), gl.STREAM_DRAW);
    gl.uniform4f(colorLoc, 1, 1, 1, 0.85);
    gl.drawArrays(gl.LINES, 0, all.length / 2);

    const diag: number[] = [];
    for (const s of geom.diagonal) diag.push(s.a[0], s.a[1], s.b[0], s.b[1]);
    if (diag.length) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(diag), gl.STREAM_DRAW);
      gl.uniform4f(colorLoc, 0.98, 0.83, 0.08, 1);
      gl.lineWidth(2);
      gl.drawArrays(gl.LINES, 0, diag.length / 2);
      gl.lineWidth(1);
    }
  }

  render(geom: ClippedGeometry, affine: boolean) {
    this.resize();
    this.renderToFbo(geom, affine);
    this.blitToScreen();
    this.drawLines(geom);
  }

  // 读取某设备像素处真正写入的纹理坐标；背景/板外返回 invalid
  readUV(deviceX: number, deviceY: number): UVReadback {
    const gl = this.gl;
    const x = Math.round(deviceX);
    const y = this.height - 1 - Math.round(deviceY); // 翻 Y
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return { valid: false, uv: [0, 0] };
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    let valid: boolean;
    let uv: [number, number];
    if (this.floatRenderable) {
      const px = new Float32Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, px);
      valid = px[3] > 0.5;
      uv = [px[0], px[1]];
    } else {
      const px = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      valid = px[3] > 127;
      uv = [px[0] / 255, px[1] / 255];
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (!valid || uv[0] < -0.05 || uv[0] > 1.05 || uv[1] < -0.05 || uv[1] > 1.05) {
      return { valid: false, uv: [0, 0] };
    }
    return { valid, uv };
  }

  get deviceSize(): [number, number] {
    return [this.width, this.height];
  }
}
