import * as THREE from 'three';

/**
 * 双目立体相机几何核心
 * ---------------------------------------------------------------
 * 坐标约定（相机 rig 局部坐标系，米 m）：
 *   +X 向右，+Y 向上，Three.js 相机看向 −Z，即“前方”为 −Z；
 *   深度 depth = −localZ（正值），rig 原点在两眼中点。
 * 模型：平行光轴（parallel-axis）+ 离轴投影（off-axis / asymmetric frustum）。
 *   - 左眼位于 (-b/2, 0, 0)，右眼位于 (+b/2, 0, 0)，两眼光轴均沿 −Z，永不旋转；
 *   - 通过平移投影锥（shear）实现会聚：会聚距离 zc 处的点在左右画面中
 *     水平归一化坐标完全相同（零视差），这是物理正确的 Toe-in 替代方案。
 *
 * 视差符号约定（与屏幕像素一致）：
 *   归一化视差 d = (xL_px - xR_px) / W，W = 单眼视口像素宽度，取值范围约 [-1, 1]。
 *   d > 0：比会聚面近（交叉视差，crossed）；
 *   d < 0：比会聚面远（非交叉视差，uncrossed）；
 *   d = 0：恰在会聚面上。
 *   百分比视差 = d × 100%。
 */

export type EyeId = 'left' | 'right';
export type ViewMode = 'sbs' | 'left' | 'right';

export interface StereoParams {
  /** 基线（两眼间距），m，>= 0 */
  baseline: number;
  /** 会聚距离（零视差面深度），m，> 0 */
  convergence: number;
  /** 水平视场角 HFOV，度 */
  fov: number;
  /** 近裁剪距离，m，> 0 */
  near: number;
  /** 远裁剪距离，m，> near */
  far: number;
}

export type Visibility =
  | 'both'        // 两眼均可见，可计算视差
  | 'left-only'   // 仅左眼可见
  | 'right-only'  // 仅右眼可见
  | 'clipped'     // 两眼均被裁剪（近/远平面外，或在相机后方）
  | 'behind';     // 位于相机后方

export interface EyeRead {
  eye: EyeId;
  /** 相机空间坐标（米） */
  cam: THREE.Vector3;
  /** NDC 坐标 [-1,1]（仅在可见时有效） */
  ndc: THREE.Vector3 | null;
  /** 归一化屏幕坐标 [0,1]，左→右、上→下 */
  u: number | null;
  v: number | null;
  visible: boolean;
  /** 不可见原因（visible=false 时） */
  reason: 'behind' | 'near' | 'far' | 'xfrustum' | 'yfrustum' | null;
}

export interface PairRead {
  /** 相对 rig 中点的光轴深度 z（米）；平行相机下两眼深度相同 */
  depth: number;
  visibility: Visibility;
  left: EyeRead;
  right: EyeRead;
  /** 归一化视差 d = (uL - uR)，仅 both 可见时有值 */
  disparity: number | null;
  /** 垂直方向归一化差异（平行相机理论上为 0），用于自检 */
  verticalDisparity: number | null;
  /** 像素视差 = d × 单眼视口宽度 W（CSS 像素） */
  pixelDisparity: number | null;
  /** 由闭式几何公式给出的预期归一化视差 */
  expectedDisparity: number | null;
  /** 实际投影读数与公式预期之差（绝对值） */
  formulaError: number | null;
  /** 是否超出安全范围 */
  unsafe: boolean;
}

/** 数值容差与对外承诺的误差范围（见 README） */
export const EPS = {
  /** 深度与裁剪面比较的几何容差，m */
  clip: 1e-5,
  /** NDC/归一化视差的公式对照容差（无量纲） */
  ndc: 1e-7,
  /** 页面读数展示时的像素视差容差，px（受设备像素与取整影响） */
  pixel: 0.5,
};

export function validateParams(p: StereoParams): string | null {
  if (!Number.isFinite(p.baseline) || p.baseline < 0) return '基线必须 ≥ 0';
  if (p.baseline > 2) return '基线过大（>2m），请输入真实尺度的基线';
  if (!Number.isFinite(p.convergence) || p.convergence <= 0) return '会聚距离必须 > 0';
  if (!Number.isFinite(p.fov) || p.fov < 5 || p.fov > 160) return '水平视角需在 5°~160° 之间';
  if (!Number.isFinite(p.near) || p.near <= 0) return '近裁剪距离必须 > 0';
  if (!Number.isFinite(p.far) || p.far <= p.near) return '远裁剪距离必须大于近裁剪距离';
  if (p.convergence <= p.near) return `会聚距离(${p.convergence}m) 必须大于近裁剪面(${p.near}m)`;
  if (p.convergence >= p.far) return `会聚距离(${p.convergence}m) 必须小于远裁剪面(${p.far}m)`;
  return null;
}

