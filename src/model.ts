/**
 * 规则化动力学内核（非通用绳索物理）。
 *
 * 三个动滑轮体（托架1 / 纸灯 / 托架2）在一条固定穿线的绳上：
 *   - 绳总长不变 → 运动学约束 a1 + aL + a2 = 0（向下为正）
 *   - 同一条绳 → 各处张力 T 相同，每个动滑轮受 2T 向上
 *   - 重力 + 线性阻尼，无刚度、无弹性绳、无碰撞回弹
 *
 * 限位/卡榫统一按“接触锁”处理：被锁住的体加速度为 0，
 * 靠约束解算给出的接触反力判断是否应自动解锁；卡榫锁不自动解锁。
 */
import {
  FRAME_DT,
  GRAVITY,
  H_INITIAL,
  H_MAX,
  H_MIN,
  LATCH_BANDS,
  LINEAR_DRAG,
  ROPE_SUM,
  SUBSTEPS,
  verticalStrandLengths,
  type LatchBand,
} from './geometry.js';

export type BodyId = 'carriage1' | 'lantern' | 'carriage2';
export type LatchId = 'upper' | 'lower';
export type LockDir = -1 | 1; // -1：顶限位（阻挡向上）；+1：底限位（阻挡向下）

export const BODY_IDS: BodyId[] = ['carriage1', 'lantern', 'carriage2'];
export const BODY_LABELS: Record<BodyId, string> = {
  carriage1: '托架1',
  lantern: '纸灯',
  carriage2: '托架2',
};

const EPS_CONTACT = 1e-6;
const IMPACT_SPEED_EPS = 4; // 低于该速度的贴边不记撞击，只算静默停靠
const LOG_LIMIT = 240;

export interface MechEvent {
  time: number;
  text: string;
}

export interface CheckRecord {
  id: number;
  time: number;
  latch: LatchId;
  result: 'locked' | 'too-fast' | 'released';
  hL: number;
  speed: number;
  vMax: number;
  note: string;
}

export interface EngineSnapshot {
  time: number;
  h: Record<BodyId, number>;
  v: Record<BodyId, number>;
  m: Record<BodyId, number>;
  contacts: Record<BodyId, LockDir | null>;
  engagedLatch: LatchId | null;
  armedLatches: LatchId[];
  tension: number;
  strands: number[];
  ropeSum: number;
}

interface BandFsm {
  inside: boolean;
}

export class Engine {
  time = 0;
  h: Record<BodyId, number>;
  v: Record<BodyId, number> = { carriage1: 0, lantern: 0, carriage2: 0 };
  m: Record<BodyId, number>;
  /** 限位接触锁（按体），与卡榫分开记录 */
  contacts: Record<BodyId, LockDir | null> = {
    carriage1: null,
    lantern: null,
    carriage2: null,
  };
  /** 已合上的卡榫（硬锁，不自动解锁），同一时刻至多一个 */
  engagedLatch: LatchId | null = null;
  /** 已扳下（武装）的卡榫，才会参与检查 */
  armedLatches = new Set<LatchId>();

  events: MechEvent[] = [];
  checks: CheckRecord[] = [];
  private checkSeq = 0;
  private bandFsm: Record<LatchId, BandFsm> = {
    upper: { inside: false },
    lower: { inside: false },
  };
  /** 最近一次约束解算的张力，供单步面板观察 */
  lastTension = 0;
  /** 最近一步的接触反力（调试用） */
  lastReactions: Partial<Record<BodyId, number>> = {};
  /** 绳张力告警仅在由正转负时记录一次，恢复后可再次告警 */
  private slackWarned = false;

  constructor(weights: Record<BodyId, number>, h0?: Record<BodyId, number>) {
    this.m = { ...weights };
    const hh = h0 ?? { carriage1: 220, lantern: 220, carriage2: 220 };
    this.h = { ...hh };
  }

  // ---- 外部操作 -----------------------------------------------------------

