import type { AppState } from './state';
import type { RenderOptions } from './types';
import { MAX_FREQ, MIN_FREQ, dbToGain, gainToDb } from './types';
import { computeSpectrum } from './dsp/fft';
import { frameAt, activeKeys } from './dsp/interp';
import { bandpassCoeffs, magnitudeAt } from './dsp/biquad';
import { findPeaks } from './dsp/peaks';
import { themeColors } from './theme';

const PLOT_MIN_F = 40;
const PLOT_MAX_F = 6000;
const DB_MIN = -70;
const DB_MAX = 6;

interface SnapshotCurve {
  freqs: number[];
  sourceDb: number[];
  shapeDb: number[];
  outputDb: number[];
  regionFills: { center: number; bandwidth: number; color: string }[];
  peakMarkers: { freq: number; db: number; regionIndex: number | null }[];
}

/**
 * 同屏三曲线频谱图：
 * 源声（谐波茎）、共振形状（解析滤波响应）、成音（对渲染 PCM 实测 FFT）。
 * 点击任意位置：标出该处频率与各曲线电平，并高亮最近的共振区。
 */
export class SpectrumPlot {
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private snapshot: SnapshotCurve | null = null;
  private hover: { x: number; y: number; freq: number } | null = null;
  private highlightedRegion = -1;