export function hfovToVfov(hfovDeg: number, aspect: number): number {
  const h = THREE.MathUtils.degToRad(hfovDeg);
  return (2 * Math.atan(Math.tan(h / 2) / Math.max(aspect, 1e-6))) * 180 / Math.PI;
}

/** 一只眼的非对称视锥参数（局部坐标，near/far 为正数） */
interface EyeFrustum {
  left: number; right: number; top: number; bottom: number;
  shift: number;
}

function eyeFrustum(p: StereoParams, aspect: number, eye: EyeId): EyeFrustum {
  const vfov = THREE.MathUtils.degToRad(hfovToVfov(p.fov, aspect));
  const halfH = -p.near * Math.tan(vfov / 2);              // < 0
  const halfW = halfH * aspect;                             // < 0，对应 HFOV
  const eyeShift = p.baseline / 2;
  // 离轴会聚（相机看向 -Z，投影面位于 z=-near）：
  //   左眼位于 -X，投影锥在投影面上向 +X（中线）平移，shift 为正；
  //   右眼位于 +X，投影锥向 -X 平移，shift 为负。
  // 平移量 = 半基线 × (near/zc)，保证深度 zc 处的点左右 NDC 完全相同。
  const shift = (eye === 'left' ? eyeShift : -eyeShift) * (p.near / p.convergence);
  return { left: halfW + shift, right: -halfW + shift, top: -halfH, bottom: halfH, shift };
}

/**
 * 双目 rig：root 是可被 OrbitControls 操控的姿态节点，
 * 两只 PerspectiveCamera 作为 root 的子节点沿 X 轴分开。
 */
export class StereoRig {
  readonly root = new THREE.Group();
  readonly left = new THREE.PerspectiveCamera();
  readonly right = new THREE.PerspectiveCamera();
  params: StereoParams;
  private aspect = 1;

  constructor(params: StereoParams) {
    this.params = { ...params };
    this.root.add(this.left, this.right);
    this.left.name = 'eye-left';
    this.right.name = 'eye-right';
  }

  getEye(eye: EyeId): THREE.PerspectiveCamera {
    return eye === 'left' ? this.left : this.right;
  }

  /** 当前宽高比（单眼视口 width/height） */
  setAspect(aspect: number) { this.aspect = aspect; }
  getAspect() { return this.aspect; }

  /** 按当前参数刷新两眼位姿与离轴投影矩阵 */
  update(): void {
    // OrbitControls 只修改 root 的本地矩阵；先确保 root 及其所有子节点
    // （含标记、辅助线、两眼相机）的世界矩阵与 matrixWorldInverse 同步，
    // 否则 worldToLocal 会用过时矩阵，把前景点误判到相机后方。
    this.root.updateMatrixWorld(true);

    const { baseline } = this.params;
    const s = baseline / 2;
    this.left.position.set(-s, 0, 0);
    this.right.position.set(s, 0, 0);

    for (const eye of ['left', 'right'] as EyeId[]) {
      const cam = this.getEye(eye);
      const f = eyeFrustum(this.params, this.aspect, eye);
      cam.near = this.params.near;
      cam.far = this.params.far;
      // 直接写入非对称透视矩阵；cameraProjectionMatrix 由 renderer 渲染时自动取此值
      cam.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, cam.near, cam.far);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      cam.matrixWorldAutoUpdate = true;
      cam.updateMatrixWorld(true);
    }
  }

  /** 两眼在世界坐标系中的位置 */
  eyeWorldPositions(): { left: THREE.Vector3; right: THREE.Vector3 } {
    return {
      left: this.left.getWorldPosition(new THREE.Vector3(0, 0, 0)),
      right: this.right.getWorldPosition(new THREE.Vector3(0, 0, 0)),
    };
  }

  /** rig 光轴前方单位方向（世界坐标，Three 相机看向 −Z） */
  forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion).normalize();
  }
}

