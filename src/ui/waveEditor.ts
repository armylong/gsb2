/**
 * 波形编辑器：
 * - 主画布把一周期首尾各复制 1/4 拼在两侧，接缝在中央，可直接查看周期性；
 * - 接缝放大条单独编辑首尾各 1/8 周期；
 * - 拖动绘制，Shift 平滑，峰值钳位，撤销栈。
 */
import { TABLE_SIZE } from '../dsp/wavetable';

const PAD = 10;
const QUARTER = TABLE_SIZE / 4;
const EIGHTH = TABLE_SIZE / 8;

export class WaveEditor {
  private canvas: HTMLCanvasElement;
  private seamCanvas: HTMLCanvasElement;
  private table: Float64Array;
  private undoStack: Float64Array[] = [];
  private painting = false;
  private smooth = false;
  private lastIndex = -1;
  private dpr = 1;
  onChange: ((table: Float64Array) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, seamCanvas: HTMLCanvasElement, initial: Float64Array) {
    this.canvas = canvas;
    this.seamCanvas = seamCanvas;
    this.table = initial.slice();
    this.bind();
    this.resize();
    this.draw();
  }

  get value(): Float64Array {
    return this.table;
  }

  setValue(table: Float64Array, recordUndo = false): void {
    if (recordUndo) this.pushUndo();
    this.table = table.slice();
    this.draw();
    this.onChange?.(this.table);
  }

