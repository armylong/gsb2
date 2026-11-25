import type { Camera } from '../core/camera';
import type { DrawGroup } from '../core/batching';
import type { Sprite } from '../core/types';
import type { TextureDef } from '../render/textures';
import { BACKDROP_FS, BACKDROP_VS, DISPLAY_FS, DISPLAY_VS, SPRITE_FS, SPRITE_VS } from './shaders';

export interface PathDraw {
  /** 本路径的绘制次序（精灵下标）。 */
  order: readonly number[];
  /** 每个绘制位次的批次颜色（0..1 RGB），用于"按批次着色"。 */
  colors: Float32Array;
  /** 本路径的连续段；参考路径每个精灵一段。 */
  groups: readonly DrawGroup[];
  /** 参考路径用非实例化绘制（每个精灵一次 drawArrays）。 */
  perSprite: boolean;
}

export interface RenderOptions {
  camera: Camera;
  sprites: readonly Sprite[];
  ref: PathDraw;
  batch: PathDraw;
  /** 切换成按批次着色（仍吃同一份实例数据）。 */
  batchColorMode: boolean;
}

export interface RenderStats {
  refBackdropCalls: number;
  refSpriteCalls: number;
  refInstances: number;
  batchBackdropCalls: number;
  batchSpriteCalls: number;
  batchInstances: number;
  /** 一次完整重绘（两条路径 + 一次全屏合成）发出的全部 draw call。 */
  frameDrawCalls: number;
  contextLost: boolean;
}

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const INSTANCE_FLOATS = 12; // 3 个 RGBA32F texel

function compile(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string, name: string): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vs || !fs) throw new Error('createShader 失败');
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error(`${name} 顶点着色器编译失败: ${gl.getShaderInfoLog(vs) ?? ''}`);
  }
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error(`${name} 片元着色器编译失败: ${gl.getShaderInfoLog(fs) ?? ''}`);
  }
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram 失败');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`${name} 链接失败: ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

