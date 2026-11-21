// 主控制器：两个对照窗共用相机与运动，编排渲染、观察点、放大查看与 HUD。
import { OrbitCamera } from './camera';
import { Renderer, queryCaps, makeGeneratedTexture, MANUAL_ANISO_MAX, MANUAL_ANISO_DEFAULT, type SampleMode, type DeviceCaps } from './gl';
import { probeAt, worldToCss, fmt, type ProbeReading } from './probe';
import { TEX_BASE, TEX_LEVELS, TILE_WORLD, texelWorldSize } from './texture';
import { v3 } from './gl-matrix';

interface Pane {
  section: HTMLElement;
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  hud: HTMLElement;
  crosshair: HTMLElement;
  magnifier: HTMLCanvasElement;
  select: HTMLSelectElement;
  // 观察点在本 pane 的 NDC 坐标（两个 pane 各自的 NDC 可能不同宽高比）
  probeNdc: [number, number] | null;
  reading: ProbeReading | null;
}

const MAX_DPR = 2;

class App {
  private camera = new OrbitCamera();
  private panes: Pane[] = [];
  private caps!: DeviceCaps;
  private dpr = 1;
  private paused = false;
  private magnifierOn = false;
  private magZoom = 8;
  private nudgePx = 0; // 已累积的偏移量，以"初始观察点物理像素"计
  private lastTime = 0;
  // 有硬件扩展时上限取设备值；无扩展时手动 shader 回退路径有自己的上限
  private adjustableCap = 1;
  private defaultAniso = 1;

  start(): void {
    const gen = makeGeneratedTexture();
    const probeCanvas = document.createElement('canvas');
    this.caps = queryCaps(probeCanvas);
    if (!this.caps.webgl2) {
      document.getElementById('device-info')!.textContent = '当前浏览器不支持 WebGL2，无法运行';
      return;
    }

    const sections = [document.getElementById('pane-left')!, document.getElementById('pane-right')!];
    this.adjustableCap = this.caps.anisoExt ? this.caps.anisoMax : MANUAL_ANISO_MAX;
    this.defaultAniso = this.caps.anisoExt ? this.caps.anisoMax : MANUAL_ANISO_DEFAULT;
    for (const section of sections) {
      const canvas = section.querySelector('canvas.gl') as HTMLCanvasElement;
      const renderer = new Renderer(canvas, gen, this.caps);
      renderer.maxAniso = this.defaultAniso;
      renderer.applyAniso();
      const pane: Pane = {
        section,
        canvas,
        renderer,
        hud: section.querySelector('.hud') as HTMLElement,
        crosshair: section.querySelector('.probe-crosshair') as HTMLElement,
        magnifier: section.querySelector('.magnifier') as HTMLCanvasElement,
        select: section.querySelector('.mode-select') as HTMLSelectElement,
        probeNdc: null,
        reading: null,
      };
      renderer.mode = Number(pane.select.value) as SampleMode;
      pane.select.addEventListener('change', () => {
        renderer.mode = Number(pane.select.value) as SampleMode;
      });
      pane.crosshair.addEventListener('click', (e) => {
        e.stopPropagation();
        this.magnifierOn = !this.magnifierOn;
      });
      this.bindPaneInput(pane);
      this.panes.push(pane);
    }

    this.bindToolbar();
    this.bindResize();
    this.updateDeviceInfo();
    this.loop(performance.now());
  }

  // ---------------- 工具栏 ----------------

