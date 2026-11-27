// 主控制器：DOM 接线、画布取景、手画采集、播放循环、偏差视图与导出。

import type { Vec2 } from './lib/geometry';
import { bboxSize } from './lib/geometry';
import {
  assessClosure, applyClosure, StrokeCollector,
  type ClosureAction, type RawPoint,
} from './lib/stroke';

import { makePreset, type PresetId } from './lib/presets';
import { runAllChecks } from './lib/checks';
import { circleReference, translatedReference } from './lib/references';
import {
  buildModel, directionCounts, modelAtPhase, originalAtPhase,
  rebuiltAtPhase, recenter, trailUpTo, SAMPLE_COUNT,
  type AppModel, type Playback, type ViewMode,
} from './state';
import type { OrderMode } from './lib/dft';
import {
  drawBackground, drawClosedPath, drawEpicycleChain, drawGrid, drawHeatmap,
  drawOpenPath, drawReferencePair, drawSeamMarker, drawTip, drawTranslationArrow,
  renderExportScene, type ViewTransform,
} from './ui/renderer';
import { THEME } from './ui/theme';
import {
  buildExportJson, buildSvg, downloadBlob, downloadText, fitLayout,
  type ExportFlags,
} from './lib/exporter';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

class App {
  private canvas = $<HTMLCanvasElement>('canvas');
  private ctx = this.canvas.getContext('2d')!;

  private model: AppModel | null = null;
  private playback: Playback = { phase: 0, playing: true, speedHz: 0.1 };
  private liveStroke: RawPoint[] = [];
  private pendingRaw: RawPoint[] | null = null;
  private vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  private lastFrame = performance.now();
  private resizeObs: ResizeObserver;

  // 界面开关
  private showChain = true;
  private showOriginal = true;
  private showTrail = true;

