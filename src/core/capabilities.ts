import * as THREE from 'three';

/**
 * 设备能力与“实际生效”的深度格式探测。
 *
 * 重要性：three.js 的 `reversedDepthBuffer` 依赖 WebGL2 的 EXT_clip_control。
 * 而反向深度能否带来收益，取决于底层深度附件到底是定点（每码点等间距）
 * 还是浮点（越远 d 越小、ulp 越小）——很多驱动会把 DEPTH_COMPONENT24
 * 直接实现成 32F，所以这里全部实测，不做假设。
 */

export type DepthFormatKey = 'u16' | 'u24' | 'f32';

export interface DepthFormatProbe {
  key: DepthFormatKey;
  label: string;
  /** 该内部格式能否作为深度附件 */
  attachable: boolean;
  /** 实测存储行为：写入已知值后读回，判断落在哪种量化网格上 */
  storage: 'fixed16' | 'fixed24' | 'f32' | 'unknown';
  /** 读回值与写入值的差（用于展示） */
  readback: number | null;
}

export interface Capabilities {
  webglVersion: string;
  vendor: string;
  gpu: string;
  maxTextureSize: number;
  maxSamples: number;
  extClipControl: boolean;
  reversedDepthBufferActive: boolean;
  floatColorBuffer: boolean;
  floatLinearFiltering: boolean;
  formats: DepthFormatProbe[];
  /** 结论：当前可用的定点格式是否真的被驱动实现成定点 */
  trueFixedPointAvailable: boolean;
}

/**
 * 重置 three.js 的 GL 状态缓存，并恢复反向深度。
 *
 * 我们的探测会直接 bind 原始 FBO，必须 resetState() 让 three 的状态缓存失效；
 * 但 WebGLState.reset() 会把深度反转标记清回 false，而相机投影仍按反向深度构建——
 * 不恢复的话，从这一帧开始画面就会整体退化。three.js 只在初始化时设置一次，
 * 所以任何我们自己调 resetState 的地方都要走这个包装。
 */
export function restoreRendererState(renderer: THREE.WebGLRenderer): void {
  renderer.resetState();
  if (renderer.capabilities.reversedDepthBuffer) {
    const depth = renderer.state.buffers.depth as unknown as {
      setReversed: (v: boolean) => void;
      setClear: (v: number) => void;
      setFunc?: (f: number) => void;
    };
    // resetState() 会把深度反转关掉、并把清深度的值恢复成 1。
    // 反向模式下清深度必须是 0，否则所有像素都通不过 GREATER 测试（整屏黑）。
    depth.setReversed(true);
    depth.setClear(1);
    depth.setFunc?.(THREE.LessEqualDepth);
  }
}

interface DebugRendererInfo {
  UNMASKED_VENDOR_WEBGL: number;
  UNMASKED_RENDERER_WEBGL: number;
}

export const INTERNAL_FORMATS: { key: DepthFormatKey; label: string; internal: number; bytes: 16 | 24 | 32 }[] = [
  { key: 'u16', label: '16 位定点', internal: 0x81a5 /* DEPTH_COMPONENT16 */, bytes: 16 },
  { key: 'u24', label: '24 位定点', internal: 0x81a6 /* DEPTH_COMPONENT24 */, bytes: 24 },
  { key: 'f32', label: '32F 浮点', internal: 0x8cac /* DEPTH_COMPONENT32F */, bytes: 32 },
];

/**
 * 探测用的写入值：刻意落在 24 位网格半格处，远离 24 位与 16 位码点。
 * 这样 24 位定点（回到网格点）、32F（保留 fround）与 16 位（粗网格）三者互不混淆。
 */
const PROBE_DEPTH = (Math.round(0.1234567 * (2 ** 24 - 1)) + 0.5) / (2 ** 24 - 1);

const PROBE_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PROBE_WRITE_FRAGMENT = `#version 300 es
precision highp float;
uniform float uDepth;
out vec4 o;
void main() { gl_FragDepth = uDepth; o = vec4(1.0); }`;