function uniformsOf(gl: WebGL2RenderingContext, program: WebGLProgram, names: string[]): UniformMap {
  const out: UniformMap = {};
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

function requireLoc(map: UniformMap, name: string): WebGLUniformLocation {
  const loc = map[name];
  if (!loc) throw new Error(`uniform 缺失: ${name}`);
  return loc;
}

export class SceneRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;

  private readonly spriteProgram: WebGLProgram;
  private readonly spriteUniforms: UniformMap;
  private readonly displayProgram: WebGLProgram;
  private readonly displayUniforms: UniformMap;
  private readonly backdropProgram: WebGLProgram;
  private readonly backdropUniforms: UniformMap;

  private readonly quadBuffer: WebGLBuffer;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly quadVao: WebGLVertexArrayObject;

  private atlas: WebGLTexture | null = null;
  private readonly instanceTex: WebGLTexture;
  private instanceCapacity = 0;
  private instanceData = new Float32Array(0);

  private refTex: WebGLTexture | null = null;
  private refFbo: WebGLFramebuffer | null = null;
  private batchTex: WebGLTexture | null = null;
  private batchFbo: WebGLFramebuffer | null = null;
  private targetW = 1;
  private targetH = 1;

  private refPixels = new Uint8Array(0);
  private batchPixels = new Uint8Array(0);

  private lastStats: RenderStats = {
    refBackdropCalls: 0,
    refSpriteCalls: 0,
    refInstances: 0,
    batchBackdropCalls: 0,
    batchSpriteCalls: 0,
    batchInstances: 0,
    frameDrawCalls: 0,
    contextLost: false,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器/显卡不提供 WebGL2 上下文');
    this.gl = gl;

    this.spriteProgram = compile(gl, SPRITE_VS, SPRITE_FS, '精灵');
    this.spriteUniforms = uniformsOf(gl, this.spriteProgram, [
      'uInstances',
      'uBase',
      'uEye',
      'uCamera',
      'uZoom',
      'uAtlas',
      'uBatchColor',
      'uBatchAlpha',
    ]);
    this.displayProgram = compile(gl, DISPLAY_VS, DISPLAY_FS, '显示');
    this.displayUniforms = uniformsOf(gl, this.displayProgram, [
      'uRef',
      'uBatch',
      'uMode',
      'uSplit',
      'uAmplify',
    ]);
    this.backdropProgram = compile(gl, BACKDROP_VS, BACKDROP_FS, '背景');
    this.backdropUniforms = uniformsOf(gl, this.backdropProgram, ['uEye', 'uCamera', 'uZoom']);

    const quadBuffer = gl.createBuffer();
    const quadVao = gl.createVertexArray();
    const emptyVao = gl.createVertexArray();
    const instTex = gl.createTexture();
    if (!quadBuffer || !quadVao || !emptyVao || !instTex) throw new Error('WebGL 资源创建失败');
    this.quadBuffer = quadBuffer;
    this.quadVao = quadVao;
    this.emptyVao = emptyVao;
    this.instanceTex = instTex;

    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, this.instanceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.lastStats.contextLost = gl.isContextLost();
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lastStats = { ...this.lastStats, contextLost: true };
    });
  }

  get pixelsRef(): Uint8Array {
    return this.refPixels;
  }

  get pixelsBatch(): Uint8Array {
    return this.batchPixels;
  }

  get width(): number {
    return this.targetW;
  }

  get height(): number {
    return this.targetH;
  }

  get stats(): RenderStats {
    return this.lastStats;
  }

  setTextures(defs: readonly TextureDef[]): void {
    const gl = this.gl;
    if (this.atlas) gl.deleteTexture(this.atlas);
    const atlas = gl.createTexture();
    if (!atlas) throw new Error('贴图数组创建失败');
    const size = defs[0]?.size ?? 1;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, size, size, defs.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let layer = 0; layer < defs.length; layer++) {
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        layer,
        size,
        size,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        defs[layer]!.premultiplied,
      );
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.atlas = atlas;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.targetW && h === this.targetH && this.refFbo && this.batchFbo) return;
    const gl = this.gl;
    this.targetW = w;
    this.targetH = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const makeTarget = (): { tex: WebGLTexture; fbo: WebGLFramebuffer } => {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!tex || !fbo) throw new Error('离屏缓冲创建失败');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`离屏缓冲不完整: 0x${status.toString(16)}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo };
    };

    if (this.refTex) gl.deleteTexture(this.refTex);
    if (this.refFbo) gl.deleteFramebuffer(this.refFbo);
    if (this.batchTex) gl.deleteTexture(this.batchTex);
    if (this.batchFbo) gl.deleteFramebuffer(this.batchFbo);
    const ref = makeTarget();
    const batch = makeTarget();
    this.refTex = ref.tex;
    this.refFbo = ref.fbo;
    this.batchTex = batch.tex;
    this.batchFbo = batch.fbo;
    this.refPixels = new Uint8Array(w * h * 4);
    this.batchPixels = new Uint8Array(w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private ensureInstanceCapacity(count: number): void {
    if (count <= this.instanceCapacity) return;
    const capacity = Math.max(64, Math.ceil(count * 1.25));
    this.instanceCapacity = capacity;
    this.instanceData = new Float32Array(capacity * INSTANCE_FLOATS);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.instanceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, capacity, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** 按绘制次序写实例数据；参考与合批路径使用同一份。 */
  private uploadInstances(opts: RenderOptions, order: readonly number[], colors: Float32Array): number {
    const count = order.length;
    this.ensureInstanceCapacity(count);
    const data = this.instanceData;
    for (let rank = 0; rank < count; rank++) {
      const sprite = opts.sprites[order[rank]!]!;
      const base = rank * INSTANCE_FLOATS;
      data[base] = sprite.x;
      data[base + 1] = sprite.y;
      data[base + 2] = sprite.w / 2;
      data[base + 3] = sprite.h / 2;
      data[base + 4] = sprite.tint[0];
      data[base + 5] = sprite.tint[1];
      data[base + 6] = sprite.tint[2];
      data[base + 7] = sprite.tint[3];
      data[base + 8] = sprite.textureIndex;
      data[base + 9] = colors[rank * 3] ?? 1;
      data[base + 10] = colors[rank * 3 + 1] ?? 1;
      data[base + 11] = colors[rank * 3 + 2] ?? 1;
    }
    if (count > 0) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.instanceTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        3,
        count,
        gl.RGBA,
        gl.FLOAT,
        data.subarray(0, count * INSTANCE_FLOATS),
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    return count;
  }

  private drawBackdrop(opts: RenderOptions): void {
    const gl = this.gl;
    gl.useProgram(this.backdropProgram);
    gl.disable(gl.BLEND);
    gl.uniform2f(requireLoc(this.backdropUniforms, 'uEye'), this.targetW, this.targetH);
    gl.uniform2f(requireLoc(this.backdropUniforms, 'uCamera'), opts.camera.cx, opts.camera.cy);
    gl.uniform1f(requireLoc(this.backdropUniforms, 'uZoom'), opts.camera.zoom);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawSprites(
    opts: RenderOptions,
    groups: readonly DrawGroup[],
    perSprite: boolean,
  ): { calls: number; instances: number } {
    const gl = this.gl;
    gl.useProgram(this.spriteProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.uniform1i(requireLoc(this.spriteUniforms, 'uAtlas'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.instanceTex);
    gl.uniform1i(requireLoc(this.spriteUniforms, 'uInstances'), 1);
    gl.uniform2f(requireLoc(this.spriteUniforms, 'uEye'), this.targetW, this.targetH);
    gl.uniform2f(requireLoc(this.spriteUniforms, 'uCamera'), opts.camera.cx, opts.camera.cy);
    gl.uniform1f(requireLoc(this.spriteUniforms, 'uZoom'), opts.camera.zoom);
    gl.uniform1i(requireLoc(this.spriteUniforms, 'uBatchColor'), opts.batchColorMode ? 1 : 0);
    gl.uniform1f(requireLoc(this.spriteUniforms, 'uBatchAlpha'), 0.9);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(this.quadVao);
    const baseLoc = requireLoc(this.spriteUniforms, 'uBase');
    let calls = 0;
    let instances = 0;
    for (const group of groups) {
      if (group.count <= 0) continue;
      // 贴图与顶点输出都是预乘 alpha，两种混合设置分别提交。
      if (group.blend === 'alpha') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1i(baseLoc, group.first);
      if (perSprite) {
        // 参考路径：每个精灵一次真正的非实例化绘制。
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else {
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
      }
      calls++;
      instances += group.count;
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    return { calls, instances };
  }

  private drawPath(
    fbo: WebGLFramebuffer,
    groups: readonly DrawGroup[],
    opts: RenderOptions,
    perSprite: boolean,
  ): { backdrop: number; calls: number; instances: number } {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, this.targetW, this.targetH);
    gl.clearColor(0.035, 0.045, 0.065, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawBackdrop(opts);
    const sprites = this.drawSprites(opts, groups, perSprite);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { backdrop: 1, calls: sprites.calls, instances: sprites.instances };
  }

  render(opts: RenderOptions): RenderStats {
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.lastStats = { ...this.lastStats, contextLost: true };
      return this.lastStats;
    }
    this.uploadInstances(opts, opts.ref.order, opts.ref.colors);
    const ref = this.drawPath(this.refFbo!, opts.ref.groups, opts, true);
    this.uploadInstances(opts, opts.batch.order, opts.batch.colors);
    const batch = this.drawPath(this.batchFbo!, opts.batch.groups, opts, false);

    this.lastStats = {
      refBackdropCalls: ref.backdrop,
      refSpriteCalls: ref.calls,
      refInstances: ref.instances,
      batchBackdropCalls: batch.backdrop,
      batchSpriteCalls: batch.calls,
      batchInstances: batch.instances,
      // 两条路径各 1 次背景 + 各自精灵批次；合成当前帧在此不计，present() 后补 1。
      frameDrawCalls: ref.backdrop + ref.calls + batch.backdrop + batch.calls + 1,
      contextLost: false,
    };
    return this.lastStats;
  }

  present(mode: number, split: number, amplify: number): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.targetW, this.targetH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.refTex);
    gl.uniform1i(requireLoc(this.displayUniforms, 'uRef'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.batchTex);
    gl.uniform1i(requireLoc(this.displayUniforms, 'uBatch'), 1);
    gl.uniform1i(requireLoc(this.displayUniforms, 'uMode'), mode);
    gl.uniform1f(requireLoc(this.displayUniforms, 'uSplit'), split);
    gl.uniform1f(requireLoc(this.displayUniforms, 'uAmplify'), amplify);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** 只读 1×1：悬停取样时避免整幅读回的同步开销。坐标原点在左上角。 */
  samplePixel(x: number, y: number): { ref: [number, number, number, number]; batch: [number, number, number, number] } {
    const gl = this.gl;
    const px = Math.max(0, Math.min(this.targetW - 1, Math.floor(x)));
    const py = Math.max(0, Math.min(this.targetH - 1, Math.floor(y)));
    const glY = this.targetH - 1 - py;
    const out = new Uint8Array(4);
    const read = (fbo: WebGLFramebuffer): [number, number, number, number] => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.readPixels(px, glY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return [out[0]!, out[1]!, out[2]!, out[3]!];
    };
    const ref = read(this.refFbo!);
    const batch = read(this.batchFbo!);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { ref, batch };
  }

  /** 读回两条路径的 RGBA 缓冲（行 0 为画面顶部）。 */
  readback(): { ref: Uint8Array; batch: Uint8Array; width: number; height: number } {
    const gl = this.gl;
    const w = this.targetW;
    const h = this.targetH;
    if (gl.isContextLost()) return { ref: this.refPixels, batch: this.batchPixels, width: w, height: h };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.refFbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.refPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.batchFbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.batchPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    flipRowsInPlace(this.refPixels, w, h);
    flipRowsInPlace(this.batchPixels, w, h);
    return { ref: this.refPixels, batch: this.batchPixels, width: w, height: h };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.spriteProgram);
    gl.deleteProgram(this.displayProgram);
    gl.deleteProgram(this.backdropProgram);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteTexture(this.instanceTex);
    if (this.atlas) gl.deleteTexture(this.atlas);
    if (this.refTex) gl.deleteTexture(this.refTex);
    if (this.batchTex) gl.deleteTexture(this.batchTex);
    if (this.refFbo) gl.deleteFramebuffer(this.refFbo);
    if (this.batchFbo) gl.deleteFramebuffer(this.batchFbo);
    this.atlas = null;
    this.refTex = null;
    this.batchTex = null;
    this.refFbo = null;
    this.batchFbo = null;
  }
}

/** readPixels 自下而上，转换为自上而下的行序，便于与鼠标/Canvas 坐标一致。 */
function flipRowsInPlace(pixels: Uint8Array, width: number, height: number): void {
  const rowBytes = width * 4;
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const top = y * rowBytes;
    const bottom = (height - 1 - y) * rowBytes;
    tmp.set(pixels.subarray(top, top + rowBytes));
    pixels.copyWithin(top, bottom, bottom + rowBytes);
    pixels.set(tmp, bottom);
  }
}