  reset(table: Float64Array): void {
    this.undoStack = [];
    this.table = table.slice();
    this.draw();
    this.onChange?.(this.table);
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev) {
      this.table = prev;
      this.draw();
      this.onChange?.(this.table);
    }
  }

  private pushUndo(): void {
    this.undoStack.push(this.table.slice());
    if (this.undoStack.length > 20) this.undoStack.shift();
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.seamCanvas]) {
      const cssW = c.clientWidth || (c.parentElement?.clientWidth ?? 800);
      c.width = Math.round(cssW * this.dpr);
    }
  }

  private bind(): void {
    window.addEventListener('resize', () => {
      this.resize();
      this.draw();
    });
    const start = (e: PointerEvent) => {
      this.painting = true;
      this.smooth = e.shiftKey;
      this.pushUndo();
      this.lastIndex = -1;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      this.paintAt(e);
    };
    const move = (e: PointerEvent) => {
      if (!this.painting) return;
      this.smooth = e.shiftKey;
      this.paintAt(e);
    };
    const end = () => {
      if (this.painting) {
        this.painting = false;
        this.lastIndex = -1;
        this.onChange?.(this.table);
      }
    };
    for (const c of [this.canvas, this.seamCanvas]) {
      c.addEventListener('pointerdown', start);
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
    }
  }

  private eventToTableIndex(e: PointerEvent, seam: boolean): { index: number; value: number } | null {
    const c = seam ? this.seamCanvas : this.canvas;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const value = Math.max(-1, Math.min(1, 1 - (2 * (y - PAD)) / (h - 2 * PAD)));

    if (seam) {
      // 左半显示尾部 1/8，右半显示开头 1/8
      const rel = x / w;
      if (rel < 0.5) {
        const idx = Math.round(TABLE_SIZE - EIGHTH + rel * 2 * EIGHTH);
        return { index: idx % TABLE_SIZE, value };
      }
      const idx = Math.round((rel - 0.5) * 2 * EIGHTH);
      return { index: Math.min(TABLE_SIZE - 1, idx), value };
    }
    // 主画布：中央 TABLE_SIZE 个采样点，两侧各 1/4 阴影
    const usableW = w - 2 * PAD;
    const centerW = usableW * (TABLE_SIZE / (TABLE_SIZE + 2 * QUARTER));
    const rel = (x - PAD - (usableW - centerW) / 2) / centerW;
    const idx = Math.round(rel * TABLE_SIZE);
    if (idx < 0 || idx >= TABLE_SIZE) return null;
    return { index: idx, value };
  }

  private paintAt(e: PointerEvent): void {
    const seam = e.target === this.seamCanvas;
    const hit = this.eventToTableIndex(e, seam);
    if (!hit) return;
    if (this.smooth && this.lastIndex >= 0) {
      // 平滑模式：在两点间做余弦插值过渡，避免硬折角
      const a = this.lastIndex;
      const b = hit.index;
      const va = this.table[a];
      const steps = Math.min(64, Math.abs(b - a) + 1);
      const dir = b >= a ? 1 : -1;
      for (let s = 0; s < steps; s++) {
        const idx = a + dir * s;
        if (idx < 0 || idx >= TABLE_SIZE) continue;
        const t = s / Math.max(1, steps - 1);
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
        this.table[idx] = va * (1 - w) + hit.value * w;
      }
    } else {
      // 普通模式：影响 ±2 采样的小刷，曲线更连贯
      for (let d = -2; d <= 2; d++) {
        const idx = hit.index + d;
        if (idx >= 0 && idx < TABLE_SIZE) {
          const w = 1 - Math.abs(d) / 3;
          this.table[idx] = this.table[idx] * (1 - w * 0.7) + hit.value * w * 0.7;
        }
      }
      this.table[hit.index] = hit.value;
    }
    this.lastIndex = hit.index;
    this.draw();
    this.onChange?.(this.table);
  }

  draw(): void {
    this.drawMain();
    this.drawSeam();
  }

  private drawMain(): void {
    const c = this.canvas;
    const ctx = c.getContext('2d')!;
    const w = c.width;
    const h = c.height;
    const s = this.dpr;
    ctx.scale(s, s);
    ctx.clearRect(0, 0, w, h);
    const cssW = w / s;
    const cssH = h / s;

    // 零轴与网格
    ctx.strokeStyle = '#2a2c33';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, cssH / 2);
    ctx.lineTo(cssW - PAD, cssH / 2);
    ctx.stroke();

    const usableW = cssW - 2 * PAD;
    const centerW = usableW * (TABLE_SIZE / (TABLE_SIZE + 2 * QUARTER));
    const centerX = PAD + (usableW - centerW) / 2;
    const xPerSample = centerW / TABLE_SIZE;

    // 两侧阴影区（首尾复制区）
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(PAD, PAD, (usableW - centerW) / 2, cssH - 2 * PAD);
    ctx.fillRect(centerX + centerW, PAD, (usableW - centerW) / 2, cssH - 2 * PAD);

    // 接缝竖线（中央）
    ctx.strokeStyle = '#3a3d45';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centerX, PAD);
    ctx.lineTo(centerX, cssH - PAD);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#898781';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('接缝（首尾相连处）', centerX + 6, PAD + 12);

    const yOf = (v: number) => cssH / 2 - v * ((cssH - 2 * PAD) / 2);
    const drawWave = (offsetSample: number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      const total = TABLE_SIZE + 2 * QUARTER;
      for (let i = 0; i < total; i++) {
        const sampleIdx = ((i - QUARTER + offsetSample) % TABLE_SIZE + TABLE_SIZE) % TABLE_SIZE;
        const x = centerX + (i - QUARTER) * xPerSample;
        const y = yOf(this.table[sampleIdx]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawWave(0, '#199e70', 2);
  }

  private drawSeam(): void {
    const c = this.seamCanvas;
    const ctx = c.getContext('2d')!;
    const w = c.width;
    const h = c.height;
    const s = this.dpr;
    ctx.scale(s, s);
    ctx.clearRect(0, 0, w, h);
    const cssW = w / s;
    const cssH = h / s;

    ctx.strokeStyle = '#2a2c33';
    ctx.beginPath();
    ctx.moveTo(PAD, cssH / 2);
    ctx.lineTo(cssW - PAD, cssH / 2);
    ctx.stroke();

    const midX = cssW / 2;
    ctx.strokeStyle = '#c98500';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(midX, PAD);
    ctx.lineTo(midX, cssH - PAD);
    ctx.stroke();
    ctx.setLineDash([]);

    const yOf = (v: number) => cssH / 2 - v * ((cssH - 2 * PAD) / 2);
    const xPerSample = (cssW - 2 * PAD) / (2 * EIGHTH);
    ctx.strokeStyle = '#3987e5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const points: { idx: number; side: number }[] = [];
    for (let i = 0; i < EIGHTH; i++) points.push({ idx: TABLE_SIZE - EIGHTH + i, side: 0 });
    for (let i = 0; i < EIGHTH; i++) points.push({ idx: i, side: 1 });
    points.forEach((p, i) => {
      const x = PAD + i * xPerSample;
      const y = yOf(this.table[p.idx]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#898781';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('尾', PAD, PAD + 12);
    ctx.fillText('头', midX + 6, PAD + 12);
  }
}