const PROBE_READ_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D uDepthTex;
out vec4 o;
void main() { o = vec4(texelFetch(uDepthTex, ivec2(4, 4), 0).r, 0.0, 0.0, 1.0); }`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'shader 编译失败');
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'program 链接失败');
  }
  return program;
}

function quantizeTo(value: number, bits: number): number {
  const max = Math.pow(2, bits) - 1;
  return Math.fround(Math.round(value * max) / max);
}

/**
 * 用 gl_FragDepth 写入已知值、再采样读回，判断真实存储量化网格。
 * 完全绕开 three.js；结束后把 GL 状态复原交给 renderer.resetState()。
 */
export function probeFormat(gl: WebGL2RenderingContext, internal: number, bits: 16 | 24 | 32): {
  attachable: boolean;
  storage: DepthFormatProbe['storage'];
  readback: number | null;
} {
  const size = 8;
  // 记录并恢复视口：three.js 自己缓存了 viewport，直接在 GL 层改而不复原，
  // 会让缓存与实际不一致——之后的渲染全被限制在这 8×8 的角上（表现为整屏黑）。
  const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const depthFbo = gl.createFramebuffer();
  const colorFbo = gl.createFramebuffer();
  const colorTex = gl.createTexture();
  const depthTex = gl.createTexture();
  if (!depthFbo || !colorFbo || !colorTex || !depthTex) {
    return { attachable: false, storage: 'unknown', readback: null };
  }
  try {
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, depthFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return { attachable: false, storage: 'unknown', readback: null };
    }

    const writeProgram = link(gl, PROBE_VERTEX, PROBE_WRITE_FRAGMENT);
    gl.useProgram(writeProgram);
    gl.viewport(0, 0, size, size);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(gl.getUniformLocation(writeProgram, 'uDepth'), PROBE_DEPTH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.DEPTH_TEST);

    // 采样 pass 用独立 FBO，避免深度纹理同时作为当前附件造成反馈回路。
    const readColorTex = gl.createTexture();
    if (!readColorTex) return { attachable: true, storage: 'unknown', readback: null };
    gl.bindTexture(gl.TEXTURE_2D, readColorTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, size, size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, colorFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, readColorTex, 0);

    const readProgram = link(gl, PROBE_VERTEX, PROBE_READ_FRAGMENT);
    gl.useProgram(readProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.uniform1i(gl.getUniformLocation(readProgram, 'uDepthTex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const px = new Float32Array(4);
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.deleteTexture(readColorTex);
    gl.deleteProgram(writeProgram);
    gl.deleteProgram(readProgram);

    const readback = px[0];
    if (!Number.isFinite(readback) || readback <= 0) {
      return { attachable: true, storage: 'unknown', readback };
    }
    const storage: DepthFormatProbe['storage'] =
      readback === Math.fround(PROBE_DEPTH)
        ? 'f32'
        : readback === quantizeTo(PROBE_DEPTH, 24)
          ? 'fixed24'
          : readback === quantizeTo(PROBE_DEPTH, 16)
            ? 'fixed16'
            : 'unknown';
    void bits;
    return { attachable: true, storage, readback };
  } catch {
    return { attachable: false, storage: 'unknown', readback: null };
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);
    gl.deleteFramebuffer(depthFbo);
    gl.deleteFramebuffer(colorFbo);
    gl.deleteTexture(depthTex);
    gl.deleteTexture(colorTex);
  }
}

const INTERNAL_BY_KIND: Record<'u16' | 'u24' | 'f32', number> = {
  u16: 0x81a5,
  u24: 0x81a6,
  f32: 0x8cac,
};

export interface StorageProbe {
  internalFormat: number | null;
  storage: DepthFormatProbe['storage'];
  readback: number | null;
}

/**
 * 实测某种深度附件类型的真实量化行为。
 * 之所以要按“用户选择的类型”分别探测：驱动可能把 24 位实现成 32F，
 * 那么反向深度的收益判断就完全不同。
 */
export function probeStorageFor(
  renderer: THREE.WebGLRenderer,
  kind: 'u16' | 'u24' | 'f32',
): StorageProbe {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const internal = INTERNAL_BY_KIND[kind];
  const result = probeFormat(gl, internal, kind === 'u16' ? 16 : kind === 'u24' ? 24 : 32);
  restoreRendererState(renderer);
  return {
    internalFormat: internal,
    storage: result.attachable ? result.storage : 'unknown',
    readback: result.readback,
  };
}

export function readCapabilities(renderer: THREE.WebGLRenderer): Capabilities {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const debug = gl.getExtension('WEBGL_debug_renderer_info') as DebugRendererInfo | null;
  const extensions = renderer.extensions;

  gl.getExtension('EXT_color_buffer_float');
  const formats: DepthFormatProbe[] = INTERNAL_FORMATS.map((spec) => {
    const probe = probeFormat(gl, spec.internal, spec.bytes);
    return { key: spec.key, label: spec.label, ...probe };
  });

  // 探测直接 bind 了原始 FBO，重置状态缓存并恢复反向深度。
  restoreRendererState(renderer);

  return {
    webglVersion: String(gl.getParameter(gl.VERSION)),
    vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
    gpu: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
    extClipControl: extensions.has('EXT_clip_control'),
    reversedDepthBufferActive: renderer.capabilities.reversedDepthBuffer,
    floatColorBuffer: extensions.has('EXT_color_buffer_float'),
    floatLinearFiltering: extensions.has('OES_texture_float_linear'),
    formats,
    trueFixedPointAvailable: formats.some(
      (f) => f.attachable && (f.storage === 'fixed16' || f.storage === 'fixed24'),
    ),
  };
}

export interface DepthAttachmentInfo {
  componentType: number | null;
  depthSize: number | null;
  label: string;
}

/** 读取某个 RenderTarget 深度附件的真实分量类型与位数。 */
export function readDepthAttachment(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
): DepthAttachmentInfo {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const props = renderer.properties.get(target) as { __webglFramebuffer?: WebGLFramebuffer };
  const framebuffer = props.__webglFramebuffer;
  if (!framebuffer) return { componentType: null, depthSize: null, label: '尚未分配' };
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  let componentType: number | null = null;
  let depthSize: number | null = null;
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    componentType = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE,
    ) as number;
    depthSize = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE,
    ) as number;
  } catch {
    /* 某些驱动对 depth-only 附件查询会抛错 */
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  }
  restoreRendererState(renderer);

  let label = '未知';
  if (componentType === gl.FLOAT || depthSize === 32) label = '32F 浮点深度';
  else if (componentType === gl.UNSIGNED_SHORT || depthSize === 16) label = '16 位定点深度';
  else if (componentType === gl.UNSIGNED_INT || depthSize === 24) label = '24 位定点深度';
  return { componentType, depthSize, label };
}
