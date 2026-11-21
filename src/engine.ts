/**
 * 水油格子仿真引擎（纯逻辑，不依赖 DOM / canvas）
 *
 * 模型约定
 * --------
 * 1. 每个非墙格子容量为 1，含两份独立储量 w（水）与 o（油），0 <= w, o 且 w + o <= 1。
 * 2. 一个仿真步分两个阶段，顺序固定且与渲染频率无关：
 *    A. 排水阶段：按格子索引升序遍历所有「打开」的排水口，按比例抽走液体。
 *    B. 流动阶段：对每条边做一次松弛（relax = 0.5），边的遍历方向每步反转一次：
 *       - step 偶数：逐行扫描，水平边先右后左、竖直边先下后上（顺时针）；
 *       - step 奇数：全部反向（逆时针）。
 *      反转扫描是确定性的，且消除了长期的单向漂移。
 * 3. 松弛规则：
 *    - 水平相邻：水、油各自以两个格子的平均值为目标；
 *    - 竖直相邻：按密度分层，下方格子优先装满水、再装油，其余留给上方格子。
 * 4. 每个排水口维护独立累计账本（每个液体的流入/流出/净变化），无进出口时账本恒为 0，
 *    且 初始总量 + 净注入 == 当前总量（浮点误差 < 1e-9）。
 */

export type Liquid = 'w' | 'o';

export interface Cell {
  /** 墙：不可流动、不可容纳液体、不可与邻居交换 */
  wall: boolean;
  /** 水量，[0, 1] */
  w: number;
  /** 油量，[0, 1] */
  o: number;
}

/** 单个口（排水/注入）的累计变化账本，单位均为液体体积 */
export interface PortLedger {
  id: string;
  x: number;
  y: number;
  open: boolean;
  /** 从该口注入的累计水量（加液工具作用在该口上时计入） */
  wIn: number;
  /** 从该口排走的累计水量 */
  wOut: number;
  oIn: number;
  oOut: number;
}

export interface Snapshot {
  step: number;
  cells: Cell[];
  ports: PortLedger[];
}