  /** 行程中取走/替换配重：质量瞬换，速度原样保留（惯性不跳变） */
  setWeight(body: BodyId, mass: number): void {
    const from = this.m[body];
    if (Math.abs(from - mass) < 1e-9) return;
    this.m[body] = mass;
    this.pushEvent(
      `${BODY_LABELS[body]}配重 ${from.toFixed(2)}kg → ${mass.toFixed(2)}kg（速度保持 ${this.v[body].toFixed(1)}px/s，按当前状态继续）`,
    );
  }

  /** 扳下/松开卡榫 */
  toggleLatch(id: LatchId): void {
    const band = LATCH_BANDS.find((b) => b.id === id)!;
    if (this.armedLatches.has(id)) {
      this.armedLatches.delete(id);
      if (this.engagedLatch === id) {
        this.engagedLatch = null;
        this.recordCheck(id, 'released', band, `手动松开${band.label}卡榫，纸灯恢复自由`);
      } else {
        this.pushEvent(`松开${band.label}卡榫（脱开，不再检查）`);
      }
      this.bandFsm[id].inside = this.inBand(band);
      return;
    }
    this.armedLatches.add(id);
    this.pushEvent(`扳下${band.label}卡榫（进入检查状态）`);
    // 扳下时若灯已在窗格内，立即复核一次
    if (this.inBand(band)) {
      this.evaluateBand(band, true);
      this.bandFsm[id].inside = true;
    } else {
      this.bandFsm[id].inside = false;
    }
  }

  reset(weights: Record<BodyId, number>): void {
    this.time = 0;
    this.m = { ...weights };
    this.h = { carriage1: H_INITIAL, lantern: H_INITIAL, carriage2: H_INITIAL };
    this.v = { carriage1: 0, lantern: 0, carriage2: 0 };
    this.contacts = { carriage1: null, lantern: null, carriage2: null };
    this.engagedLatch = null;
    this.armedLatches.clear();
    this.events = [];
    this.checks = [];
    this.checkSeq = 0;
    this.lastTension = 0;
    this.lastReactions = {};
    this.slackWarned = false;
    this.bandFsm = { upper: { inside: false }, lower: { inside: false } };
  }

  // ---- 单步推进 -----------------------------------------------------------

  step(dt: number = FRAME_DT): MechEvent[] {
    const before = this.events.length;
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this.substep(h);
    this.time += dt;
    return this.events.slice(before);
  }

  private substep(dt: number): void {
    // 1) 约束解算（含接触锁的自动释放判定），迭代到锁集合稳定
    let sol = this.solve();
    for (let iter = 0; iter < BODY_IDS.length; iter++) {
      const released: BodyId[] = [];
      for (const id of BODY_IDS) {
        const dir = this.contacts[id];
        if (dir === null) continue;
        const R = sol.reactions[id] ?? 0;
        // R>0 是台面向上托的合法接触力。R<0 表示需要台面“拉住”体才能维持，
        // 单向接触给不出这种力 → 锁失效，体被绳拖离限位。
        // 同时要求自由解的加速度确实指向脱离方向，防止边界上一帧一帧抖动。
        const away = dir === -1 ? sol.a[id] < -1e-4 : sol.a[id] > 1e-4;
        if (R < -EPS_CONTACT && away) released.push(id);
      }
      if (released.length === 0) break;
      for (const id of released) {
        this.contacts[id] = null;
        this.pushEvent(`${BODY_LABELS[id]}的限位接触反力反向，自动解除接触锁`);
      }
      sol = this.solve();
    }
    this.lastTension = sol.T;
    this.lastReactions = { ...sol.reactions };

    // 2) 积分：仅自由体运动；被锁住的体 h、v 都钉住（绳不会突然变长）
    for (const id of BODY_IDS) {
      if (this.isHeld(id)) continue;
      const a = sol.a[id];
      this.h[id] += this.v[id] * dt + 0.5 * a * dt * dt;
      this.v[id] += a * dt;
    }

    // 2.5) 绳长守恒投影：离散积分会有浮点/截断漂移，把误差按 1/m 均摊回自由体，
    //      严格维持 h1+hL+h2 = 常量（与速度层约束 v1+vL+v2=0 一致）。
    this.enforceRopeLength();

    // 3) 自由体越界 → 撞上限位，非弹性停住并登记接触锁。
    //    已在边界上但本帧没有朝限位运动的体（刚被释放、正要脱离）不重新夹紧，
    //    否则会出现“释放→重锁”逐帧抖动。
    for (const id of BODY_IDS) {
      if (this.isHeld(id)) continue;
      if (this.h[id] < H_MIN - EPS_CONTACT || (this.h[id] <= H_MIN && this.v[id] < 0)) {
        if (this.v[id] < -IMPACT_SPEED_EPS) {
          this.pushEvent(
            `${BODY_LABELS[id]}撞上顶限位（${this.v[id].toFixed(0)}px/s 冲量停住），该侧锁死`,
          );
        }
        this.h[id] = H_MIN;
        this.v[id] = 0;
        this.contacts[id] = -1;
      } else if (
        this.h[id] > H_MAX + EPS_CONTACT ||
        (this.h[id] >= H_MAX && this.v[id] > 0)
      ) {
        if (this.v[id] > IMPACT_SPEED_EPS) {
          this.pushEvent(
            `${BODY_LABELS[id]}撞上底限位（${this.v[id].toFixed(0)}px/s 冲量停住），该侧锁死`,
          );
        }
        this.h[id] = H_MAX;
        this.v[id] = 0;
        this.contacts[id] = 1;
      }
    }

    // 4) 窗格卡榫检查（状态机：进入/停留/离开）
    for (const band of LATCH_BANDS) {
      if (!this.armedLatches.has(band.id)) continue;
      const fsm = this.bandFsm[band.id];
      const inside = this.inBand(band);
      if (inside && !fsm.inside) {
        this.evaluateBand(band, false);
      } else if (inside && fsm.inside && this.engagedLatch !== band.id) {
        // 进窗格时过快没卡上，若在窗格内把速度降下来，仍可补卡
        if (Math.abs(this.v.lantern) <= band.vMax) this.evaluateBand(band, false);
      }
      fsm.inside = inside;
    }
  }

