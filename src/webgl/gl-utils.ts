import { VERT } from './shaders';

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}\n${src}`);
  }
  return sh;
}

export class Program {
  readonly prog: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation>();
  private vao: WebGLVertexArrayObject;

  constructor(private gl: WebGL2RenderingContext, fragSrc: string) {
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    this.vao = gl.createVertexArray()!;
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const loc = gl.getUniformLocation(prog, info.name);
      if (loc) this.uniforms.set(info.name, loc);
    }
  }

  use(): void {
    this.gl.useProgram(this.prog);
    this.gl.bindVertexArray(this.vao);
  }

  u(name: string): WebGLUniformLocation {
    const loc = this.uniforms.get(name);
    if (!loc) throw new Error(`Unknown uniform: ${name}`);
    return loc;
  }
}

export interface TexSpec {
  internal: number;
  format: number;
  type: number;
  filter: number;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  spec: TexSpec,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, spec.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, spec.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, spec.internal, width, height, 0,
    spec.format, spec.type, null,
  );
  return tex;
}

/**
 * Color target spec. The scene's hatch shading stays inside [0,1], so plain
 * RGBA8 is sufficient and guarantees UNSIGNED_BYTE readPixels works on every
 * driver (16F targets reject byte readback on some ANGLE/SwiftShader builds).
 */
export function pickColorSpec(_gl: WebGL2RenderingContext): TexSpec {
  return { internal: _gl.RGBA8, format: _gl.RGBA, type: _gl.UNSIGNED_BYTE, filter: _gl.NEAREST };
}

// RGBA8 is the universally renderable format; id and mask each use the red
// channel of their own RGBA8 attachment (R8 render targets are optional in
// WebGL2 and unsupported by some drivers, e.g. SwiftShader).
export const ID_SPEC: TexSpec = {
  internal: 0x8058, // gl.RGBA8
  format: 0x1908, // gl.RGBA
  type: 0x1401, // gl.UNSIGNED_BYTE
  filter: 0x2600, // gl.NEAREST
};
export const MASK_SPEC: TexSpec = { ...ID_SPEC };

/** Framebuffer holding color + id (+ optional mask) attachments at one size. */
export class RenderTarget {
  fbo: WebGLFramebuffer;
  textures: WebGLTexture[] = [];
  width = 0;
  height = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    width: number,
    height: number,
    private specs: TexSpec[],
  ) {
    this.fbo = gl.createFramebuffer()!;
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    const gl = this.gl;
    this.width = width;
    this.height = height;
    this.textures.forEach((t) => gl.deleteTexture(t));
    this.textures = this.specs.map((s) => createTexture(gl, width, height, s));

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.textures.forEach((tex, i) => {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0,
      );
    });
    gl.drawBuffers(this.textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  bindTextures(startUnit: number): void {
    const gl = this.gl;
    this.textures.forEach((tex, i) => {
      gl.activeTexture(gl.TEXTURE0 + startUnit + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    });
  }

  clearColor(r: number, g: number, b: number, a: number, clearIdAndMask: boolean): void {
    const gl = this.gl;
    this.bind();
    gl.disable(gl.SCISSOR_TEST);
    gl.clearBufferfv(gl.COLOR, 0, [r, g, b, a]);
    if (clearIdAndMask) {
      gl.clearBufferfv(gl.COLOR, 1, [0.75, 0, 0, 1]); // sentinel id, matches nothing real
      if (this.textures.length > 2) {
        gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 1]); // mask = 0
      }
    }
  }
}
