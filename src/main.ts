import {
  Mat4,
  Vec2,
  Vec3,
  invertMat4,
  mat4LookAt,
  mat4Mul,
  mat4Perspective,
  ndcToRay,
  orbitEye,
  orbitUp,
  rayPlaneY0,
  transformVec4,
} from './math3d';
import {
  BOARD_D,
  BOARD_W,
  ClippedGeometry,
  Diagonal,
  cellOfUV,
  buildClippedGeometry,
  buildCorners,
  makeCheckerCanvas,
  worldToBoardUV,
} from './board';
import { RenderView } from './glview';
import { CameraState, makeViewProj, runSelfTest, TestHarness } from './selftest';

interface Preset {
  name: string;
  desc: string;
  state: CameraState;
  sample: Vec2 | null;
}

const PRESETS: Preset[] = [
  {
    name: '组 1 · 平行正对',
    desc: '板面平行镜头，两套规则应完全对得上',
    state: {
      azimuthDeg: 0, elevationDeg: 90, distance: 14,
      fovDeg: 45, near: 0.3, far: 120, diagonal: 'A',
    },
    sample: [0.5, 0.5],
  },
  {
    name: '组 2 · 强透视斜放',
    desc: '远近拉伸明显，仿射结果沿对角线拐折',
    state: {
      azimuthDeg: -32, elevationDeg: 22, distance: 12,
      fovDeg: 55, near: 0.3, far: 120, diagonal: 'A',
    },
    sample: [0.72, 0.35],
  },
  {
    name: '组 3 · 近裁面切入',
    desc: '板子一角伸到相机后方，只保留截进来的部分',
    state: {
      azimuthDeg: 18, elevationDeg: 7, distance: 6.5,
      fovDeg: 60, near: 4.2, far: 120, diagonal: 'A',
    },
    sample: [0.5, 0.62],
  },
];

interface SampleInfo {
  uv: Vec2; // 板上真实纹理位置
  onScreen: boolean;
  ndc: Vec2 | null;
  per: { valid: boolean; uv: Vec2 } | null;
  aff: { valid: boolean; uv: Vec2 } | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

class App implements TestHarness {
  private glCanvas: HTMLCanvasElement;
  private glCanvas2: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private overlay2: HTMLCanvasElement;
  private thumb: HTMLCanvasElement;
  private checker: HTMLCanvasElement;
  private viewPer!: RenderView;
  private viewAff!: RenderView;
  private corners = buildCorners();
  private state: CameraState;
  private activePreset = 0;
  private sample: Vec2 | null;
  private lastGeom: ClippedGeometry | null = null;
  private lastVP: Mat4 | null = null;
  private sliderEls: Record<string, HTMLInputElement> = {};

  constructor() {
    // 支持 ?preset=0|1|2 与 ?diag=A|B，便于无头截图与固定分享视角
    const params = new URLSearchParams(location.search);
    const presetIdx = Math.min(
      2,
      Math.max(0, parseInt(params.get('preset') ?? '0', 10) || 0)
    );
    this.activePreset = presetIdx;
    const preset = PRESETS[presetIdx];
    this.state = { ...preset.state };
    if (params.get('diag') === 'B') this.state.diagonal = 'B';
    this.sample = preset.sample ? ([...preset.sample] as Vec2) : null;

    this.glCanvas = $('glcanvas');
    this.glCanvas2 = $('glcanvas2');
    this.overlay = $('overlay');
    this.overlay2 = $('overlay2');
    this.thumb = $('thumb');
    this.checker = makeCheckerCanvas();

    this.viewPer = new RenderView(this.glCanvas, this.checker);
    this.viewAff = new RenderView(this.glCanvas2, this.checker);

    this.bindSliders();
    this.bindButtons();
    this.bindPicking();
    this.bindPresets();

    new ResizeObserver(() => this.render()).observe(this.glCanvas.parentElement!);
    new ResizeObserver(() => this.render()).observe(this.glCanvas2.parentElement!);

    if (!this.viewPer.supportsFloatReadback() || !this.viewAff.supportsFloatReadback()) {
      $('testResults').innerHTML =
        '<div class="t-fail">当前环境不支持 RGBA16F 渲染目标，UV 读回降级为 8bit，自检精度会下降。</div>';
    }
    this.applyStateToUI();
    this.render();
  }

