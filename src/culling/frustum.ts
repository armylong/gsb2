import { Box3, Frustum, Matrix4, Sphere } from 'three';

/** 视锥六个面的可读名称，顺序与 THREE.Frustum 内部一致。 */
export const PLANE_NAMES = [
  'right',
  'left',
  'bottom',
  'top',
  'near',
  'far',
] as const;

export type PlaneName = (typeof PLANE_NAMES)[number];

/** 包围体相对视锥的位置。 */
export type CullStatus = 'in' | 'intersect' | 'out';
export interface CullResult {
  status: CullStatus;
  /** status === 'out' 时，第一个拒绝该包围体的视锥面。 */
  rejectedBy: PlaneName | null;
}

const _projScreen = new Matrix4();
const _frustum = new Frustum();

/** 用观察相机刷新一个视锥（相机投影矩阵 × 视图矩阵）。 */
export function updateFrustum(camera: {
  projectionMatrix: Matrix4;
  matrixWorldInverse: Matrix4;
}): Frustum {
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
  return _frustum;
}

/**
 * 球与视锥的关系。
 * - 任一面到球心距离 < -radius => 完全在面外 => out
 * - 否则若任一面 |distance| < radius => 与面相交 => intersect
 * - 否则球整体在所有面内侧 => in
 */
export function classifySphere(frustum: Frustum, sphere: Sphere): CullResult {
  let intersects = false;
  for (let i = 0; i < frustum.planes.length; i++) {
    const plane = frustum.planes[i];
    const distance = plane.distanceToPoint(sphere.center);
    if (distance < -sphere.radius) {
      return { status: 'out', rejectedBy: PLANE_NAMES[i] };
    }
    if (distance < sphere.radius) {
      intersects = true;
    }
  }
  return { status: intersects ? 'intersect' : 'in', rejectedBy: null };
}

/** 轴对齐包围盒与视锥的关系（p-顶点法，返回首个拒绝面）。 */
export function classifyBox(frustum: Frustum, box: Box3): CullResult {
  if (box.isEmpty()) {
    return { status: 'out', rejectedBy: null };
  }
  let intersects = false;
  for (let i = 0; i < frustum.planes.length; i++) {
    const plane = frustum.planes[i];
    const nx = plane.normal.x;
    const ny = plane.normal.y;
    const nz = plane.normal.z;
    // p-顶点：沿法线反方向取盒角，是离面负侧最远的点。
    const px = nx >= 0 ? box.min.x : box.max.x;
    const py = ny >= 0 ? box.min.y : box.max.y;
    const pz = nz >= 0 ? box.min.z : box.max.z;
    const minSide = nx * px + ny * py + nz * pz + plane.constant;
    if (minSide > 0) {
      // 连最靠负侧的顶点都在面正侧，整个盒子在面外。
      return { status: 'out', rejectedBy: PLANE_NAMES[i] };
    }
    const qx = nx >= 0 ? box.max.x : box.min.x;
    const qy = ny >= 0 ? box.max.y : box.min.y;
    const qz = nz >= 0 ? box.max.z : box.min.z;
    const maxSide = nx * qx + ny * qy + nz * qz + plane.constant;
    if (maxSide > 0) {
      intersects = true;
    }
  }
  return { status: intersects ? 'intersect' : 'in', rejectedBy: null };
}
