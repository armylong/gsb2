import {
  TAU,
  clamp,
  normalizeAngle,
  polarToXY,
  angleInArc,
  samplePolarSegment,
  type LocalPoint,
} from './geometry';
import {
  DISC_RADIUS,
  HUB_RADIUS,
  PATTERNS,
  getPattern,
  type Pattern,
} from './patterns';

export interface Dab {
  /** 陶盘局部坐标 */
  x: number;
  y: number;
  r: number;
  theta: number;
  /** 落笔时刷子半径 */
  width: number;
  /** 该点实际消耗的颜料 */
  cost: number;
}

export interface Stroke {
  colorIndex: number;
  width: number;
  dabs: Dab[];
  /** 整笔颜料消耗, 撤回时按它退还 */
  cost: number;
}

export interface PaintBucket {
  color: string;
  name: string;
  remaining: number;
  capacity: number;
}

export interface ScoreMark {
  kind: 'miss' | 'over';
  x: number;
  y: number;
}

export interface ScoreResult {
  totalCells: number;
  miss: number;
  over: number;
  coverage: number;
  overRate: number;
  pass: boolean;
  marks: ScoreMark[];
}

export interface SaveArchiveV1 {
  version: 1;
  savedAt: string;
  patternId: string;
  rpm: number;
  rotation: number;
  buckets: PaintBucket[];
  strokes: Stroke[];
}

interface ActivePointer {
  pointerId: number;
  stroke: Stroke;
  lastR: number;
  lastTheta: number;
  lastX: number;
  lastY: number;
}

export interface EngineCallbacks {
  onStateChange?: () => void;
}

const STORAGE_KEY = 'pottery-prototype-save-v1';
/** 每像素拖痕的颜料消耗系数 (面积近似: 宽度 × 长度 × 系数) */
const COST_PER_AREA = 0.012;
/** 评分采样: 径向步长 (像素) */
const SAMPLE_RADIAL_STEP = 8;
/** 标记点在局部空间的最小间距, 防止满屏圆点 */
const MARK_MIN_DIST = 22;
/** 判定"有颜料"的 alpha 阈值 */
const ALPHA_THRESHOLD = 40;

export const PALETTE: Array<{ color: string; name: string }> = [
  { color: '#c0392b', name: '朱砂红' },
  { color: '#2471a3', name: '青花蓝' },
  { color: '#1e8449', name: '松石绿' },
  { color: '#b9770e', name: '赭石黄' },
  { color: '#6c3483', name: '茄皮紫' },
  { color: '#17202a', name: '墨黑' },
];

const BUCKET_CAPACITY = 220;

