/**
 * render.ts — Canvas 天平渲染器
 * 只负责画：底座、立柱、会倾斜的横梁、吊盘、盘上编号包裹。
 * 不持有游戏规则；点击盘上包裹时回调 onPackageClick（用于取下）。
 */
import type { Outcome } from './engine';

export interface ScaleView {
  left: number[];
  right: number[];
  /** 已确认记录的结果；null 表示当前未确认摆法（保持水平） */
  outcome: Outcome | null;
}

interface HitRegion {
  pkg: number;
  x: number;
  y: number;
  size: number;
}

const VW = 760;
const VH = 440;
const PIVOT_X = 380;
const PIVOT_Y = 168;
const BEAM_HALF = 226;
const PAN_DROP = 84;

export class ScaleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private angle = 0;
  private targetAngle = 0;
  private view: ScaleView = { left: [], right: [], outcome: null };
  private hits: HitRegion[] = [];
  private cssW = VW;
  private cssH = VH;
  private dpr = 1;
  private hoverPkg: number | null = null;
  onPackageClick: ((pkg: number) => void) | null = null;
  private resizeObs: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    canvas.addEventListener('click', this.handleClick);
    canvas.addEventListener('pointermove', this.handleMove);
    canvas.addEventListener('pointerleave', this.handleLeave);
    const loop = (): void => {
      // 阻尼趋近目标角，带轻微过冲感
      this.angle += (this.targetAngle - this.angle) * 0.16;
      if (Math.abs(this.targetAngle - this.angle) < 0.0004) this.angle = this.targetAngle;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('pointermove', this.handleMove);
    this.canvas.removeEventListener('pointerleave', this.handleLeave);
  }

  setView(view: ScaleView, animate = true): void {
    this.view = view;
    const maxTilt = 0.17;
    this.targetAngle = view.outcome === null ? 0 : view.outcome === 1 ? -maxTilt : view.outcome === -1 ? maxTilt : 0;
    if (!animate) this.angle = this.targetAngle;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(280, rect.width || VW);
    this.cssH = Math.max(300, rect.height || VH);
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
  }

  private toLogical(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(this.cssW / VW, this.cssH / VH);
    const ox = (this.cssW - VW * scale) / 2;
    const oy = (this.cssH - VH * scale) / 2;
    const x = (e.clientX - rect.left - ox) / scale;
    const y = (e.clientY - rect.top - oy) / scale;
    return { x, y };
  }

  private handleClick = (e: MouseEvent): void => {
    const { x, y } = this.toLogical(e);
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (Math.abs(x - h.x) <= h.size / 2 + 4 && Math.abs(y - h.y) <= h.size / 2 + 4) {
        this.onPackageClick?.(h.pkg);
        return;
      }
    }
  };

  private handleMove = (e: MouseEvent): void => {
    const { x, y } = this.toLogical(e);
    let hover: number | null = null;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (Math.abs(x - h.x) <= h.size / 2 + 4 && Math.abs(y - h.y) <= h.size / 2 + 4) {
        hover = h.pkg;
        break;
      }
    }
    this.hoverPkg = hover;
    this.canvas.style.cursor = hover !== null ? 'pointer' : 'default';
  };

  private handleLeave = (): void => {
    this.hoverPkg = null;
  };

  /* ---------------- 绘制 ---------------- */

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const scale = Math.min(this.cssW / VW, this.cssH / VH);
    const ox = (this.cssW - VW * scale) / 2;
    const oy = (this.cssH - VH * scale) / 2;
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    this.hits = [];
    this.drawGround();
    this.drawPost();
    this.drawBeamAndPans();
  }

  private drawGround(): void {
    const ctx = this.ctx;
    // 地面阴影
    ctx.save();
    ctx.fillStyle = 'rgba(60, 44, 28, 0.10)';
    ctx.beginPath();
    ctx.ellipse(PIVOT_X, 418, 190, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    // 底座
    const g = ctx.createLinearGradient(0, 392, 0, 420);
    g.addColorStop(0, '#8a6238');
    g.addColorStop(1, '#5f4124');
    ctx.fillStyle = g;
    this.roundRect(PIVOT_X - 118, 392, 236, 22, 11);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    this.roundRect(PIVOT_X - 104, 395, 208, 6, 3);
    ctx.fill();
    ctx.restore();
  }

  private drawPost(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(PIVOT_X - 9, 0, PIVOT_X + 9, 0);
    g.addColorStop(0, '#5f4124');
    g.addColorStop(0.5, '#9a7042');
    g.addColorStop(1, '#5f4124');
    ctx.fillStyle = g;
    this.roundRect(PIVOT_X - 9, PIVOT_Y + 6, 18, 392 - PIVOT_Y, 8);
    ctx.fill();
    // 支点三角
    ctx.fillStyle = '#c9973f';
    ctx.strokeStyle = '#8a6420';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PIVOT_X - 20, PIVOT_Y + 14);
    ctx.lineTo(PIVOT_X + 20, PIVOT_Y + 14);
    ctx.lineTo(PIVOT_X, PIVOT_Y - 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 支点铆钉
    ctx.fillStyle = '#7a551c';
    ctx.beginPath();
    ctx.arc(PIVOT_X, PIVOT_Y + 4, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  private beamEndpoints(): { lx: number; ly: number; rx: number; ry: number } {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    // 左端 (-BEAM_HALF, 0) 旋转后 y = -BEAM_HALF * sin(angle)?
    // 点 (x,0) 旋转: x'=x cos, y'=x sin。左端 x=-H => y'=-H*sin。
    return {
      lx: PIVOT_X - BEAM_HALF * cos,
      ly: PIVOT_Y - BEAM_HALF * sin,
      rx: PIVOT_X + BEAM_HALF * cos,
      ry: PIVOT_Y + BEAM_HALF * sin,
    };
  }

  private drawBeamAndPans(): void {
    const e = this.beamEndpoints();
    const ctx = this.ctx;

    // 横梁
    ctx.save();
    ctx.translate(PIVOT_X, PIVOT_Y);
    ctx.rotate(this.angle);
    const bg = ctx.createLinearGradient(0, -8, 0, 8);
    bg.addColorStop(0, '#a9794a');
    bg.addColorStop(0.5, '#7c5530');
    bg.addColorStop(1, '#5d3f22');
    ctx.fillStyle = bg;
    this.roundRect(-BEAM_HALF - 14, -7, BEAM_HALF * 2 + 28, 14, 7);
    ctx.fill();
    // 两端吊环
    ctx.fillStyle = '#e3b45f';
    ctx.strokeStyle = '#8a6420';
    ctx.lineWidth = 2;
    for (const x of [-BEAM_HALF, BEAM_HALF]) {
      ctx.beginPath();
      ctx.arc(x, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // 两个吊盘（盘体保持水平，位置跟随梁端）
    this.drawPan(e.lx, e.ly, this.view.left, 'left');
    this.drawPan(e.rx, e.ry, this.view.right, 'right');
  }

  private drawPan(endX: number, endY: number, pkgs: number[], _which: 'left' | 'right'): void {
    const ctx = this.ctx;
    const panY = endY + PAN_DROP;
    const rx = 90;
    const ry = 17;

    // 吊绳
    ctx.strokeStyle = 'rgba(74, 55, 33, 0.75)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(endX, endY + 4);
    ctx.lineTo(endX - rx + 14, panY - 4);
    ctx.moveTo(endX, endY + 4);
    ctx.lineTo(endX + rx - 14, panY - 4);
    ctx.stroke();

    // 盘体阴影
    ctx.fillStyle = 'rgba(60, 44, 28, 0.12)';
    ctx.beginPath();
    ctx.ellipse(endX, panY + 16, rx * 0.92, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    // 盘碗
    const g = ctx.createLinearGradient(0, panY - ry, 0, panY + ry + 14);
    g.addColorStop(0, '#f0cd86');
    g.addColorStop(0.55, '#d39e4c');
    g.addColorStop(1, '#a9762c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(endX, panY + 4, rx, ry + 6, 0, 0, Math.PI);
    // 用半椭圆画碗身
    ctx.moveTo(endX - rx, panY);
    ctx.quadraticCurveTo(endX, panY + 34, endX + rx, panY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8a6420';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 盘沿
    ctx.fillStyle = '#e8bd6b';
    ctx.beginPath();
    ctx.ellipse(endX, panY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8a6420';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(endX - rx * 0.25, panY - 5, rx * 0.45, ry * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // 包裹（分行摆放）
    this.layoutPackagesOnPan(endX, panY, pkgs);
  }

  private layoutPackagesOnPan(cx: number, panY: number, pkgs: number[]): void {
    if (pkgs.length === 0) return;
    // 本游戏包裹数 ≤ 5：始终单排、按数量收缩，避免多行包裹与横梁重叠。
    const baseSize = 50;
    const gap = 8;
    const maxRowWidth = 176;
    const size = Math.max(24, Math.min(baseSize, (maxRowWidth - (pkgs.length - 1) * gap) / pkgs.length));
    const rowW = pkgs.length * size + (pkgs.length - 1) * gap;
    const y = panY - 12 - size / 2;
    pkgs.forEach((pkg, ci) => {
      const x = cx - rowW / 2 + size / 2 + ci * (size + gap);
      this.drawPackage(x, y, size, pkg);
      this.hits.push({ pkg, x, y, size });
    });
  }

  private drawPackage(x: number, y: number, size: number, pkg: number): void {
    const ctx = this.ctx;
    const hovered = this.hoverPkg === pkg;
    const lift = hovered ? -4 : 0;
    y += lift;
    ctx.save();
    // 阴影
    ctx.fillStyle = 'rgba(50, 35, 18, 0.18)';
    this.roundRect(x - size / 2 + 2, y + size / 2 - 4, size, size * 0.28, 6);
    ctx.fill();

    const r = size * 0.16;
    const g = ctx.createLinearGradient(x, y - size / 2, x, y + size / 2);
    g.addColorStop(0, hovered ? '#e8b574' : '#ddab6b');
    g.addColorStop(1, hovered ? '#c98d45' : '#bd8240');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#8a5a24';
    ctx.lineWidth = 2;
    this.roundRect(x - size / 2, y - size / 2, size, size, r);
    ctx.fill();
    ctx.stroke();

    // 封箱带
    ctx.strokeStyle = 'rgba(122, 80, 32, 0.55)';
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.beginPath();
    ctx.moveTo(x, y - size / 2 + 2);
    ctx.lineTo(x, y + size / 2 - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - size / 2 + 2, y - size * 0.18);
    ctx.lineTo(x + size / 2 - 2, y - size * 0.18);
    ctx.stroke();

    // 编号圆牌
    const br = size * 0.3;
    ctx.fillStyle = '#fff7e8';
    ctx.strokeStyle = '#7c4f1c';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y + size * 0.12, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#43301a';
    ctx.font = `700 ${Math.round(size * 0.4)}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(pkg + 1), x, y + size * 0.14);

    if (hovered) {
      ctx.fillStyle = 'rgba(67, 48, 26, 0.75)';
      ctx.font = `600 ${Math.max(11, Math.round(size * 0.24))}px system-ui, sans-serif`;
      ctx.fillText('点击取下', x, y - size / 2 - 10);
    }
    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