  /** 组装并求解当前锁集合下的 KKT 小系统（至多 4 阶高斯消元） */
  private solve(): {
    a: Record<BodyId, number>;
    T: number;
    reactions: Partial<Record<BodyId, number>>;
  } {
    const free = BODY_IDS.filter((id) => !this.isHeld(id));
    const locked = BODY_IDS.filter((id) => this.isHeld(id));
    const zero: Record<BodyId, number> = { carriage1: 0, lantern: 0, carriage2: 0 };
    // 全部被锁住：绳长约束自动满足，加速度全 0；反力欠定，取一个体的力平衡做显示估算
    if (free.length === 0) {
      const id = BODY_IDS[0];
      return { a: zero, T: (this.m[id] * GRAVITY) / 2, reactions: {} };
    }
    // 未知量顺序：自由体 a…，T，锁住体的接触反力 R…
    const n = 4;
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    let row = 0;
    for (const id of free) {
      // 力平衡 m·a = m(g−kv) − 2T，移项为 m·a + 2T = m(g−kv)
      A[row][free.indexOf(id)] = this.m[id];
      A[row][free.length] = 2; // T 的列
      b[row] = this.m[id] * (GRAVITY - LINEAR_DRAG * this.v[id]);
      row++;
    }
    for (const id of locked) {
      const rCol = free.length + 1 + locked.indexOf(id);
      A[row][free.length] = 2;
      A[row][rCol] = 1;
      b[row] = this.m[id] * (GRAVITY - LINEAR_DRAG * this.v[id]); // a=0
      row++;
    }
    // 约束行：自由体加速度之和为 0（锁住体 a=0 已省略）。
    // 力平衡 m·a = m(g−kv) − 2T 与 a1+aL+a2=0 联立，解析上
    // 2T = (Σ m(g−kv)) / (1 + Σ1/(2m_i))，见 test/ 里的数值校验。
    for (let c = 0; c < free.length; c++) A[row][c] = 1;
    b[row] = 0;

    const x = gaussianSolve(A, b);
    const a: Record<BodyId, number> = { carriage1: 0, lantern: 0, carriage2: 0 };
    free.forEach((id, i) => (a[id] = x[i]));
    const T = x[free.length];
    const reactions: Partial<Record<BodyId, number>> = {};
    locked.forEach((id, i) => (reactions[id] = x[free.length + 1 + i]));
    if (T < -1e-4 && !this.slackWarned) {
      this.slackWarned = true;
      this.pushEvent('警告：解出绳张力为负，当前配重会让绳松弛（规则模型只处理张紧绳，结果停在松弛前的锁态）');
    } else if (T >= 0) {
      this.slackWarned = false;
    }
    return { a, T, reactions };
  }

