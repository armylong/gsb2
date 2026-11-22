/**
 * 纯规则层：绳长约束、拉紧判定、角色受力与受限回滚。
 * 不依赖 DOM，可作为确定性重放的内核。
 *
 * 核心模型：
 *  - 绳子有历史。RopeSim 维护一条“已绕拐点序列” wraps，而不是每帧重新求
 *    全局最短路径。这样绳子不会凭空跳到障碍另一侧。
 *  - 每帧由 wraps.ts 的 evolveWraps 增量更新：能直接拉直 -> 解开；
 *    某段被障碍边严格挡住 -> 绕上最近的可见拐点。
 *  - 折线长度按各段实际欧氏距离累计（不是锚点到角色的直线距离）。
 *  - 可用绳长 L 只约束“拉紧”：折线 > L 时沿最后一段绳径向把角色拉回；
 *    拉不回（会穿入障碍）则整步回滚，保留上一个有效状态。
 *  - 拐点事件只在绳拉紧时公布，并有去抖，避免临界处反复增删。
 */
import { Vec, add, clamp, dist, dot, mul, norm, pointInPolygon, polygonDistance, sub } from './math.js';
import {
  ObstacleDef,
  RopeCorner,
  RopePath,
  bodyBlocked,
  clonePath,
  resolveCircleObstacles,
  solveRopePath,
} from './rope.js';
import { buildPathFromWraps, evolveWraps, verifyWraps } from './wraps.js';

export const GRAVITY = 900; // 像素/秒²
export const BASE_DT = 1 / 120; // 内部最大固定步长
export const MAX_SPEED = 2400;
export const PAYOUT_RATE = 200; // 像素/秒
export const TAKEUP_RATE = 260; // 像素/秒
export const ANCHOR_RADIUS = 11; // 锚点轮半径（角色不能穿过）

/** 锚点是否落在障碍内部或离障碍太近。 */
export function anchorInsideObstacle(anchor: Vec, obstacles: readonly ObstacleDef[], radius = ANCHOR_RADIUS): boolean {
  for (const ob of obstacles) {
    if (pointInPolygon(anchor, ob.points)) return true;
    if (polygonDistance(anchor, ob.points).d < radius) return true;
  }
  return false;
}
/** 拐点增删的去抖时间（秒）。 */
export const WRAP_DEBOUNCE = 0.05;

export interface InputState {
  /** 左右发力 -1..1；需要支撑（接触障碍或绳已绷紧）。 */
  swing: number;
  /** 收绳/放绳 -1..1；+1 为收短。 */
  ropeTrim: number;
}

export const EMPTY_INPUT: InputState = { swing: 0, ropeTrim: 0 };

export interface SimConfig {
  anchor: Vec;
  radius: number;
  obstacles: ObstacleDef[];
  ropeLength: number;
  autoWrap: boolean;
  autoRelease: boolean;
}

export interface BodyState {
  pos: Vec;
  vel: Vec;
  sinceContact: number;
  contact: boolean;
}

export type EventKind = 'wrap' | 'release' | 'takeup-limit' | 'anchor-move' | 'reset';

export interface SimEvent {
  t: number;
  frame: number;
  kind: EventKind;
  text: string;
  cornerKey?: string;
  /** 事件发生时的角色位置（时间线点击时用于回看）。 */
  bodyPos: Vec;
  pathPoints: Vec[];
  /** 事件发生时的拐点 key 序列，与 pathPoints 的中间点一一对应。 */
  cornerKeys: string[];
  ropeLength: number;
  anchor: Vec;
  taut: boolean;
}

export interface TakeupLimit {
  active: boolean;
  requested: number;
  allowed: number;
  reason: string;
  /** 当前几何下还能收到的最短绳长。 */
  minLength: number;
}

export interface StepResult {
  events: SimEvent[];
  blockedReason: string | null;
}

