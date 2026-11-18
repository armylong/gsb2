/**
 * 模拟内核:不依赖 DOM,可在浏览器与 Node(tsx)中运行。
 *
 * 避障流程(每个固定步长):
 *  1. 为每个代理构造 ORCA 半平面:边界墙/矩形(半径感知,始终生效)+ 邻近代理(RVO 半责任)
 *  2. 线性规划求距“目标偏好速度”最近的可行速度
 *  3. 按最大加速度限速后积分,保证启停/转向连续
 *  4. 硬投影兜底:任何数值退化都不允许穿墙或越界
 *
 * 避障强度为 0 时只关闭代理间约束,静态约束保留,便于对照冲突。
 */
import {
  Vec,
  add,
  sub,
  mul,
  dot,
  norm,
  dist,
  clamp,
  EPS,
} from './math';
import { Line, solveOrca } from './orca';
import {
  AgentSpec,
  Rect,
  SimStats,
  OverlapInfo,
  LayoutResult,
  WORLD_W,
  WORLD_H,
  DT,
  TIME_HORIZON_MIN,
  TIME_HORIZON_MAX,
  TIME_HORIZON_OBS,
  NEIGHBOR_DIST,
  OBS_INFLUENCE,
  ARRIVE_EPS,
  STALL_SPEED,
  STALL_TIME,
} from './types';

export class RuntimeAgent {
  readonly spec: AgentSpec;
  pos: Vec;
  vel: Vec = { x: 0, y: 0 };
  goal: Vec;
  arrived = false;
  stallTimer = 0;
  waiting = false;
  trail: Vec[] = [];
  private trailTick = 0;

  constructor(spec: AgentSpec) {
    this.spec = spec;
    this.pos = { ...spec.pos };
    this.goal = { ...spec.goal };
  }

  get id(): number {
    return this.spec.id;
  }
  get radius(): number {
    return this.spec.radius;
  }
  get maxSpeed(): number {
    return this.spec.maxSpeed;
  }
  get prefSpeed(): number {
    return this.spec.prefSpeed;
  }
  get maxAccel(): number {
    return this.spec.maxAccel;
  }
  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.y);
  }

  pushTrail(): void {
    this.trailTick++;
    if (this.trailTick % 3 === 0) {
      this.trail.push({ ...this.pos });
      if (this.trail.length > 600) this.trail.shift();
    }
  }

  resetTrail(): void {
    this.trail = [];
    this.trailTick = 0;
  }
}

/** 矩形上距 p 最近的点;返回最近点与最近特征类型 */
function nearestOnRect(
  p: Vec,
  r: Rect,
): { q: Vec; d: number; n: Vec; feature: 'edge-x' | 'edge-y' | 'corner' | 'inside' } {
  const cx = clamp(p.x, r.x, r.x + r.w);
  const cy = clamp(p.y, r.y, r.y + r.h);
  const q = { x: cx, y: cy };
  const onLeft = Math.abs(cx - r.x) < EPS;
  const onRight = Math.abs(cx - (r.x + r.w)) < EPS;
  const onTop = Math.abs(cy - r.y) < EPS;
  const onBottom = Math.abs(cy - (r.y + r.h)) < EPS;
  const corner = (onLeft || onRight) && (onTop || onBottom);

  let d = dist(p, q);
  let n: Vec;
  if (d < EPS) {
    // 位于矩形内部:沿侵入最浅的轴推出
    const pushes = [
      { n: { x: -1, y: 0 }, depth: p.x - r.x },
      { n: { x: 1, y: 0 }, depth: r.x + r.w - p.x },
      { n: { x: 0, y: -1 }, depth: p.y - r.y },
      { n: { x: 0, y: 1 }, depth: r.y + r.h - p.y },
    ].filter((k) => k.depth >= 0);
    pushes.sort((a, b) => a.depth - b.depth);
    n = pushes[0]?.n ?? { x: 1, y: 0 };
    d = 0;
    return { q: p, d, n, feature: 'inside' };
  }
  n = mul(sub(p, q), 1 / d);
  const feature = corner ? 'corner' : onTop || onBottom ? 'edge-x' : 'edge-y';
  return { q, d, n, feature };
}

/** 静态特征(墙/矩形)ORCA 半平面:n 指向自由空间,gap = d - radius */
function staticLine(n: Vec, gap: number, timeHorizon: number): Line {
  // 约束: n·v >= -gap/T,即 cross(dir, v - point) >= 0,dir 使 n 为其左法向
  const dir = { x: n.y, y: -n.x };
  const point = mul(n, -gap / timeHorizon);
  return { dir, point };
}

