/**
 * 频谱对照视图（两块画布共用同一对数频率坐标）：
 * - 理论面板：波形 DFT 谐波茎，基带内 aqua、越界 yellow，预测折叠位置 orange 虚线；
 * - 实测面板：FFT 谱线 blue，实测真峰按 harmonic/alias/extra 分类打点，缺失空心圈。
 * 悬停有十字线与 tooltip；所有信息同时进谐波明细表，颜色不是唯一通道。
 */
import type { MeasurementResult } from '../dsp/spectrum';
import { downsampleSpectrum } from '../dsp/spectrum';
import { midiToName, freqToMidi } from '../dsp/notes';

const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 14;
const PAD_B = 30;
const DB_MIN = -105;
const DB_MAX = -5;

const COLORS = {
  ideal: '#199e70',
  measured: '#3987e5',
  alias: '#d95926',
  extra: '#e66767',
  missing: '#b9bac0',
  nyq: '#c98500',
  grid: '#2a2c33',
  axis: '#3a3d45',
  muted: '#898781',
  ink: '#f0efec',
};

export class SpectrumView {
  private idealCanvas: HTMLCanvasElement;
  private measuredCanvas: HTMLCanvasElement;
  private tooltip: HTMLDivElement;
  private result: MeasurementResult | null = null;
  private dpr = 1;