export interface SimSnapshot {
  t: number;
  frame: number;
  anchor: Vec;
  ropeLength: number;
  body: BodyState;
  path: RopePath;
  wraps: RopeCorner[];
  taut: boolean;
  tensionDir: Vec;
  ropeSlack: number;
  takeup: TakeupLimit;
  blockedReason: string | null;
  events: SimEvent[];
  sweptClean: boolean;
}

export interface SimState {
  t: number;
  frame: number;
  anchor: Vec;
  ropeLength: number;
  body: BodyState;
  path: RopePath;
  wraps: RopeCorner[];
  events: SimEvent[];
  takeup: TakeupLimit;
  blockedReason: string | null;
  paused: boolean;
}

export interface ResolveResult {
  wraps: RopeCorner[];
  added: RopeCorner[];
  removed: RopeCorner[];
  path: RopePath;
}

/**
 * 由“上一帧的拐点历史”解析出当前绳路。
 * 若增量结果不可行（每段必须可见），退回全局最短可见折线作为兜底；
 * 兜底只会在几何极端时发生，并会明确报告 added/removed。
 */
export function resolveRope(
  anchor: Vec,
  body: Vec,
  prevWraps: readonly RopeCorner[],
  obstacles: readonly ObstacleDef[],
): ResolveResult {
  const ev = evolveWraps(anchor, body, prevWraps, obstacles);
  let wraps = ev.wraps;
  let added = ev.added;
  let removed = ev.removed;
  if (!verifyWraps(anchor, body, wraps, obstacles)) {
    const sp = solveRopePath(anchor, body, obstacles, null);
    const spKeys = new Set(sp.corners.map((c) => c.key));
    const prevKeys = new Set(prevWraps.map((c) => c.key));
    added = sp.corners.filter((c) => !prevKeys.has(c.key));
    removed = prevWraps.filter((c) => !spKeys.has(c.key));
    wraps = sp.corners;
  }
  return { wraps, added, removed, path: buildPathFromWraps(anchor, body, wraps) };
}

interface ProjectionResult {
  ok: boolean;
  pos: Vec;
  path: RopePath;
  wraps: RopeCorner[];
  reason: string;
}

/**
 * 把角色沿“最后一段绳”的径向拉回，使实际折线路径长度不超过 L。
 * 关键点：r = L − prefix，prefix 是锚点到最后一个拐点的真实累计长度。
 * 这正是“连续绕过两个拐角按实际路径消耗绳长”的体现。
 */
export function projectToRopeLength(
  anchor: Vec,
  pos: Vec,
  radius: number,
  obstacles: readonly ObstacleDef[],
  L: number,
  wraps: readonly RopeCorner[],
): ProjectionResult {
  let p = { ...pos };
  let currentWraps = wraps.map((w) => ({ ...w, point: { ...w.point } }));
  let resolved = resolveRope(anchor, p, currentWraps, obstacles);
  currentWraps = resolved.wraps;
  let path = resolved.path;
  for (let iter = 0; iter < 8; iter++) {
    if (path.totalLength <= L + 1e-6) return { ok: true, pos: p, path, wraps: currentWraps, reason: '' };
    const last = path.points[path.points.length - 2];
    const lastSeg = dist(last, p);
    const prefix = path.totalLength - lastSeg;
    const r = L - prefix;
    if (r < -1e-6) {
      const lastCorner = path.corners[path.corners.length - 1];
      return {
        ok: false,
        pos: p,
        path,
        wraps: currentWraps,
        reason: `可用绳长不足：沿实际路径到“${lastCorner ? lastCorner.label : '锚点'}”已用 ${prefix.toFixed(1)}px，只剩 ${Math.max(0, L - prefix).toFixed(1)}px，无法再把角色拉回外侧`,
      };
    }
    if (lastSeg <= r + 1e-9) return { ok: true, pos: p, path, wraps: currentWraps, reason: '' };
    const dir = norm(sub(p, last));
    const next = add(last, mul(dir, Math.max(0, r)));
    if (dist(next, anchor) < radius + ANCHOR_RADIUS) {
      return {
        ok: false,
        pos: p,
        path,
        wraps: currentWraps,
        reason: `可用绳长不足：再收短角色会撞上锚点（需要至少 ${(radius + ANCHOR_RADIUS).toFixed(0)}px 间距）`,
      };
    }
    const sep = resolveCircleObstacles(next, radius, obstacles);
    if (bodyBlocked(sep.pos, radius, obstacles)) {
      return {
        ok: false,
        pos: p,
        path,
        wraps: currentWraps,
        reason: '可用绳长不足：继续收紧会把角色压进障碍物',
      };
    }
    p = sep.pos;
    resolved = resolveRope(anchor, p, currentWraps, obstacles);
    currentWraps = resolved.wraps;
    path = resolved.path;
  }
  if (path.totalLength > L + 0.05) {
    const lastCorner = path.corners[path.corners.length - 1];
    return {
      ok: false,
      pos: p,
      path,
      wraps: currentWraps,
      reason: lastCorner
        ? `可用绳长不足：绳绕在${lastCorner.label}上，角色已贴着该拐点外侧，再收就会把角色挤进障碍`
        : '可用绳长不足：折线路径无法收敛到当前绳长',
    };
  }
  return { ok: true, pos: p, path, wraps: currentWraps, reason: '' };
}

