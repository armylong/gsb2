/**
 * 布料模拟核心: Verlet 积分 + PBD 距离约束 + 球体位置修正碰撞.
 *
 * 刻意不依赖 three.js / DOM, 使同一套物理代码既能在浏览器渲染循环里跑,
 * 也能在 Node (scripts/verify.ts) 里做确定性的帧率对比验证.
 *
 * 坐标约定: y 轴向上, 重力沿 -y.
 */

export interface ClothConfig {
  /** 水平分段数 (列数 = segmentsX + 1) */
  segmentsX: number;
  /** 垂直分段数 (行数 = segmentsY + 1) */
  segmentsY: number;
  /** 布宽 (米) */
  width: number;
  /** 布高 (米) */
  height: number;
  /** 布顶边的世界 y 坐标 */
  topY: number;
  /** 重力加速度大小 (m/s^2), 方向 -y */
  gravity: number;
  /** 抗拉程度 0..1, 映射为距离约束每轮刚度, 不做任何整体缩放 */
  stiffness: number;
  /** 每个模拟步的约束迭代次数 */
  iterations: number;
  /** 空气阻尼 (每秒速度衰减比例系数) */
  drag: number;
  /** 固定点粒子索引 (行优先: r * cols + c) */
  pinned: number[];
}

export interface SphereState {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** 运行时可直接显示/用于验证的量化指标 */
export interface ClothMetrics {
  /** 固定点相对其锚点的最大位移 (米), 理论上恒为 0 */
  pinOffset: number;
  /** 所有网格边相对静止长度的最大拉伸率 (正数表示拉长) */
  maxEdgeStrain: number;
  /** 当前最长网格边长度 (米) */
  maxEdgeLength: number;
  /** 顶点陷入球体的最大深度 (米, 0 表示无穿入; 固定点不参与) */
  maxPenetration: number;
  /** 穿入球内的顶点数 */
  penetratingCount: number;
}

export interface Tolerances {
  /** 固定点偏移上限 (米) */
  pinOffset: number;
  /** 网格边最大拉伸率上限 */
  edgeStrain: number;
  /** 顶点穿入球内深度上限 (米) */
  penetration: number;
  /** 两次模拟最终顶点位置的最大逐点距离 (米) */
  shapeMaxDiff: number;
  /** 两次模拟最终顶点位置的均方根距离 (米) */
  shapeRmsDiff: number;
  /** 两次模拟结束时模拟时间差 (秒) */
  simTimeDiff: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  pinOffset: 1e-9,
  edgeStrain: 0.05,
  penetration: 1e-9,
  shapeMaxDiff: 0.02,
  shapeRmsDiff: 0.01,
  simTimeDiff: 1e-6,
};

const STRUCTURAL_STIFF = 1.0;
const SHEAR_STIFF = 0.9;
const BEND_STIFF = 0.5;

/** 约束拓扑类型, 用于运行时按比例重映射刚度 */
const ConstraintType = {
  Structural: 0,
  Shear: 1,
  Bend: 2,
} as const;

export class ClothSimulation {
  readonly cfg: ClothConfig;
  readonly cols: number;
  readonly rows: number;
  readonly particleCount: number;

  /** 当前位置 (Float64, 每粒子 xyz 连续存储) */
  pos: Float64Array;
  /** 上一步位置, Verlet 隐式速度 */
  prev: Float64Array;
  /** 固定点锚点位置 */
  anchors: Float64Array;
  pinned: boolean[];

  /** 约束 (扁平类型化数组) */
  constraintA: Uint16Array;
  constraintB: Uint16Array;
  constraintRest: Float64Array;
  constraintK: Float64Array;
  constraintType: Uint8Array;
  /** 是否为网格边 (结构/剪切); 弯曲约束不算网格边 */
  constraintIsEdge: boolean[];

  sphere: SphereState;
  /** 球体是否参与碰撞; 关闭后仅作为装饰显示 */
  sphereActive = true;
  simTime = 0;
  dt: number;