  // ---- TestHarness ---------------------------------------------------------
  setCamera(s: CameraState) {
    this.state = { ...s };
  }
  viewPerspective() { return this.viewPer; }
  viewAffine() { return this.viewAff; }
  viewProj() { return this.lastVP!; }
  aspect() {
    const [w, h] = this.viewPer.deviceSize;
    return w / h;
  }
  render(): ClippedGeometry {
    const aspect = this.aspect();
    const vp = makeViewProj(this.state, aspect);
    this.lastVP = vp;
    const geom = buildClippedGeometry(vp, this.corners, this.state.diagonal);
    this.lastGeom = geom;
    this.viewPer.render(geom, false);
    this.viewAff.render(geom, true);
    this.updateOverlaysAndReadout(vp);
    return geom;
  }

  // ---- UI 绑定 -------------------------------------------------------------
  private bindSliders() {
    const defs: [string, keyof CameraState][] = [
      ['azimuth', 'azimuthDeg'],
      ['elevation', 'elevationDeg'],
      ['distance', 'distance'],
      ['fov', 'fovDeg'],
      ['near', 'near'],
      ['far', 'far'],
    ];
    for (const [id, key] of defs) {
      const el = $(id) as HTMLInputElement;
      this.sliderEls[id] = el;
      el.addEventListener('input', () => {
        this.state[key] = parseFloat(el.value) as never;
        this.render();
      });
    }
  }

  private bindButtons() {
    $('diagA').addEventListener('click', () => this.setDiagonal('A'));
    $('diagB').addEventListener('click', () => this.setDiagonal('B'));
    $('saveBtn').addEventListener('click', () => this.saveSideBySide());
    $('testBtn').addEventListener('click', () => {
      const saved = { ...this.state };
      const savedSample = this.sample;
      const result = runSelfTest(this);
      $('testResults').innerHTML = result.html;
      // 自检会改动相机，恢复用户视角与取样点
      this.state = saved;
      this.sample = savedSample;
      this.applyStateToUI();
      this.render();
    });
  }

  private bindPresets() {
    const row = $('presetRow');
    PRESETS.forEach((p, i) => {
      const btn = document.createElement('button');
      btn.innerHTML = `<b>${p.name}</b><small>${p.desc}</small>`;
      btn.addEventListener('click', () => {
        this.activePreset = i;
        this.state = { ...p.state };
        this.sample = p.sample ? ([...p.sample] as Vec2) : null;
        this.applyStateToUI();
        this.render();
        this.updatePresetButtons();
      });
      row.appendChild(btn);
    });
    this.updatePresetButtons();
  }

  private updatePresetButtons() {
    [...$('presetRow').children].forEach((el, i) =>
      el.classList.toggle('active', i === this.activePreset)
    );
    $('diagA').classList.toggle('active', this.state.diagonal === 'A');
    $('diagB').classList.toggle('active', this.state.diagonal === 'B');
  }

  private setDiagonal(d: Diagonal) {
    this.state.diagonal = d;
    this.updatePresetButtons();
    this.render();
  }

  private applyStateToUI() {
    const s = this.state;
    this.sliderEls.azimuth.value = String(s.azimuthDeg);
    this.sliderEls.elevation.value = String(s.elevationDeg);
    this.sliderEls.distance.value = String(s.distance);
    this.sliderEls.fov.value = String(s.fovDeg);
    this.sliderEls.near.value = String(s.near);
    this.sliderEls.far.value = String(s.far);
    $('azimuthVal').textContent = `${s.azimuthDeg.toFixed(1)}°`;
    $('elevationVal').textContent = `${s.elevationDeg.toFixed(1)}°`;
    $('distanceVal').textContent = s.distance.toFixed(1);
    $('fovVal').textContent = `${s.fovDeg.toFixed(0)}°`;
    $('nearVal').textContent = s.near.toFixed(2);
    $('farVal').textContent = s.far.toFixed(0);
    this.updatePresetButtons();
  }

  // ---- 点选 ----------------------------------------------------------------
  private bindPicking() {
    for (const canvas of [this.glCanvas, this.glCanvas2]) {
      let downX = 0;
      let downY = 0;
      canvas.addEventListener('pointerdown', (e) => {
        downX = e.clientX;
        downY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (e.buttons !== 1) return;
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        downX = e.clientX;
        downY = e.clientY;
        this.state.azimuthDeg += dx * 0.4;
        if (this.state.azimuthDeg > 180) this.state.azimuthDeg -= 360;
        if (this.state.azimuthDeg < -180) this.state.azimuthDeg += 360;
        this.state.elevationDeg = Math.min(
          90,
          Math.max(3, this.state.elevationDeg - dy * 0.3)
        );
        this.applyStateToUI();
        this.render();
      });
      canvas.addEventListener('pointerup', (e) => {
        // 位移足够小视为点击取样
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) return;
        this.handleClick(canvas, e);
      });
    }
  }

