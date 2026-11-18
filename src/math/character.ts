import type { AABB } from './aabb';
import { pointInAABB } from './aabb';
import type { Vec3 } from './vector';
import { v3 } from './vector';

/**
 * 角色：地面移动的垂直胶囊（用圆柱近似即可，需求只要求盒形障碍与合法间距）。
 * 碰撞用“水平圆盘 vs 矩形”逐轴推出，保持与墙体的合法间距，无跳跃、无动画。
 */
export interface CharacterConfig {
  radius: number;
  height: number;
  /** 观察点相对角色脚底的高度 */
  pivotHeight: number;
  moveSpeed: number;
}

export const DEFAULT_CHARACTER: CharacterConfig = {
  radius: 0.45,
  height: 1.7,
  pivotHeight: 1.55,
  moveSpeed: 5.0,
};

/**
 * 尝试把角色从 current 平移 delta（仅使用 x/z，y 固定）。
 * 对每个 AABB 做逐轴扫掠推出：先尝试 X 轴移动，再尝试 Z 轴移动，
 * 这样贴墙滑动自然，且不会卡进墙角。
 * 返回是否发生了实际位移。
 */
export function moveCharacter(
  current: Vec3,
  delta: Vec3,
  radius: number,
  boxes: AABB[],
): boolean {
  const startX = current.x;
  const startZ = current.z;

  // ---- X 轴：在当前 Z 上移动，重叠时按“本轴移动前位置”决定推出侧 ----
  current.x += delta.x;
  for (const box of boxes) {
    if (verticalOverlap(current.y, box) && discOverlapsBoxXZ(current, radius, box)) {
      // 用移动前坐标判断来向，避免大跨步越过盒中心后被推到错误一侧
      current.x = startX >= (box.min.x + box.max.x) * 0.5
        ? box.max.x + radius
        : box.min.x - radius;
    }
  }

  // ---- Z 轴：在新 X 上移动，同理按本轴起点决定推出侧 ----
  const zBefore = startZ;
  current.z += delta.z;
  for (const box of boxes) {
    if (verticalOverlap(current.y, box) && discOverlapsBoxXZ(current, radius, box)) {
      current.z = zBefore >= (box.min.z + box.max.z) * 0.5
        ? box.max.z + radius
        : box.min.z - radius;
    }
  }

  return Math.abs(current.x - startX) > 1e-9 || Math.abs(current.z - startZ) > 1e-9;
}

/** 角色垂直区间 [y, y+height] 与盒子是否有重叠（留一点余量避免地面盒子误判）。 */
function verticalOverlap(footY: number, box: AABB): boolean {
  // 角色高度由调用方保证，这里用脚底 + 2m 的固定胶囊区间判定
  const headY = footY + 2.0;
  return headY > box.min.y + 1e-6 && footY < box.max.y - 1e-6;
}

/** 水平圆盘（圆心 x/z，半径 r）是否与盒子的 XZ 矩形相交。 */
function discOverlapsBoxXZ(center: Vec3, r: number, box: AABB): boolean {
  const nearestX = Math.max(box.min.x, Math.min(center.x, box.max.x));
  const nearestZ = Math.max(box.min.z, Math.min(center.z, box.max.z));
  const dx = center.x - nearestX;
  const dz = center.z - nearestZ;
  return dx * dx + dz * dz < r * r;
}

/** 角色当前是否与任何盒子重叠（用于校验/调试断言）。 */
export function characterPenetrating(pos: Vec3, radius: number, boxes: AABB[]): boolean {
  return boxes.some(
    (b) => verticalOverlap(pos.y, b) && discOverlapsBoxXZ(pos, radius, b),
  );
}

/** 角色观察点（相机围绕的 pivot）世界坐标。 */
export function pivotPosition(foot: Vec3, pivotHeight: number, out: Vec3): Vec3 {
  return v3.set(out, foot.x, foot.y + pivotHeight, foot.z);
}

/** 供调试：点是否在任意 AABB 内。 */
export function insideAnyBox(p: Vec3, boxes: AABB[]): boolean {
  return boxes.some((b) => pointInAABB(p, b));
}
