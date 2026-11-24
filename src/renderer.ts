import { GRID_H, GRID_W, type NamedVertex } from "./state.js";
import type { PixelResult, RasterResult, SampleInfo, Triangle, Vec2 } from "./rasterizer.js";

/** 覆盖层图元：0=线段 1=点 2=四边形 */
type OverlayKind = 0 | 1 | 2;

interface OverlayVertex {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
  kind: OverlayKind;
  size: number; // 点直径/线宽（CSS px）
}

export interface FrameData {
  result: RasterResult;
  verts: NamedVertex[];
  triangles: Triangle[];
  cell: number;
  showGrid: boolean;
  showSamples: boolean;
  showVerts: boolean;
  selected: { px: number; py: number } | null;
  selectedVertex: number | null;
  /** 公共边端点（逻辑坐标） */
  sharedEdges: Array<[Vec2, Vec2]>;
}

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
layout(location=2) in float a_kind;
layout(location=3) in float a_size;
uniform vec2 u_viewport;
uniform float u_cell;
out vec4 v_color;
flat out int v_kind;
void main() {
  vec2 clip = (a_pos * u_cell - u_viewport * 0.5) / (u_viewport * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
  v_kind = int(a_kind + 0.5);
  gl_PointSize = a_size;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
flat in int v_kind;
out vec4 outColor;
void main() {
  if (v_kind == 1) {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard;
    outColor = v_color;
  } else {
    outColor = v_color;
  }
}`;

const FULLSCREEN_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const TEX_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_grid;
uniform float u_cell;
uniform float u_showGrid;
out vec4 outColor;
void main() {
  vec2 px = v_uv * u_grid;
  vec2 f = fract(px);
  vec4 c = texture(u_tex, v_uv);
  // 每格四周画 1px 网格线
  float lx = min(f.x, 1.0 - f.x) * u_cell;
  float ly = min(f.y, 1.0 - f.y) * u_cell;
  float line = (step(lx, 1.0) + step(ly, 1.0)) * u_showGrid;
  vec3 col = mix(c.rgb, vec3(0.16, 0.18, 0.22), clamp(line, 0.0, 1.0) * 0.55);
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader 编译失败: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program 链接失败: " + gl.getProgramInfoLog(p));
  }
  return p;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private texProg: WebGLProgram;
  private overlayProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private fullVao: WebGLVertexArrayObject;
  private fullVbo: WebGLBuffer;
  private texture: WebGLTexture;
  private vertexCount = 0;
  private dpr = 1;
  canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      // 允许合成后通过 2D drawImage / readPixels 抓取画面，便于截图核对
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("当前浏览器不支持 WebGL2");
    this.gl = gl;
    this.canvas = canvas;
    this.texProg = program(gl, FULLSCREEN_VERT, TEX_FRAG);
    this.overlayProg = program(gl, VERT, FRAG);

    this.fullVao = gl.createVertexArray()!;
    this.fullVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.fullVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 7 * 4);

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.disable(gl.DEPTH_TEST);
  }

  resize(dpr: number, cell: number): void {
    this.dpr = dpr;
    const w = Math.round(GRID_W * cell * dpr);
    const h = Math.round(GRID_H * cell * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${GRID_W * cell}px`;
      this.canvas.style.height = `${GRID_H * cell}px`;
    }
  }

  render(frame: FrameData): void {
    const gl = this.gl;
    const cell = frame.cell;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 第 1 层：CPU 光栅结果纹理 + 网格线
    this.uploadTexture(frame.result);
    gl.disable(gl.BLEND);
    gl.useProgram(this.texProg);
    gl.bindVertexArray(this.fullVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.texProg, "u_tex"), 0);
    gl.uniform2f(
      gl.getUniformLocation(this.texProg, "u_grid"),
      GRID_W,
      GRID_H,
    );
    gl.uniform1f(gl.getUniformLocation(this.texProg, "u_cell"), cell * this.dpr);
    gl.uniform1f(
      gl.getUniformLocation(this.texProg, "u_showGrid"),
      frame.showGrid ? 1 : 0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 第 2 层：矢量覆盖
    const data = this.buildOverlay(frame);
    if (data.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.overlayProg);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.uniform2f(
        gl.getUniformLocation(this.overlayProg, "u_viewport"),
        this.canvas.width,
        this.canvas.height,
      );
      gl.uniform1f(gl.getUniformLocation(this.overlayProg, "u_cell"), cell * this.dpr);
      gl.drawArrays(gl.POINTS, 0, this.vertexCount);
      gl.drawArrays(gl.LINES, 0, this.vertexCount);
    }
  }

  private uploadTexture(result: RasterResult): void {
    const gl = this.gl;
    const data = new Uint8Array(GRID_W * GRID_H * 4);
    for (const p of result.pixels) {
      const i = (p.py * GRID_W + p.px) * 4;
      data[i] = p.rgba[0];
      data[i + 1] = p.rgba[1];
      data[i + 2] = p.rgba[2];
      data[i + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      GRID_W,
      GRID_H,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
  }

  private buildOverlay(frame: FrameData): Float32Array {
    const out: OverlayVertex[] = [];
    const cell = frame.cell;

    // 选中像素高亮框：细线沿网格线内侧描，避免粗线外扩造成的视觉错位
    if (frame.selected) {
      const { px, py } = frame.selected;
      const inset = 0.02;
      this.pushRect(
        out,
        cell,
        { x: px + inset, y: py + inset },
        { x: px + 1 - inset, y: py + 1 - inset },
        [1, 0.92, 0.35, 0.95],
        Math.max(1.5, cell * 0.04),
      );
    }

    // 三角形边线
    for (const t of frame.triangles) {
      const c = t.color;
      const loop = [t.v[0], t.v[1], t.v[2], t.v[0]];
      for (let i = 0; i < 3; i++) {
        this.pushLine(
          out,
          cell,
          frame.verts[loop[i]],
          frame.verts[loop[i + 1]],
          [c.r, c.g, c.b, 0.9],
          Math.max(1.5, cell * 0.045),
        );
      }
    }

    // 公共边加粗金色描边
    for (const [a, b] of frame.sharedEdges) {
      this.pushLine(out, cell, a, b, [1, 0.78, 0.25, 0.85], Math.max(2.5, cell * 0.09));
    }

    // 选中像素内的采样点
    if (frame.showSamples && frame.selected) {
      const pix = this.pixelAt(frame.result, frame.selected.px, frame.selected.py);
      if (pix) {
        for (const s of pix.samples) {
          this.pushSample(out, s, pix, frame, cell);
        }
      }
    }

    // 可拖拽顶点
    if (frame.showVerts) {
      frame.verts.forEach((vert, i) => {
        const selected = i === frame.selectedVertex;
        this.pushPoint(
          out,
          vert,
          selected ? [1, 0.95, 0.4, 1] : [1, 1, 1, 0.95],
          selected ? cell * 0.34 : cell * 0.24,
        );
      });
    }

    const flat = new Float32Array(out.length * 8);
    out.forEach((v, i) => {
      const o = i * 8;
      flat[o] = v.x;
      flat[o + 1] = v.y;
      flat[o + 2] = v.r;
      flat[o + 3] = v.g;
      flat[o + 4] = v.b;
      flat[o + 5] = v.a;
      flat[o + 6] = v.kind;
      flat[o + 7] = v.size * this.dpr;
    });
    this.vertexCount = out.length;
    return flat;
  }

  private pushSample(
    out: OverlayVertex[],
    s: SampleInfo,
    pix: PixelResult,
    frame: FrameData,
    cell: number,
  ): void {
    const pos: Vec2 = { x: pix.px + s.dx, y: pix.py + s.dy };
    let color: [number, number, number, number];
    if (s.owners.length === 0) {
      color = [0.75, 0.78, 0.85, 0.5]; // 未覆盖：空心灰
    } else if (s.owners.length > 1) {
      color = [1, 0.1, 0.9, 1]; // 重复占用：品红
    } else {
      const tri = frame.triangles.find((t) => t.id === s.owners[0])!;
      color = [tri.color.r, tri.color.g, tri.color.b, 1];
    }
    this.pushPoint(out, pos, color, cell * 0.2);
  }

  private pixelAt(result: RasterResult, px: number, py: number): PixelResult | undefined {
    return result.pixels.find((p) => p.px === px && p.py === py);
  }

  private pushPoint(
    out: OverlayVertex[],
    p: Vec2,
    c: [number, number, number, number],
    size: number,
  ): void {
    out.push({ x: p.x, y: p.y, r: c[0], g: c[1], b: c[2], a: c[3], kind: 1, size });
  }

  private pushLine(
    out: OverlayVertex[],
    cell: number,
    a: Vec2,
    b: Vec2,
    c: [number, number, number, number],
    width: number,
  ): void {
    // 用两条与法线垂直的四边形边模拟粗线（LINES 的线宽在多数驱动上恒为 1）
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // width 是 CSS 像素，偏移要换算回逻辑坐标
    const half = width / 2 / cell;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    const p1: OverlayVertex = {
      x: a.x + nx,
      y: a.y + ny,
      r: c[0],
      g: c[1],
      b: c[2],
      a: c[3],
      kind: 0,
      size: 1,
    };
    const p2: OverlayVertex = {
      x: b.x + nx,
      y: b.y + ny,
      r: c[0],
      g: c[1],
      b: c[2],
      a: c[3],
      kind: 0,
      size: 1,
    };
    const p3: OverlayVertex = {
      x: b.x - nx,
      y: b.y - ny,
      r: c[0],
      g: c[1],
      b: c[2],
      a: c[3],
      kind: 0,
      size: 1,
    };
    const p4: OverlayVertex = {
      x: a.x - nx,
      y: a.y - ny,
      r: c[0],
      g: c[1],
      b: c[2],
      a: c[3],
      kind: 0,
      size: 1,
    };
    out.push(p1, p3, p1, p4, p2, p3);
  }

  private pushRect(
    out: OverlayVertex[],
    cell: number,
    lo: Vec2,
    hi: Vec2,
    c: [number, number, number, number],
    width: number,
  ): void {
    const pts: Vec2[] = [
      { x: lo.x, y: lo.y },
      { x: hi.x, y: lo.y },
      { x: hi.x, y: hi.y },
      { x: lo.x, y: hi.y },
    ];
    for (let i = 0; i < 4; i++) {
      this.pushLine(out, cell, pts[i], pts[(i + 1) % 4], c, width);
    }
  }
}