export class PotteryEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** 逻辑尺寸 (CSS 像素) */
  readonly size = 620;
  private dpr = 1;

  private pattern: Pattern = PATTERNS[0];
  private strokes: Stroke[] = [];
  private buckets: PaintBucket[] = PALETTE.map((p) => ({
    ...p,
    remaining: BUCKET_CAPACITY,
    capacity: BUCKET_CAPACITY,
  }));

  colorIndex = 0;
  brushWidth = 14;

  /** 转速, 转/分钟, 0 = 静止 */
  rpm = 30;
  /** 当前盘转角 (弧度), 局部 0 度相对屏幕的偏转 */
  private rotation = 0;
  paused = false;

  /** 颜料离屏画布: 画在陶盘局部坐标系, 随盘一起旋转显示 */
  private paintCanvas: HTMLCanvasElement;
  private paintCtx: CanvasRenderingContext2D;
  /** 评分标记离屏画布, 同样在局部坐标系 */
  private markCanvas: HTMLCanvasElement;
  private markCtx: CanvasRenderingContext2D;

  private active: ActivePointer | null = null;
  private score: ScoreResult | null = null;
  private rafId = 0;
  private lastFrame = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cb: EngineCallbacks;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks = {}) {
    this.canvas = canvas;
    this.cb = cb;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2d 上下文');
    this.ctx = ctx;

    this.paintCanvas = document.createElement('canvas');
    this.paintCtx = this.setupLayer(this.paintCanvas);
    this.markCanvas = document.createElement('canvas');
    this.markCtx = this.setupLayer(this.markCanvas);

    this.resize();
    this.attachEvents();
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
  }

  // ---------- 画布与离屏层 ----------

  /** 离屏层按 DPR 建物理像素, 上下文缩放到逻辑坐标, 高分屏不发虚 */
  private setupLayer(c: HTMLCanvasElement): CanvasRenderingContext2D {
    c.width = Math.round(this.size * this.dpr);
    c.height = Math.round(this.size * this.dpr);
    c.style.width = `${this.size}px`;
    c.style.height = `${this.size}px`;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('无法创建离屏 2d 上下文');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  resize(): void {
    const oldDpr = this.dpr;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.size * this.dpr);
    this.canvas.height = Math.round(this.size * this.dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    if (oldDpr !== this.dpr) {
      this.setupLayer(this.paintCanvas);
      this.setupLayer(this.markCanvas);
      this.rebuildPaintLayer();
      this.renderMarks();
    }
  }

  // ---------- 坐标换算 ----------

  /** 屏幕客户端坐标 -> 陶盘局部坐标 (悬停预览等公开入口) */
  pointerToLocal(clientX: number, clientY: number): LocalPoint {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left - this.size / 2;
    const sy = clientY - rect.top - this.size / 2;
    const theta = Math.atan2(sy, sx) - this.rotation;
    const r = Math.hypot(sx, sy);
    return polarToXY(clamp(r, 0, DISC_RADIUS), theta);
  }

  /**
   * 屏幕指针坐标 -> 陶盘局部坐标。
   * 减去当前盘转角: 盘怎么转, 落笔都固定在陶盘自己的位置上,
   * 盘转回来时原来那一笔还在原处。
   */
  private toLocal(e: PointerEvent): LocalPoint {
    return this.pointerToLocal(e.clientX, e.clientY);
  }

  // ---------- 指针交互 ----------

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.active) return;
    const p = this.toLocal(e);
    if (Math.hypot(p.x, p.y) > DISC_RADIUS) return;
    if (this.buckets[this.colorIndex].remaining <= 0) {
      this.notify();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    const stroke: Stroke = {
      colorIndex: this.colorIndex,
      width: this.brushWidth,
      dabs: [],
      cost: 0,
    };
    this.strokes.push(stroke);
    this.score = null;
    this.active = {
      pointerId: e.pointerId,
      stroke,
      lastR: Math.hypot(p.x, p.y),
      lastTheta: Math.atan2(p.y, p.x),
      lastX: p.x,
      lastY: p.y,
    };
    this.extendStroke(p, true);
    this.notify();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.active || e.pointerId !== this.active.pointerId) return;
    const p = this.toLocal(e);
    this.extendStroke(p, false);
    this.notify();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.active || e.pointerId !== this.active.pointerId) return;
    if (this.active.stroke.dabs.length === 0) {
      this.strokes.pop();
    } else {
      this.scheduleSave();
    }
    this.active = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放时忽略 */
    }
    this.notify();
  };

  /**
   * 从上一个采样点插值到新位置并落笔。
   * - 子采样步长 <= 半个笔宽, 拖得再快也是连续实心痕迹
   * - 角度按最短绕向 wrap, 跨零度只走短弧, 不横穿盘心
   * - 颜料按实际拖过的面积计费, 用完即停笔
   */
  private extendStroke(p: LocalPoint, isFirst: boolean): void {
    const a = this.active;
    if (!a) return;
    const bucket = this.buckets[a.stroke.colorIndex];
    const halfW = a.stroke.width / 2;

    const r = Math.hypot(p.x, p.y);
    const theta = Math.atan2(p.y, p.x);

    if (isFirst) {
      this.paintDab(p.x, p.y, halfW, bucket.color);
      const cost = halfW * halfW * Math.PI * COST_PER_AREA;
      const used = Math.min(cost, bucket.remaining);
      bucket.remaining -= used;
      a.stroke.cost += used;
      a.stroke.dabs.push({
        x: p.x,
        y: p.y,
        r,
        theta,
        width: a.stroke.width,
        cost: used,
      });
      a.lastR = r;
      a.lastTheta = theta;
      a.lastX = p.x;
      a.lastY = p.y;
      return;
    }

    const samples = samplePolarSegment(
      { r: a.lastR, theta: a.lastTheta },
      { r, theta },
      Math.max(2, halfW),
    );

    for (const s of samples) {
      if (bucket.remaining <= 0) break;
      const xy = polarToXY(s.r, s.theta);
      // 段长即局部空间实际移动距离, 颜料费用与盘转不转、转多快无关
      const segLen = Math.hypot(xy.x - a.lastX, xy.y - a.lastY);
      const cost = segLen * a.stroke.width * COST_PER_AREA;
      const used = Math.min(cost, bucket.remaining);
      this.paintSegment(
        a.lastX,
        a.lastY,
        xy.x,
        xy.y,
        halfW,
        bucket.color,
      );
      bucket.remaining -= used;
      a.stroke.cost += used;
      a.stroke.dabs.push({
        x: xy.x,
        y: xy.y,
        r: s.r,
        theta: s.theta,
        width: a.stroke.width,
        cost: used,
      });
      a.lastR = s.r;
      a.lastTheta = s.theta;
      a.lastX = xy.x;
      a.lastY = xy.y;
    }
  }

  /** 离屏颜料层上画一个圆点 (下笔第一点) */
  private paintDab(x: number, y: number, halfW: number, color: string): void {
    const ctx = this.paintCtx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.size / 2 + x, this.size / 2 + y, halfW, 0, TAU);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(this.size / 2 + x, this.size / 2 + y, halfW, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  /** 离屏颜料层上画一段圆头线段; clip 到陶盘圆盘内, 颜料不会出界 */
  private paintSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfW: number,
    color: string,
  ): void {
    const ctx = this.paintCtx;
    const c = this.size / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, DISC_RADIUS, 0, TAU);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = halfW * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(c + x0, c + y0);
    ctx.lineTo(c + x1, c + y1);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 撤回 / 清空 / 换色 ----------

  /** 撤回最近一笔: 整层重放保证覆盖顺序, 同时退还该笔全部颜料 */
  undo(): void {
    const stroke = this.strokes.pop();
    if (!stroke) return;
    this.buckets[stroke.colorIndex].remaining = clamp(
      this.buckets[stroke.colorIndex].remaining + stroke.cost,
      0,
      this.buckets[stroke.colorIndex].capacity,
    );
    this.rebuildPaintLayer();
    this.score = null;
    this.scheduleSave();
    this.notify();
  }

  /** 清空盘面, 所有颜料桶补满 */
  clearBoard(): void {
    this.strokes = [];
    this.active = null;
    this.score = null;
    for (const b of this.buckets) b.remaining = b.capacity;
    this.rebuildPaintLayer();
    this.scheduleSave();
    this.notify();
  }

  selectColor(i: number): void {
    this.colorIndex = clamp(i, 0, this.buckets.length - 1);
    this.notify();
  }

  setBrushWidth(w: number): void {
    this.brushWidth = clamp(w, 4, 40);
    this.notify();
  }

  // ---------- 转速控制 ----------

  setRpm(rpm: number): void {
    this.rpm = clamp(rpm, 0, 120);
    this.notify();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.notify();
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  // ---------- 花纹 ----------

  getPattern(): Pattern {
    return this.pattern;
  }

  setPattern(id: string): void {
    this.pattern = getPattern(id);
    this.score = null;
    this.scheduleSave();
    this.notify();
  }

  // ---------- 重放与评分 ----------

  /** 按笔画顺序整层重放: 后画的颜色自然覆盖先画的颜色 */
  private rebuildPaintLayer(): void {
    const ctx = this.paintCtx;
    const c = this.size / 2;
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, DISC_RADIUS, 0, TAU);
    ctx.clip();
    for (const stroke of this.strokes) {
      if (stroke.dabs.length === 0) continue;
      const color = this.buckets[stroke.colorIndex].color;
      if (stroke.dabs.length === 1) {
        const d = stroke.dabs[0];
        ctx.beginPath();
        ctx.arc(c + d.x, c + d.y, stroke.width / 2, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
        continue;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(c + stroke.dabs[0].x, c + stroke.dabs[0].y);
      for (let i = 1; i < stroke.dabs.length; i++) {
        ctx.lineTo(c + stroke.dabs[i].x, c + stroke.dabs[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private alphaAtLocal(x: number, y: number): number {
    const c = this.size / 2;
    // 离屏层物理像素按 DPR 放大, 取像素要换算回设备坐标
    const px = Math.round(clamp((c + x) * this.dpr, 0, this.paintCanvas.width - 1));
    const py = Math.round(clamp((c + y) * this.dpr, 0, this.paintCanvas.height - 1));
    const data = this.paintCtx.getImageData(px, py, 1, 1).data;
    return data[3];
  }

  /**
   * 完成检查。完全在陶盘局部坐标系采样, 与盘当前转角、是否暂停无关:
   * - 圆带内且不在留白弧: 应有颜料, 没有 => 漏涂 (蓝)
   * - 圆带外 (盘内) 或落在留白弧: 应留白, 有颜料 => 涂出 (红)
   */
  checkCompletion(): ScoreResult {
    const p = this.pattern;
    let totalCells = 0;
    let miss = 0;
    let over = 0;
    const marks: ScoreMark[] = [];

    const consider = (x: number, y: number, expectPaint: boolean, kind: ScoreMark['kind']): void => {
      const painted = this.alphaAtLocal(x, y) >= ALPHA_THRESHOLD;
      if (expectPaint) {
        totalCells++;
        if (!painted) {
          miss++;
          this.pushMark(marks, { kind, x, y });
        }
      } else if (painted) {
        over++;
        this.pushMark(marks, { kind, x, y });
      }
    };

    for (let r = HUB_RADIUS; r <= DISC_RADIUS; r += SAMPLE_RADIAL_STEP) {
      const angleCount = Math.max(12, Math.round((TAU * r) / (SAMPLE_RADIAL_STEP * 2)));
      for (let i = 0; i < angleCount; i++) {
        const theta = (i / angleCount) * TAU;
        const xy = polarToXY(r, theta);
        const inBand = r >= p.rMin && r <= p.rMax;
        const inBlank = p.blanks.some((b) => angleInArc(theta, b.start, b.length));
        if (inBand && !inBlank) {
          consider(xy.x, xy.y, true, 'miss');
        } else {
          consider(xy.x, xy.y, false, 'over');
        }
      }
    }

    const coverage = totalCells === 0 ? 0 : 1 - miss / totalCells;
    const overRate = totalCells === 0 ? (over > 0 ? 1 : 0) : over / totalCells;
    const result: ScoreResult = {
      totalCells,
      miss,
      over,
      coverage,
      overRate,
      pass: miss === 0 && over === 0,
      marks,
    };
    this.score = result;
    this.renderMarks();
    this.notify();
    return result;
  }

  clearScore(): void {
    this.score = null;
    this.markCtx.clearRect(0, 0, this.size, this.size);
    this.notify();
  }

  private pushMark(marks: ScoreMark[], mark: ScoreMark): void {
    for (const m of marks) {
      if (Math.hypot(m.x - mark.x, m.y - mark.y) < MARK_MIN_DIST) return;
    }
    marks.push(mark);
  }

  private renderMarks(): void {
    const ctx = this.markCtx;
    const c = this.size / 2;
    ctx.clearRect(0, 0, this.size, this.size);
    if (!this.score) return;
    for (const m of this.score.marks) {
      ctx.beginPath();
      ctx.arc(c + m.x, c + m.y, 7, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = m.kind === 'miss' ? '#2e86de' : '#e74c3c';
      ctx.stroke();
    }
  }

  // ---------- 存档 / 读档 ----------

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveToStorage();
    }, 400);
  }

  private buildArchive(): SaveArchiveV1 {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      patternId: this.pattern.id,
      rpm: this.rpm,
      rotation: normalizeAngle(this.rotation),
      buckets: this.buckets.map((b) => ({ ...b })),
      strokes: this.strokes.map((s) => ({
        ...s,
        dabs: s.dabs.map((d) => ({ ...d })),
      })),
    };
  }

  saveToStorage(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.buildArchive()));
      return true;
    } catch {
      return false;
    }
  }

  exportFile(): void {
    const blob = new Blob([JSON.stringify(this.buildArchive(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pottery-save-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importFile(file: File): Promise<void> {
    const text = await file.text();
    const archive = this.validateArchive(JSON.parse(text) as unknown);
    this.loadArchive(archive);
  }

  hasStorageSave(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      this.loadArchive(this.validateArchive(JSON.parse(raw) as unknown));
      return true;
    } catch (err) {
      console.warn('读取本地存档失败', err);
      return false;
    }
  }

  private validateArchive(raw: unknown): SaveArchiveV1 {
    if (typeof raw !== 'object' || raw === null) throw new Error('存档不是对象');
    const a = raw as Record<string, unknown>;
    if (a.version !== 1) throw new Error('不支持的存档版本');
    if (typeof a.patternId !== 'string' || !PATTERNS.some((p) => p.id === a.patternId)) {
      throw new Error('存档中的花纹不存在');
    }
    if (!Array.isArray(a.strokes) || !Array.isArray(a.buckets)) {
      throw new Error('存档缺少笔画或颜料数据');
    }
    const buckets = a.buckets as unknown[];
    if (buckets.length !== PALETTE.length) throw new Error('颜料桶数量不匹配');
    for (const b of buckets) {
      const bb = b as Record<string, unknown>;
      if (
        typeof bb.color !== 'string' ||
        typeof bb.remaining !== 'number' ||
        typeof bb.capacity !== 'number'
      ) {
        throw new Error('颜料桶数据损坏');
      }
    }
    for (const s of a.strokes as unknown[]) {
      const ss = s as Record<string, unknown>;
      if (
        typeof ss.colorIndex !== 'number' ||
        ss.colorIndex < 0 ||
        ss.colorIndex >= PALETTE.length ||
        !Array.isArray(ss.dabs)
      ) {
        throw new Error('笔画数据损坏');
      }
      for (const d of ss.dabs as unknown[]) {
        const dd = d as Record<string, unknown>;
        if (
          typeof dd.x !== 'number' ||
          typeof dd.y !== 'number' ||
          typeof dd.width !== 'number' ||
          typeof dd.cost !== 'number'
        ) {
          throw new Error('笔画采样点损坏');
        }
      }
    }
    return raw as SaveArchiveV1;
  }

  private loadArchive(a: SaveArchiveV1): void {
    this.active = null;
    this.pattern = getPattern(a.patternId);
    this.rpm = clamp(typeof a.rpm === 'number' ? a.rpm : 30, 0, 120);
    this.rotation = typeof a.rotation === 'number' ? normalizeAngle(a.rotation) : 0;
    this.buckets = a.buckets.map((b, i) => ({
      color: PALETTE[i].color,
      name: PALETTE[i].name,
      remaining: clamp(b.remaining, 0, b.capacity),
      capacity: b.capacity,
    }));
    this.strokes = a.strokes.map((s) => ({
      colorIndex: s.colorIndex,
      width: s.width,
      cost: s.cost,
      dabs: s.dabs.map((d) => ({ ...d })),
    }));
    this.score = null;
    this.rebuildPaintLayer();
    this.markCtx.clearRect(0, 0, this.size, this.size);
    this.scheduleSave();
    this.notify();
  }

  // ---------- 状态读取 (供 UI) ----------

  getStrokes(): Stroke[] {
    return this.strokes;
  }

  getBuckets(): PaintBucket[] {
    return this.buckets;
  }

  getScore(): ScoreResult | null {
    return this.score;
  }

  getRotation(): number {
    return this.rotation;
  }

  private notify(): void {
    this.cb.onStateChange?.();
  }

  // ---------- 渲染循环 ----------

  private frame = (now: number): void => {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.paused && this.rpm > 0) {
      this.rotation = normalizeAngle(this.rotation + (this.rpm / 60) * TAU * dt);
    }
    this.render();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const ctx = this.ctx;
    const c = this.size / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);

    // 陶盘底座
    ctx.beginPath();
    ctx.arc(c, c, DISC_RADIUS, 0, TAU);
    ctx.fillStyle = '#e8dcc4';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#b8a583';
    ctx.stroke();

    // 盘上随盘旋转的参考纹理 (局部 0 度用高亮刻度标出)
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(this.rotation);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (DISC_RADIUS - 14), Math.sin(a) * (DISC_RADIUS - 14));
      ctx.lineTo(Math.cos(a) * (DISC_RADIUS - 6), Math.sin(a) * (DISC_RADIUS - 6));
      ctx.strokeStyle = i === 0 ? '#c0392b' : 'rgba(120, 100, 70, 0.45)';
      ctx.lineWidth = i === 0 ? 3 : 1.5;
      ctx.stroke();
    }
    for (const rr of [HUB_RADIUS, 80, 160, 230]) {
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.strokeStyle = 'rgba(120, 100, 70, 0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 目标花纹引导
    this.drawGuide(ctx);
    // 颜料层与评分标记都在局部坐标系, 跟着盘一起转; 显式缩到逻辑尺寸
    ctx.drawImage(this.paintCanvas, -c, -c, this.size, this.size);
    ctx.drawImage(this.markCanvas, -c, -c, this.size, this.size);
    ctx.restore();

    // 盘心轴 (不转)
    ctx.beginPath();
    ctx.arc(c, c, HUB_RADIUS, 0, TAU);
    ctx.fillStyle = '#8d7b5f';
    ctx.fill();
    ctx.strokeStyle = '#6b5d47';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, 6, 0, TAU);
    ctx.fillStyle = '#4a3f30';
    ctx.fill();

    // 悬停刷子预览 (屏幕坐标, 不跟盘转)
    this.drawCursorPreview();
  }

  private drawGuide(ctx: CanvasRenderingContext2D): void {
    const p = this.pattern;
    ctx.save();
    // 允许涂色的圆带: 半透明绿
    ctx.beginPath();
    ctx.arc(0, 0, p.rMax, 0, TAU);
    ctx.arc(0, 0, p.rMin, 0, TAU);
    ctx.fillStyle = 'rgba(39, 174, 96, 0.14)';
    ctx.fill('evenodd');

    // 留白弧: 半透明红扇形环, 支持跨零度 (start+length 可 > 2π)
    for (const b of p.blanks) {
      ctx.beginPath();
      ctx.arc(0, 0, p.rMax, b.start, b.start + b.length);
      ctx.arc(0, 0, p.rMin, b.start + b.length, b.start, true);
      ctx.closePath();
      ctx.fillStyle = 'rgba(231, 76, 60, 0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(192, 57, 43, 0.8)';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 圆带边界虚线
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(30, 132, 73, 0.85)';
    for (const rr of [p.rMin, p.rMax]) {
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private hoverLocal: LocalPoint | null = null;

  setHover(local: LocalPoint | null): void {
    this.hoverLocal = local;
  }

  private drawCursorPreview(): void {
    if (!this.hoverLocal || this.active) return;
    const c = this.size / 2;
    const sx = c + this.hoverLocal.x * Math.cos(this.rotation) - this.hoverLocal.y * Math.sin(this.rotation);
    const sy = c + this.hoverLocal.x * Math.sin(this.rotation) + this.hoverLocal.y * Math.cos(this.rotation);
    if (Math.hypot(this.hoverLocal.x, this.hoverLocal.y) > DISC_RADIUS) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(sx, sy, this.brushWidth / 2, 0, TAU);
    ctx.strokeStyle = this.buckets[this.colorIndex].color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
