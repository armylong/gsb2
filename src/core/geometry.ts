/**
 * 基础几何与轨段模型。
 *
 * 约定:
 * - 长度单位统一为 "世界单位" (近似像素), 角度用弧度。
 * - 屏幕坐标 y 轴向下; 所有几何都在同一坐标系内, 不影响物理。
 * - 每段轨道都是一条参数曲线 p(u), u ∈ [0,1], 弧长 s = u * length。
 *   车辆按 **弧长** 前进 (s += v * dt), 所以线速度与轨段类型/参数取值无关。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export const TAU = Math.PI * 2;
export const deg = (r: number): number => (r * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

/** 把角度差规范到 (-π, π]。 */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function headingOf(v: Vec2): number {
  return Math.atan2(v.y, v.x);
}

export function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function rotateAround(p: Vec2, pivot: Vec2, angle: number): Vec2 {
  return add(pivot, rotate(sub(p, pivot), angle));
}

export interface Pose {
  pos: Vec2;
  /** 单位切线 (行进方向)。 */
  tangent: Vec2;
}

export interface TrackSegment {
  readonly id: string;
  readonly kind: 'line' | 'arc';
  /** 弧长 (世界单位)。 */
  readonly length: number;
  poseAt(u: number): Pose;
  poseAtS(s: number): Pose;
  sample(count?: number): Vec2[];
}

export interface LineSegmentInit {
  id: string;
  start: Vec2;
  end: Vec2;
}

export class LineSegment implements TrackSegment {
  readonly kind = 'line' as const;
  readonly id: string;
  readonly start: Vec2;
  readonly end: Vec2;
  readonly length: number;

  constructor(init: LineSegmentInit) {
    this.id = init.id;
    this.start = { ...init.start };
    this.end = { ...init.end };
    this.length = dist(this.start, this.end);
  }

  poseAt(u: number): Pose {
    const t = Math.min(1, Math.max(0, u));
    return {
      pos: {
        x: this.start.x + (this.end.x - this.start.x) * t,
        y: this.start.y + (this.end.y - this.start.y) * t,
      },
      tangent: norm(sub(this.end, this.start)),
    };
  }

  poseAtS(s: number): Pose {
    return this.poseAt(this.length < 1e-9 ? 0 : s / this.length);
  }

  sample(count = 2): Vec2[] {
    const n = Math.max(2, count);
    const out: Vec2[] = [];
    for (let i = 0; i < n; i += 1) out.push(this.poseAt(i / (n - 1)).pos);
    return out;
  }
}

export interface ArcSegmentInit {
  id: string;
  center: Vec2;
  radius: number;
  /** 起始极角 (世界坐标)。 */
  startAngle: number;
  /** 带符号扫角, 正 = 极角增大。 */
  sweep: number;
}

/**
 * 圆弧段: p(θ) = center + R(cos θ, sin θ), θ 从 startAngle 扫 sweep。
 * 行进方向 = θ 增大方向 (sweep > 0) 或减小方向 (sweep < 0)。
 */
export class ArcSegment implements TrackSegment {
  readonly kind = 'arc' as const;
  readonly id: string;
  readonly center: Vec2;
  readonly radius: number;
  readonly startAngle: number;
  readonly sweep: number;
  readonly length: number;

  constructor(init: ArcSegmentInit) {
    this.id = init.id;
    this.center = { ...init.center };
    this.radius = Math.abs(init.radius);
    this.startAngle = init.startAngle;
    this.sweep = init.sweep;
    this.length = this.radius * Math.abs(this.sweep);
  }

  pointAtTheta(theta: number): Vec2 {
    return {
      x: this.center.x + this.radius * Math.cos(theta),
      y: this.center.y + this.radius * Math.sin(theta),
    };
  }

  tangentAtTheta(theta: number): Vec2 {
    const s = Math.sign(this.sweep) || 1;
    return norm({ x: -Math.sin(theta) * s, y: Math.cos(theta) * s });
  }

  poseAt(u: number): Pose {
    const t = Math.min(1, Math.max(0, u));
    const theta = this.startAngle + this.sweep * t;
    return { pos: this.pointAtTheta(theta), tangent: this.tangentAtTheta(theta) };
  }

  poseAtS(s: number): Pose {
    return this.poseAt(this.length < 1e-9 ? 0 : s / this.length);
  }

  sample(count = 24): Vec2[] {
    const n = Math.max(2, count);
    const out: Vec2[] = [];
    for (let i = 0; i < n; i += 1) out.push(this.poseAt(i / (n - 1)).pos);
    return out;
  }
}