interface PendingCorner {
  kind: 'wrap' | 'release' | 'detach';
  since: number;
  corner: RopeCorner;
}

export class RopeSim {
  config: SimConfig;
  t = 0;
  frame = 0;
  anchor: Vec;
  body: BodyState;
  path: RopePath;
  /** 绳子“挂住”的拐点历史（按锚点到角色的顺序）。 */
  wraps: RopeCorner[] = [];
  /** 用户设定的可用绳长（收放操作改变它）。 */
  ropeLength: number;
  events: SimEvent[] = [];
  lastBlockedReason: string | null = null;
  paused = false;
  /** 最近一步是否没有发生“扫掠穿透”。 */
  sweptClean = true;
  /** 最近一次 step 内部各子步的位置，用于大步骤时展示扫掠采样。 */
  lastStepSamples: Vec[] = [];
  private takeup: TakeupLimit = { active: false, requested: 0, allowed: 0, reason: '', minLength: 0 };
  /** 上一次对外报告的受限原因与时间（用于节流，避免每子步刷一条事件）。 */
  private lastLimitReason = '';
  private lastLimitEventT = -1;
  /** 已公布的拐点（用于时间线去重与回放）。 */
  private announced = new Map<string, RopeCorner>();
  private pending = new Map<string, PendingCorner>();

  constructor(config: SimConfig, start: { pos: Vec; vel: Vec }) {
    this.config = {
      ...config,
      anchor: { ...config.anchor },
      obstacles: config.obstacles.map((o) => ({
        ...o,
        points: o.points.map((p) => ({ ...p })),
        vertexLabels: o.vertexLabels ? [...o.vertexLabels] : undefined,
      })),
    };
    this.anchor = { ...config.anchor };
    this.ropeLength = config.ropeLength;
    this.body = { pos: { ...start.pos }, vel: { ...start.vel }, sinceContact: 999, contact: false };
    const initial = solveRopePath(this.anchor, this.body.pos, this.config.obstacles, null);
    this.wraps = initial.corners.map((c) => ({ ...c, point: { ...c.point } }));
    this.path = buildPathFromWraps(this.anchor, this.body.pos, this.wraps);
    this.takeup = { active: false, requested: 0, allowed: 0, reason: '', minLength: this.ropeLength };
  }