  constructor(
    idealCanvas: HTMLCanvasElement,
    measuredCanvas: HTMLCanvasElement,
    tooltip: HTMLDivElement,
  ) {
    this.idealCanvas = idealCanvas;
    this.measuredCanvas = measuredCanvas;
    this.tooltip = tooltip;
    window.addEventListener('resize', () => this.render());
    this.measuredCanvas.addEventListener('pointermove', (e) => this.onHover(e));
    this.measuredCanvas.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true;
    });
  }

  setResult(result: MeasurementResult): void {
    this.result = result;
    this.resizeCanvases();
    this.render();
  }

  private resizeCanvases(): void {
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.idealCanvas, this.measuredCanvas]) {
      const cssW = c.clientWidth || c.parentElement!.clientWidth;
      c.width = Math.round(cssW * this.dpr);
    }
  }

  private geom(canvas: HTMLCanvasElement) {
    const cssW = canvas.width / this.dpr;
    const cssH = canvas.height / this.dpr;
    const fMin = 20;
    const fMax = this.result ? this.result.sampleRate / 2 : 24000;
    const xOf = (f: number) =>
      PAD_L +
      ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin))) *
        (cssW - PAD_L - PAD_R);
    const yOf = (db: number) =>
      PAD_T +
      ((DB_MAX - db) / (DB_MAX - DB_MIN)) * (cssH - PAD_T - PAD_B);
    return { cssW, cssH, fMin, fMax, xOf, yOf };
  }

  render(): void {
    if (!this.result) {
      this.drawEmpty(this.idealCanvas, '选择波形与音高后点击“离线测量”');
      this.drawEmpty(this.measuredCanvas, '选择波形与音高后点击“离线测量”');
      return;
    }
    this.resizeCanvases();
    this.drawIdeal();
    this.drawMeasured();
  }

  private drawEmpty(canvas: HTMLCanvasElement, text: string): void {
    const dpr = this.dpr || 1;
    const cssW = canvas.clientWidth || 800;
    canvas.width = Math.round(cssW * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, canvas.height / dpr);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(text, PAD_L, 60);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, g: ReturnType<SpectrumView['geom']>): void {
    const { cssW, cssH, xOf, yOf } = g;
    // 水平 dB 网格
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.muted;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (let db = -100; db <= 0; db += 20) {
      const y = yOf(db);
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(cssW - PAD_R, y);
      ctx.stroke();
      ctx.fillText(`${db}`, PAD_L - 6, y + 3);
    }
    // 垂直对数网格：每十倍程标 1/2/5×10^n
    ctx.textAlign = 'center';
    const ticks: number[] = [];
    for (let decade = 1; decade <= 4; decade++) {
      for (const m of [1, 2, 5]) {
        const f = m * Math.pow(10, decade);
        if (f >= g.fMin && f <= g.fMax) ticks.push(f);
      }
    }
    for (const f of ticks) {
      const x = xOf(f);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, PAD_T);
      ctx.lineTo(x, cssH - PAD_B);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, cssH - PAD_B + 14);
    }
    // 奈奎斯特线
    const nyq = this.result!.sampleRate / 2;
    const xNyq = xOf(nyq);
    ctx.strokeStyle = COLORS.nyq;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xNyq, PAD_T);
    ctx.lineTo(xNyq, cssH - PAD_B);
    ctx.stroke();
    ctx.fillStyle = COLORS.nyq;
    ctx.textAlign = 'right';
    ctx.fillText(`奈奎斯特 ${nyq.toLocaleString()}Hz`, xNyq - 4, PAD_T + 10);

    // 轴基线
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(PAD_L, cssH - PAD_B);
    ctx.lineTo(cssW - PAD_R, cssH - PAD_B);
    ctx.stroke();
  }

  private drawIdeal(): void {
    const canvas = this.idealCanvas;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = this.geom(canvas);
    ctx.clearRect(0, 0, g.cssW, g.cssH);
    this.drawGrid(ctx, g);

    const r = this.result!;
    // 越界谐波的预测折叠位置：橙色虚线茎（仅画理论上有分量的）
    for (const row of r.rows.filter((x) => x.status === 'folded')) {
      const x = g.xOf(row.foldedFreq!);
      ctx.strokeStyle = COLORS.alias;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, g.yOf(row.idealDb));
      ctx.lineTo(x, g.yOf(DB_MIN));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 理论谐波茎：基带内 aqua，越界 yellow（半透明，表示“放不出来”）
    for (const h of r.idealHarmonics) {
      const x = g.xOf(h.freq);
      ctx.strokeStyle = h.inBand ? COLORS.ideal : 'rgba(201,133,0,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, g.yOf(h.db));
      ctx.lineTo(x, g.yOf(DB_MIN));
      ctx.stroke();
      ctx.fillStyle = h.inBand ? COLORS.ideal : COLORS.nyq;
      ctx.beginPath();
      ctx.arc(x, g.yOf(h.db), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 当前基频标注
    const x0 = g.xOf(r.f0);
    ctx.fillStyle = COLORS.ink;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`f₀ ${r.f0.toFixed(1)}Hz · ${midiToName(Math.round(freqToMidi(r.f0)))}`, x0 + 5, PAD_T + 12);
  }

  private drawMeasured(): void {
    const canvas = this.measuredCanvas;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = this.geom(canvas);
    ctx.clearRect(0, 0, g.cssW, g.cssH);
    this.drawGrid(ctx, g);

    const r = this.result!;
    const ds = downsampleSpectrum(r.spectrumFreq, r.spectrumDb, 1400);

    // 实测谱线（2px，blue）
    ctx.strokeStyle = COLORS.measured;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < ds.freq.length; i++) {
      if (ds.freq[i] < g.fMin) continue;
      const x = g.xOf(ds.freq[i]);
      const y = g.yOf(ds.db[i]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 分类峰打点（表面色 2px 环，保证重叠可辨）
    for (const p of r.classified) {
      const x = g.xOf(p.freq);
      const y = g.yOf(p.db);
      const color =
        p.kind === 'harmonic' ? COLORS.ideal : p.kind === 'alias' ? COLORS.alias : COLORS.extra;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#1e2026';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // 缺失谐波：空心灰圈（理论有、实测无）
    for (const row of r.rows.filter((x) => x.status === 'missing')) {
      const x = g.xOf(row.idealFreq);
      const y = g.yOf(row.idealDb);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.missing;
      ctx.stroke();
    }
  }

  private onHover(e: PointerEvent): void {
    if (!this.result) return;
    const canvas = this.measuredCanvas;
    const rect = canvas.getBoundingClientRect();
    const g = this.geom(canvas);
    const x = e.clientX - rect.left;
    // 反查最近的频率
    const ratio = (x - PAD_L) / (g.cssW - PAD_L - PAD_R);
    if (ratio < 0 || ratio > 1) {
      this.tooltip.hidden = true;
      return;
    }
    const f = Math.pow(
      10,
      Math.log10(g.fMin) + ratio * (Math.log10(g.fMax) - Math.log10(g.fMin)),
    );
    // 找最近分类峰
    const nearest = [...this.result.classified]
      .sort((a, b) => Math.abs(a.freq - f) - Math.abs(b.freq - f))[0];
    const lines: string[] = [`光标频率 ${f.toFixed(1)} Hz`];
    if (nearest && Math.abs(nearest.freq - f) < g.cssW / 12) {
      const label =
        nearest.kind === 'harmonic'
          ? `真实谐波 k=${nearest.harmonicK}`
          : nearest.kind === 'alias'
            ? `折叠分量 k=${nearest.harmonicK}（原 ${nearest.sourceFreq!.toFixed(0)}Hz 折回）`
            : '多出的真峰（理论无对应）';
      lines.push(`${label}`, `${nearest.freq.toFixed(1)} Hz · ${nearest.db.toFixed(1)} dBFS`);
    }
    this.tooltip.textContent = lines.join('\n');
    this.tooltip.hidden = false;
    const tx = Math.min(rect.width - 220, x + 14);
    this.tooltip.style.left = `${tx}px`;
    this.tooltip.style.top = `${e.clientY - rect.top + 12}px`;
  }
}