  private isHeld(id: BodyId): boolean {
    return this.contacts[id] !== null || (id === 'lantern' && this.engagedLatch !== null);
  }

  /**
   * 绳长约束的位置/速度投影。被锁住的体不动，误差在自由体之间按 1/m 加权分配；
   * 单自由体时由它独自承担（此时它沿绳的位移本就应为 0，投影会把它钉回原位）。
   */
  private enforceRopeLength(): void {
    const free = BODY_IDS.filter((id) => !this.isHeld(id));
    if (free.length === 0) return;
    const sum = BODY_IDS.reduce((acc, id) => acc + this.h[id], 0);
    const err = ROPE_SUM - sum; // 需要补回的总位移
    if (Math.abs(err) < 1e-10) {
      // 仍做一次速度约束投影，防止数值残差累积
    }
    const weights = free.map((id) => 1 / this.m[id]);
    const wSum = weights.reduce((a, b) => a + b, 0);
    free.forEach((id, i) => {
      this.h[id] += (err * weights[i]) / wSum;
    });

    const vErr = free.reduce((acc, id) => acc + this.v[id], 0);
    const vw = free.map((id) => 1 / this.m[id]);
    const vwSum = vw.reduce((a, b) => a + b, 0);
    free.forEach((id, i) => {
      this.v[id] -= (vErr * vw[i]) / vwSum;
    });
  }

  private inBand(band: LatchBand): boolean {
    return this.h.lantern >= band.hMin && this.h.lantern <= band.hMax;
  }

  private evaluateBand(band: LatchBand, manual: boolean): void {
    if (this.engagedLatch === band.id) return;
    const speed = Math.abs(this.v.lantern);
    if (speed <= band.vMax) {
      this.engagedLatch = band.id;
      this.v.lantern = 0;
      this.recordCheck(
        band.id,
        'locked',
        band,
        manual ? '扳下卡榫时灯在窗格内且速度达标，直接卡住' : '进入窗格速度达标，卡榫合上锁死',
      );
    } else {
      this.recordCheck(
        band.id,
        'too-fast',
        band,
        manual
          ? `扳下复核时速度 ${speed.toFixed(1)} > ${band.vMax}，卡不上`
          : `过快经过窗格（${speed.toFixed(1)} > ${band.vMax}px/s），不予卡住`,
      );
    }
  }

  private recordCheck(
    latch: LatchId,
    result: CheckRecord['result'],
    band: LatchBand,
    note: string,
  ): void {
    this.checks.push({
      id: ++this.checkSeq,
      time: this.time,
      latch,
      result,
      hL: this.h.lantern,
      speed: Math.abs(this.v.lantern),
      vMax: band.vMax,
      note,
    });
    if (this.checks.length > LOG_LIMIT) this.checks.shift();
  }

  private pushEvent(text: string): void {
    this.events.push({ time: this.time, text });
    if (this.events.length > LOG_LIMIT) this.events.shift();
  }

  snapshot(): EngineSnapshot {
    return {
      time: this.time,
      h: { ...this.h },
      v: { ...this.v },
      m: { ...this.m },
      contacts: { ...this.contacts },
      engagedLatch: this.engagedLatch,
      armedLatches: [...this.armedLatches],
      tension: this.lastTension,
      strands: verticalStrandLengths(this.h.carriage1, this.h.lantern, this.h.carriage2),
      ropeSum: this.h.carriage1 + this.h.lantern + this.h.carriage2,
    };
  }
}

/** 部分主元高斯消元（系统 ≤4 阶） */
function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) {
      if (piv === -1 || Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) {
      throw new Error('约束系统奇异，检查锁状态与穿线约束');
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}