  /** 抬高/放低锚点。若新位置使绳长不足且角色拉不回来，则撤销移动。 */
  moveAnchor(anchor: Vec): SimEvent[] {
    if (anchorInsideObstacle(anchor, this.config.obstacles, ANCHOR_RADIUS)) {
      const reason = '锚点不能进入障碍物内部';
      const ev = this.makeEvent('takeup-limit', reason);
      this.events.push(ev);
      return [ev];
    }
    const oldAnchor = { ...this.anchor };
    const oldBody = { ...this.body.pos };
    const oldVel = { ...this.body.vel };
    const oldPath = clonePath(this.path);
    const oldWraps = this.wraps.map((w) => ({ ...w, point: { ...w.point } }));

    const resolved = resolveRope(anchor, this.body.pos, this.wraps, this.config.obstacles);
    let bodyPos = this.body.pos;
    let wraps = resolved.wraps;
    let path = resolved.path;
    if (path.totalLength > this.ropeLength + 0.05) {
      const proj = projectToRopeLength(anchor, bodyPos, this.config.radius, this.config.obstacles, this.ropeLength, wraps);
      if (!proj.ok) {
        this.anchor = oldAnchor;
        this.body.pos = oldBody;
        this.body.vel = oldVel;
        this.path = oldPath;
        this.wraps = oldWraps;
        const reason = `锚点移动被拒绝：${proj.reason}`;
        const ev = this.makeEvent('takeup-limit', reason);
        this.events.push(ev);
        return [ev];
      }
      bodyPos = proj.pos;
      wraps = proj.wraps;
      path = proj.path;
    }
    this.anchor = { ...anchor };
    this.body.pos = bodyPos;
    this.wraps = wraps;
    this.path = path;
    const events: SimEvent[] = [];
    this.announceChanges(events);
    const move = this.makeEvent('anchor-move', `锚点移动到 (${anchor.x.toFixed(0)}, ${anchor.y.toFixed(0)})`);
    // 拖拽会高频触发：把 0.25s 内的连续锚点移动合并成一条。
    const last = this.events[this.events.length - 1];
    if (last && last.kind === 'anchor-move' && move.t - last.t < 0.25) {
      last.text = move.text;
      last.t = move.t;
      last.frame = move.frame;
      last.bodyPos = move.bodyPos;
      last.pathPoints = move.pathPoints;
      last.cornerKeys = move.cornerKeys;
      last.ropeLength = move.ropeLength;
      last.anchor = move.anchor;
      last.taut = move.taut;
    } else {
      events.push(move);
    }
    this.events.push(...events);
    return events;
  }

  setRopeLength(length: number): void {
    this.ropeLength = Math.max(0, length);
  }

  get taut(): boolean {
    return this.path.totalLength >= this.ropeLength - 0.1;
  }

  get slack(): number {
    return Math.max(0, this.ropeLength - this.path.totalLength);
  }

  /** 角色受到的绳张力方向（由角色指向上一拐点/锚点）。 */
  tensionDirection(): Vec {
    const pts = this.path.points;
    if (pts.length < 2) return { x: 0, y: -1 };
    return norm(sub(pts[pts.length - 2], this.body.pos));
  }

  /** 推进一个可变步长；内部固定步长 + 位移上限细分，避免大步穿隧。 */
  step(dt: number, input: InputState): StepResult {
    if (this.paused) return { events: [], blockedReason: null };
    const events: SimEvent[] = [];
    const speed = Math.hypot(this.body.vel.x, this.body.vel.y);
    const byTime = Math.ceil(dt / BASE_DT - 1e-9);
    const byMove = Math.ceil((speed * dt) / Math.max(4, this.config.radius * 0.5));
    const substeps = Math.max(1, byTime, byMove);
    const h = dt / substeps;
    let blockedReason: string | null = null;
    this.lastStepSamples = [{ ...this.body.pos }];
    for (let i = 0; i < substeps; i++) {
      const res = this.substep(h, input, events);
      if (res) blockedReason = res;
      this.t += h;
      this.lastStepSamples.push({ ...this.body.pos });
    }
    this.frame++;
    this.lastBlockedReason = blockedReason;
    this.events.push(...events);
    return { events, blockedReason };
  }

