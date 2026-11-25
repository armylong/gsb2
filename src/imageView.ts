import type { Calibration } from './calibration';
import { projectPoint } from './calibration';
import type { MarkedLine, PlacedBox, Vec2 } from './types';

export type Mode = 'select' | 'drawX' | 'drawZ' | 'drawRef' | 'place';

export interface ImageViewCallbacks {
  onLineCreated: (line: MarkedLine) => void;
  onLinesChanged: () => void;       // 拖动结束等结构性变化
  onLinesChanging: () => void;      // 拖动中(轻量刷新)
  onSelectLine: (id: number | null) => void;
  onPlaceBox: (imgPt: Vec2) => void;
  onStatus: (msg: string) => void;
}

const COLORS: Record<string, string> = {
  X: '#e8912d',
  Z: '#2dc4c4',
  REF: '#5cc45c',
};

/**
 * 图像视图:标注全部保存在图像像素坐标系中,
 * 屏幕缩放/平移只是显示变换,不改变任何标注数据。
 */
export class ImageView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: HTMLCanvasElement | null = null;

  // 视图变换:screen = image * scale + offset
  private scale = 1;
  private offset: Vec2 = { x: 0, y: 0 };

  mode: Mode = 'select';
  lines: MarkedLine[] = [];
  boxes: PlacedBox[] = [];
  calibration: Calibration | null = null;
  selectedId: number | null = null;

  private imgW = 0;
  private imgH = 0;

  // 拖动状态
  private drag:
    | { kind: 'pan'; start: Vec2; offset0: Vec2 }
    | { kind: 'draw'; p1: Vec2; p2: Vec2 }
    | { kind: 'endpoint'; line: MarkedLine; which: 1 | 2 }
    | { kind: 'line'; line: MarkedLine; last: Vec2 }
    | null = null;

  constructor(canvas: HTMLCanvasElement, private cb: ImageViewCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.attach();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
  }

  setImage(img: HTMLCanvasElement) {
    this.image = img;
    this.imgW = img.width;
    this.imgH = img.height;
    this.fit();
  }

  get imageSize() { return { w: this.imgW, h: this.imgH }; }

  fit() {
    if (!this.image) return;
    const r = this.canvas.getBoundingClientRect();
    this.scale = Math.min(r.width / this.imgW, r.height / this.imgH) * 0.96;
    this.offset = {
      x: (r.width - this.imgW * this.scale) / 2,
      y: (r.height - this.imgH * this.scale) / 2,
    };
    this.render();
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.render();
  }

  toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.scale + this.offset.x, y: p.y * this.scale + this.offset.y };
  }
  toImage(p: Vec2): Vec2 {
    return { x: (p.x - this.offset.x) / this.scale, y: (p.y - this.offset.y) / this.scale };
  }

  private canvasPt(e: PointerEvent | WheelEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private attach() {
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', (e) => this.onUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  private hitEndpoint(sp: Vec2): { line: MarkedLine; which: 1 | 2 } | null {
    const tol = 10;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const ln = this.lines[i];
      for (const which of [1, 2] as const) {
        const ep = this.toScreen(which === 1 ? ln.p1 : ln.p2);
        if (Math.hypot(ep.x - sp.x, ep.y - sp.y) <= tol) return { line: ln, which };
      }
    }
    return null;
  }

  private hitLine(sp: Vec2): MarkedLine | null {
    const tol = 7;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const ln = this.lines[i];
      const a = this.toScreen(ln.p1);
      const b = this.toScreen(ln.p2);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      let t = ((sp.x - a.x) * dx + (sp.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(sp.x - (a.x + t * dx), sp.y - (a.y + t * dy));
      if (d <= tol) return ln;
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.canvasPt(e);

    if (this.mode === 'place') {
      if (e.button === 0) this.cb.onPlaceBox(this.toImage(sp));
      return;
    }
    if (this.mode === 'drawX' || this.mode === 'drawZ' || this.mode === 'drawRef') {
      if (e.button !== 0) return;
      const ip = this.toImage(sp);
      this.drag = { kind: 'draw', p1: ip, p2: ip };
      return;
    }
    // select 模式
    if (e.button === 1) {
      this.drag = { kind: 'pan', start: sp, offset0: { ...this.offset } };
      return;
    }
    const ep = this.hitEndpoint(sp);
    if (ep) {
      this.selectedId = ep.line.id;
      this.cb.onSelectLine(ep.line.id);
      this.drag = { kind: 'endpoint', line: ep.line, which: ep.which };
      this.render();
      return;
    }
    const ln = this.hitLine(sp);
    if (ln) {
      this.selectedId = ln.id;
      this.cb.onSelectLine(ln.id);
      this.drag = { kind: 'line', line: ln, last: this.toImage(sp) };
      this.render();
      return;
    }
    // 空白:平移
    this.selectedId = null;
    this.cb.onSelectLine(null);
    this.drag = { kind: 'pan', start: sp, offset0: { ...this.offset } };
    this.render();
  }

  private onMove(e: PointerEvent) {
    const sp = this.canvasPt(e);
    if (!this.drag) {
      // 状态栏显示图像坐标
      const ip = this.toImage(sp);
      if (ip.x >= 0 && ip.x < this.imgW && ip.y >= 0 && ip.y < this.imgH) {
        this.cb.onStatus(`图像坐标: (${ip.x.toFixed(0)}, ${ip.y.toFixed(0)})`);
      } else {
        this.cb.onStatus('');
      }
      return;
    }
    switch (this.drag.kind) {
      case 'pan':
        this.offset = {
          x: this.drag.offset0.x + sp.x - this.drag.start.x,
          y: this.drag.offset0.y + sp.y - this.drag.start.y,
        };
        break;
      case 'draw':
        this.drag.p2 = this.toImage(sp);
        break;
      case 'endpoint': {
        const ip = this.toImage(sp);
        if (this.drag.which === 1) this.drag.line.p1 = ip;
        else this.drag.line.p2 = ip;
        this.cb.onLinesChanging();
        break;
      }
      case 'line': {
        const ip = this.toImage(sp);
        const dx = ip.x - this.drag.last.x;
        const dy = ip.y - this.drag.last.y;
        this.drag.line.p1.x += dx; this.drag.line.p1.y += dy;
        this.drag.line.p2.x += dx; this.drag.line.p2.y += dy;
        this.drag.last = ip;
        this.cb.onLinesChanging();
        break;
      }
    }
    this.render();
  }

  private nextId = 1;
  setNextId(v: number) { this.nextId = v; }
  getNextId() { return this.nextId; }

  private onUp(_e: PointerEvent) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.kind === 'draw') {
      const len = Math.hypot(d.p2.x - d.p1.x, d.p2.y - d.p1.y);
      if (len > 5) {
        const dir = this.mode === 'drawX' ? 'X' : this.mode === 'drawZ' ? 'Z' : 'REF';
        const line: MarkedLine = { id: this.nextId++, p1: d.p1, p2: d.p2, dir };
        this.cb.onLineCreated(line);
      }
    } else if (d.kind === 'endpoint' || d.kind === 'line') {
      this.cb.onLinesChanged();
    }
    this.render();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const sp = this.canvasPt(e);
    const factor = Math.exp(-e.deltaY * 0.0012);
    const newScale = Math.max(0.05, Math.min(40, this.scale * factor));
    // 以光标为中心缩放:光标下的图像点保持不动
    const ip = this.toImage(sp);
    this.scale = newScale;
    this.offset = { x: sp.x - ip.x * this.scale, y: sp.y - ip.y * this.scale };
    this.render();
  }

  // ---------- 渲染 ----------

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);

    if (this.image) {
      ctx.imageSmoothingEnabled = this.scale < 3;
      ctx.drawImage(
        this.image,
        this.offset.x, this.offset.y,
        this.imgW * this.scale, this.imgH * this.scale,
      );
      // 图像边框
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.offset.x, this.offset.y, this.imgW * this.scale, this.imgH * this.scale);
    }

    const cal = this.calibration;

    // 地平线
    if (cal?.horizon) {
      const { a, b, c } = cal.horizon;
      // 与图像边界求交
      const pts: Vec2[] = [];
      const W = this.imgW, H = this.imgH;
      const edges: [Vec2, Vec2][] = [
        [{ x: 0, y: 0 }, { x: W, y: 0 }],
        [{ x: W, y: 0 }, { x: W, y: H }],
        [{ x: W, y: H }, { x: 0, y: H }],
        [{ x: 0, y: H }, { x: 0, y: 0 }],
      ];
      for (const [e1, e2] of edges) {
        const d1 = a * e1.x + b * e1.y + c;
        const d2 = a * e2.x + b * e2.y + c;
        if (d1 * d2 < 0) {
          const t = d1 / (d1 - d2);
          pts.push({ x: e1.x + t * (e2.x - e1.x), y: e1.y + t * (e2.y - e1.y) });
        }
      }
      if (pts.length === 2) {
        const s1 = this.toScreen(pts[0]);
        const s2 = this.toScreen(pts[1]);
        ctx.strokeStyle = 'rgba(255,80,80,0.8)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,80,80,0.9)';
        ctx.font = '11px sans-serif';
        ctx.fillText('地平线(推断)', (s1.x + s2.x) / 2 + 6, (s1.y + s2.y) / 2 - 6);
      }
    }

    // 灭点
    for (const [vp, color, name] of [
      [cal?.vpX, COLORS.X, 'Vx'],
      [cal?.vpZ, COLORS.Z, 'Vz'],
    ] as const) {
      if (!vp) continue;
      const sp = this.toScreen(vp);
      if (sp.x < -1e5 || sp.x > 1e5 || sp.y < -1e5 || sp.y > 1e5) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sp.x - 8, sp.y); ctx.lineTo(sp.x + 8, sp.y);
      ctx.moveTo(sp.x, sp.y - 8); ctx.lineTo(sp.x, sp.y + 8);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '11px sans-serif';
      ctx.fillText(name, sp.x + 10, sp.y - 6);
    }

    // 已放置盒子(投影到图像)
    if (cal) {
      ctx.lineWidth = 1.6;
      for (const box of this.boxes) {
        const corners: Vec2[] = [];
        let ok = true;
        for (const dy of [0, box.h]) {
          for (const dz of [-box.d / 2, box.d / 2]) {
            for (const dx of [-box.w / 2, box.w / 2]) {
              const p = projectPoint(
                [box.gx + dx, dy, box.gz + dz], cal, this.imgW, this.imgH,
              );
              if (!p) { ok = false; break; }
              corners.push(p);
            }
            if (!ok) break;
          }
          if (!ok) break;
        }
        if (!ok) continue;
        const idx = (y: number, z: number, x: number) => y * 4 + z * 2 + x;
        const E = [
          [idx(0,0,0), idx(0,0,1)], [idx(0,0,1), idx(0,1,1)], [idx(0,1,1), idx(0,1,0)], [idx(0,1,0), idx(0,0,0)],
          [idx(1,0,0), idx(1,0,1)], [idx(1,0,1), idx(1,1,1)], [idx(1,1,1), idx(1,1,0)], [idx(1,1,0), idx(1,0,0)],
          [idx(0,0,0), idx(1,0,0)], [idx(0,0,1), idx(1,0,1)], [idx(0,1,0), idx(1,1,0)], [idx(0,1,1), idx(1,1,1)],
        ];
        ctx.strokeStyle = '#e05ce0';
        for (const [i, j] of E) {
          const a = this.toScreen(corners[i]);
          const b = this.toScreen(corners[j]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // 标注线
    for (const ln of this.lines) {
      const a = this.toScreen(ln.p1);
      const b = this.toScreen(ln.p2);
      const color = COLORS[ln.dir];
      const selected = ln.id === this.selectedId;
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // 端点
      for (const p of [a, b]) {
        ctx.fillStyle = selected ? '#fff' : color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, selected ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // 标签
      ctx.fillStyle = color;
      ctx.font = '11px sans-serif';
      ctx.fillText(
        `${ln.dir}#${ln.id}`,
        (a.x + b.x) / 2 + 6,
        (a.y + b.y) / 2 - 6,
      );
    }

    // 正在画的线
    if (this.drag?.kind === 'draw') {
      const a = this.toScreen(this.drag.p1);
      const b = this.toScreen(this.drag.p2);
      const dir = this.mode === 'drawX' ? 'X' : this.mode === 'drawZ' ? 'Z' : 'REF';
      ctx.strokeStyle = COLORS[dir];
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
