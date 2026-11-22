/**
 * 正交视图描述与投影基。
 * 视图用 (eye, target, up, halfHeight, aspect) 完全确定，可序列化进 SVG 并重开复原。
 */

import type { Vec3 } from './math3d.ts';
import { v3, sub, add, scale, normalize, dot, cross } from './math3d.ts';
import type { WorldMesh } from './geometry.ts';
import { worldBounds } from './geometry.ts';

export interface ViewDescriptor {
  name: string;
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  /** 正交半高（世界单位）。半宽 = halfHeight * aspect。 */
  halfHeight: number;
  /** 宽高比 = 画布宽 / 画布高。 */
  aspect: number;
}

export interface ViewBasis {
  view: ViewDescriptor;
  f: Vec3; // 视线方向（eye -> target）
  right: Vec3;
  upT: Vec3;
  dist: number;
  halfWidth: number;
}

export function makeBasis(view: ViewDescriptor): ViewBasis {
  const f = normalize(sub(view.target, view.eye));
  const right = normalize(cross(f, view.up));
  const upT = cross(right, f); // 与 f、right 构成右手正交基
  const dist = lengthOr(sub(view.target, view.eye), 1);
  return {
    view, f, right, upT, dist,
    halfWidth: view.halfHeight * view.aspect
  };
}

function lengthOr(a: Vec3, fallback: number): number {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-12 ? l : fallback;
}

export interface ScreenPoint {
  /** 归一化设备坐标 [-1, 1]。 */
  x: number;
  y: number;
  /** 沿视线的深度，越大越远。 */
  depth: number;
  inside: boolean;
}

export function project(basis: ViewBasis, p: Vec3): ScreenPoint {
  const rel = sub(p, basis.view.eye);
  const sx = dot(rel, basis.right);
  const sy = dot(rel, basis.upT);
  const depth = dot(rel, basis.f);
  const x = sx / basis.halfWidth;
  const y = sy / basis.view.halfHeight;
  return { x, y, depth, inside: x >= -1 && x <= 1 && y >= -1 && y <= 1 };
}

/**
 * 内置三个正交视图：正视（沿 -Z）、俯视（沿 +Y 向下看）、斜视（等轴方向）。
 * 取景框由世界 AABB 统一确定，斜视也使用正交相机（无透视收敛）。
 */
export function standardViews(mesh: WorldMesh, aspect: number): ViewDescriptor[] {
  const b = worldBounds(mesh);
  const center = b.center;
  const dist = Math.max(b.size * 3, 10);
  const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);

  const front: ViewDescriptor = {
    name: 'front',
    eye: add(center, v3(0, 0, -dist)),
    target: { ...center },
    up: v3(0, 1, 0),
    halfHeight: span * 0.62,
    aspect
  };

  const top: ViewDescriptor = {
    name: 'top',
    eye: add(center, v3(0, dist, 0)),
    target: { ...center },
    up: v3(0, 0, 1),
    halfHeight: span * 0.62,
    aspect
  };

  // 斜视：相机放在 (-X, +Y, -Z) 方向，看向中心；视线方向 = -isoDir。
  const isoDir = normalize(v3(-1, 1, -1));
  const isoDraft: ViewDescriptor = {
    name: 'iso',
    eye: add(center, scale(isoDir, dist)),
    target: { ...center },
    up: v3(0, 1, 0),
    halfHeight: span,
    aspect
  };
  // 斜视投影会平移并放大包围盒：量出实际屏幕投影包围盒，
  // 把取景中心移到投影包围盒中心、尺寸按投影完整跨度取，保证所有边都在框内。
  const basis0 = makeBasis(isoDraft);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of mesh.vertices) {
    const sp = project(basis0, p);
    minX = Math.min(minX, sp.x); maxX = Math.max(maxX, sp.x);
    minY = Math.min(minY, sp.y); maxY = Math.max(maxY, sp.y);
  }
  const pcx = (minX + maxX) * 0.5;
  const pcy = (minY + maxY) * 0.5;
  // NDC 偏移换算回世界单位下的屏幕位移，沿 right/upT 移动 target
  const shiftX = pcx * basis0.halfWidth;
  const shiftY = pcy * isoDraft.halfHeight;
  const shiftedTarget = add(
    isoDraft.target,
    add(scale(basis0.right, shiftX), scale(basis0.upT, shiftY))
  );
  // 投影完整跨度（NDC）换算为世界半高/半宽需求，取两者更严格者并留 15% 边距
  const needHalfH = ((maxY - minY) * 0.5) * isoDraft.halfHeight;
  const needHalfW = ((maxX - minX) * 0.5) * basis0.halfWidth;
  const iso: ViewDescriptor = {
    ...isoDraft,
    target: shiftedTarget,
    eye: add(shiftedTarget, sub(isoDraft.eye, isoDraft.target)),
    halfHeight: Math.max(needHalfH, needHalfW / aspect) * 1.15
  };

  return [front, top, iso];
}

/** 由 three.js 相机当前姿态生成等价的正交视图描述（用于"同步 3D 视角"）。 */
export function viewFromCamera(
  name: string,
  position: Vec3,
  target: Vec3,
  up: Vec3,
  halfHeight: number,
  aspect: number
): ViewDescriptor {
  return { name, eye: { ...position }, target: { ...target }, up: { ...up }, halfHeight, aspect };
}