  private substep(h: number, input: InputState, events: SimEvent[]): string | null {
    const cfg = this.config;
    const prevPos = { ...this.body.pos };
    const prevVel = { ...this.body.vel };
    const prevPath = clonePath(this.path);
    const prevWraps = this.wraps.map((w) => ({ ...w, point: { ...w.point } }));
    const prevRope = this.ropeLength;
    const wasTaut = this.taut;
    this.takeup = { active: false, requested: 0, allowed: 0, reason: '', minLength: this.ropeLength };

    const contact = this.contactWithObstacle();
    this.body.contact = contact;
    this.body.sinceContact = contact ? 0 : this.body.sinceContact + h;

    // 1. 重力
    this.body.vel = add(this.body.vel, { x: 0, y: GRAVITY * h });

    // 2. 左右发力：需要支撑（接触障碍或绳已绷紧）。
    const canPush = contact || wasTaut;
    if (input.swing !== 0 && canPush) {
      const dir = Math.sign(input.swing);
      const strength = Math.min(1, Math.abs(input.swing));
      this.body.vel = add(this.body.vel, { x: dir * strength * 820 * h, y: 0 });
    }

    // 3. 收放绳长。收短前做可行性检查，只收“物理上还收得动”的部分。
    if (input.ropeTrim > 0) {
      const request = TAKEUP_RATE * Math.min(1, input.ropeTrim) * h;
      const allowed = this.maxFeasibleTakeup(request);
      if (allowed < request - 1e-9) {
        const reason = this.takeup.reason || '可用绳长不足：拐点限定了实际路径，无法继续收短';
        this.takeup.active = true;
        this.takeup.reason = reason;
        this.reportLimit(reason, events);
      }
      this.ropeLength = Math.max(0, this.ropeLength - allowed);
    } else if (input.ropeTrim < 0) {
      const pay = PAYOUT_RATE * Math.min(1, -input.ropeTrim) * h;
      this.ropeLength = Math.min(this.ropeLength + pay, 6000);
    }

    // 4. 位置积分
    this.body.pos = add(this.body.pos, mul(this.body.vel, h));

    // 5. 角色-障碍分离
    const sep = resolveCircleObstacles(this.body.pos, cfg.radius, cfg.obstacles);
    this.body.pos = sep.pos;

    // 6. 绳长约束：若折线超过可用绳长，沿末段径向把角色拉回；
    //    拉不回则回滚本步，保留上一个有效状态。
    const proj = projectToRopeLength(
      this.anchor,
      this.body.pos,
      cfg.radius,
      cfg.obstacles,
      this.ropeLength,
      this.wraps,
    );
    if (!proj.ok) {
      this.body.pos = prevPos;
      this.body.vel = prevVel;
      this.ropeLength = prevRope;
      this.path = prevPath;
      this.wraps = prevWraps;
      this.takeup = { active: true, requested: 0, allowed: 0, reason: proj.reason, minLength: prevRope };
      this.reportLimit(proj.reason, events);
      return proj.reason;
    }
    const pulled = dist(proj.pos, this.body.pos) > 1e-9 || proj.path.totalLength < this.path.totalLength - 1e-9;
    this.body.pos = proj.pos;
    this.wraps = proj.wraps;
    this.path = proj.path;
    if (pulled) {
      // 拉紧时不可伸长：去掉沿绳向外的速度分量。
      const last = proj.path.points[proj.path.points.length - 2] ?? this.anchor;
      const outward = norm(sub(this.body.pos, last));
      const radial = dot(this.body.vel, outward);
      if (radial > 0) this.body.vel = sub(this.body.vel, mul(outward, radial));
    }

    // 7. 按当前几何再解析一次绳路，并公布稳定的拐点增删。
    this.recomputePath(events);

    // 8. 角色圆与障碍再次分离
    const sep2 = resolveCircleObstacles(this.body.pos, cfg.radius, cfg.obstacles);
    if (dist(sep2.pos, this.body.pos) > 1e-6) this.body.pos = sep2.pos;
    if (bodyBlocked(this.body.pos, cfg.radius, cfg.obstacles)) {
      this.body.pos = prevPos;
      this.body.vel = prevVel;
      this.ropeLength = prevRope;
      this.path = prevPath;
      this.wraps = prevWraps;
      const reason = '角色圆会与障碍重叠，本步已回滚';
      events.push(this.makeEvent('takeup-limit', reason));
      return reason;
    }

    // 9. 扫掠检查：大步长下沿位移采样，确认没有从障碍中穿过。
    if (!this.sweptSegmentClear(prevPos, this.body.pos)) {
      this.sweptClean = false;
      const reason = '检测到扫掠穿透，本步已回滚';
      this.body.pos = prevPos;
      this.body.vel = prevVel;
      this.ropeLength = prevRope;
      this.path = prevPath;
      this.wraps = prevWraps;
      this.reportLimit(reason, events, true);
      return reason;
    }
    this.sweptClean = true;

    // 10. 速度上限
    const sp = Math.hypot(this.body.vel.x, this.body.vel.y);
    if (sp > MAX_SPEED) this.body.vel = mul(this.body.vel, MAX_SPEED / sp);
    return null;
  }