export class Simulation {
  agents: RuntimeAgent[] = [];
  rects: Rect[];
  readonly presetKey: string;
  readonly timeLimit: number;
  readonly seed: number;
  time = 0;
  /** 0..1,0 表示关闭代理间避障(静态障碍约束保留) */
  avoidanceStrength: number;
  layoutOverlaps: OverlapInfo[] = [];
  /** 布局存在初始/当前重叠时为 true,禁止步进直到现场被修正 */
  layoutBlocked = false;
  finished = false;
  /** 全部代理到达的时刻(自然结束),未完成时为 null */
  allArrivedTime: number | null = null;
  private allTimeMinGap = Infinity;
  private allTimeMaxSpeed = 0;

  constructor(
    specs: AgentSpec[],
    rects: Rect[],
    presetKey: string,
    timeLimit: number,
    seed: number,
    avoidanceStrength = 0.7,
  ) {
    this.presetKey = presetKey;
    this.timeLimit = timeLimit;
    this.seed = seed;
    this.rects = rects.map((r) => ({ ...r }));
    this.avoidanceStrength = avoidanceStrength;
    this.agents = specs.map((s) => new RuntimeAgent(s));
    this.refreshLayoutOverlaps();
  }

  get timeHorizon(): number {
    return (
      TIME_HORIZON_MIN +
      (TIME_HORIZON_MAX - TIME_HORIZON_MIN) * this.avoidanceStrength
    );
  }