/** 单只眼的投影读数 */
export function projectWithEye(
  rig: StereoRig,
  eye: EyeId,
  worldPoint: THREE.Vector3,
): EyeRead {
  const cam = rig.getEye(eye);
  const camPos = worldPoint.clone().applyMatrix4(cam.matrixWorldInverse);
  const read: EyeRead = {
    eye,
    cam: camPos,
    ndc: null,
    u: null,
    v: null,
    visible: false,
    reason: null,
  };

  // 相机空间中可见点需满足 near ≤ -z ≤ far（Three 相机看向 -Z）
  const zView = -camPos.z;
  if (zView <= EPS.clip) {
    read.reason = 'behind';
    return read;
  }
  if (zView < rig.params.near - EPS.clip) {
    read.reason = 'near';
    return read;
  }
  if (zView > rig.params.far + EPS.clip) {
    read.reason = 'far';
    return read;
  }

  const ndc = camPos.clone().applyMatrix4(cam.projectionMatrix);
  read.ndc = ndc;
  if (ndc.x < -1 - EPS.clip || ndc.x > 1 + EPS.clip) {
    read.reason = 'xfrustum';
    return read;
  }
  if (ndc.y < -1 - EPS.clip || ndc.y > 1 + EPS.clip) {
    read.reason = 'yfrustum';
    return read;
  }

  ndc.x = THREE.MathUtils.clamp(ndc.x, -1, 1);
  ndc.y = THREE.MathUtils.clamp(ndc.y, -1, 1);
  read.u = (ndc.x + 1) / 2;
  read.v = (1 - ndc.y) / 2;
  read.visible = true;
  return read;
}

/**
 * 闭式公式：预期归一化视差（离轴平行相机，HFOV 为水平视场角）
 *   d = b / (2·tan(HFOV/2)) · (1/z − 1/zc)
 * 推导：归一化画面坐标 u = (ndc_x+1)/2，单眼画面半宽对应 tan(HFOV/2)，
 * 左右眼横坐标之差 Δu = (b/2)/z/tan(HFOV/2)，再代入会聚面零视差条件即得上式。
 * z 为相对 rig 中点的光轴深度；b=0 或点在相机后方时无意义。
 */
export function expectedDisparity(p: StereoParams, depth: number): number | null {
  if (depth <= EPS.clip) return null;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
  return (p.baseline / (2 * tanHalf)) * (1 / depth - 1 / p.convergence);
}

/** 对一个世界点计算完整的双目读数。eyeWidthPx = 单眼视口 CSS 像素宽度 */
export function readPoint(
  rig: StereoRig,
  worldPoint: THREE.Vector3,
  eyeWidthPx: number,
  safePct: number,
): PairRead {
  const left = projectWithEye(rig, 'left', worldPoint);
  const right = projectWithEye(rig, 'right', worldPoint);
  const local = rig.root.worldToLocal(worldPoint.clone());
  // 相机看向 −Z：深度取 −localZ，前方为正
  const depth = -local.z;

  let visibility: Visibility;
  if (left.reason === 'behind' && right.reason === 'behind') visibility = 'behind';
  else if (!left.visible && !right.visible) visibility = 'clipped';
  else if (left.visible && !right.visible) visibility = 'left-only';
  else if (!left.visible && right.visible) visibility = 'right-only';
  else visibility = 'both';

  const read: PairRead = {
    depth,
    visibility,
    left,
    right,
    disparity: null,
    verticalDisparity: null,
    pixelDisparity: null,
    expectedDisparity: expectedDisparity(rig.params, depth),
    formulaError: null,
    unsafe: false,
  };

  // 关键规则：不可见点绝不产出“正常视差”
  if (visibility === 'both' && left.u !== null && right.u !== null
    && left.v !== null && right.v !== null) {
    read.disparity = left.u - right.u;
    read.verticalDisparity = left.v - right.v;
    read.pixelDisparity = read.disparity * eyeWidthPx;
    if (read.expectedDisparity !== null) {
      read.formulaError = Math.abs(read.disparity - read.expectedDisparity);
    }
    read.unsafe = Math.abs(read.disparity) * 100 > safePct + 1e-12;
  }
  return read;
}

export const VISIBILITY_TEXT: Record<Visibility, string> = {
  both: '双眼可见',
  'left-only': '仅左眼可见',
  'right-only': '仅右眼可见',
  clipped: '已被裁剪',
  behind: '相机后方',
};
