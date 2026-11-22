import { Program, RenderTarget, ID_SPEC, MASK_SPEC, pickColorSpec, type TexSpec } from './gl-utils';
import { DISPLAY_FRAG, SCENE_FRAG, TEMPORAL_FRAG } from './shaders';
import { roiPixels, type SimState } from '../scene/sim';

export interface BlendWeights {
  cur: number;
  hist: number;
}

export interface RegionStats {
  meanAbsLuma: number;   // mean |direct - temporal| luma, 0..255 scale
  maxAbsLuma: number;
  reuseFraction: number; // 0..1 fraction of effective history weight
}

/**
 * Owns the full frame pipeline:
 *   scene -> current(color,id) -> temporal reprojection -> ping-pong history
 *   -> three display viewports (direct / temporal / history-reuse map)
 */
export class Renderer {
  private gl: WebGL2RenderingContext;
  private sceneProg: Program;
  private temporalProg: Program;
  private displayProg: Program;
  private colorSpec: TexSpec;
  private cur: RenderTarget;          // [color, id]
  private histA: RenderTarget;        // [color, id, mask]
  private histB: RenderTarget;
  private src = 0;                     // which hist target is the newest history
  width = 0;
  height = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.colorSpec = pickColorSpec(gl);
    this.sceneProg = new Program(gl, SCENE_FRAG);
    this.temporalProg = new Program(gl, TEMPORAL_FRAG);
    this.displayProg = new Program(gl, DISPLAY_FRAG);