  private handleClick(canvas: HTMLCanvasElement, e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const ndcX = (cssX / rect.width) * 2 - 1;
    const ndcY = 1 - (cssY / rect.height) * 2;

    const inv = invertMat4(this.lastVP!);
    const ray = ndcToRay(inv, ndcX, ndcY);
    const hit = rayPlaneY0(ray.origin, ray.dir);
    let uv: Vec2 | null = null;
    if (hit) uv = worldToBoardUV(hit);

    // 再以 GPU 读回兜底：射线打在板的包围范围但该处已被裁掉，也算无取样
    if (uv) {
      const [w, h] = this.viewPer.deviceSize;
      const dx = (cssX / rect.width) * w;
      const dy = (cssY / rect.height) * h;
      if (!this.viewPer.readUV(dx, dy).valid) uv = null;
    }
    this.sample = uv;
    this.render();
  }

  // ---- 覆盖层、读数、缩略图 -------------------------------------------------
  private sampleInfo(vp: Mat4): SampleInfo | null {
    if (!this.sample) return null;
    const [u, v] = this.sample;
    const world: Vec3 = [u * BOARD_W - BOARD_W / 2, 0, v * BOARD_D - BOARD_D / 2];
    const c = transformVec4(vp, world[0], world[1], world[2]);
    const info: SampleInfo = {
      uv: [u, v],
      onScreen: false,
      ndc: null,
      per: null,
      aff: null,
    };
    if (c[3] > 1e-6) {
      const nx = c[0] / c[3];
      const ny = c[1] / c[3];
      info.ndc = [nx, ny];
      info.onScreen = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
      if (info.onScreen) {
        const [w, h] = this.viewPer.deviceSize;
        const dx = (nx * 0.5 + 0.5) * w;
        const dy = (0.5 - ny * 0.5) * h;
        const r1 = this.viewPer.readUV(dx, dy);
        const r2 = this.viewAff.readUV(dx, dy);
        info.per = { valid: r1.valid, uv: r1.uv };
        info.aff = { valid: r2.valid, uv: r2.uv };
      }
    }
    return info;
  }

