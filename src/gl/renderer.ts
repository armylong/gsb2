import {
  MOUNTAIN_ALBEDO,
  RIDGES,
  type GpuReadout,
  type SceneParams,
  type Vec3,
} from '../scene/config';
import { exposureScale, sunDirection, DEG } from '../scene/math';
import {
  fullscreenVertexShader,
  sceneFragmentShader,
  tonemapFragmentShader,
} from './shaders';

export interface RenderParams extends SceneParams {
  viewMode?: 0 | 1 | 2;
}

export interface MainRenderResult {
  autoExposureEv: number | null;
  averageLuminance: number | null;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

const COMMON_UNIFORM_NAMES = [
  'uResolution',
  'uSunDir',
  'uProbeDir',
  'uProbeEnabled',
  'uYaw',
  'uPitch',
  'uCameraHeight',
  'uTurbidity',
  'uRayleighOn',
  'uMieOn',
  'uExposure',
  'uViewMode',
  'uMountainAlbedo',
  'uRidgeRadius[0]',
  'uRidgeBase[0]',
  'uRidgeAmp[0]',
  'uRidgeSeed[0]',
] as const;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '未知 shader 编译错误';
    gl.deleteShader(shader);
    throw new Error(`${log}\n\n${withLineNumbers(source)}`);
  }
  return shader;
}

function withLineNumbers(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '未知 program 链接错误';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function getUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): UniformMap {
  const map: UniformMap = {};
  for (const name of COMMON_UNIFORM_NAMES) {
    map[name] = gl.getUniformLocation(program, name);
  }
  map.uTexture = gl.getUniformLocation(program, 'uTexture');
  return map;
}

function createQuadVao(gl: WebGL2RenderingContext, program: WebGLProgram): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('无法创建 VAO');
  gl.bindVertexArray(vao);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]),
    gl.STATIC_DRAW,
  );

  const location = gl.getAttribLocation(program, 'aPosition');
  if (location >= 0) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
  return vao;
}

function setCommonUniforms(
  gl: WebGL2RenderingContext,
  uniforms: UniformMap,
  params: RenderParams,
  width: number,
  height: number,
  probeDirection: Vec3 | null,
): void {
  const sun = sunDirection(params);
  gl.uniform2f(uniforms.uResolution, width, height);
  gl.uniform3f(uniforms.uSunDir, sun[0], sun[1], sun[2]);
  if (probeDirection) {
    gl.uniform3f(uniforms.uProbeDir, probeDirection[0], probeDirection[1], probeDirection[2]);
    gl.uniform1i(uniforms.uProbeEnabled, 1);
  } else {
    gl.uniform3f(uniforms.uProbeDir, 0, 1, 0);
    gl.uniform1i(uniforms.uProbeEnabled, 0);
  }
  gl.uniform1f(uniforms.uYaw, params.yawDeg * DEG);
  gl.uniform1f(uniforms.uPitch, params.viewPitchDeg * DEG);
  gl.uniform1f(uniforms.uCameraHeight, params.cameraHeightKm);
  gl.uniform1f(uniforms.uTurbidity, params.turbidity);
  gl.uniform1f(uniforms.uRayleighOn, params.rayleighEnabled ? 1 : 0);
  gl.uniform1f(uniforms.uMieOn, params.mieEnabled ? 1 : 0);
  gl.uniform1f(uniforms.uExposure, exposureScale(params.exposureEv));
  gl.uniform1i(uniforms.uViewMode, params.viewMode ?? 0);
  gl.uniform3f(
    uniforms.uMountainAlbedo,
    MOUNTAIN_ALBEDO[0],
    MOUNTAIN_ALBEDO[1],
    MOUNTAIN_ALBEDO[2],
  );
  gl.uniform1fv(
    uniforms['uRidgeRadius[0]'],
    new Float32Array(RIDGES.map((ridge) => ridge.radiusKm)),
  );
  gl.uniform1fv(
    uniforms['uRidgeBase[0]'],
    new Float32Array(RIDGES.map((ridge) => ridge.baseKm)),
  );
  gl.uniform1fv(
    uniforms['uRidgeAmp[0]'],
    new Float32Array(RIDGES.map((ridge) => ridge.amplitudeKm)),
  );
  gl.uniform1fv(
    uniforms['uRidgeSeed[0]'],
    new Float32Array(RIDGES.map((ridge) => ridge.seed)),
  );
}