  constructor() {
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas.parentElement!);
    this.resize();
    this.bindUi();
    this.setupCollector();
    requestAnimationFrame(this.frame);
    // 首屏给一个可玩的默认图形
    this.loadPreset('leaf');
  }

  // ---------- 取景 ----------

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fitView();
  }

  private fitView(): void {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return; // 布局未稳定，等下一次 ResizeObserver
    const pts = this.model?.samples ?? this.liveStroke;
    if (!pts || pts.length === 0) {
      this.vt = { scale: 1, offsetX: w / 2, offsetY: h / 2 };
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // 圆链展开范围：重心 ± 当前保留圆半径之和，保证最大的圆也不贴边
    if (this.model) {
      const c0 = this.model.ordered.find((c) => c.k === 0)!;
      const reach = this.model.ordered.reduce((s, c) => s + c.r, 0);
      minX = Math.min(minX, c0.re - reach); maxX = Math.max(maxX, c0.re + reach);
      minY = Math.min(minY, c0.im - reach); maxY = Math.max(maxY, c0.im + reach);
    }
    const pad = 60;
    const scale = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1), (h - 2 * pad) / Math.max(maxY - minY, 1));
    this.vt = {
      scale,
      offsetX: w / 2 - ((minX + maxX) / 2) * scale,
      offsetY: h / 2 - ((minY + maxY) / 2) * scale,
    };
  }

  private toModel(clientX: number, clientY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.vt.offsetX) / this.vt.scale,
      y: (clientY - rect.top - this.vt.offsetY) / this.vt.scale,
    };
  }

  // ---------- 采集 ----------

  private setupCollector(): void {
    new StrokeCollector(
      this.canvas,
      (x, y) => this.toModel(x, y),
      (raw) => {
        this.liveStroke = raw;
        // 开始新一笔时清掉上一笔遗留的闭合提示
        if (raw.length <= 2) {
          this.pendingRaw = null;
          $('closure-banner').classList.add('hidden');
          $('closure-actions').classList.add('hidden');
        }
      },
      (raw) => this.finishStroke(raw),
    );
  }

  private finishStroke(raw: RawPoint[]): void {
    const info = assessClosure(raw);
    const banner = $('closure-banner');
    banner.className = `banner ${info.quality}`;
    banner.textContent = info.message;
    const actions = $('closure-actions');
    actions.classList.remove('hidden');
    if (info.quality === 'closed') {
      this.commitStroke(raw, 'auto-close');
      actions.classList.add('hidden');
    } else if (info.quality === 'loose') {
      this.pendingRaw = raw;
    } else {
      this.pendingRaw = raw;
    }
  }

  private commitStroke(raw: RawPoint[], action: ClosureAction): void {
    const closed = applyClosure(raw, action);
    if (closed.length < 3) {
      this.liveStroke = [];
      return;
    }
    this.liveStroke = [];
    $('closure-actions').classList.add('hidden');
    $('canvas-hint').classList.add('hidden');
    this.setModel(recenter(closed));
  }

  private setModel(points: Vec2[]): void {
    const keep = Number($<HTMLInputElement>('keep').value);
    const order = this.model?.order ?? 'frequency';
    const view = this.model?.view ?? 'trace';
    this.model = buildModel(points, keep, order, view);
    this.playback.phase = 0;
    this.fitView();
    this.refreshDerivedUi();
  }

  // ---------- 预设 ----------

  private loadPreset(id: PresetId): void {
    const pts = recenter(makePreset(id, SAMPLE_COUNT));
    $('closure-banner').classList.add('hidden');
    $('closure-actions').classList.add('hidden');
    $('canvas-hint').classList.add('hidden');
    this.setModel(pts);
  }

  // ---------- UI 接线 ----------

  private bindUi(): void {
    $('btn-clear').onclick = () => {
      this.model = null;
      this.liveStroke = [];
      $('closure-banner').classList.add('hidden');
      $('closure-actions').classList.add('hidden');
      $('canvas-hint').classList.remove('hidden');
      this.fitView();
    };
    $('btn-preset-leaf').onclick = () => this.loadPreset('leaf');
    $('btn-preset-lop').onclick = () => this.loadPreset('lopsided');
    $('btn-preset-circle').onclick = () => this.loadPreset('circle');

    document.querySelectorAll<HTMLButtonElement>('#closure-actions button').forEach((b) => {
      b.onclick = () => {
        if (!this.pendingRaw) return;
        this.commitStroke(this.pendingRaw, b.dataset.close as ClosureAction);
        this.pendingRaw = null;
      };
    });

    const keep = $<HTMLInputElement>('keep');
    keep.oninput = () => {
      $('keep-value').textContent = keep.value;
      if (this.model) {
        const total = this.model.allComponents.filter((c) => c.k !== 0).length;
        const k = Math.min(Number(keep.value), total);
        this.model = buildModel(
          this.model.rawClosed, k, this.model.order, this.model.view,
        );
        this.fitView();
        this.refreshDerivedUi();
      }
    };

    document.querySelectorAll<HTMLButtonElement>('#order-mode button').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('#order-mode button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        if (this.model) {
          this.model = buildModel(
            this.model.rawClosed, this.model.keep, b.dataset.order as OrderMode, this.model.view,
          );
          this.refreshDerivedUi();
        }
      };
    });

    for (const [id, prop] of [
      ['show-chain', 'showChain'], ['show-original', 'showOriginal'], ['show-trail', 'showTrail'],
    ] as const) {
      $(id).onchange = (e) => {
        (this as Record<string, unknown>)[prop] = (e.target as HTMLInputElement).checked;
      };
    }

    $('btn-play').onclick = () => {
      this.playback.playing = !this.playback.playing;
      $('btn-play').textContent = this.playback.playing ? '暂停' : '播放';
    };
    $('btn-restart').onclick = () => { this.playback.phase = 0; this.syncPhaseSlider(); };
    $('btn-step-fwd').onclick = () => this.step(1);
    $('btn-step-back').onclick = () => this.step(-1);

    const phase = $<HTMLInputElement>('phase');
    phase.oninput = () => {
      this.playback.phase = Number(phase.value) / 1000;
      this.playback.playing = false;
      $('btn-play').textContent = '播放';
      this.syncPhaseLabel();
    };
    const speed = $<HTMLInputElement>('speed');
    speed.oninput = () => {
      // 0..200 滑块 → 0.02..0.5 圈/秒
      this.playback.speedHz = 0.02 + (Number(speed.value) / 200) * 0.48;
      $('speed-value').textContent = `${this.playback.speedHz.toFixed(2)}×`;
    };

    $('btn-view-trace').onclick = () => this.setView('trace');
    $('btn-view-deviation').onclick = () => this.setView('deviation');

    $('btn-checks').onclick = () => this.runChecks();

    $('btn-export-png').onclick = () => this.exportPng();
    $('btn-export-svg').onclick = () => this.exportSvg();
    $('btn-export-json').onclick = () => this.exportJson();
  }

  private setView(view: ViewMode): void {
    $('btn-view-trace').classList.toggle('active', view === 'trace');
    $('btn-view-deviation').classList.toggle('active', view === 'deviation');
    $('heat-legend').classList.toggle('hidden', view !== 'deviation');
    $('references').classList.toggle('hidden', view !== 'deviation');
    if (this.model) {
      this.model = buildModel(this.model.rawClosed, this.model.keep, this.model.order, view);
      this.refreshDerivedUi();
      if (view === 'deviation') this.drawReferences();
    } else {
      $('heat-legend').classList.add('hidden');
      $('references').classList.add('hidden');
    }
  }

  private step(dir: 1 | -1): void {
    this.playback.playing = false;
    $('btn-play').textContent = '播放';
    // 单步 = 一个采样相位
    this.playback.phase = (((this.playback.phase + (dir / SAMPLE_COUNT)) % 1) + 1) % 1;
    this.syncPhaseSlider();
  }

  private syncPhaseSlider(): void {
    $<HTMLInputElement>('phase').value = String(Math.round(this.playback.phase * 1000));
    this.syncPhaseLabel();
  }

  private syncPhaseLabel(): void {
    $('phase-value').textContent = `${this.playback.phase.toFixed(3)} / 1.000`;
  }

  private refreshDerivedUi(): void {
    if (!this.model) return;
    const total = this.model.allComponents.filter((c) => c.k !== 0).length;
    const keepSlider = $<HTMLInputElement>('keep');
    keepSlider.max = String(total);
    $('keep-total').textContent = String(total);
    $('keep-value').textContent = String(this.model.keep);
    const { ccw, cw } = directionCounts(this.model.ordered);
    $('ccw-count').textContent = String(ccw);
    $('cw-count').textContent = String(cw);
    this.renderDeviationStats();
    if (this.model.view === 'deviation') this.drawReferences();
  }

  private renderDeviationStats(): void {
    if (!this.model) return;
    const s = this.model.report.stats;
    const shapeClass = s.maxShapeError < bboxSize(this.model.samples) * 0.01 ? 'ok' : 'warn';
    $('deviation-stats').innerHTML = `
      <span>整体平移 <b>${s.translationMagnitude.toFixed(2)}px</b>（Δx ${s.translation.x.toFixed(2)}, Δy ${s.translation.y.toFixed(2)}）</span>
      <span>形变 RMS <b class="${shapeClass}">${s.rmsShapeError.toFixed(2)}px</b> · 最大 <b>${s.maxShapeError.toFixed(2)}px</b></span>
      <span>偏差来源：平移/形变能量比中形变占 <b>${(s.shapeShare * 100).toFixed(1)}%</b></span>`;
  }

  // ---------- 自检 ----------

  private runChecks(): void {
    const ul = $('check-list');
    ul.innerHTML = '';
    for (const r of runAllChecks()) {
      const li = document.createElement('li');
      li.className = r.pass ? 'pass' : 'fail';
      li.innerHTML = `${r.pass ? '✅' : '❌'} ${r.name}<span class="detail">${r.detail}</span>`;
      ul.appendChild(li);
    }
  }

  // ---------- 参照小图 ----------

  private drawReferences(): void {
    if (!this.model) return;
    const keep = this.model.keep;
    this.drawReferenceCanvas($<HTMLCanvasElement>('ref-circle'), circleReference(keep));
    this.drawReferenceCanvas($<HTMLCanvasElement>('ref-translated'), translatedReference(keep));
  }

  private drawReferenceCanvas(cv: HTMLCanvasElement, scene: ReturnType<typeof circleReference>): void {
    const ctx = cv.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr;
    cv.height = 150 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cv.clientWidth;
    const h = 150;
    drawBackground(ctx, w, h);
    const layout = fitLayout(scene.original, w, h, 24);
    const vt: ViewTransform = { scale: layout.scale, offsetX: layout.offsetX, offsetY: layout.offsetY };
    drawHeatmap(ctx, scene.report, vt, 4);
    drawClosedPath(ctx, scene.original, vt, { color: THEME.original, width: 1, dash: [4, 4], alpha: 0.5 });
    const c0 = { x: scene.original[0].x - scene.report.stats.translation.x, y: scene.original[0].y - scene.report.stats.translation.y };
    drawTranslationArrow(ctx, c0, scene.report.stats.translation, vt);
    drawSeamMarker(ctx, scene.original[0], vt);
    const cap = cv.nextElementSibling as HTMLElement;
    if (cap) cap.textContent = scene.note;
  }

  // ---------- 导出 ----------

  private exportFlags(): ExportFlags {
    return {
      original: $<HTMLInputElement>('exp-original').checked,
      rebuilt: $<HTMLInputElement>('exp-rebuilt').checked,
      chain: $<HTMLInputElement>('exp-chain').checked,
      heatmap: $<HTMLInputElement>('exp-heat').checked,
    };
  }

  private exportLayout(width: number, height: number) {
    if (!this.model) throw new Error('没有可导出的曲线');
    return fitLayout(this.model.samples, width, height, 50);
  }

  private exportDims(): { width: number; height: number } {
    const clampInt = (raw: string, fallback: number): number => {
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) && n >= 200 && n <= 8000 ? n : fallback;
    };
    return {
      width: clampInt($<HTMLInputElement>('exp-w').value, 1600),
      height: clampInt($<HTMLInputElement>('exp-h').value, 1200),
    };
  }

  private exportPng(): void {
    if (!this.model) return;
    const { width, height } = this.exportDims();
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d')!;
    const L = this.exportLayout(width, height);
    const flags = this.exportFlags();
    const { chain } = modelAtPhase(this.model, this.playback.phase);
    renderExportScene(ctx, width, height, L, {
      original: flags.original ? this.model.samples : null,
      rebuilt: flags.rebuilt ? this.model.rebuilt : null,
      chain: flags.chain ? chain : null,
      heatmap: flags.heatmap ? this.model.report : null,
    });
    off.toBlob((blob) => {
      if (blob) downloadBlob(blob, `epicycle-keep${this.model!.keep}-${width}x${height}.png`);
    }, 'image/png');
  }

  private exportSvg(): void {
    if (!this.model) return;
    const { width, height } = this.exportDims();
    const L = this.exportLayout(width, height);
    const flags = this.exportFlags();
    const { chain } = modelAtPhase(this.model, this.playback.phase);
    const svg = buildSvg(
      {
        original: this.model.samples,
        rebuilt: this.model.rebuilt,
        chain,
        report: flags.heatmap ? this.model.report : null,
        components: this.model.ordered,
      },
      L,
      flags,
    );
    downloadText(svg, `epicycle-keep${this.model.keep}.svg`, 'image/svg+xml');
  }

  private exportJson(): void {
    if (!this.model) return;
    const { width, height } = this.exportDims();
    const L = this.exportLayout(width, height);
    const json = buildExportJson(
      {
        original: this.model.samples,
        rebuilt: this.model.rebuilt,
        chain: modelAtPhase(this.model, 0).chain,
        report: this.model.report,
        components: this.model.ordered,
      },
      this.model.allComponents,
      L,
    );
    downloadText(JSON.stringify(json, null, 2), `epicycle-keep${this.model.keep}.json`, 'application/json');
  }

  // ---------- 渲染循环 ----------

  /** 只读快照，供浏览器冒烟脚本与控制台自检使用 */
  snapshot(): Record<string, unknown> {
    const parent = this.canvas.parentElement!;
    const viewport = { w: parent.clientWidth, h: parent.clientHeight };
    if (!this.model) return { hasModel: false, viewport, vt: this.vt };
    const s = this.model.report.stats;
    return {
      hasModel: true,
      keep: this.model.keep,
      total: this.model.allComponents.filter((c) => c.k !== 0).length,
      order: this.model.order,
      view: this.model.view,
      ccw: directionCounts(this.model.ordered).ccw,
      cw: directionCounts(this.model.ordered).cw,
      rms: s.rmsShapeError,
      maxShape: s.maxShapeError,
      translation: s.translation,
      trailPointsAtEnd: trailUpTo(this.model, 0.999).length,
      rebuiltHead: this.model.rebuilt[0],
      rebuiltTail: this.model.rebuilt[this.model.rebuilt.length - 1],
      phase: this.playback.phase,
      viewport,
      vt: this.vt,
    };
  }

  private frame = (now: number): void => {
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    if (this.playback.playing && this.model) {
      this.playback.phase = (this.playback.phase + dt * this.playback.speedHz) % 1;
      this.syncPhaseSlider();
    }
    this.render();
    requestAnimationFrame(this.frame);
  };

  private render(): void {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    drawBackground(this.ctx, w, h);
    drawGrid(this.ctx, w, h, this.vt);

    // 正在拖的笔画（固定线宽，与速度无关）
    if (!this.model && this.liveStroke.length > 1) {
      drawOpenPath(this.ctx, this.liveStroke, this.vt, { color: THEME.secondary, width: 2 });
      return;
    }
    if (!this.model) return;

    const m = this.model;
    const phase = this.playback.phase;

    if (m.view === 'deviation') {
      // 中性底轮廓：即使误差接近 0、热图颜色沉入暗背景，形状仍可见
      drawClosedPath(this.ctx, m.samples, this.vt, { color: THEME.muted, width: 1, alpha: 0.35 });
      drawHeatmap(this.ctx, m.report, this.vt, 5);
      if (this.showOriginal) {
        drawClosedPath(this.ctx, m.samples, this.vt, { color: THEME.original, width: 1.25, dash: [5, 5], alpha: 0.55 });
      }
      // 平移向量：从原重心指向重建重心
      const cOrig = m.samples.reduce((a, p) => ({ x: a.x + p.x / m.samples.length, y: a.y + p.y / m.samples.length }), { x: 0, y: 0 });
      drawTranslationArrow(this.ctx, cOrig, m.report.stats.translation, this.vt);
    } else {
      if (this.showOriginal) {
        drawClosedPath(this.ctx, m.samples, this.vt, { color: THEME.original, width: 2, dash: [7, 5], alpha: 0.8 });
      }
      const { chain, tip } = modelAtPhase(m, phase);
      if (this.showChain) drawEpicycleChain(this.ctx, chain, this.vt);
      if (this.showTrail) {
        // 开放轨迹：仅画到当前相位，结束处停住，无跨接缝连线
        drawOpenPath(this.ctx, trailUpTo(m, phase), this.vt, { color: THEME.rebuilt, width: 2.5 });
      }
      drawTip(this.ctx, tip, this.vt, THEME.rebuilt);
    }

    // 两侧位置参照：原线点 vs 重建点（两种视图都显示）
    const o = originalAtPhase(m, phase);
    const r = rebuiltAtPhase(m, phase);
    drawReferencePair(this.ctx, o, r, this.vt);
    drawSeamMarker(this.ctx, m.samples[0], this.vt);

    // 实时误差读数
    const idx = Math.round(phase * SAMPLE_COUNT) % SAMPLE_COUNT;
    $('live-err').textContent = `${m.report.points[idx].shapeError.toFixed(2)}px`;
    this.syncPhaseLabel();
  }
}

const app = new App();
declare global {
  interface Window {
    __epi?: { snapshot: () => Record<string, unknown> };
  }
}
window.__epi = { snapshot: () => app.snapshot() };
