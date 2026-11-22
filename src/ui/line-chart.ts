// Minimal dark-theme multi-series line chart on a 2D canvas.
// Palette validated with the dataviz skill validator (dark surface #1a1a19):
// blue #3987e5 / orange #d95926 pass every CVD + contrast gate.

export interface Series {
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

const COLORS = {
  surface: '#1a1a19',
  ink: '#f0efec',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
};

export class LineChart {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private series: Series[] = [];
  private hoverX: number | null = null;
  private pad = { l: 44, r: 10, t: 12, b: 26 };
  xLabel = 'frame';
  yLabel = '';
  private onHover: ((idx: number | null) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - rect.left;
      this.draw();
      this.onHover?.(this.hoverIndex());
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.draw();
      this.onHover?.(null);
    });
  }

  setHoverCallback(cb: (idx: number | null) => void): void {
    this.onHover = cb;
  }

  setSeries(series: Series[]): void {
    this.series = series;
    this.draw();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.draw();
  }

  private plotRect() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    return {
      x: this.pad.l,
      y: this.pad.t,
      w: Math.max(10, w - this.pad.l - this.pad.r),
      h: Math.max(10, h - this.pad.t - this.pad.b),
    };
  }

  private bounds() {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = 0;
    let y1 = -Infinity;
    for (const s of this.series) {
      for (const p of s.points) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    if (!isFinite(x0)) {
      x0 = 0;
      x1 = 1;
      y1 = 1;
    }
    if (y1 <= 0) y1 = 1;
    return { x0, x1, y0, y1: y1 * 1.08 };
  }

  private hoverIndex(): number | null {
    if (this.hoverX === null || this.series.length === 0) return null;
    const r = this.plotRect();
    const b = this.bounds();
    if (this.hoverX < r.x || this.hoverX > r.x + r.w) return null;
    const t = (this.hoverX - r.x) / r.w;
    const x = b.x0 + t * (b.x1 - b.x0);
    const pts = this.series[0].points;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].x - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  draw(): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, w, h);
    if (this.series.length === 0) return;

    const r = this.plotRect();
    const b = this.bounds();
    const sx = (x: number) => r.x + ((x - b.x0) / (b.x1 - b.x0)) * r.w;
    const sy = (y: number) => r.h * (1 - (y - b.y0) / (b.y1 - b.y0)) + r.y;

    // Grid + y ticks (5 levels).
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const yv = b.y0 + ((b.y1 - b.y0) * i) / 4;
      const y = sy(yv);
      ctx.strokeStyle = i === 0 ? COLORS.axis : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = 'right';
      ctx.fillText(yv.toFixed(yv < 10 ? 1 : 0), r.x - 6, y);
    }

    // x ticks (up to 6).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ticks = Math.min(6, Math.max(2, Math.floor(r.w / 60)));
    for (let i = 0; i <= ticks; i++) {
      const xv = Math.round(b.x0 + ((b.x1 - b.x0) * i) / ticks);
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(String(xv), sx(xv), r.y + r.h + 6);
    }
    ctx.fillText(this.xLabel, r.x + r.w / 2, h - 4);

    // Series lines, 2px.
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = sx(p.x);
        const y = sy(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Crosshair + hover markers + tooltip.
    const idx = this.hoverIndex();
    if (idx !== null) {
      const x = sx(this.series[0].points[idx].x);
      ctx.strokeStyle = COLORS.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, r.y);
      ctx.lineTo(x, r.y + r.h);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const s of this.series) {
        const p = s.points[idx];
        if (!p) continue;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(x, sy(p.y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      const lines = [`frame ${this.series[0].points[idx].x}`];
      for (const s of this.series) {
        const p = s.points[idx];
        if (p) lines.push(`${s.label}: ${p.y.toFixed(2)}`);
      }
      this.drawTooltip(x, lines);
    }

    // Legend (top-left inside plot), two series max expected.
    let lx = r.x + 8;
    const ly = r.y + 4;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const s of this.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly, 14, 3);
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(s.label, lx + 18, ly + 1);
      lx += ctx.measureText(s.label).width + 40;
    }
  }

  private drawTooltip(px: number, lines: string[]): void {
    const ctx = this.ctx;
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
    const lineH = 14;
    const h = lines.length * lineH + 8;
    const r = this.plotRect();
    let x = px + 8;
    if (x + w > r.x + r.w) x = px - w - 8;
    const y = r.y + 6;
    ctx.fillStyle = 'rgba(13,13,13,0.92)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(x + 4, y);
    ctx.arcTo(x + w, y, x + w, y + h, 4);
    ctx.arcTo(x + w, y + h, x, y + h, 4);
    ctx.arcTo(x, y + h, x, y, 4);
    ctx.arcTo(x, y, x + w, y, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => {
      ctx.fillText(l, x + 7, y + 8 + i * lineH);
    });
  }
}
