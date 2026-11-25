import type { RGBAImage } from '../core/image.ts';
import { cameraForLod, type Arrangement } from '../core/samples.ts';
import { identity, lookAt, multiply, ortho, rotationY, type Mat4 } from './mat4.ts';

export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 640;
export const VIEW_SIZE = 640;

export interface TextureSet {
  texture: WebGLTexture;
  maxLevel: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  ordinary: TextureSet;
  area: TextureSet;
  cutoff: number;
  arrangement: Arrangement;
  cameraLod: number;
  lodLock: number | 'auto';
  sourceWidth: number;
  sourceHeight: number;
}

export interface RenderInfo {
  level: number;
  viewHeight: number;
  pull: number;
  nominalDistance: number;
}

const VERT = `#version 300 es
layout(location = 0) in vec2 a_position;
uniform mat4 u_mvp;
uniform vec2 u_size;
out vec2 v_uv;
void main() {
  vec3 p = vec3(a_position * u_size, 0.0);
  gl_Position = u_mvp * vec4(p, 1.0);
  v_uv = a_position + vec2(0.5);
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_cutoffByte;
uniform float u_lod;
out vec4 outColor;
void main() {
  vec4 texel = textureLod(u_tex, v_uv, u_lod);
  float alphaByte = floor(texel.a * 255.0 + 0.5);
  if (alphaByte < u_cutoffByte) {
    discard;
  }
  outColor = vec4(texel.rgb, 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log ?? 'unknown error'}`);
  }
  return shader;
}

export class LeafRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private scratchA: Mat4 = identity();
  private scratchB: Mat4 = identity();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: true,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('当前浏览器或环境没有提供 WebGL2。');
    this.gl = gl;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!program) throw new Error('Unable to create WebGL program');
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`);
    }
    this.program = program;

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Unable to create VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const quad = new Float32Array([
      -0.5, -0.5,
       0.5, -0.5,
      -0.5,  0.5,
      -0.5,  0.5,
       0.5, -0.5,
       0.5,  0.5,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      mvp: gl.getUniformLocation(program, 'u_mvp'),
      size: gl.getUniformLocation(program, 'u_size'),
      tex: gl.getUniformLocation(program, 'u_tex'),
      cutoff: gl.getUniformLocation(program, 'u_cutoffByte'),
      lod: gl.getUniformLocation(program, 'u_lod'),
    };

    gl.useProgram(program);
    gl.uniform1i(this.uniforms.tex, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clearDepth(1);
  }

  uploadChain(images: RGBAImage[]): TextureSet {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to create WebGL texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    images.forEach((image, level) => {
      gl.texImage2D(
        gl.TEXTURE_2D,
        level,
        gl.RGBA8,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.data,
      );
    });

    const maxLevel = images.length - 1;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { texture, maxLevel, width: images[0].width, height: images[0].height };
  }

  deleteTextureSet(set: TextureSet | null): void {
    if (set) this.gl.deleteTexture(set.texture);
  }

  render(options: RenderOptions): RenderInfo {
    const gl = this.gl;
    const maxLevel = options.ordinary.maxLevel;
    const camera = cameraForLod(options.cameraLod, options.sourceHeight, maxLevel);
    const level = options.lodLock === 'auto'
      ? camera.level
      : Math.max(0, Math.min(maxLevel, Math.round(options.lodLock)));

    const aspect = options.sourceWidth / options.sourceHeight;
    const cardHeight = 2;
    const cardWidth = cardHeight * aspect;

    const projection = ortho(
      -camera.viewHeight / 2,
      camera.viewHeight / 2,
      -camera.viewHeight / 2,
      camera.viewHeight / 2,
      0.1,
      40,
    );
    const view = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const projectionView = multiply(this.scratchA, projection, view);
    const angles = options.arrangement === 'front' ? [0] : [Math.PI / 4, -Math.PI / 4];

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1f(this.uniforms.cutoff, options.cutoff);
    gl.uniform1f(this.uniforms.lod, level);
    gl.uniform2f(this.uniforms.size, cardWidth, cardHeight);
    gl.activeTexture(gl.TEXTURE0);

    const sides: Array<{ x: number; set: TextureSet }> = [
      { x: 0, set: options.ordinary },
      { x: VIEW_SIZE, set: options.area },
    ];

    for (const side of sides) {
      gl.viewport(side.x, 0, VIEW_SIZE, VIEW_SIZE);
      gl.scissor(side.x, 0, VIEW_SIZE, VIEW_SIZE);
      gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.bindTexture(gl.TEXTURE_2D, side.set.texture);
      for (const angle of angles) {
        const model = rotationY(angle);
        const mvp = multiply(this.scratchB, projectionView, model);
        gl.uniformMatrix4fv(this.uniforms.mvp, false, mvp);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    return {
      level,
      viewHeight: camera.viewHeight,
      pull: camera.pull,
      nominalDistance: camera.nominalDistance,
    };
  }
}