  private bindToolbar(): void {
    document.getElementById('btn-grazing')!.addEventListener('click', () => {
      this.camera.presetGrazing();
      this.resetNudge();
    });
    document.getElementById('btn-top')!.addEventListener('click', () => {
      this.camera.presetTop();
      this.resetNudge();
    });

    const btnDolly = document.getElementById('btn-dolly')!;
    btnDolly.addEventListener('click', () => {
      this.camera.startDolly();
      this.paused = false;
      this.syncPauseButton();
      btnDolly.textContent = '⏸ 停止推镜';
    });
    document.getElementById('btn-replay')!.addEventListener('click', () => {
      this.resetNudge();
      this.camera.replayDolly();
      this.paused = false;
      this.syncPauseButton();
      btnDolly.textContent = '⏸ 停止推镜';
    });

    document.getElementById('btn-pause')!.addEventListener('click', () => this.togglePause());
    document.getElementById('btn-step')!.addEventListener('click', () => {
      if (!this.paused) this.togglePause(true);
      this.camera.update(1 / 30);
    });

    document.getElementById('btn-subpx')!.addEventListener('click', () => this.jumpSubPixel());
    document.getElementById('btn-nudge-plus')!.addEventListener('click', () => this.nudge(0.5));
    document.getElementById('btn-nudge-minus')!.addEventListener('click', () => this.nudge(-0.5));
    document.getElementById('btn-clear-nudge')!.addEventListener('click', () => this.resetNudge());

    const slider = document.getElementById('aniso-slider') as HTMLInputElement;
    slider.max = String(Math.max(1, this.adjustableCap));
    slider.value = String(this.defaultAniso);
    slider.disabled = false;
    const value = document.getElementById('aniso-value')!;
    value.textContent = `${this.defaultAniso}×`;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      value.textContent = `${v}×`;
      for (const p of this.panes) {
        p.renderer.maxAniso = v;
        p.renderer.applyAniso();
      }
    });

    const lod = document.getElementById('lod-debug') as HTMLInputElement;
    lod.addEventListener('change', () => {
      for (const p of this.panes) p.renderer.lodDebug = lod.checked;
    });

    const magZoom = document.getElementById('mag-zoom') as HTMLInputElement;
    magZoom.addEventListener('input', () => {
      this.magZoom = Number(magZoom.value);
      document.getElementById('mag-zoom-value')!.textContent = `${this.magZoom}×`;
    });
    document.getElementById('mag-close')!.addEventListener('click', () => {
      this.magnifierOn = false;
    });
  }

  private togglePause(force?: boolean): void {
    this.paused = force ?? !this.paused;
    if (this.paused) this.camera.stopDolly();
    this.syncPauseButton();
  }

  private syncPauseButton(): void {
    const btn = document.getElementById('btn-pause')!;
    btn.textContent = this.paused ? '▶ 继续' : '⏸ 暂停';
    const btnDolly = document.getElementById('btn-dolly')!;
    if (!this.camera.isDollyPlaying) btnDolly.textContent = '▶ 固定速度推镜';
  }

  private updateDeviceInfo(): void {
    const c = this.caps;
    const el = document.getElementById('device-info')!;
    el.innerHTML =
      `WebGL2 ✓ · 各向异性扩展：${c.anisoExt ? '可用（硬件采样）' : '不可用（shader 手动回退）'}` +
      ` · 设备上限 <b>${c.anisoMax}×</b> · 最大纹理 ${c.maxTextureSize}px · ${c.renderer}`;
  }

  // ---------------- 观察点 / 亚像素 ----------------

  private bindPaneInput(pane: Pane): void {
    const el = pane.canvas;
    let dragging = false;
    let button = 0;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      button = e.button;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (button === 2) this.camera.pan(dx, dy, el.clientHeight);
      else this.camera.rotate(dx, dy);
    });
    el.addEventListener('pointerup', (e) => {
      if (dragging && moved < 5 && button === 0) this.placeProbe(pane, e);
      dragging = false;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
  }

  private placeProbe(pane: Pane, e: PointerEvent): void {
    const rect = pane.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    pane.probeNdc = [ndcX, ndcY];
    // 另一窗用同一世界点，保证观察的是地面同一块砖
    const aspect = rect.width / rect.height;
    const vp = this.camera.getVP(aspect);
    const reading = probeAt(
      this.camera, vp, ndcX, ndcY,
      rect.width * this.dpr, rect.height * this.dpr,
      this.currentMaxAniso(), this.caps.anisoMax,
    );
    if (reading) {
      const other = this.panes.find((p) => p !== pane)!;
      const orect = other.canvas.getBoundingClientRect();
      const css = worldToCss(this.camera.getVP(orect.width / orect.height), reading.world, orect.width, orect.height);
      if (css) other.probeNdc = [(css[0] / orect.width) * 2 - 1, 1 - (css[1] / orect.height) * 2];
    }
    this.nudgePx = 0;
  }

  private currentMaxAniso(): number {
    return this.panes[0]?.renderer.maxAniso ?? this.caps.anisoMax;
  }

  /** 跳到预设的不足一像素对照位：贴地斜视 + 远处观察点（保证像素足迹 > 1 texel）。 */
  private jumpSubPixel(): void {
    this.camera.presetGrazing();
    this.resetNudge();
    // 取左窗屏幕纵向约 72% 处（远处、靠近地平线，保证像素足迹大于一个 texel）
    const pane = this.panes[0];
    const rect = pane.canvas.getBoundingClientRect();
    const ndcY = 1 - 2 * 0.72;
    pane.probeNdc = [0, ndcY];
    const vp = this.camera.getVP(rect.width / rect.height);
    const reading = probeAt(
      this.camera, vp, 0, ndcY,
      rect.width * this.dpr, rect.height * this.dpr,
      this.currentMaxAniso(), this.caps.anisoMax,
    );
    if (reading) {
      const other = this.panes[1];
      const orect = other.canvas.getBoundingClientRect();
      const css = worldToCss(this.camera.getVP(orect.width / orect.height), reading.world, orect.width, orect.height);
      if (css) other.probeNdc = [(css[0] / orect.width) * 2 - 1, 1 - (css[1] / orect.height) * 2];
    }
  }

  /** 沿观察点屏幕 x 方向移动 ±0.5 个物理像素的世界距离（只动相机，不改取景）。 */
  private nudge(sign: number): void {
    const pane = this.panes[0];
    if (!pane.probeNdc) {
      this.jumpSubPixel();
    }
    const r = this.computeReading(pane);
    if (!r) return;
    this.camera.translate(v3.scale(r.halfPxDelta, sign));
    this.nudgePx += sign * 0.5;
  }

  private resetNudge(): void {
    this.nudgePx = 0;
  }

  // ---------------- 尺寸 ----------------

  private bindResize(): void {
    const ro = new ResizeObserver(() => this.resizeAll());
    for (const p of this.panes) ro.observe(p.section);
    window.addEventListener('resize', () => this.resizeAll());
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.resizeAll();
  }

  private resizeAll(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    for (const p of this.panes) {
      const rect = p.section.getBoundingClientRect();
      p.renderer.resize(rect.width, rect.height, this.dpr);
    }
  }

  // ---------------- 帧循环 ----------------

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000 || 0);
    this.lastTime = now;
    if (!this.paused) this.camera.update(dt);

    for (const p of this.panes) {
      const rect = p.section.getBoundingClientRect();
      const aspect = rect.width / Math.max(1, rect.height);
      const vp = this.camera.getVP(aspect);
      p.renderer.render(vp);
      p.reading = this.computeReading(p);
      this.updateHud(p);
      this.updateProbeOverlay(p, rect, vp);
      this.updateMagnifier(p, rect);
    }

    const fill = document.getElementById('dolly-fill') as HTMLElement;
    fill.style.width = `${Math.round(this.camera.dollyProgress * 100)}%`;
  };

  private computeReading(p: Pane): ProbeReading | null {
    if (!p.probeNdc) return null;
    const rect = p.canvas.getBoundingClientRect();
    const vp = this.camera.getVP(rect.width / Math.max(1, rect.height));
    return probeAt(
      this.camera, vp, p.probeNdc[0], p.probeNdc[1],
      rect.width * this.dpr, rect.height * this.dpr,
      this.currentMaxAniso(), this.caps.anisoMax,
    );
  }

  private updateProbeOverlay(p: Pane, rect: DOMRect, vp: Float32Array): void {
    if (!p.reading) {
      p.crosshair.classList.add('hidden');
      return;
    }
    const css = worldToCss(vp, p.reading.world, rect.width, rect.height);
    if (!css) {
      p.crosshair.classList.add('hidden');
      return;
    }
    p.crosshair.classList.remove('hidden');
    p.crosshair.style.left = `${css[0]}px`;
    p.crosshair.style.top = `${css[1]}px`;
  }

  private updateMagnifier(p: Pane, rect: DOMRect): void {
    const show = this.magnifierOn && !!p.reading;
    p.magnifier.classList.toggle('hidden', !show);
    const bar = document.getElementById('magnifier-bar')!;
    bar.classList.toggle('hidden', !this.magnifierOn);
    if (!show || !p.reading) return;

    const vp = this.camera.getVP(rect.width / Math.max(1, rect.height));
    const css = worldToCss(vp, p.reading.world, rect.width, rect.height);
    if (!css) return;

    const dpr = this.dpr;
    const mag = p.magnifier;
    // 放大倍数即每个原始物理像素在放大窗中占多少格；反推采样框（物理像素，取奇数居中）
    const cropCss = Math.max(3, Math.round(mag.width / this.magZoom));
    const crop = cropCss * dpr;
    const srcX = Math.round(css[0] * dpr - crop / 2);
    const srcY = Math.round(css[1] * dpr - crop / 2);
    const ctx = mag.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mag.width, mag.height);
    // 直接从已渲染的 canvas 拷贝物理像素并最近邻放大（不动采样相机）
    ctx.drawImage(
      p.canvas,
      Math.max(0, srcX), Math.max(0, srcY), crop, crop,
      0, 0, mag.width, mag.height,
    );
    const cropInfo = document.getElementById('mag-crop-info');
    if (cropInfo) cropInfo.textContent = `（采样框 ${cropCss}×${cropCss} 物理像素）`;
    // 中心十字
    ctx.strokeStyle = 'rgba(109,179,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mag.width / 2, 0);
    ctx.lineTo(mag.width / 2, mag.height);
    ctx.moveTo(0, mag.height / 2);
    ctx.lineTo(mag.width, mag.height / 2);
    ctx.stroke();

    // 放在观察点附近，避免遮挡
    const left = Math.min(Math.max(8, css[0] + 24), rect.width - 272);
    const top = Math.min(Math.max(8, css[1] - 140), rect.height - 290);
    p.magnifier.style.left = `${left}px`;
    p.magnifier.style.top = `${top}px`;
  }

  private updateHud(p: Pane): void {
    const modeName = ['A 无缩小层', 'B 三线性缩小层', 'C 倾斜向各向异性'][p.renderer.mode];
    const eye = this.camera.eye();
    let html =
      `<span class="k">模式</span> <span class="v">${modeName}</span>\n` +
      `<span class="k">相机</span> 眼高 <span class="v">${fmt(eye[1], 2)}</span>  距 <span class="v">${fmt(this.camera.dist, 2)}</span>` +
      `  俯仰 <span class="v">${fmt((this.camera.pitch * 180) / Math.PI, 1)}°</span>` +
      (this.paused ? '  <span class="warn">已暂停</span>' : '');

    const r = p.reading;
    if (!r) {
      p.hud.textContent = '';
      p.hud.innerHTML = html + '\n<span class="k">点击地面放置观察点…</span>';
      return;
    }

    const world = `(${fmt(r.world[0], 2)}, ${fmt(r.world[2], 2)})`;
    const uv = `(${fmt(r.uvCont[0], 3)}, ${fmt(r.uvCont[1], 3)})`;
    html +=
      `\n<span class="k">观察点世界</span> <span class="v">${world}</span>  砖 ${r.tile[0]},${r.tile[1]}  砖内UV (${fmt(r.uvInTile[0], 3)}, ${fmt(r.uvInTile[1], 3)})` +
      `\n<span class="k">连续UV(跨砖)</span> <span class="v">${uv}</span>  ← 不取模，接缝两侧读数连续` +
      `\n<span class="k">每物理像素世界跨度</span> 屏x <span class="v">${fmt(r.pxWorldX, 4)}</span> × 屏y <span class="v">${fmt(r.pxWorldY, 4)}</span>` +
      `  (1 砖 = ${TILE_WORLD} 世界单位)` +
      `\n<span class="k">折合第0级 texel</span> 屏x <span class="v">${fmt(r.pxTexelX, 2)}</span> × 屏y <span class="v">${fmt(r.pxTexelY, 2)}</span> 个` +
      `\n<span class="k">连续 LOD</span> <span class="good">${fmt(r.lambda, 2)}</span> → 落在 ` +
      `<span class="good">第 ${r.lodLo} 层</span>` +
      (r.lodHi !== r.lodLo ? ` 与 <span class="good">第 ${r.lodHi} 层</span> 之间，混合 ${Math.round(Math.min(1, Math.max(0, r.lodBlend)) * 100)}%` : '（本层内部双线性）') +
      `\n<span class="k">该层纹素世界尺寸</span> ${fmt(texelWorldSize(Math.min(r.lodLo, TEX_LEVELS - 1)), 4)} / texel` +
      ` · 共 ${TEX_LEVELS} 层 (${TEX_BASE}→1)` +
      `\n<span class="k">足迹长短轴比</span> <span class="warn">${fmt(r.anisoRatio, 2)}×</span>` +
      `  C 模式预计采样 <span class="warn">${r.effectiveTaps}</span> 次` +
      (this.nudgePx !== 0 ? `\n<span class="warn">亚像素对照偏移：${fmt(this.nudgePx, 1)} 物理像素（取景未变）</span>` : '');

    p.hud.innerHTML = html;
  }
}

const app = new App();
app.start();