  /** 检测代理间与代理-矩形的初始/当前重叠;不把重叠算作“已安全避开” */
  refreshLayoutOverlaps(): LayoutResult {
    const overlaps: OverlapInfo[] = [];
    const a = this.agents;
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        const penetration = a[i].radius + a[j].radius - dist(a[i].pos, a[j].pos);
        if (penetration > 1e-6) {
          overlaps.push({
            kind: 'agent',
            aId: a[i].id,
            bId: a[j].id,
            penetration,
          });
        }
      }
      for (let k = 0; k < this.rects.length; k++) {
        const { d } = nearestOnRect(a[i].pos, this.rects[k]);
        const penetration = a[i].radius - d;
        if (penetration > 1e-6) {
          overlaps.push({
            kind: 'rect',
            aId: a[i].id,
            bId: k,
            penetration,
          });
        }
      }
    }
    this.layoutOverlaps = overlaps;
    this.layoutBlocked = overlaps.length > 0;
    return { overlaps };
  }

  private buildAgentLines(agent: RuntimeAgent, out: Line[]): void {
    if (this.avoidanceStrength <= 0) return;
    const T = this.timeHorizon;
    for (const other of this.agents) {
      if (other.id === agent.id) continue;
      const relPos = sub(agent.pos, other.pos);
      const d = Math.hypot(relPos.x, relPos.y);
      const R = agent.radius + other.radius;
      if (d - R > NEIGHBOR_DIST) continue;

      let n: Vec;
      if (d < EPS) {
        // 极端重叠:用编号决定一个确定的推开方向
        const ang = Math.PI * ((agent.id * 0.618 + other.id) % 2);
        n = { x: Math.cos(ang), y: Math.sin(ang) };
      } else {
        n = mul(relPos, 1 / d);
      }
      const dir = { x: n.y, y: -n.x };
      // RVO 半责任:边界点取双方速度中点,再沿法向让出一半侵入
      const midVel = mul(add(agent.vel, other.vel), 0.5);
      const point = add(midVel, mul(n, (R - Math.max(d, EPS)) / (2 * T)));
      out.push({ dir, point });
    }
  }

  private buildStaticLines(agent: RuntimeAgent, out: Line[]): void {
    const r = agent.radius;
    const T = TIME_HORIZON_OBS;
    // 四面边界墙
    const walls: Array<{ n: Vec; gap: number }> = [
      { n: { x: 0, y: 1 }, gap: agent.pos.y - r },
      { n: { x: 0, y: -1 }, gap: WORLD_H - agent.pos.y - r },
      { n: { x: 1, y: 0 }, gap: agent.pos.x - r },
      { n: { x: -1, y: 0 }, gap: WORLD_W - agent.pos.x - r },
    ];
    for (const w of walls) out.push(staticLine(w.n, w.gap, T));

    for (const rect of this.rects) {
      const near = nearestOnRect(agent.pos, rect);
      const gap = near.d - r;
      if (gap > OBS_INFLUENCE) continue;
      if (near.feature === 'inside') {
        // 已侵入:直接沿推出方向给强约束
        out.push(staticLine(near.n, gap, DT));
        continue;
      }
      if (near.feature === 'corner') {
        // 角点视为静止点障碍(速度锥)
        out.push(staticLine(near.n, gap, T));
      } else {
        out.push(staticLine(near.n, gap, T));
      }
    }
  }

  /** 积分后的硬投影:保证不穿墙、不出界 */
  private enforceFreeSpace(agent: RuntimeAgent): void {
    const r = agent.radius;
    agent.pos.x = clamp(agent.pos.x, r, WORLD_W - r);
    agent.pos.y = clamp(agent.pos.y, r, WORLD_H - r);

    for (const rect of this.rects) {
      const near = nearestOnRect(agent.pos, rect);
      if (near.feature === 'inside' || near.d < r) {
        const push = r - Math.max(near.d, 0);
        agent.pos = add(agent.pos, mul(near.n, push + EPS));
        // 去掉继续朝障碍内部的速度分量
        const inward = dot(agent.vel, near.n);
        if (inward < 0) agent.vel = sub(agent.vel, mul(near.n, inward));
      }
    }
  }

  step(): void {
    if (this.layoutBlocked || this.finished) return;

    for (const agent of this.agents) {
      const toGoal = sub(agent.goal, agent.pos);
      const goalDist = Math.hypot(toGoal.x, toGoal.y);

      if (agent.arrived) {
        agent.vel = { x: 0, y: 0 };
        this.enforceFreeSpace(agent);
        agent.pushTrail();
        continue;
      }

      let preferred: Vec;
      if (goalDist < ARRIVE_EPS) {
        preferred = { x: 0, y: 0 };
      } else {
        // 右手法则的微小横向偏好:打破正面相遇时的 RVO 对称,
        // 对向双方的右侧法向天然相反,因此会稳定从彼此不同侧通过。
        // 偏好强度随避障强度缩放:关闭避障时退化为纯直线,便于对照冲突。
        const heading = norm(toGoal);
        const right = { x: heading.y, y: -heading.x };
        preferred = add(
          mul(heading, agent.prefSpeed),
          mul(right, agent.prefSpeed * 0.06 * this.avoidanceStrength),
        );
      }

      const lines: Line[] = [];
      this.buildStaticLines(agent, lines);
      this.buildAgentLines(agent, lines);

      const desired = solveOrca(lines, preferred, agent.maxSpeed);

      // 加速度限速:启停与转向连续
      const dv = sub(desired, agent.vel);
      const maxDv = agent.maxAccel * DT;
      const dvLen = Math.hypot(dv.x, dv.y);
      const nextVel =
        dvLen > maxDv ? add(agent.vel, mul(dv, maxDv / dvLen)) : desired;

      agent.vel = nextVel;
      agent.pos = add(agent.pos, mul(nextVel, DT));
      this.enforceFreeSpace(agent);

      // 到达判定:位置足够近且几乎停稳,避免伪报
      if (goalDist < ARRIVE_EPS && agent.speed < STALL_SPEED) {
        agent.arrived = true;
        agent.vel = { x: 0, y: 0 };
        agent.waiting = false;
        agent.stallTimer = 0;
      } else if (agent.speed < STALL_SPEED) {
        agent.stallTimer += DT;
        agent.waiting = agent.stallTimer >= STALL_TIME;
      } else {
        agent.stallTimer = 0;
        agent.waiting = false;
      }
      agent.pushTrail();
    }

    this.time += DT;
    this.separateAgents();
    this.updateGapStats();
    if (this.time >= this.timeLimit) this.finished = true;
    if (this.allArrivedTime === null && this.agents.every((a) => a.arrived)) {
      this.allArrivedTime = this.time;
      this.finished = true;
    }
  }

  /**
   * 代理间硬投影:ORCA 数值退化或拖拽导致的微小穿透在这里被完全消除,
   * 与墙体投影同级,保证“避免明显重叠”是硬约束而非仅靠优化器保证。
   */
  private separateAgents(): void {
    // 强度 0 是“关闭避障”的对照模式:不做代理间分离,允许对穿以暴露冲突;
    // 静态障碍投影始终生效,因此不会穿墙或出界。
    if (this.avoidanceStrength <= 0) return;
    const a = this.agents;
    // 链式接触时单轮投影会留下残余,迭代到不再有重叠(最多 4 轮)
    for (let pass = 0; pass < 4; pass++) {
      let anyOverlap = false;
      for (let i = 0; i < a.length; i++) {
        for (let j = i + 1; j < a.length; j++) {
          const delta = sub(a[j].pos, a[i].pos);
          const d = Math.hypot(delta.x, delta.y);
          const R = a[i].radius + a[j].radius;
          if (d >= R) continue;
          anyOverlap = true;
          let n: Vec;
          if (d < EPS) {
            const ang = Math.PI * ((a[i].id * 0.618 + a[j].id) % 2);
            n = { x: Math.cos(ang), y: Math.sin(ang) };
          } else {
            n = mul(delta, 1 / d);
          }
          const push = (R - d) / 2 + EPS;
          a[i].pos = sub(a[i].pos, mul(n, push));
          a[j].pos = add(a[j].pos, mul(n, push));
          this.enforceFreeSpace(a[i]);
          this.enforceFreeSpace(a[j]);
        }
      }
      if (!anyOverlap) break;
    }
  }

  private surfaceGaps(): number[] {
    const gaps: number[] = [];
    const a = this.agents;
    for (let i = 0; i < a.length; i++) {
      gaps.push(a[i].pos.y - a[i].radius);
      gaps.push(WORLD_H - a[i].pos.y - a[i].radius);
      gaps.push(a[i].pos.x - a[i].radius);
      gaps.push(WORLD_W - a[i].pos.x - a[i].radius);
      for (let k = 0; k < this.rects.length; k++) {
        gaps.push(nearestOnRect(a[i].pos, this.rects[k]).d - a[i].radius);
      }
      for (let j = i + 1; j < a.length; j++) {
        gaps.push(dist(a[i].pos, a[j].pos) - a[i].radius - a[j].radius);
      }
    }
    return gaps;
  }

  private updateGapStats(): void {
    const gaps = this.surfaceGaps();
    const current = Math.min(...gaps);
    this.allTimeMinGap = Math.min(this.allTimeMinGap, current);
    for (const ag of this.agents) {
      this.allTimeMaxSpeed = Math.max(this.allTimeMaxSpeed, ag.speed);
    }
  }

  stats(): SimStats {
    const gaps = this.surfaceGaps();
    const currentMinGap = Math.min(...gaps);
    // 初始重叠尚未步进时,也把负间距纳入统计
    const allTime = Math.min(this.allTimeMinGap, currentMinGap);
    let stalled = 0;
    let waiting = 0;
    let arrived = 0;
    let maxSpeed = this.allTimeMaxSpeed;
    for (const a of this.agents) {
      if (a.arrived) arrived++;
      if (a.waiting) {
        waiting++;
        stalled++;
      }
      maxSpeed = Math.max(maxSpeed, a.speed);
    }
    return {
      time: this.time,
      minSurfaceGap: allTime,
      currentMinGap,
      arrived,
      total: this.agents.length,
      stalled,
      waiting,
      maxSpeedObserved: maxSpeed,
      layoutOverlaps: this.layoutOverlaps,
    };
  }

  /** 选中代理的邻近列表(表面距离在感知半径内) */
  neighborsOf(id: number): Array<{ id: number; surfaceGap: number }> {
    const me = this.agents.find((a) => a.id === id);
    if (!me) return [];
    const out: Array<{ id: number; surfaceGap: number }> = [];
    for (const o of this.agents) {
      if (o.id === id) continue;
      const surfaceGap = dist(me.pos, o.pos) - me.radius - o.radius;
      if (surfaceGap <= NEIGHBOR_DIST) {
        out.push({ id: o.id, surfaceGap });
      }
    }
    return out.sort((x, y) => x.surfaceGap - y.surfaceGap);
  }

  /** 运行中拖动目标点 */
  dragGoal(id: number, goal: Vec): void {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return;
    agent.goal = {
      x: clamp(goal.x, agent.radius, WORLD_W - agent.radius),
      y: clamp(goal.y, agent.radius, WORLD_H - agent.radius),
    };
    if (dist(agent.pos, agent.goal) > ARRIVE_EPS * 2) {
      agent.arrived = false;
      this.finished = false;
    }
  }

  /** 暂停后拖动代理身体,释放后按当前现场重新避让 */
  dragAgent(id: number, pos: Vec): void {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return;
    agent.pos = {
      x: clamp(pos.x, agent.radius, WORLD_W - agent.radius),
      y: clamp(pos.y, agent.radius, WORLD_H - agent.radius),
    };
    agent.vel = { x: 0, y: 0 };
    agent.stallTimer = 0;
    if (dist(agent.pos, agent.goal) > ARRIVE_EPS * 2) agent.arrived = false;
    this.refreshLayoutOverlaps();
  }

  /** 重置:回到初始起点/目标,清空全部历史统计与轨迹 */
  reset(): void {
    for (const agent of this.agents) {
      agent.pos = { ...agent.spec.pos };
      agent.goal = { ...agent.spec.goal };
      agent.vel = { x: 0, y: 0 };
      agent.arrived = false;
      agent.waiting = false;
      agent.stallTimer = 0;
      agent.resetTrail();
    }
    this.time = 0;
    this.finished = false;
    this.allArrivedTime = null;
    this.allTimeMinGap = Infinity;
    this.allTimeMaxSpeed = 0;
    this.refreshLayoutOverlaps();
  }
}