export class ComponentRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: UniformMap;
  private readonly vao: WebGLVertexArrayObject;
  private readonly viewMode: 1 | 2;

  constructor(canvas: HTMLCanvasElement, viewMode: 1 | 2) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器或设备未启用 WebGL2。');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('缺少 EXT_color_buffer_float 支持，无法读取 HDR 测点。');
    }
    this.viewMode = viewMode;
    this.program = createProgram(gl, fullscreenVertexShader, sceneFragmentShader(false));
    this.uniforms = getUniforms(gl, this.program);
    this.vao = createQuadVao(gl, this.program);
  }

  resize(maxDpr = 1.5): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  render(params: SceneParams): void {
    this.resize();
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    setCommonUniforms(
      gl,
      this.uniforms,
      { ...params, viewMode: this.viewMode },
      canvas.width,
      canvas.height,
      null,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}

interface FloatTarget {
  framebuffer: WebGLFramebuffer;
  textures: WebGLTexture[];
  width: number;
  height: number;
}

function createFloatTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  attachmentCount: number,
): FloatTarget {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('无法创建帧缓冲');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

  const textures: WebGLTexture[] = [];
  const drawBuffers: number[] = [];

  for (let i = 0; i < attachmentCount; i += 1) {
    const texture = gl.createTexture();
    if (!texture) throw new Error('无法创建浮点纹理');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      width,
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0 + i,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    textures.push(texture);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
  }

  gl.drawBuffers(drawBuffers);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`浮点帧缓冲不完整: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, textures, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, target: FloatTarget): void {
  for (const texture of target.textures) gl.deleteTexture(texture);
  gl.deleteFramebuffer(target.framebuffer);
}

const ATTACHMENT_COUNT = 6;
const AUTO_WIDTH = 48;
const AUTO_HEIGHT = 27;

export class MainRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly dataProgram: WebGLProgram;
  private readonly tonemapProgram: WebGLProgram;
  private readonly dataUniforms: UniformMap;
  private readonly tonemapUniforms: UniformMap;
  private readonly vao: WebGLVertexArrayObject;
  private mainTarget: FloatTarget;
  private probeTarget: FloatTarget;
  private autoTarget: FloatTarget;
  private readonly pixelBuffer = new Float32Array(4);
  private readonly autoBuffer = new Float32Array(AUTO_WIDTH * AUTO_HEIGHT * 4);

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器或设备未启用 WebGL2。');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('当前 WebGL2 环境缺少 EXT_color_buffer_float，无法保存 HDR 读数。');
    }

    this.dataProgram = createProgram(gl, fullscreenVertexShader, sceneFragmentShader(true));
    this.dataUniforms = getUniforms(gl, this.dataProgram);
    this.tonemapProgram = createProgram(gl, fullscreenVertexShader, tonemapFragmentShader);
    this.tonemapUniforms = getUniforms(gl, this.tonemapProgram);
    this.vao = createQuadVao(gl, this.dataProgram);

    const width = Math.max(1, canvas.width || 2);
    const height = Math.max(1, canvas.height || 2);
    this.mainTarget = createFloatTarget(gl, width, height, ATTACHMENT_COUNT);
    this.probeTarget = createFloatTarget(gl, 1, 1, ATTACHMENT_COUNT);
    this.autoTarget = createFloatTarget(gl, AUTO_WIDTH, AUTO_HEIGHT, 1);
  }

  resize(maxDpr = 1.75): void {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return;

    this.canvas.width = width;
    this.canvas.height = height;
    deleteTarget(this.gl, this.mainTarget);
    this.mainTarget = createFloatTarget(this.gl, width, height, ATTACHMENT_COUNT);
  }

  private renderDataTarget(
    target: FloatTarget,
    params: RenderParams,
    probeDirection: Vec3 | null,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(this.dataProgram);
    gl.bindVertexArray(this.vao);
    setCommonUniforms(
      gl,
      this.dataUniforms,
      params,
      target.width,
      target.height,
      probeDirection,
    );
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      gl.COLOR_ATTACHMENT2,
      gl.COLOR_ATTACHMENT3,
      gl.COLOR_ATTACHMENT4,
      gl.COLOR_ATTACHMENT5,
    ]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  render(params: SceneParams): MainRenderResult {
    this.resize();
    const gl = this.gl;
    this.renderDataTarget(this.mainTarget, params, null);

    let autoExposureEv: number | null = null;
    let averageLuminance: number | null = null;
    let exposureEv = params.exposureEv;

    if (params.autoExposure) {
      averageLuminance = this.readAverageLuminance();
      if (averageLuminance !== null && Number.isFinite(averageLuminance)) {
        // Geometric mean is robust to the very bright, small solar disk.
        autoExposureEv = Math.max(-7, Math.min(5, Math.log2(0.12 / averageLuminance)));
        exposureEv = autoExposureEv;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.tonemapProgram);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mainTarget.textures[0]);
    gl.uniform1i(this.tonemapUniforms.uTexture, 0);
    gl.uniform1f(this.tonemapUniforms.uExposure, exposureScale(exposureEv));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    return { autoExposureEv, averageLuminance };
  }

  private readAverageLuminance(): number | null {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.mainTarget.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.autoTarget.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.blitFramebuffer(
      0,
      0,
      this.mainTarget.width,
      this.mainTarget.height,
      0,
      0,
      AUTO_WIDTH,
      AUTO_HEIGHT,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.autoTarget.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    this.autoBuffer.fill(0);
    gl.readPixels(
      0,
      0,
      AUTO_WIDTH,
      AUTO_HEIGHT,
      gl.RGBA,
      gl.FLOAT,
      this.autoBuffer,
    );

    let sumLog = 0;
    let count = 0;
    for (let i = 0; i < this.autoBuffer.length; i += 4) {
      const luminance =
        0.2126 * this.autoBuffer[i] +
        0.7152 * this.autoBuffer[i + 1] +
        0.0722 * this.autoBuffer[i + 2];
      if (Number.isFinite(luminance) && luminance > 1e-5) {
        sumLog += Math.log(Math.max(luminance, 1e-5));
        count += 1;
      }
    }
    if (count < 8) return null;
    return Math.exp(sumLog / count);
  }

  private readAttachments(target: FloatTarget, x: number, y: number): GpuReadout {
    const gl = this.gl;
    const values: Vec3[] = [];
    let hitId = 0;
    let distanceKm = -1;

    // Bind both halves explicitly. Some WebGL2 drivers/readback paths behave
    // badly when READ_FRAMEBUFFER is an FBO but DRAW_FRAMEBUFFER is still the
    // default canvas after the tonemap pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);

    for (let attachment = 0; attachment < ATTACHMENT_COUNT; attachment += 1) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      this.pixelBuffer.fill(0);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, this.pixelBuffer);
      values.push([this.pixelBuffer[0], this.pixelBuffer[1], this.pixelBuffer[2]]);
      if (attachment === 1) hitId = Math.round(this.pixelBuffer[3]);
      if (attachment === 0) distanceKm = this.pixelBuffer[3];
    }

    if (hitId === 0) distanceKm = 0;
    return {
      total: values[0],
      rayleigh: values[1],
      mie: values[2],
      surface: values[3],
      transmittance: values[4],
      direct: values[5],
      hitId,
      distanceKm: hitId === 0 ? 0 : Math.max(0, distanceKm),
    };
  }

  /** NDC uses the same orientation as pointer events: y=+1 at the top. */
  readAtNdc(ndcX: number, ndcY: number): GpuReadout {
    const x = Math.max(
      0,
      Math.min(this.mainTarget.width - 1, Math.floor((ndcX * 0.5 + 0.5) * this.mainTarget.width)),
    );
    const y = Math.max(
      0,
      Math.min(this.mainTarget.height - 1, Math.floor((ndcY * 0.5 + 0.5) * this.mainTarget.height)),
    );
    return this.readAttachments(this.mainTarget, x, y);
  }

  probe(direction: Vec3, params: SceneParams): GpuReadout {
    this.renderDataTarget(this.probeTarget, params, direction);
    return this.readAttachments(this.probeTarget, 0, 0);
  }
}