  constructor(cfg: ClothConfig, dt: number, sphere: SphereState) {
    this.cfg = { ...cfg, pinned: [...cfg.pinned] };
    this.dt = dt;
    this.sphere = { ...sphere };
    this.cols = cfg.segmentsX + 1;
    this.rows = cfg.segmentsY + 1;
    this.particleCount = this.cols * this.rows;

    this.pos = new Float64Array(this.particleCount * 3);
    this.prev = new Float64Array(this.particleCount * 3);
    this.anchors = new Float64Array(this.particleCount * 3);
    this.pinned = new Array(this.particleCount).fill(false);

    this.buildGrid();
    const constraints = this.buildConstraints();
    this.constraintA = constraints.a;
    this.constraintB = constraints.b;
    this.constraintRest = constraints.rest;
    this.constraintK = constraints.k;
    this.constraintType = constraints.type;
    this.constraintIsEdge = constraints.isEdge;

    for (const idx of this.cfg.pinned) this.setPinned(idx, true);
    // 初始处于静止状态: prev = pos
    this.prev.set(this.pos);
    this.anchors.set(this.pos);
  }

  index(r: number, c: number): number {
    return r * this.cols + c;
  }

  private buildGrid(): void {
    const { width, height, topY, segmentsX, segmentsY } = this.cfg;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = this.index(r, c);
        const x = (c / segmentsX - 0.5) * width;
        const y = topY - (r / segmentsY) * height;
        this.pos[i * 3] = x;
        this.pos[i * 3 + 1] = y;
        this.pos[i * 3 + 2] = 0;
      }
    }
  }

  private buildConstraints(): {
    a: Uint16Array;
    b: Uint16Array;
    rest: Float64Array;
    k: Float64Array;
    type: Uint8Array;
    isEdge: boolean[];
  } {
    const aList: number[] = [];
    const bList: number[] = [];
    const restList: number[] = [];
    const kList: number[] = [];
    const typeList: number[] = [];
    const isEdge: boolean[] = [];

    const dist = (i: number, j: number): number => {
      const dx = this.pos[i * 3] - this.pos[j * 3];
      const dy = this.pos[i * 3 + 1] - this.pos[j * 3 + 1];
      const dz = this.pos[i * 3 + 2] - this.pos[j * 3 + 2];
      return Math.hypot(dx, dy, dz);
    };

    const add = (i: number, j: number, typeK: number, edge: boolean, type: number): void => {
      aList.push(i);
      bList.push(j);
      restList.push(dist(i, j));
      kList.push(typeK);
      typeList.push(type);
      isEdge.push(edge);
    };

    const s = this.cfg.stiffness;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = this.index(r, c);
        // 结构约束: 横 / 纵
        if (c + 1 < this.cols)
          add(i, this.index(r, c + 1), STRUCTURAL_STIFF * s, true, ConstraintType.Structural);
        if (r + 1 < this.rows)
          add(i, this.index(r + 1, c), STRUCTURAL_STIFF * s, true, ConstraintType.Structural);
        // 剪切约束: 单元格两条对角线
        if (c + 1 < this.cols && r + 1 < this.rows) {
          add(i, this.index(r + 1, c + 1), SHEAR_STIFF * s, true, ConstraintType.Shear);
          add(this.index(r, c + 1), this.index(r + 1, c), SHEAR_STIFF * s, true, ConstraintType.Shear);
        }
        // 弯曲约束: 跨一个顶点, 抑制布料像橡皮筋一样对折
        if (c + 2 < this.cols)
          add(i, this.index(r, c + 2), BEND_STIFF * s, false, ConstraintType.Bend);
        if (r + 2 < this.rows)
          add(i, this.index(r + 2, c), BEND_STIFF * s, false, ConstraintType.Bend);
      }
    }

    return {
      a: Uint16Array.from(aList),
      b: Uint16Array.from(bList),
      rest: Float64Array.from(restList),
      k: Float64Array.from(kList),
      type: Uint8Array.from(typeList),
      isEdge,
    };
  }

  /** 运行中调整抗拉程度: 只改约束刚度, 不重建网格、不缩放布片 */
  setStiffness(stiffness: number): void {
    this.cfg.stiffness = clamp(stiffness, 0.01, 1);
    const baseForType = [STRUCTURAL_STIFF, SHEAR_STIFF, BEND_STIFF];
    for (let n = 0; n < this.constraintK.length; n++) {
      this.constraintK[n] = baseForType[this.constraintType[n]] * this.cfg.stiffness;
    }
  }

  setGravity(g: number): void {
    this.cfg.gravity = clamp(g, 0, 30);
  }

  setDt(dt: number): void {
    this.dt = dt;
  }

  /**
   * 切换固定点 (要求暂停时调用).
   * 固定: 锚点取当前位置, 继续运行后该顶点保持原位.
   * 释放: prev 对齐当前位置, 不产生速度突跳.
   */
  setPinned(index: number, pin: boolean): void {
    if (index < 0 || index >= this.particleCount) return;
    const i3 = index * 3;
    if (pin) {
      this.pinned[index] = true;
      this.anchors[i3] = this.pos[i3];
      this.anchors[i3 + 1] = this.pos[i3 + 1];
      this.anchors[i3 + 2] = this.pos[i3 + 2];
      this.prev[i3] = this.pos[i3];
      this.prev[i3 + 1] = this.pos[i3 + 1];
      this.prev[i3 + 2] = this.pos[i3 + 2];
      if (!this.cfg.pinned.includes(index)) this.cfg.pinned.push(index);
    } else {
      this.pinned[index] = false;
      this.prev[i3] = this.pos[i3];
      this.prev[i3 + 1] = this.pos[i3 + 1];
      this.prev[i3 + 2] = this.pos[i3 + 2];
      const p = this.cfg.pinned.indexOf(index);
      if (p >= 0) this.cfg.pinned.splice(p, 1);
    }
  }

  get pinnedCount(): number {
    let n = 0;
    for (const p of this.pinned) if (p) n++;
    return n;
  }

  /** 推进一个固定模拟步长 dt */
  step(): void {
    const dt = this.dt;
    const n = this.particleCount;
    const dragFactor = Math.max(0, 1 - this.cfg.drag * dt);
    const g = this.cfg.gravity;

    // 1) Verlet 积分 (固定点直接锁回锚点)
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (this.pinned[i]) {
        this.pos[i3] = this.anchors[i3];
        this.pos[i3 + 1] = this.anchors[i3 + 1];
        this.pos[i3 + 2] = this.anchors[i3 + 2];
        this.prev[i3] = this.anchors[i3];
        this.prev[i3 + 1] = this.anchors[i3 + 1];
        this.prev[i3 + 2] = this.anchors[i3 + 2];
        continue;
      }
      const px = this.pos[i3];
      const py = this.pos[i3 + 1];
      const pz = this.pos[i3 + 2];
      const vx = (px - this.prev[i3]) * dragFactor;
      const vy = (py - this.prev[i3 + 1]) * dragFactor;
      const vz = (pz - this.prev[i3 + 2]) * dragFactor;
      this.prev[i3] = px;
      this.prev[i3 + 1] = py;
      this.prev[i3 + 2] = pz;
      this.pos[i3] = px + vx;
      this.pos[i3 + 1] = py + vy - g * dt * dt;
      this.pos[i3 + 2] = pz + vz;
    }

    // 2) 距离约束迭代, 每轮后立即做球碰撞, 避免约束求解把顶点重新推进球里
    for (let iter = 0; iter < this.cfg.iterations; iter++) {
      this.solveConstraints();
      this.resolveSphereCollision();
    }

    this.simTime += dt;
  }

  private solveConstraints(): void {
    const m = this.constraintA.length;
    for (let n = 0; n < m; n++) {
      const ia = this.constraintA[n];
      const ib = this.constraintB[n];
      const a3 = ia * 3;
      const b3 = ib * 3;
      const dx = this.pos[b3] - this.pos[a3];
      const dy = this.pos[b3 + 1] - this.pos[a3 + 1];
      const dz = this.pos[b3 + 2] - this.pos[a3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-12) continue;
      const rest = this.constraintRest[n];
      const k = this.constraintK[n];
      // PBD 位置修正: 两个自由顶点各承担一半; 固定点不动, 另一端承担全部
      const pinA = this.pinned[ia];
      const pinB = this.pinned[ib];
      if (pinA && pinB) continue;
      const wA = pinA ? 0 : pinB ? 1 : 0.5;
      const wB = 1 - wA;
      const diff = ((d - rest) / d) * k;
      if (wA > 0) {
        this.pos[a3] += dx * diff * wA;
        this.pos[a3 + 1] += dy * diff * wA;
        this.pos[a3 + 2] += dz * diff * wA;
      }
      if (wB > 0) {
        this.pos[b3] -= dx * diff * wB;
        this.pos[b3 + 1] -= dy * diff * wB;
        this.pos[b3 + 2] -= dz * diff * wB;
      }
    }
  }

  /** 球碰撞: 位置投影到球面, 固定点不参与 (锚点始终在球外) */
  resolveSphereCollision(): void {
    if (!this.sphereActive) return;
    const r = this.sphere.radius;
    if (r <= 0) return;
    const r2 = r * r;
    const sx = this.sphere.x;
    const sy = this.sphere.y;
    const sz = this.sphere.z;
    for (let i = 0; i < this.particleCount; i++) {
      if (this.pinned[i]) continue;
      const i3 = i * 3;
      const dx = this.pos[i3] - sx;
      const dy = this.pos[i3 + 1] - sy;
      const dz = this.pos[i3 + 2] - sz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const d = Math.sqrt(d2);
      if (d > 1e-12) {
        const push = r / d;
        this.pos[i3] = sx + dx * push;
        this.pos[i3 + 1] = sy + dy * push;
        this.pos[i3 + 2] = sz + dz * push;
      } else {
        // 球心重合的退化情况: 沿 +y 推出
        this.pos[i3] = sx;
        this.pos[i3 + 1] = sy + r;
        this.pos[i3 + 2] = sz;
      }
    }
  }

  metrics(): ClothMetrics {
    let pinOffset = 0;
    for (let i = 0; i < this.particleCount; i++) {
      if (!this.pinned[i]) continue;
      const i3 = i * 3;
      const d = Math.hypot(
        this.pos[i3] - this.anchors[i3],
        this.pos[i3 + 1] - this.anchors[i3 + 1],
        this.pos[i3 + 2] - this.anchors[i3 + 2],
      );
      if (d > pinOffset) pinOffset = d;
    }

    let maxEdgeStrain = 0;
    let maxEdgeLength = 0;
    for (let n = 0; n < this.constraintA.length; n++) {
      if (!this.constraintIsEdge[n]) continue;
      const a3 = this.constraintA[n] * 3;
      const b3 = this.constraintB[n] * 3;
      const d = Math.hypot(
        this.pos[b3] - this.pos[a3],
        this.pos[b3 + 1] - this.pos[a3 + 1],
        this.pos[b3 + 2] - this.pos[a3 + 2],
      );
      const rest = this.constraintRest[n];
      const strain = (d - rest) / rest;
      if (strain > maxEdgeStrain) maxEdgeStrain = strain;
      if (d > maxEdgeLength) maxEdgeLength = d;
    }

    let maxPenetration = 0;
    let penetratingCount = 0;
    const r = this.sphere.radius;
    if (r > 0 && this.sphereActive) {
      const r2 = r * r;
      for (let i = 0; i < this.particleCount; i++) {
        if (this.pinned[i]) continue;
        const i3 = i * 3;
        const d2 =
          (this.pos[i3] - this.sphere.x) ** 2 +
          (this.pos[i3 + 1] - this.sphere.y) ** 2 +
          (this.pos[i3 + 2] - this.sphere.z) ** 2;
        if (d2 < r2) {
          penetratingCount++;
          const pen = r - Math.sqrt(d2);
          if (pen > maxPenetration) maxPenetration = pen;
        }
      }
    }

    return { pinOffset, maxEdgeStrain, maxEdgeLength, maxPenetration, penetratingCount };
  }

  /** 恢复同一组初始条件 (当前重力/刚度参数保留, 顶点/锚点/时间全部复位) */
  reset(): void {
    this.buildGrid();
    this.prev.set(this.pos);
    this.anchors.set(this.pos);
    for (let i = 0; i < this.particleCount; i++) this.pinned[i] = false;
    for (const idx of this.cfg.pinned) {
      this.pinned[idx] = true;
      this.anchors[idx * 3] = this.pos[idx * 3];
      this.anchors[idx * 3 + 1] = this.pos[idx * 3 + 1];
      this.anchors[idx * 3 + 2] = this.pos[idx * 3 + 2];
    }
    this.simTime = 0;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
