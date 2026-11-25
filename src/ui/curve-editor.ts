import { normalizeCurve } from '../audio/curve';
import type { CurvePoint } from '../audio/types';

/**
 * 分段曲线编辑器。
 * - 点击空白: 新增断点
 * - 拖动断点: 修改 (t, v)
 * - 双击非端点断点: 删除
 * 端点始终保留(保证 t=0 / t=1 存在)。
 */
export class CurveEditor {
  private ctx: CanvasRenderingContext2D;
  private points: CurvePoint[];
  private dragIndex = -1;
  private padding = 28;

  constructor(
    private canvas: HTMLCanvasElement,
    points: CurvePoint[],
    private onChange: (points: CurvePoint[]) => void,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no 2d context');
    this.ctx = c;
    this.points = points.map((p) => ({ ...p }));
    this.attach();
    this.draw();
  }

  setPoints(points: CurvePoint[]): void {
    this.points = normalizeCurve(points.map((p) => ({ ...p })));
    this.draw();
  }

  getPoints(): CurvePoint[] {
    return this.points.map((p) => ({ ...p }));
  }

  private get w(): number {
    return this.canvas.width;
  }
  private get h(): number {
    return this.canvas.height;
  }

  private toX(t: number): number {
    return this.padding + t * (this.w - 2 * this.padding);
  }
  private toY(v: number): number {
    return this.h - this.padding - v * (this.h - 2 * this.padding);
  }
  private toT(x: number): number {
    return (x - this.padding) / (this.w - 2 * this.padding);
  }
  private toV(y: number): number {
    return (this.h - this.padding - y) / (this.h - 2 * this.padding);
  }

  private hitTest(x: number, y: number): number {
    for (let i = 0; i < this.points.length; i++) {
      const px = this.toX(this.points[i].t);
      const py = this.toY(this.points[i].v);
      if (Math.hypot(x - px, y - py) <= 9) return i;
    }
    return -1;
  }

  private pointerPos(ev: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return { x: (ev.clientX - rect.left) * scaleX, y: (ev.clientY - rect.top) * scaleY };
  }

  private attach(): void {
    this.canvas.addEventListener('pointerdown', (ev) => {
      const { x, y } = this.pointerPos(ev);
      const hit = this.hitTest(x, y);
      if (hit >= 0) {
        this.dragIndex = hit;
        this.canvas.setPointerCapture(ev.pointerId);
      } else {
        const t = Math.min(1, Math.max(0, this.toT(x)));
        const v = Math.min(1, Math.max(0, this.toV(y)));
        this.points.push({ t, v });
        this.points = normalizeCurve(this.points);
        this.dragIndex = this.points.findIndex((p) => Math.abs(p.t - t) < 1e-6);
        this.canvas.setPointerCapture(ev.pointerId);
        this.emit();
      }
      this.draw();
    });

    this.canvas.addEventListener('pointermove', (ev) => {
      if (this.dragIndex < 0) return;
      const { x, y } = this.pointerPos(ev);
      const pt = this.points[this.dragIndex];
      const isEndpoint = this.dragIndex === 0 || this.dragIndex === this.points.length - 1;
      pt.t = isEndpoint ? pt.t : Math.min(1, Math.max(0, this.toT(x)));
      pt.v = Math.min(1, Math.max(0, this.toV(y)));
      this.points = normalizeCurve(this.points);
      this.dragIndex = this.points.indexOf(pt);
      this.emit();
      this.draw();
    });

    const endDrag = (ev: PointerEvent) => {
      if (this.dragIndex >= 0) {
        this.canvas.releasePointerCapture(ev.pointerId);
        this.dragIndex = -1;
      }
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    this.canvas.addEventListener('dblclick', (ev: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const x = (ev.clientX - rect.left) * scaleX;
      const y = (ev.clientY - rect.top) * scaleY;
      const hit = this.hitTest(x, y);
      if (hit > 0 && hit < this.points.length - 1) {
        this.points.splice(hit, 1);
        this.points = normalizeCurve(this.points);
        this.emit();
        this.draw();
      }
    });
  }

  private emit(): void {
    this.onChange(this.getPoints());
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // 背景网格
    ctx.strokeStyle = '#26314a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gx = this.toX(i / 4);
      const gy = this.toY(i / 4);
      ctx.beginPath();
      ctx.moveTo(gx, this.padding);
      ctx.lineTo(gx, this.h - this.padding);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(this.padding, gy);
      ctx.lineTo(this.w - this.padding, gy);
      ctx.stroke();
    }

    // 坐标轴文字
    ctx.fillStyle = '#7c8db0';
    ctx.font = '12px sans-serif';
    ctx.fillText('1.0', 4, this.toY(1) + 4);
    ctx.fillText('0', 12, this.toY(0) + 4);
    ctx.fillText('t=0', this.toX(0) - 10, this.h - 8);
    ctx.fillText('t=1', this.toX(1) - 10, this.h - 8);

    // 折线
    ctx.strokeStyle = '#7aa2ff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    this.points.forEach((p, i) => {
      const x = this.toX(p.t);
      const y = this.toY(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 断点
    this.points.forEach((p, i) => {
      const x = this.toX(p.t);
      const y = this.toY(p.v);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 || i === this.points.length - 1 ? '#ffb86b' : '#9fc0ff';
      ctx.fill();
      ctx.strokeStyle = '#0d1322';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}