/**
 * 从给定起点位姿出发, 生成一段圆弧:
 * - turn > 0: 行进方向角度增大;
 * - turn < 0: 行进方向角度减小;
 * - |turn| 是扫角, radius 是半径。
 * 生成的弧在起点与 pose.tangent 精确相切, 这是端点连接规则的基础。
 */
export function arcFromPose(
  id: string,
  pose: Pose,
  radius: number,
  turn: number,
): ArcSegment {
  const f = norm(pose.tangent);
  const sign = Math.sign(turn) || 1;
  // 圆心在行进方向的 +90° (turn>0) 或 -90° (turn<0) 一侧。
  const normal = { x: -f.y, y: f.x };
  const center = add(pose.pos, scale(normal, radius * sign));
  const startAngle = Math.atan2(pose.pos.y - center.y, pose.pos.x - center.x);
  return new ArcSegment({ id, center, radius, startAngle, sweep: turn });
}

/** 从起点位姿出发的直线段。 */
export function lineFromPose(id: string, pose: Pose, length: number): LineSegment {
  const f = norm(pose.tangent);
  return new LineSegment({ id, start: { ...pose.pos }, end: add(pose.pos, scale(f, length)) });
}

/**
 * 起点给定切线方向、终点给定坐标的圆弧 (唯一解)。
 * 若终点恰在切线上 (α≈0) 或超出半圆 (|α|>=π/2), 返回 null, 由调用方回退。
 *
 * 推导: 弦与起点切线的有向夹角 α, 则扫角 = 2α, 半径 = 弦长 / (2 sin α)。
 */
export function arcFromPoseToPoint(id: string, pose: Pose, end: Vec2): ArcSegment | null {
  const t0 = norm(pose.tangent);
  const chord = sub(end, pose.pos);
  const d = len(chord);
  if (d < 1e-6) return null;
  // 有向角: chord 相对起点切线的偏角 (切线 -> 弦)。0 => 共线, |a|>=90° => 拖到了起点后方, 均无解。
  const a = Math.atan2(t0.x * chord.y - t0.y * chord.x, chord.x * t0.x + chord.y * t0.y);
  if (Math.abs(a) < 1e-4 || Math.abs(a) >= Math.PI / 2 - 1e-3) return null;
  const radiusSigned = d / (2 * Math.sin(a));
  const normal = { x: -t0.y, y: t0.x };
  const center = add(pose.pos, scale(normal, radiusSigned));
  const startAngle = Math.atan2(pose.pos.y - center.y, pose.pos.x - center.x);
  return new ArcSegment({ id, center, radius: Math.abs(radiusSigned), startAngle, sweep: 2 * a });
}

/**
 * 起点、终点确定、不指定起点切线时, 用固定扫角 (默认 90°) 生成唯一圆弧。
 * 圆弧的弦切角等于扫角的一半, 所以起点切线 = 弦方向旋转 -sweep/2。
 */
export function arcFromStartEndSweep(
  id: string,
  start: Vec2,
  end: Vec2,
  sweep: number,
): ArcSegment | null {
  const chord = sub(end, start);
  const d = len(chord);
  const half = sweep / 2;
  if (d < 1e-6 || Math.abs(Math.sin(half)) < 1e-6) return null;
  const radius = d / (2 * Math.sin(half));
  const chordHeading = Math.atan2(chord.y, chord.x);
  const tangent = rotate({ x: 1, y: 0 }, chordHeading - half);
  const arc = arcFromPose(id, { pos: { ...start }, tangent }, Math.abs(radius), sweep);
  // arcFromPose 的半径取绝对长度, 圆心侧由 sweep 决定, 再求一次方向确保终点落点正确。
  const endDist = dist(arc.poseAt(1).pos, end);
  if (endDist > 1e-6) {
    // 数值兜底: 用解析生成的圆心重算。
    const normal = { x: -tangent.y, y: tangent.x };
    const center = add(start, scale(normal, radius));
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    return new ArcSegment({ id, center, radius: Math.abs(radius), startAngle, sweep });
  }
  return arc;
}

export function poseText(pose: Pose): string {
  return `(${pose.pos.x.toFixed(1)}, ${pose.pos.y.toFixed(1)}) @ ${deg(headingOf(pose.tangent)).toFixed(1)}°`;
}

export function near(a: Vec2, b: Vec2, radius: number): boolean {
  return dist(a, b) <= radius;
}
