/**
 * 锚点可见性判定（纯逻辑，便于单元测试）。
 *
 * 三种状态：
 * - `visible`  ：从镜头到锚点没有实体阻挡。
 * - `occluded` ：被实体挡住（包括被自己的零件背面挡住）。
 * - `behind`   ：锚点在镜头背后，不参与排布。
 *
 * 关键约定：锚点通常正好落在零件表面上。射线在「距离锚点 tolerance 以内」
 * 的命中视为贴面/浮点误差，不算遮挡；否则从锚点所在零件的近表面到锚点之间
 * 隔着一层实体，就应当判定为被挡。
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type AnchorState = 'visible' | 'occluded' | 'behind';

const EPS = 1e-9;

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function normalize(v: Vec3Like): Vec3Like {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < EPS) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function subtract(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** 场景尺度相关的贴面容差。 */
export function surfaceTolerance(distanceToAnchor: number, sceneScale = 12): number {
  return Math.max(sceneScale * 0.002, distanceToAnchor * 0.0015);
}

export interface VisibilityInput {
  cameraPosition: Vec3Like;
  /** 镜头的朝向（指向 orbit target），无需归一化。 */
  cameraForward: Vec3Like;
  anchorPosition: Vec3Like;
  /** 沿镜头→锚点射线的最近实体命中距离；没有命中为 null。 */
  nearestHitDistance: number | null;
  /** 命中距离落在 [anchorDistance - tolerance, anchorDistance] 内视为贴面。 */
  tolerance: number;
}

export interface VisibilityResult {
  state: AnchorState;
  distance: number;
  /** 判定为遮挡时，最早的阻挡距离。 */
  blockerDistance: number | null;
}

export function classifyVisibility(input: VisibilityInput): VisibilityResult {
  const d = distance(input.cameraPosition, input.anchorPosition);
  if (d < EPS) return { state: 'behind', distance: d, blockerDistance: null };

  const forward = normalize(input.cameraForward);
  const toAnchor = {
    x: (input.anchorPosition.x - input.cameraPosition.x) / d,
    y: (input.anchorPosition.y - input.cameraPosition.y) / d,
    z: (input.anchorPosition.z - input.cameraPosition.z) / d,
  };

  // 正好在镜头平面上的锚点没有可靠的投影，归为 behind。
  if (dot(forward, toAnchor) <= EPS) {
    return { state: 'behind', distance: d, blockerDistance: null };
  }

  const hit = input.nearestHitDistance;
  if (hit !== null && hit >= 0 && hit < d - input.tolerance) {
    return { state: 'occluded', distance: d, blockerDistance: hit };
  }

  return {
    state: 'visible',
    distance: d,
    blockerDistance: hit !== null && hit >= 0 ? hit : null,
  };
}

/** 注入式判定，便于不依赖 Three.js 的测试；nearestHit 由调用方提供。 */
export function evaluateAnchorVisibility(
  cameraPosition: Vec3Like,
  cameraForward: Vec3Like,
  anchorPosition: Vec3Like,
  castNearestHit: (from: Vec3Like, to: Vec3Like, far: number) => number | null,
  sceneScale = 12,
): VisibilityResult {
  const d = distance(cameraPosition, anchorPosition);
  const tol = surfaceTolerance(d, sceneScale);
  const nearestHitDistance =
    d <= tol ? null : castNearestHit(cameraPosition, anchorPosition, Math.max(0, d - tol));
  return classifyVisibility({
    cameraPosition,
    cameraForward,
    anchorPosition,
    nearestHitDistance,
    tolerance: tol,
  });
}
