/**
 * flatMapView.ts —— 平面投影视图（Canvas 2D）。
 *
 * - equirect / azimuthal 两种投影，后者以指定地标为中心；
 * - 航线经 projectPath 断段，跨反经线不会出现横穿全图的直线；
 * - 指针拾取把像素位置换算回全局 t，读数仍由 GreatCircle.at(t) 给出，
 *   因此与球面视图严格同源；
 * - 方位投影外圆周是中心对跖点（方位奇点），终点手柄对齐到航线断段的
 *   实际末端，而不是投影公式在奇点处的任意方位。
 */
import {
  formatKm,
  formatLonLat,
  type GreatCircle,
  type LonLat,
} from './geo';
import { LANDMARKS, type Landmark } from './landmarks';
import {
  createProjector,
  graticuleLines,
  projectPath,
  type ProjectionId,
  type Projector,
  type Pt,
} from './projections';

export interface FlatMapOptions {
  onScrubStart: (t: number) => void;
  onScrubMove: (t: number) => void;
  onScrubEnd: () => void;
  onHover: (t: number | null) => void;
  formatTooltip: (t: number) => string;
}

interface HitPoint extends Pt {
  t: number;
}
interface HitSegment {
  pts: HitPoint[];
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COLORS = {
  plotFill: '#eaf2fb',
  plotBorder: '#c9d6e4',
  grid: '#d3dfec',
  gridMajor: '#b9cadd',
  polar: '#a98bd6',
  landmark: '#52514e',
  route: '#2a78d6',
  routeHalo: 'rgba(42,120,214,0.16)',
  start: '#1baf7a',
  end: '#eb6834',
  violet: '#6250d6',
  muted: '#898781',
};

export class FlatMapView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltipEl: HTMLDivElement;
  private readonly opts: FlatMapOptions;
  private readonly resizeObs: ResizeObserver;

  private gc: GreatCircle | null = null;
  private projection: ProjectionId = 'equirect';
  private center: LonLat = LANDMARKS[0].ll;
  private centerLandmark: Landmark = LANDMARKS[0];
  private cssW = 800;
  private cssH = 460;

  private scrubT = 0.4;
  private hoverT: number | null = null;
  private dragging = false;
  private hitSegments: HitSegment[] = [];
  /** 航线实际首/末端的投影像素（已处理投影奇点断段） */
  private routeEndpoints: { start: Pt; end: Pt } | null = null;

  constructor(canvas: HTMLCanvasElement, opts: FlatMapOptions) {
    this.canvas = canvas;
    this.opts = opts;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    canvas.style.touchAction = 'none';

    const parent = canvas.parentElement as HTMLElement;
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'viz-tooltip map-tooltip';
    this.tooltipEl.hidden = true;
    parent.appendChild(this.tooltipEl);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('pointerup', this.onWindowPointerUp);

    this.resizeObs = new ResizeObserver(() => {
      this.resize();
      this.draw();
    });
    this.resizeObs.observe(parent);
    this.resize();
  }

  setRoute(gc: GreatCircle | null): void {
    this.gc = gc;
    this.draw();
  }

  setProjection(id: ProjectionId, centerLandmark: Landmark): void {
    this.projection = id;
    this.centerLandmark = centerLandmark;
    this.center = centerLandmark.ll;
    this.draw();
  }

  setScrubT(t: number): void {
    this.scrubT = t;
    this.draw();
  }

  setHoverT(t: number | null): void {
    this.hoverT = t;
    this.draw();
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
    this.tooltipEl.remove();
  }

  // ---------------- 尺寸 ----------------

  private resize(): void {
    const parent = this.canvas.parentElement as HTMLElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------------- 绘制总流程 ----------------

  draw(): void {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    const p = createProjector(this.projection, w, h, this.center);

    // 投影区域底色 + 经纬网（裁剪在区域内）
    ctx.save();
    ctx.beginPath();
    if (p.bounds.kind === 'rect') {
      const b = p.bounds;
      this.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 10);
      ctx.fillStyle = COLORS.plotFill;
      ctx.fill();
      ctx.clip();
    } else {
      const b = p.bounds;
      ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.plotFill;
      ctx.fill();
      ctx.clip();
    }
    this.drawGraticule(p);
    ctx.restore();

    // 刻度文字必须在裁剪区外绘制，否则位于绘图矩形之外的坐标会被裁掉
    if (this.projection === 'equirect') this.drawEquirectAxisLabels(p);

    // 边界
    ctx.save();
    ctx.beginPath();
    if (p.bounds.kind === 'rect') {
      const b = p.bounds;
      this.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 10);
    } else {
      const b = p.bounds;
      ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
    }
    ctx.strokeStyle = COLORS.plotBorder;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();