/** 单格容量 */
export const CELL_CAPACITY = 1;
/** 每步朝平衡目标移动的比例 */
const RELAX = 0.5;
/** 浮点清理阈值：低于该值的储量直接归零 */
const EPS = 1e-12;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Simulation {
  readonly width: number;
  readonly height: number;
  cells: Cell[];
  step = 0;
  /** cellIndex -> 账本；Map 保持插入顺序，排水阶段按索引升序另行遍历以保证确定性 */
  ports = new Map<number, PortLedger>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Array(width * height);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = { wall: false, w: 0, o: 0 };
    }
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Cell {
    return this.cells[this.idx(x, y)];
  }

  // ---------- 结构编辑 ----------

  /**
   * 设置/移除挡板。设为墙会清空该格液体；墙上的口会被一并移除。
   */
  setWall(x: number, y: number, wall: boolean): void {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    const c = this.cells[i];
    c.wall = wall;
    if (wall) {
      c.w = 0;
      c.o = 0;
      this.ports.delete(i);
    }
  }

  /** 在格子上放置/移除排水口（口只能位于非墙格） */
  togglePort(x: number, y: number): PortLedger | null {
    if (!this.inBounds(x, y)) return null;
    const i = this.idx(x, y);
    const existing = this.ports.get(i);
    if (existing) {
      this.ports.delete(i);
      return null;
    }
    if (this.cells[i].wall) return null;
    const ledger: PortLedger = {
      id: `p${i}`,
      x,
      y,
      open: true,
      wIn: 0,
      oOut: 0,
      oIn: 0,
      wOut: 0,
    };
    this.ports.set(i, ledger);
    return ledger;
  }

  setPortOpen(x: number, y: number, open: boolean): void {
    const p = this.ports.get(this.idx(x, y));
    if (p) p.open = open;
  }

  /**
   * 向格子加少量液体，自动夹紧到容量内，绝不产生负量或超容量。
   * 若该格有口，注入量同时计入该口的累计流入账本。
   * 返回实际加入量。
   */
  addLiquid(x: number, y: number, kind: Liquid, amount: number): number {
    if (!this.inBounds(x, y) || amount <= 0) return 0;
    const c = this.get(x, y);
    if (c.wall) return 0;
    const free = CELL_CAPACITY - c.w - c.o;
    const added = Math.min(amount, free);
    c[kind] += added;
    const port = this.ports.get(this.idx(x, y));
    if (port) {
      if (kind === 'w') port.wIn += added;
      else port.oIn += added;
    }
    return added;
  }

  /** 预设内部使用：直接设定储量（仍夹紧，保证不变量成立） */
  setLiquid(x: number, y: number, w: number, o: number): void {
    const c = this.get(x, y);
    if (c.wall) return;
    c.w = clamp01(w);
    c.o = clamp01(o);
    if (c.w + c.o > CELL_CAPACITY) {
      const scale = CELL_CAPACITY / (c.w + c.o);
      c.w *= scale;
      c.o *= scale;
    }
  }

  // ---------- 仿真推进 ----------

  /** 推进一个确定性仿真步 */
  advance(): void {
    this.drainPhase();
    this.flowPhase();
    this.step++;
  }

  /** 阶段 A：排水口按格子索引升序处理，打开的口按当前比例抽干 */
  private drainPhase(): void {
    const indices = [...this.ports.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const port = this.ports.get(i)!;
      if (!port.open) continue;
      const c = this.cells[i];
      if (c.wall || (c.w === 0 && c.o === 0)) continue;
      port.wOut += c.w;
      port.oOut += c.o;
      c.w = 0;
      c.o = 0;
    }
  }

  /**
   * 阶段 B：每条边松弛一次。
   * 偶数步顺时针扫描（水平：左→右；竖直：上→下），奇数步整体反转。
   */
  private flowPhase(): void {
    const reverse = (this.step & 1) === 1;
    const { width: W, height: H, cells } = this;

    if (!reverse) {
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W - 1; x++) {
          this.pairRelax(cells[row + x], cells[row + x + 1], 'h');
        }
      }
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H - 1; y++) {
          this.pairRelax(cells[y * W + x], cells[(y + 1) * W + x], 'v');
        }
      }
    } else {
      for (let y = H - 1; y >= 0; y--) {
        const row = y * W;
        for (let x = W - 2; x >= 0; x--) {
          this.pairRelax(cells[row + x], cells[row + x + 1], 'h');
        }
      }
      for (let x = W - 1; x >= 0; x--) {
        for (let y = H - 2; y >= 0; y--) {
          this.pairRelax(cells[y * W + x], cells[(y + 1) * W + x], 'v');
        }
      }
    }
  }

  /**
   * 相邻两格的一次松弛。a/b 的几何位置由 dir 决定：
   *  - h：a 在左、b 在右；
   *  - v：a 在上、b 在下（密度分层时下格 b 优先）。
   */
  private pairRelax(a: Cell, b: Cell, dir: 'h' | 'v'): void {
    if (a.wall || b.wall) return;

    let aw: number, ao: number, bw: number, bo: number;

    if (dir === 'h') {
      // 水平：每种液体独立朝两格均值靠拢
      aw = a.w + (b.w - a.w) * RELAX;
      bw = b.w + (a.w - b.w) * RELAX;
      ao = a.o + (b.o - a.o) * RELAX;
      bo = b.o + (a.o - b.o) * RELAX;
    } else {
      // 竖直：总量守恒，下格 b 优先装水、再装油，剩下的留给上格 a
      const tw = a.w + b.w;
      const to = a.o + b.o;
      const bwTarget = clamp01(tw);
      const boTarget = clamp01(to - Math.max(0, bwTarget + to - CELL_CAPACITY));
      bw = b.w + (bwTarget - b.w) * RELAX;
      bo = b.o + (boTarget - b.o) * RELAX;
      aw = tw - bw;
      ao = to - bo;
    }

    // 统一夹紧：浮点误差就地清零，保证 0 <= w,o 且 w+o <= 1
    a.w = this.clean(aw);
    a.o = this.clean(ao);
    b.w = this.clean(bw);
    b.o = this.clean(bo);
  }

  private clean(v: number): number {
    const c = clamp01(v);
    return c < EPS ? 0 : c;
  }

  // ---------- 统计与快照 ----------

  totals(): { w: number; o: number; capacity: number } {
    let w = 0;
    let o = 0;
    let capacity = 0;
    for (const c of this.cells) {
      if (c.wall) continue;
      w += c.w;
      o += c.o;
      capacity += CELL_CAPACITY;
    }
    return { w, o, capacity };
  }

  /** 所有口的累计净注入（注入为正、排走为负） */
  netPortFlow(): { w: number; o: number } {
    let w = 0;
    let o = 0;
    for (const p of this.ports.values()) {
      w += p.wIn - p.wOut;
      o += p.oIn - p.oOut;
    }
    return { w, o: o };
  }

  snapshot(): Snapshot {
    return {
      step: this.step,
      cells: this.cells.map((c) => ({ ...c })),
      ports: [...this.ports.values()].map((p) => ({ ...p })),
    };
  }

  restore(s: Snapshot): void {
    this.step = s.step;
    this.cells = s.cells.map((c) => ({ ...c }));
    this.ports = new Map();
    for (const p of s.ports) {
      this.ports.set(this.idx(p.x, p.y), { ...p });
    }
  }

  /** 全量不变量检查：非负、不超容量、无墙格带液、账本守恒 */
  checkInvariants(tolerance = 1e-9): string | null {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.get(x, y);
        if (c.w < -tolerance || c.o < -tolerance) {
          return `格子(${x},${y}) 出现负量 w=${c.w} o=${c.o}`;
        }
        if (c.w > CELL_CAPACITY + tolerance || c.o > CELL_CAPACITY + tolerance) {
          return `格子(${x},${y}) 单液体超容量 w=${c.w} o=${c.o}`;
        }
        if (c.w + c.o > CELL_CAPACITY + tolerance) {
          return `格子(${x},${y}) 总储量超容量 w+o=${c.w + c.o}`;
        }
        if (c.wall && (c.w !== 0 || c.o !== 0)) {
          return `墙格(${x},${y}) 带有液体`;
        }
      }
    }
    for (const p of this.ports.values()) {
      for (const v of [p.wIn, p.wOut, p.oIn, p.oOut]) {
        if (v < -tolerance) return `口 ${p.id} 账本出现负值 ${v}`;
      }
    }
    return null;
  }
}
