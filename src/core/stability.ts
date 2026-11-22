/**
 * 视角变化分类器。
 *
 * 目的：缓慢转动镜头时，让排布引擎继续沿用上一帧的 slot（粘滞），
 * 避免标签在左右两侧来回交换；而「突然换视角」（预设视角、瞬移、
 * 大幅旋转/缩放）时清空粘滞，使标签按新视角重新选择最合适的位子。
 *
 * 分类只依赖相机位置 / 目标点 / FOV，不依赖具体渲染器。
 */

import { distance, normalize, dot, subtract, type Vec3Like } from './visibility';

export interface CameraPose {
  position: Vec3Like;
  target: Vec3Like;
  fov: number;
}

export interface ChangeThresholds {
  /** 每秒最大平移速度（场景单位/秒）超过即视为跳转。 */
  maxSpeed: number;
  /** 每秒最大角度变化（度/秒）超过即视为跳转。 */
  maxAngularSpeed: number;
  /** 相机到目标的距离变化比例超过即视为跳转。 */
  maxZoomRatio: number;
  /** 两次采样之间允许的最大时间间隔（秒）；超出则不参考速度，只看绝对变化。 */
  maxGap: number;
  /** 单帧绝对角度变化（度）上限。 */
  maxStepAngle: number;
  /** 单帧绝对平移（场景单位）上限。 */
  maxStepDistance: number;
}

export const DEFAULT_THRESHOLDS: ChangeThresholds = {
  maxSpeed: 90,
  maxAngularSpeed: 140,
  maxZoomRatio: 0.35,
  maxGap: 0.25,
  maxStepAngle: 28,
  maxStepDistance: 9,
};

export type ChangeKind = 'none' | 'smooth' | 'jump';

export interface ChangeResult {
  kind: ChangeKind;
  angleDeg: number;
  /** 单位方向向量的变化（0–2）。 */
  directionDelta: number;
  positionDelta: number;
  zoomRatio: number;
  dt: number;
}

function orbitDirection(pose: CameraPose): Vec3Like {
  return normalize(subtract(pose.position, pose.target));
}

function orbitRadius(pose: CameraPose): number {
  return distance(pose.position, pose.target);
}

/** 角度制，忽略平移，只看「从目标看相机」的方向。 */
export function angleBetweenPoses(a: CameraPose, b: CameraPose): number {
  const da = orbitDirection(a);
  const db = orbitDirection(b);
  const c = Math.min(1, Math.max(-1, dot(da, db)));
  return (Math.acos(c) * 180) / Math.PI;
}

export function classifyChange(
  prev: CameraPose | null,
  next: CameraPose,
  dt: number,
  thresholds: ChangeThresholds = DEFAULT_THRESHOLDS,
): ChangeResult {
  if (!prev) {
    return {
      kind: 'jump',
      angleDeg: 0,
      directionDelta: 0,
      positionDelta: 0,
      zoomRatio: 0,
      dt: 0,
    };
  }

  const safeDt = Math.max(dt, 1 / 240);
  const dirPrev = orbitDirection(prev);
  const dirNext = orbitDirection(next);
  const directionDelta = distance(dirPrev, dirNext);
  const angleDeg = angleBetweenPoses(prev, next);
  const positionDelta = distance(prev.position, next.position);
  const rPrev = orbitRadius(prev);
  const rNext = orbitRadius(next);
  const zoomRatio = rPrev > 1e-6 ? Math.abs(rNext - rPrev) / rPrev : 0;

  const reliableDt = dt > 0 && dt <= thresholds.maxGap;

  const stepTooBig =
    angleDeg > thresholds.maxStepAngle || positionDelta > thresholds.maxStepDistance;
  const speedTooBig = reliableDt
    ? angleDeg / safeDt > thresholds.maxAngularSpeed ||
      positionDelta / safeDt > thresholds.maxSpeed
    : false;
  const zoomTooBig = zoomRatio > thresholds.maxZoomRatio;

  if (stepTooBig || speedTooBig || zoomTooBig) {
    return {
      kind: 'jump',
      angleDeg,
      directionDelta,
      positionDelta,
      zoomRatio,
      dt,
    };
  }

  const changed = angleDeg > 0.01 || positionDelta > 1e-4;
  return {
    kind: changed ? 'smooth' : 'none',
    angleDeg,
    directionDelta,
    positionDelta,
    zoomRatio,
    dt,
  };
}

/**
 * 维护上一帧相机状态，供渲染循环调用。
 * `update()` 返回本帧应如何处理粘滞位。
 */
export class ViewChangeTracker {
  private prev: CameraPose | null = null;
  private lastTime = 0;

  constructor(private readonly thresholds: ChangeThresholds = DEFAULT_THRESHOLDS) {}

  update(pose: CameraPose, nowSeconds: number): ChangeResult {
    const dt = this.lastTime > 0 ? nowSeconds - this.lastTime : 0;
    const result = classifyChange(this.prev, pose, dt, this.thresholds);
    this.prev = {
      position: { ...pose.position },
      target: { ...pose.target },
      fov: pose.fov,
    };
    this.lastTime = nowSeconds;
    return result;
  }

  reset(): void {
    this.prev = null;
    this.lastTime = 0;
  }
}