    // 航线（同时构建拾取段与实际端点位置）
    this.drawRoute(p);

    // 已被手柄占用的矩形，供地标标签避让
    const occupied: Rect[] = [];
    for (const pos of [this.routeEndpointPos(p, 'start'), this.routeEndpointPos(p, 'end')]) {
      if (pos) occupied.push({ x: pos.x - 12, y: pos.y - 12, w: 24, h: 24 });
    }
    const scrubPos = this.pointAtT(p, this.scrubT);
    if (scrubPos && this.gc?.kind !== 'coincident') {
      occupied.push({ x: scrubPos.x - 11, y: scrubPos.y - 11, w: 22, h: 22 });
    }

    this.drawLandmarks(p, occupied);
    this.drawHandles(p);

    if (this.projection === 'azimuthal' && p.bounds.kind === 'circle') {
      ctx.fillStyle = COLORS.muted;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(
        `方位等距投影 · 中心：${this.centerLandmark.name}（外圆为中心的对跖点）`,
        p.bounds.cx,
        this.cssH - 8,
      );
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private drawGraticule(p: Projector): void {
    const ctx = this.ctx;
    for (const line of graticuleLines()) {
      const segs = projectPath(line.lls, p);
      const polar = Math.abs(line.lls[0].lat) === 66.56;
      for (const seg of segs) {
        ctx.beginPath();
        seg.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
        if (polar) {
          ctx.strokeStyle = COLORS.polar;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
        } else {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = line.major ? COLORS.gridMajor : COLORS.grid;
          ctx.lineWidth = line.major ? 1.25 : 0.8;
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawEquirectAxisLabels(p: Projector): void {
    if (p.bounds.kind !== 'rect') return;
    const b = p.bounds;
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.muted;
    ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let lon = -180; lon <= 180; lon += 30) {
      const pt = p.project({ lon, lat: 0 });
      const label =
        lon === 180
          ? '180°'
          : `${lon > 0 ? `${lon}E` : lon < 0 ? `${-lon}W` : '0°'}`;
      ctx.fillText(label, pt.x, b.y1 + 7);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let lat = -60; lat <= 60; lat += 30) {
      const pt = p.project({ lon: -180, lat });
      const label = lat > 0 ? `${lat}N` : lat < 0 ? `${-lat}S` : '0°';
      ctx.fillText(label, b.x0 - 7, pt.y);
    }
  }

  // ---------------- 地标与标签避让 ----------------

  private rectsOverlap(a: Rect, b: Rect, pad = 3): boolean {
    return !(
      a.x + a.w + pad < b.x ||
      b.x + b.w + pad < a.x ||
      a.y + a.h + pad < b.y ||
      b.y + b.h + pad < a.y
    );
  }

  private drawLandmarks(p: Projector, occupied: Rect[]): void {
    const ctx = this.ctx;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // 中心地标优先摆放，其余按固定顺序
    const ordered = [...LANDMARKS].sort((a, b) => {
      if (a.id === this.centerLandmark.id) return -1;
      if (b.id === this.centerLandmark.id) return 1;
      return 0;
    });

    for (const lm of ordered) {
      const pt = p.project(lm.ll);
      const isCenter = lm.id === this.centerLandmark.id;

      // 标签候选方位（相对点），逐个做碰撞检测。
      // 注意：自身点的碰撞盒在选位“之后”才加入 occupied，否则六个候选
      // 都会与自己的点相交，导致所有标签被误隐藏。
      const text = lm.name;
      const tw = ctx.measureText(text).width;
      const th = 15;
      const candidates: { dx: number; dy: number; align: CanvasTextAlign }[] = [
        { dx: 8, dy: -8, align: 'left' }, // 右上
        { dx: 8, dy: 9, align: 'left' }, // 右下
        { dx: -8, dy: -8, align: 'right' }, // 左上
        { dx: -8, dy: 9, align: 'right' }, // 左下
        { dx: 0, dy: -13, align: 'center' }, // 正上
        { dx: 0, dy: 14, align: 'center' }, // 正下
      ];

      let placed: Rect | null = null;
      let chosen: (typeof candidates)[number] | null = null;
      for (const c of candidates) {
        let rx: number;
        if (c.align === 'left') rx = pt.x + c.dx - 3;
        else if (c.align === 'right') rx = pt.x + c.dx + 3 - tw - 6;
        else rx = pt.x + c.dx - tw / 2 - 3;
        const ry = pt.y + c.dy - th / 2;
        const rect: Rect = { x: rx, y: ry, w: tw + 6, h: th };
        // 不超出 canvas
        if (
          rect.x < 2 ||
          rect.y < 2 ||
          rect.x + rect.w > this.cssW - 2 ||
          rect.y + rect.h > this.cssH - 18
        ) {
          continue;
        }
        if (!occupied.some((o) => this.rectsOverlap(rect, o, 2))) {
          placed = rect;
          chosen = c;
          break;
        }
      }

      // 点本身（在标签之前画，标签背景可轻微压住点边缘时以避让为准）
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isCenter ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isCenter ? 3.2 : 2.1, 0, Math.PI * 2);
      ctx.fillStyle = isCenter ? COLORS.violet : COLORS.landmark;
      ctx.fill();
      occupied.push({ x: pt.x - 5, y: pt.y - 5, w: 10, h: 10 });

      if (placed && chosen) {
        occupied.push(placed);
        ctx.fillStyle = 'rgba(252,252,251,0.88)';
        ctx.fillRect(placed.x, placed.y, placed.w, placed.h);
        ctx.textAlign = chosen.align;
        ctx.fillStyle = isCenter ? '#4a3aa7' : COLORS.landmark;
        ctx.fillText(text, pt.x + chosen.dx, pt.y + chosen.dy);
      }
    }
  }

  // ---------------- 航线 ----------------

  /** 与 projectPath 同样的 cut 规则，但保留每个点的全局 t */
  private buildHitSegments(p: Projector): HitSegment[] {
    const gc = this.gc;
    if (!gc) return [];
    const bounds = p.bounds;
    const shortSide =
      bounds.kind === 'rect'
        ? Math.min(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
        : bounds.r * 2;
    const maxJump = shortSide * 0.45;

    const result: HitSegment[] = [];
    let current: HitPoint[] = [];
    gc.samples.forEach((s, i) => {
      const pt0 = p.project(s.ll);
      const withT: HitPoint = { x: pt0.x, y: pt0.y, t: s.t };
      if (current.length === 0) {
        current.push(withT);
        return;
      }
      const prevSample = gc.samples[i - 1].ll;
      let cut = false;
      if (p.splitOnLonJump && Math.abs(s.ll.lon - prevSample.lon) > 180) {
        cut = true;
      } else {
        const last = current[current.length - 1];
        if (Math.hypot(pt0.x - last.x, pt0.y - last.y) > maxJump) cut = true;
      }
      if (cut) {
        if (current.length >= 2) result.push({ pts: current });
        current = [withT];
      } else {
        current.push(withT);
      }
    });
    if (current.length >= 2) result.push({ pts: current });
    return result;
  }

  private drawRoute(p: Projector): void {
    this.routeEndpoints = null;
    if (!this.gc || this.gc.kind === 'coincident') {
      this.hitSegments = [];
      return;
    }
    const gc = this.gc;
    const lls = gc.samples.map((s) => s.ll);
    const segs = projectPath(lls, p);
    this.hitSegments = this.buildHitSegments(p);

    if (this.hitSegments.length > 0) {
      const first = this.hitSegments[0].pts[0];
      const lastSeg = this.hitSegments[this.hitSegments.length - 1].pts;
      const last = lastSeg[lastSeg.length - 1];
      this.routeEndpoints = { start: { x: first.x, y: first.y }, end: { x: last.x, y: last.y } };
    }

    const ctx = this.ctx;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const trace = (width: number, style: string | CanvasGradient) => {
      ctx.beginPath();
      for (const seg of segs) {
        seg.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    trace(9, COLORS.routeHalo);
    trace(3, COLORS.route);

    // 断段端点小点，强调“断开但航线连续”
    if (p.id === 'equirect') {
      ctx.fillStyle = COLORS.route;
      for (const seg of segs) {
        for (const pt of [seg[0], seg[seg.length - 1]]) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /** 端点手柄的像素位置：优先对齐航线断段实际末端 */
  private routeEndpointPos(p: Projector, which: 'start' | 'end'): Pt | null {
    if (!this.gc) return null;
    if (this.routeEndpoints) return which === 'start' ? this.routeEndpoints.start : this.routeEndpoints.end;
    return p.project(which === 'start' ? this.gc.start : this.gc.end);
  }

  /** 任意 t 的手柄位置；t=0/1 时对齐断段末端，避开投影奇点抖动 */
  private pointAtT(p: Projector, t: number): Pt | null {
    if (!this.gc) return null;
    if (t <= 0) return this.routeEndpointPos(p, 'start') ?? p.project(this.gc.start);
    if (t >= 1) return this.routeEndpointPos(p, 'end') ?? p.project(this.gc.end);
    return p.project(this.gc.at(t).ll);
  }

  private drawHandles(p: Projector): void {
    if (!this.gc) return;
    const ctx = this.ctx;

    const drawEndpoint = (pos: Pt, color: string, char: string) => {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 9.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(char, pos.x, pos.y + 0.5);
    };

    if (this.gc.kind !== 'coincident') {
      const s = this.routeEndpointPos(p, 'start') ?? p.project(this.gc.start);
      const e = this.routeEndpointPos(p, 'end') ?? p.project(this.gc.end);
      drawEndpoint(s, COLORS.start, '起');
      drawEndpoint(e, COLORS.end, '终');
    } else {
      const pt = p.project(this.gc.start);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 9.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.violet;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('同', pt.x, pt.y + 0.5);
    }

    // 悬停点
    if (this.hoverT !== null && this.gc.kind !== 'coincident') {
      const hp = this.pointAtT(p, this.hoverT);
      if (hp) {
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.violet;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 位置指示（可拖拽）
    if (this.gc.kind !== 'coincident') {
      const sp = this.pointAtT(p, this.scrubT);
      if (sp) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = COLORS.violet;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.violet;
        ctx.fill();
      }
    }
  }

  // ---------------- 拾取 ----------------

  private eventPoint(e: PointerEvent): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** 像素 -> 全局 t：在所有“未被切割”的折线段上做点线段最近 */
  private nearestT(pos: Pt): { t: number; distPx: number } | null {
    if (this.hitSegments.length === 0) return null;
    let best: { t: number; distPx: number } | null = null;
    for (const seg of this.hitSegments) {
      for (let i = 1; i < seg.pts.length; i++) {
        const a = seg.pts[i - 1];
        const b = seg.pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let u = len2 === 0 ? 0 : ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2;
        u = Math.max(0, Math.min(1, u));
        const cx = a.x + dx * u;
        const cy = a.y + dy * u;
        const distPx = Math.hypot(pos.x - cx, pos.y - cy);
        if (!best || distPx < best.distPx) {
          best = { t: a.t + (b.t - a.t) * u, distPx };
        }
      }
    }
    return best;
  }

  private onPointerDown = (e: PointerEvent): void => {
    const hit = this.nearestT(this.eventPoint(e));
    if (hit && hit.distPx <= 16) {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.opts.onScrubStart(hit.t);
      this.showTooltip(e, hit.t);
      e.preventDefault();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const hit = this.nearestT(this.eventPoint(e));
    if (this.dragging) {
      if (hit) {
        this.opts.onScrubMove(hit.t);
        this.showTooltip(e, hit.t);
      }
      return;
    }
    if (hit && hit.distPx <= 14) {
      this.canvas.style.cursor = 'pointer';
      this.opts.onHover(hit.t);
      this.showTooltip(e, hit.t);
    } else {
      this.canvas.style.cursor = '';
      this.opts.onHover(null);
      this.tooltipEl.hidden = true;
    }
  };

  private onPointerLeave = (): void => {
    if (!this.dragging) {
      this.opts.onHover(null);
      this.tooltipEl.hidden = true;
    }
  };

  private onWindowPointerUp = (): void => {
    if (this.dragging) {
      this.dragging = false;
      this.opts.onScrubEnd();
      this.tooltipEl.hidden = true;
    }
  };

  private showTooltip(e: PointerEvent, t: number): void {
    if (!this.gc) return;
    this.tooltipEl.innerHTML = this.opts.formatTooltip(t);
    this.tooltipEl.hidden = false;
    const parent = this.canvas.parentElement as HTMLElement;
    const rect = parent.getBoundingClientRect();
    let x = e.clientX - rect.left + 14;
    let y = e.clientY - rect.top + 14;
    const tw = this.tooltipEl.offsetWidth;
    if (x + tw > rect.width - 8) x = e.clientX - rect.left - tw - 14;
    if (y + 60 > rect.height - 8) y -= 70;
    this.tooltipEl.style.left = `${Math.max(4, x)}px`;
    this.tooltipEl.style.top = `${Math.max(4, y)}px`;
  }
}

/** 供 main 使用的统一 tooltip 内容，保证两个视图文案完全一致 */
export function formatRouteTooltip(gc: GreatCircle, t: number): string {
  const p = gc.at(t);
  return `
    <div class="tt-dist">${formatKm(p.distanceKm)} <span>km</span></div>
    <div class="tt-row">${formatLonLat(p.ll, 3)}</div>
    <div class="tt-row tt-muted">全程 ${formatKm(gc.totalKm)} km · ${(t * 100).toFixed(1)}%</div>
  `;
}