  constructor(canvas: HTMLCanvasElement, tip: HTMLElement) {
    this.canvas = canvas;
    this.tip = tip;
    canvas.addEventListener('click', (e) => this.onClick(e));
    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.classList.add('hidden');
      this.draw();
    });
  }

  private get ctx(): CanvasRenderingContext2D {
    return this.canvas.getContext('2d')!;
  }

  private layout() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, rect.width);
    const h = 320;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== h * dpr) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = h * dpr;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, padL: 58, padR: 16, padT: 14, padB: 34 };
  }

  private xOf(freq: number, padL: number, plotW: number): number {
    const u =
      (Math.log(freq) - Math.log(PLOT_MIN_F)) / (Math.log(PLOT_MAX_F) - Math.log(PLOT_MIN_F));
    return padL + u * plotW;
  }

  private freqAtX(x: number, padL: number, plotW: number): number {
    const u = (x - padL) / plotW;
    return Math.exp(
      Math.log(PLOT_MIN_F) + u * (Math.log(PLOT_MAX_F) - Math.log(PLOT_MIN_F)),
    );
  }

  private yOf(db: number, padT: number, plotH: number): number {
    const u = (db - DB_MIN) / (DB_MAX - DB_MIN);
    return padT + (1 - u) * plotH;
  }

  /** 重新计算光标处的三条曲线（成音曲线来自对短帧的真实 FFT） */
  rebuild(state: AppState, render: (opts: RenderOptions) => Float32Array): void {
    const { sampleRate } = { sampleRate: 44100 };
    const t = state.cursor;
    const regions = frameAt(state.timeline, t);
    const colors = themeColors();

    // 成音：用当前时间线渲染整段，再取光标附近一帧做 FFT
    const full = render({
      sampleRate,
      duration: state.duration,
      f0: state.f0,
      noiseMix: state.noiseMix,
      timeline: state.timeline,
      normalizeTo: state.normalize ? dbToGain(state.targetDb) : null,
      seed: state.seed,
    });
    const center = Math.floor(t * full.length);
    const half = Math.floor(0.06 * sampleRate);
    const frame = full.slice(Math.max(0, center - half), Math.min(full.length, center + half));
    const spec = computeSpectrum(frame, sampleRate, 4096);

    const nPoints = 320;
    const freqs: number[] = [];
    const shapeDb: number[] = [];
    const outputDb: number[] = [];
    for (let i = 0; i < nPoints; i++) {
      const u = i / (nPoints - 1);
      const freq = Math.exp(
        Math.log(PLOT_MIN_F) + u * (Math.log(PLOT_MAX_F) - Math.log(PLOT_MIN_F)),
      );
      freqs.push(freq);
      // 共振形状：三段带通解析响应的能量和（并联滤波器）
      let energy = 0;
      regions.forEach((r) => {
        const c = bandpassCoeffs(r.center, r.bandwidth, sampleRate);
        const mag = magnitudeAt(c, freq, sampleRate) * r.gain;
        energy += mag * mag;
      });
      shapeDb.push(gainToDb(Math.sqrt(energy)));
      // 实测 FFT 取最近 bin
      const bin = Math.round((freq * spec.fftSize) / sampleRate);
      outputDb.push(spec.magDb[Math.min(bin, spec.magDb.length - 1)] ?? DB_MIN);
    }

    // 源声：恒定 f0 的谐波茎（只画到图内）
    const sourceDb: number[] = new Array(nPoints).fill(DB_MIN);
    const nHarm = Math.floor(PLOT_MAX_F / state.f0);
    const harmonicIdx = new Map<number, number>();
    for (let k = 1; k <= nHarm; k++) {
      const hf = k * state.f0;
      if (hf < PLOT_MIN_F || hf > PLOT_MAX_F) continue;
      // 谐波幅度 1/k，换算 dB 后整体上移到与成音可比的窗口
      const db = gainToDb(1 / k) + 18;
      harmonicIdx.set(k, db);
      // 把最近的曲线点抬到谐波电平，形成茎状效果
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < nPoints; i++) {
        const d = Math.abs(Math.log(freqs[i]) - Math.log(hf));
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      sourceDb[best] = Math.max(sourceDb[best], db);
    }

    // 峰标记：实测谱上的清楚峰，并归属最近共振区
    const peaks = findPeaks(spec, MIN_FREQ, Math.min(MAX_FREQ, PLOT_MAX_F)).slice(0, 12);
    const peakMarkers = peaks.map((p) => {
      let nearest = -1;
      let nd = Infinity;
      regions.forEach((r, i) => {
        const d = Math.abs(Math.log(r.center) - Math.log(p.freq));
        if (d < nd) {
          nd = d;
          nearest = i;
        }
      });
      return { freq: p.freq, db: p.magDb, regionIndex: nd < 0.35 ? nearest : -1 };
    });

    this.snapshot = {
      freqs,
      sourceDb,
      shapeDb,
      outputDb,
      regionFills: regions.map((r, i) => ({
        center: r.center,
        bandwidth: r.bandwidth,
        color: [colors.f1, colors.f2, colors.f3][i],
      })),
      peakMarkers,
    };
    this.draw();
  }

  highlightRegion(index: number): void {
    this.highlightedRegion = index;
    this.draw();
  }

  private drawAxes(l: ReturnType<typeof this.layout>) {
    const { ctx } = this;
    const { w, h, padL, padR, padT, padB } = l;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const c = themeColors();
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = c.muted;
    ctx.textAlign = 'center';
    const ticks = [50, 100, 200, 500, 1000, 2000, 4000];
    ticks.forEach((f) => {
      const x = this.xOf(f, padL, plotW);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, h - padB + 16);
    });
    ctx.textAlign = 'right';
    for (let db = DB_MIN; db <= DB_MAX; db += 10) {
      const y = this.yOf(db, padT, plotH);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${db}`, padL - 8, y + 4);
    }
    ctx.strokeStyle = c.axis;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
  }

  private draw(): void {
    if (!this.snapshot) return;
    const l = this.layout();
    const { ctx } = this;
    const { padL, padT, padR, padB } = l;
    const plotW = l.w - padL - padR;
    const plotH = l.h - padT - padB;
    const c = themeColors();
    this.drawAxes(l);

    const s = this.snapshot;

    // 共振区带宽填充
    s.regionFills.forEach((rf, i) => {
      const x1 = this.xOf(Math.max(PLOT_MIN_F, rf.center - rf.bandwidth / 2), padL, plotW);
      const x2 = this.xOf(Math.min(PLOT_MAX_F, rf.center + rf.bandwidth / 2), padL, plotW);
      ctx.fillStyle = rf.color;
      ctx.globalAlpha = this.highlightedRegion === i || this.highlightedRegion === -1 ? 0.14 : 0.05;
      ctx.fillRect(x1, padT, x2 - x1, plotH);
      ctx.globalAlpha = 1;
      // 中心虚线
      ctx.strokeStyle = rf.color;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      const xc = this.xOf(rf.center, padL, plotW);
      ctx.beginPath();
      ctx.moveTo(xc, padT);
      ctx.lineTo(xc, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rf.color;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`F${i + 1} ${Math.round(rf.center)}Hz`, xc, padT + 12);
    });

    const drawLine = (vals: number[], color: string, width: number, dashed = false) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      vals.forEach((db, i) => {
        const x = this.xOf(s.freqs[i], padL, plotW);
        const y = this.yOf(db, padT, plotH);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawLine(s.shapeDb, c.shape, 2);
    drawLine(s.outputDb, c.output, 2.2);

    // 源声谐波茎
    ctx.strokeStyle = c.source;
    ctx.lineWidth = 1.4;
    s.sourceDb.forEach((db, i) => {
      if (db <= DB_MIN + 1) return;
      const x = this.xOf(s.freqs[i], padL, plotW);
      const yTop = this.yOf(db, padT, plotH);
      const yBase = this.yOf(DB_MIN, padT, plotH);
      ctx.beginPath();
      ctx.moveTo(x, yBase);
      ctx.lineTo(x, yTop);
      ctx.stroke();
    });

    // 峰标记
    s.peakMarkers.forEach((p) => {
      if (p.freq < PLOT_MIN_F || p.freq > PLOT_MAX_F) return;
      const x = this.xOf(p.freq, padL, plotW);
      const y = this.yOf(p.db, padT, plotH);
      const color = p.regionIndex !== null && p.regionIndex >= 0 ? [c.f1, c.f2, c.f3][p.regionIndex] : c.muted;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = c.surface;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // 悬停十字线
    if (this.hover) {
      ctx.strokeStyle = c.axis;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this.hover.x, padT);
      ctx.lineTo(this.hover.x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private eventPos(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private valueAtFreq(freq: number) {
    const s = this.snapshot!;
    let best = 0;
    let bestDist = Infinity;
    s.freqs.forEach((f, i) => {
      const d = Math.abs(Math.log(f) - Math.log(freq));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return { source: s.sourceDb[best], shape: s.shapeDb[best], output: s.outputDb[best] };
  }

  private onMove(e: MouseEvent) {
    if (!this.snapshot) return;
    const l = this.layout();
    const { x, y } = this.eventPos(e);
    const freq = this.freqAtX(x, l.padL, l.w - l.padL - l.padR);
    if (freq < PLOT_MIN_F || freq > PLOT_MAX_F) {
      this.tip.classList.add('hidden');
      return;
    }
    this.hover = { x, y, freq };
    const v = this.valueAtFreq(freq);
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${Math.min(x + 12, l.w - 220)}px`;
    this.tip.style.top = `${y + 12}px`;
    this.tip.innerHTML =
      `<b>${freq.toFixed(0)} Hz</b><br>源声 ${v.source.toFixed(1)} dB · 共振 ${v.shape.toFixed(
        1,
      )} dB<br>成音 ${v.output.toFixed(1)} dB`;
    this.draw();
  }

  private onClick(e: MouseEvent) {
    if (!this.snapshot) return;
    const l = this.layout();
    const { x, y } = this.eventPos(e);
    const freq = this.freqAtX(x, l.padL, l.w - l.padL - l.padR);
    const s = this.snapshot;
    // 最近的峰
    let nearestPeak: { freq: number; db: number; regionIndex: number | null } | null = null;
    let pd = Infinity;
    for (const p of s.peakMarkers) {
      const d = Math.abs(Math.log(p.freq) - Math.log(freq));
      if (d < pd) {
        pd = d;
        nearestPeak = p;
      }
    }
    // 最近的共振区
    let region = -1;
    let rd = Infinity;
    s.regionFills.forEach((rf, i) => {
      const d = Math.abs(Math.log(rf.center) - Math.log(freq));
      if (d < rd) {
        rd = d;
        region = i;
      }
    });
    this.highlightedRegion = region;
    const v = this.valueAtFreq(freq);
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${Math.min(x + 12, l.w - 240)}px`;
    this.tip.style.top = `${y + 12}px`;
    const peakText = nearestPeak && pd < 0.12
      ? `<br>最近实测峰 ${nearestPeak.freq.toFixed(0)} Hz（${
          nearestPeak.regionIndex !== null && nearestPeak.regionIndex >= 0
            ? `靠近 F${nearestPeak.regionIndex + 1}`
            : '不在任何共振区附近'
        }）`
      : '<br>附近没有清楚的峰';
    this.tip.innerHTML =
      `<b>${freq.toFixed(0)} Hz</b> · 最近共振区 <b>F${region + 1}</b>（中心 ${s.regionFills[
        region
      ].center.toFixed(0)} Hz，带宽 ${s.regionFills[region].bandwidth.toFixed(0)} Hz）` +
      `<br>源声 ${v.source.toFixed(1)} / 共振 ${v.shape.toFixed(1)} / 成音 ${v.output.toFixed(1)} dB${peakText}`;
    this.draw();
  }
}

/** 时间线轨迹图：三个共振中心随时间的滑动曲线 + 节点 + 光标 */
export class TimelinePlot {
  private canvas: HTMLCanvasElement;
  onSeek: ((t: number) => void) | null = null;
  onSelectNode: ((index: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.handlePointer(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging) this.handlePointer(e);
    });
    canvas.addEventListener('pointerup', () => {
      dragging = false;
    });
  }

  private get ctx(): CanvasRenderingContext2D {
    return this.canvas.getContext('2d')!;
  }

  private handlePointer(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const padL = 46;
    const padR = 14;
    const x = e.clientX - rect.left;
    const t = Math.max(0, Math.min(1, (x - padL) / (rect.width - padL - padR)));
    this.onSeek?.(t);
  }

  draw(state: AppState): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, rect.width);
    const h = 200;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== h * dpr) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = h * dpr;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = themeColors();
    const padL = 46;
    const padR = 14;
    const padT = 14;
    const padB = 30;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, w, h);

    const fMin = 150;
    const fMax = 3500;
    const yOf = (f: number) =>
      padT +
      (1 - (Math.log(f) - Math.log(fMin)) / (Math.log(fMax) - Math.log(fMin))) * plotH;
    const xOf = (t: number) => padL + t * plotW;

    // 网格与 y 轴标签
    ctx.strokeStyle = c.grid;
    ctx.fillStyle = c.muted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    [200, 500, 1000, 2000, 3000].forEach((f) => {
      const y = yOf(f);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${f}`, padL - 6, y + 4);
    });
    ctx.textAlign = 'center';
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
      const x = xOf(t);
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.fillText(`${(t * state.duration).toFixed(2)}s`, x, h - 10);
    });

    // 三条 F 轨迹
    const colors = [c.f1, c.f2, c.f3];
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = colors[k];
      ctx.lineWidth = 2;
      ctx.beginPath();
      const steps = 120;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const regions = frameAt(state.timeline, t);
        const x = xOf(t);
        const y = yOf(regions[k].center);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 节点
    const keys = activeKeys(state.timeline);
    keys.forEach((key, idx) => {
      const x = xOf(key.pos);
      key.formants.forEach((r, k) => {
        const y = yOf(r.center);
        ctx.fillStyle = colors[k];
        ctx.beginPath();
        ctx.arc(x, y, idx === state.selectedNode ? 7 : 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = c.surface;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      // 节点标签：放在绘图区内下方空白带（与时间刻度错开），首尾向内侧对齐防裁切
      ctx.fillStyle = c.ink;
      ctx.font = '11px system-ui, sans-serif';
      const labelY = padT + plotH - 8;
      if (key.pos <= 0.01) {
        ctx.textAlign = 'left';
        ctx.fillText(key.label, x + 8, labelY);
      } else if (key.pos >= 0.99) {
        ctx.textAlign = 'right';
        ctx.fillText(key.label, x - 8, labelY);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(key.label, x, labelY);
      }
    });

    // 光标
    const xc = xOf(state.cursor);
    ctx.strokeStyle = c.cursor;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(xc, padT);
    ctx.lineTo(xc, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.cursor;
    ctx.beginPath();
    ctx.moveTo(xc, padT - 2);
    ctx.lineTo(xc - 6, padT - 10);
    ctx.lineTo(xc + 6, padT - 10);
    ctx.closePath();
    ctx.fill();
  }
}