  /** 受限事件节流：同一原因每 0.4s 最多一条；原因变化立即记录。 */
  private reportLimit(reason: string, events: SimEvent[], force = false): void {
    const now = this.t;
    const same = reason === this.lastLimitReason;
    if (!force && same && now - this.lastLimitEventT < 0.4) return;
    this.lastLimitReason = reason;
    this.lastLimitEventT = now;
    events.push(this.makeEvent('takeup-limit', reason));
  }

  private sweptSegmentClear(a: Vec, b: Vec): boolean {
    const d = dist(a, b);
    const n = Math.max(1, Math.ceil(d / Math.max(2, this.config.radius * 0.5)));
    for (let i = 1; i <= n; i++) {
      const p = add(a, mul(sub(b, a), i / n));
      if (bodyBlocked(p, this.config.radius, this.config.obstacles)) return false;
    }
    return true;
  }

  private contactWithObstacle(): boolean {
    for (const ob of this.config.obstacles) {
      if (this.penetrationAgainst(this.body.pos, ob) > -0.75) return true;
    }
    return false;
  }

  private penetrationAgainst(p: Vec, ob: ObstacleDef): number {
    const r = this.config.radius;
    let bestD = Infinity;
    for (let i = 0; i < ob.points.length; i++) {
      const a = ob.points[i];
      const b = ob.points[(i + 1) % ob.points.length];
      const ab = sub(b, a);
      const l2 = ab.x * ab.x + ab.y * ab.y;
      const t = l2 < 1e-18 ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
      const q = add(a, mul(ab, t));
      bestD = Math.min(bestD, dist(p, q));
    }
    let inside = false;
    for (let i = 0, j = ob.points.length - 1; i < ob.points.length; j = i++) {
      const pi = ob.points[i];
      const pj = ob.points[j];
      if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) {
        inside = !inside;
      }
    }
    return inside ? bestD + r : r - bestD;
  }

  /**
   * 二分搜索本步最多能收多短。可行性完全由实际折线路径长度判定
   * （projectToRopeLength），不以锚点到角色的直线距离代替。
   */
  private maxFeasibleTakeup(request: number): number {
    const current = this.ropeLength;
    if (request <= 1e-12) return 0;
    const feasible = (L: number): ProjectionResult =>
      projectToRopeLength(this.config.anchor, this.body.pos, this.config.radius, this.config.obstacles, L, this.wraps);

    const test = feasible(current - request);
    if (test.ok) {
      this.takeup = { active: false, requested: request, allowed: request, reason: '', minLength: current - request };
      return request;
    }
    let lo = current - request;
    let hi = current;
    let best = current;
    let reason = test.reason;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const r = feasible(mid);
      if (r.ok) {
        best = mid;
        hi = mid;
      } else {
        lo = mid;
        reason = r.reason;
      }
    }
    const allowed = Math.max(0, current - best);
    this.takeup = { active: true, requested: request, allowed, reason, minLength: best };
    return allowed;
  }

  /** 重新解析绳路（可能增删拐点），然后公布去抖后的拐点事件。 */
  recomputePath(events: SimEvent[]): void {
    const resolved = resolveRope(this.anchor, this.body.pos, this.wraps, this.config.obstacles);
    this.wraps = resolved.wraps;
    this.path = resolved.path;
    this.announceChanges(events);
  }

  /**
   * 公布拐点增删：
   *  - 只有拉紧的绳段才算“绕上/解开”，松弛下落时只更新内部历史。
   *  - 候选持续 WRAP_DEBOUNCE 秒才公布，给临界擦角一个稳定取舍。
   */
  private announceChanges(events: SimEvent[]): void {
    const now = this.t;
    const current = new Map(this.wraps.map((c) => [c.key, c]));

    // 绕上只在绳拉紧时发生（松弛的绳不会挂住拐角）。
    if (this.taut && this.config.autoWrap) {
      for (const [key, c] of current) {
        if (this.announced.has(key)) continue;
        const p = this.pending.get(key);
        if (!p || p.kind !== 'wrap') this.pending.set(key, { kind: 'wrap', since: now, corner: c });
        else p.corner = c;
      }
    }
    // 解开是几何关系变化，无论绳子是否绷紧都应当记录。
    for (const [key, c] of this.announced) {
      if (current.has(key)) {
        this.pending.delete(key);
        continue;
      }
      const p = this.pending.get(key);
      if (!p || (p.kind !== 'release' && p.kind !== 'detach')) {
        this.pending.set(key, {
          kind: this.config.autoRelease ? 'release' : 'detach',
          since: now,
          corner: c,
        });
      }
    }

    // 已经回来/已经消失的候选直接撤销。
    for (const [key, p] of [...this.pending]) {
      if (p.kind === 'wrap' && !current.has(key)) this.pending.delete(key);
      if (p.kind === 'release' && current.has(key)) this.pending.delete(key);
      if (p.kind === 'detach' && current.has(key)) this.pending.delete(key);
    }

    for (const [key, p] of [...this.pending]) {
      if (now - p.since < WRAP_DEBOUNCE) continue;
      if (p.kind === 'wrap') {
        const c = current.get(key);
        if (!c) {
          this.pending.delete(key);
          continue;
        }
        if (!this.config.autoWrap || !this.taut) continue;
        this.announced.set(key, c);
        events.push(this.makeEvent('wrap', `绕上 ${c.label}`, key, c.point));
        this.pending.delete(key);
      } else if (p.kind === 'detach') {
        // 松弛状态下从绳上滑脱：静默遗忘，不写入事件。
        if (current.has(key)) {
          this.pending.delete(key);
          continue;
        }
        this.announced.delete(key);
        this.pending.delete(key);
      } else {
        if (current.has(key) || !this.config.autoRelease) {
          this.pending.delete(key);
          continue;
        }
        const c = p.corner;
        this.announced.delete(key);
        events.push(this.makeEvent('release', `解开 ${c.label}`, key, c.point));
        this.pending.delete(key);
      }
    }
  }

  makeEvent(kind: EventKind, text: string, cornerKey?: string, _position?: Vec): SimEvent {
    return {
      t: this.t,
      frame: this.frame,
      kind,
      text,
      cornerKey,
      bodyPos: { ...this.body.pos },
      pathPoints: this.path.points.map((p) => ({ ...p })),
      cornerKeys: this.path.corners.map((c) => c.key),
      ropeLength: this.ropeLength,
      anchor: { ...this.anchor },
      taut: this.taut,
    };
  }

  snapshot(): SimSnapshot {
    return {
      t: this.t,
      frame: this.frame,
      anchor: { ...this.anchor },
      ropeLength: this.ropeLength,
      body: {
        pos: { ...this.body.pos },
        vel: { ...this.body.vel },
        sinceContact: this.body.sinceContact,
        contact: this.body.contact,
      },
      path: clonePath(this.path),
      wraps: this.wraps.map((w) => ({ ...w, point: { ...w.point } })),
      taut: this.taut,
      tensionDir: this.tensionDirection(),
      ropeSlack: this.slack,
      takeup: { ...this.takeup },
      blockedReason: this.lastBlockedReason,
      events: this.events.slice(),
      sweptClean: this.sweptClean,
    };
  }

  captureState(): SimState {
    return {
      t: this.t,
      frame: this.frame,
      anchor: { ...this.anchor },
      ropeLength: this.ropeLength,
      body: {
        pos: { ...this.body.pos },
        vel: { ...this.body.vel },
        sinceContact: this.body.sinceContact,
        contact: this.body.contact,
      },
      path: clonePath(this.path),
      wraps: this.wraps.map((w) => ({ ...w, point: { ...w.point } })),
      events: this.events.map((e) => ({
        ...e,
        bodyPos: { ...e.bodyPos },
        pathPoints: e.pathPoints.map((p) => ({ ...p })),
        cornerKeys: [...e.cornerKeys],
        anchor: { ...e.anchor },
      })),
      takeup: { ...this.takeup },
      blockedReason: this.lastBlockedReason,
      paused: this.paused,
    };
  }

  restoreState(s: SimState): void {
    this.t = s.t;
    this.frame = s.frame;
    this.anchor = { ...s.anchor };
    this.ropeLength = s.ropeLength;
    this.body = {
      pos: { ...s.body.pos },
      vel: { ...s.body.vel },
      sinceContact: s.body.sinceContact,
      contact: s.body.contact,
    };
    this.path = clonePath(s.path);
    this.wraps = s.wraps.map((w) => ({ ...w, point: { ...w.point } }));
    this.events = s.events.map((e) => ({
      ...e,
      bodyPos: { ...e.bodyPos },
      pathPoints: e.pathPoints.map((p) => ({ ...p })),
      cornerKeys: [...e.cornerKeys],
      anchor: { ...e.anchor },
    }));
    this.takeup = { ...s.takeup };
    this.lastBlockedReason = s.blockedReason;
    this.paused = s.paused;
    this.announced = new Map();
    this.pending = new Map();
    for (const e of this.events) {
      if ((e.kind === 'wrap' || e.kind === 'release') && e.cornerKey) {
        const corner = this.wraps.find((w) => w.key === e.cornerKey);
        if (corner) this.announced.set(e.cornerKey, corner);
        else this.announced.delete(e.cornerKey);
      }
    }
  }

  reset(start: { pos: Vec; vel: Vec }, ropeLength = this.config.ropeLength, anchor = this.config.anchor): void {
    this.t = 0;
    this.frame = 0;
    this.anchor = { ...anchor };
    this.ropeLength = ropeLength;
    this.body = { pos: { ...start.pos }, vel: { ...start.vel }, sinceContact: 999, contact: false };
    this.events = [];
    this.lastBlockedReason = null;
    this.takeup = { active: false, requested: 0, allowed: 0, reason: '', minLength: ropeLength };
    const initial = solveRopePath(this.anchor, this.body.pos, this.config.obstacles, null);
    this.wraps = initial.corners.map((c) => ({ ...c, point: { ...c.point } }));
    this.path = buildPathFromWraps(this.anchor, this.body.pos, this.wraps);
    this.paused = false;
    this.sweptClean = true;
    this.announced.clear();
    this.pending.clear();
    this.lastStepSamples = [];
    this.lastLimitReason = '';
    this.lastLimitEventT = -1;
  }
}