    this.width = 1;
    this.height = 1;
    this.cur = new RenderTarget(gl, 1, 1, [this.colorSpec, ID_SPEC]);
    this.histA = new RenderTarget(gl, 1, 1, [this.colorSpec, ID_SPEC, MASK_SPEC]);
    this.histB = new RenderTarget(gl, 1, 1, [this.colorSpec, ID_SPEC, MASK_SPEC]);
    this.invalidateHistory();
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.cur.resize(this.width, this.height);
    this.histA.resize(this.width, this.height);
    this.histB.resize(this.width, this.height);
    this.invalidateHistory();
  }

  /** Drop all cached history (cut / drag / resize / clip start). */
  invalidateHistory(): void {
    const gl = this.gl;
    // Real layer ids are 0.0 (bg), 0.5 (mid), 1.0 (fg). A sentinel of ~0.749
    // (byte 191) matches none, so the first temporal frame takes fresh pixels.
    this.src = 0;
    for (const t of [this.histA, this.histB]) {
      t.bind();
      gl.disable(gl.SCISSOR_TEST);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
      gl.clearBufferfv(gl.COLOR, 1, [191 / 255, 0, 0, 1]);
      gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 1]);
    }
  }

  private histIn(): RenderTarget {
    return this.src === 0 ? this.histA : this.histB;
  }
  private histOut(): RenderTarget {
    return this.src === 0 ? this.histB : this.histA;
  }

  render(s: SimState, blend: BlendWeights): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;

    // 1. Scene pass -> current target.
    this.cur.bind();
    this.sceneProg.use();
    gl.uniform2f(this.sceneProg.u('uResolution'), w, h);
    gl.uniform2f(this.sceneProg.u('uCam'), s.camX, s.camY);
    gl.uniform2f(this.sceneProg.u('uMidPos'), s.midX, s.midY);
    gl.uniform2f(this.sceneProg.u('uFgPos'), s.fgX, s.fgY);
    gl.uniform1f(this.sceneProg.u('uFgVisible'), s.fgVisible);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. Temporal reproject -> other history target.
    const inH = this.histIn();
    const outH = this.histOut();
    outH.bind();
    this.temporalProg.use();
    this.cur.bindTextures(0); // units 0,1
    inH.bindTextures(2);      // units 2,3,4
    gl.uniform1i(this.temporalProg.u('uCurColor'), 0);
    gl.uniform1i(this.temporalProg.u('uCurId'), 1);
    gl.uniform1i(this.temporalProg.u('uHistColor'), 2);
    gl.uniform1i(this.temporalProg.u('uHistId'), 3);
    gl.uniform2f(this.temporalProg.u('uResolution'), w, h);
    gl.uniform2f(
      this.temporalProg.u('uCamDelta'),
      s.camX - s.prevCamX,
      s.camY - s.prevCamY,
    );
    gl.uniform1f(this.temporalProg.u('uCurW'), blend.cur);
    gl.uniform1f(this.temporalProg.u('uHistW'), blend.hist);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.src = this.src === 0 ? 1 : 0;

    // 3. Three display viewports into the default framebuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const vw = Math.floor(w / 3);
    const roi = roiPixels(w, h);
    gl.disable(gl.SCISSOR_TEST);
    this.displayProg.use();
    gl.uniform2f(this.displayProg.u('uResolution'), vw, h);
    gl.uniform4f(
      this.displayProg.u('uROI'),
      roi.x, roi.y, roi.x + roi.w, roi.y + roi.h,
    );

    // Direct.
    gl.viewport(0, 0, vw, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cur.textures[0]);
    gl.uniform1i(this.displayProg.u('uTex'), 0);
    gl.uniform1i(this.displayProg.u('uHasScene'), 0);
    gl.uniform1i(this.displayProg.u('uMode'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Temporal composite.
    const newest = this.histIn();
    gl.viewport(vw, 0, vw, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, newest.textures[0]);
    gl.uniform1i(this.displayProg.u('uMode'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // History-reuse map (mask attachment of the newest history), tinted over
    // the current frame so layer structure remains visible.
    gl.viewport(2 * vw, 0, w - 2 * vw, h);
    gl.uniform2f(this.displayProg.u('uResolution'), w - 2 * vw, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, newest.textures[2]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cur.textures[0]);
    gl.uniform1i(this.displayProg.u('uTex'), 0);
    gl.uniform1i(this.displayProg.u('uSceneTex'), 1);
    gl.uniform1i(this.displayProg.u('uHasScene'), 1);
    gl.uniform1i(this.displayProg.u('uMode'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read the ROI back from either color attachment; returns 0..255 RGBA-ish data. */
  private readColor(target: RenderTarget, attachment: number): Uint8Array {
    const gl = this.gl;
    const roi = roiPixels(this.width, this.height);
    target.bind();
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
    const n = roi.w * roi.h * 4;
    const out = new Uint8Array(n);
    gl.readPixels(roi.x, roi.y, roi.w, roi.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  private readMask(): Uint8Array {
    const gl = this.gl;
    const roi = roiPixels(this.width, this.height);
    const newest = this.histIn();
    newest.bind();
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + 2);
    const rgba = new Uint8Array(roi.w * roi.h * 4);
    gl.readPixels(roi.x, roi.y, roi.w, roi.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const out = new Uint8Array(roi.w * roi.h);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
    return out;
  }

  /** ROI statistics comparing direct current frame vs temporal composite. */
  regionStats(): RegionStats {
    const direct = this.readColor(this.cur, 0);
    const temporal = this.readColor(this.histIn(), 0);
    const mask = this.readMask();
    const px = direct.length / 4;
    let sumAbs = 0;
    let maxAbs = 0;
    let reuse = 0;
    for (let i = 0; i < px; i++) {
      const j = i * 4;
      const dl = 0.2126 * direct[j] + 0.7152 * direct[j + 1] + 0.0722 * direct[j + 2];
      const tl = 0.2126 * temporal[j] + 0.7152 * temporal[j + 1] + 0.0722 * temporal[j + 2];
      const a = Math.abs(dl - tl);
      sumAbs += a;
      maxAbs = Math.max(maxAbs, a);
      reuse += mask[i] / 255;
    }
    return {
      meanAbsLuma: sumAbs / px,
      maxAbsLuma: maxAbs,
      reuseFraction: reuse / px,
    };
  }
}