  private drawCrosshair(ov: HTMLCanvasElement, info: SampleInfo) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = ov.clientWidth * dpr;
    const h = ov.clientHeight * dpr;
    if (ov.width !== Math.round(w) || ov.height !== Math.round(h)) {
      ov.width = Math.round(w);
      ov.height = Math.round(h);
    }
    const ctx = ov.getContext('2d')!;
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!info.onScreen || !info.ndc) return;
    const x = (info.ndc[0] * 0.5 + 0.5) * ov.width;
    const y = (0.5 - info.ndc[1] * 0.5) * ov.height;

    const ring = (color: string, r: number) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    ring('#4ade80', 11);
    ring('#fb923c', 7);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y);
    ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16);
    ctx.stroke();

    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 3;
    const label = `取样 (${info.ndc[0].toFixed(3)}, ${info.ndc[1].toFixed(3)})`;
    ctx.strokeText(label, x + 14, y - 12);
    ctx.fillText(label, x + 14, y - 12);
  }

  private updateOverlaysAndReadout(vp: Mat4) {
    const info = this.sampleInfo(vp);
    if (info) {
      this.drawCrosshair(this.overlay, info);
      this.drawCrosshair(this.overlay2, info);
    } else {
      for (const ov of [this.overlay, this.overlay2]) {
        const ctx = ov.getContext('2d')!;
        ctx.clearRect(0, 0, ov.width, ov.height);
      }
    }
    this.updateReadout(info);
    this.updateThumbnail(info);
  }

  private updateReadout(info: SampleInfo | null) {
    const el = $('readout');
    if (!info) {
      el.innerHTML = '<span class="none">无取样</span>\n鼠标点在板外或背景上，两套通道都没有使用任何纹理位置。';
      return;
    }
    const [u, v] = info.uv;
    const cell = cellOfUV(info.uv);
    const id = cell.row * 10 + cell.col;
    const fmt = (q: { valid: boolean; uv: Vec2 } | null) =>
      q ? (q.valid ? `(${q.uv[0].toFixed(4)}, ${q.uv[1].toFixed(4)})` : '该像素已被裁掉')
        : '画面外';
    const lines: string[] = [];
    lines.push(`板上真实纹理位置 u,v = (${u.toFixed(4)}, ${v.toFixed(4)})`);
    lines.push(`所在棋格 #${id}（列 ${cell.col}，行 ${cell.row}）`);
    if (info.onScreen && info.ndc) {
      lines.push(`屏幕取样点 NDC = (${info.ndc[0].toFixed(3)}, ${info.ndc[1].toFixed(3)})`);
      lines.push(`<span class="g">① 透视通道实际 uv = ${fmt(info.per)}</span>`);
      lines.push(`<span class="o">② 仿射通道实际 uv = ${fmt(info.aff)}</span>`);
      if (info.per?.valid && info.aff?.valid) {
        const du = info.aff.uv[0] - info.per.uv[0];
        const dv = info.aff.uv[1] - info.per.uv[1];
        lines.push(`两通道偏差 Δuv = (${du >= 0 ? '+' : ''}${du.toFixed(4)}, ${dv >= 0 ? '+' : ''}${dv.toFixed(4)})`);
      }
    } else {
      lines.push('<span class="none">该取样点当前在画面外或位于相机后方</span>');
    }
    el.innerHTML = lines.join('\n');
  }

  private updateThumbnail(info: SampleInfo | null) {
    const ctx = this.thumb.getContext('2d')!;
    ctx.clearRect(0, 0, this.thumb.width, this.thumb.height);
    ctx.drawImage(this.checker, 0, 0, this.thumb.width, this.thumb.height);

    const marker = (uv: Vec2 | null, color: string, r: number) => {
      if (!uv) return;
      const x = uv[0] * this.thumb.width;
      const y = uv[1] * this.thumb.height;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    if (info) {
      // 白色十字标出板上真实位置；绿/橙圈标出两通道真正读到的位置
      const tx = info.uv[0] * this.thumb.width;
      const ty = info.uv[1] * this.thumb.height;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx - 8, ty); ctx.lineTo(tx + 8, ty);
      ctx.moveTo(tx, ty - 8); ctx.lineTo(tx, ty + 8);
      ctx.stroke();
      marker(info.per?.valid ? info.per.uv : null, '#4ade80', 9);
      marker(info.aff?.valid ? info.aff.uv : null, '#fb923c', 6);
    }
  }

  // ---- 导出并排图 -----------------------------------------------------------
  private saveSideBySide() {
    const [w1, h1] = this.viewPer.deviceSize;
    const [w2, h2] = this.viewAff.deviceSize;
    const W = w1 + w2;
    const H = Math.max(h1, h2) + 90;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, W, H);

    ctx.drawImage(this.glCanvas, 0, 90, w1, h1);
    ctx.drawImage(this.glCanvas2, w1, 90, w2, h2);
    ctx.drawImage(this.overlay, 0, 90, w1, h1);
    ctx.drawImage(this.overlay2, w1, 90, w2, h2);

    ctx.fillStyle = '#e6e9ef';
    ctx.font = 'bold 26px sans-serif';
    const preset = PRESETS[this.activePreset];
    ctx.fillText(`${preset.name} · 对角线 ${this.state.diagonal}`, 16, 38);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#4ade80';
    ctx.fillText('① 透视校正插值', 16, 74);
    ctx.fillStyle = '#fb923c';
    ctx.fillText('② 屏幕直接插值', w1 + 16, 74);

    if (this.sample) {
      const info = this.sampleInfo(this.lastVP!);
      ctx.font = '18px ui-monospace, monospace';
      ctx.fillStyle = '#9aa4b2';
      const txt = info?.onScreen
        ? `板上 uv=(${this.sample[0].toFixed(3)},${this.sample[1].toFixed(3)})  NDC=(${info.ndc![0].toFixed(3)},${info.ndc![1].toFixed(3)})`
        : `板上 uv=(${this.sample[0].toFixed(3)},${this.sample[1].toFixed(3)})  当前在画面外`;
      ctx.fillText(txt, W - ctx.measureText(txt).width - 16, 38);
    }

    const a = document.createElement('a');
    a.download = `${preset.name.replace(/[^\p{L}\p{N}]+/gu, '_')}_diag${this.state.diagonal}_${Date.now()}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
  }
}

new App();
