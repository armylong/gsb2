import { pointInAABB, sphereSweepAABB, sphereToAABBClearance, type AABB } from './aabb';
import type { Vec3 } from './vector';
import { v3 } from './vector';

/**
 * 第三人称相机碰撞求解器（纯数学，不依赖 three.js）。
 *
 * 碰撞策略（不只查中心射线）：
 * 1. 球体扫掠：把每个 AABB 按相机碰撞半径膨胀，沿 pivot→相机方向求首次接触距离；
 * 2. 近裁剪面检查：在候选位置构造近裁剪矩形，取 4 角 + 4 边中点 + 中心共 9 个点，
 *    任一点进入盒体（带 skin 余量）即判非法；该约束沿视线平移不变，
 *    专门拦“中心射线不碰、画面边缘穿入平行侧墙/顶板”的情况；
 * 3. 二分回退：在 [0, 球体上限] 内找最大合法距离；
 * 4. 距离平滑：缩近用快时间常数并做硬钳制（插值绝不穿墙），恢复用慢时间常数，
 *    配合死区抑制遮挡边界处的抽动；
 * 5. 最优合法距离仍小于公布的最小距离 → 报告受限：使用几何最优位姿（保证不穿），
 *    若光线上完全无合法位姿则保持上一帧安全位姿。
 */

export interface CameraCollisionConfig {
  /** 相机球体碰撞半径（可调） */
  collisionRadius: number;
  /** 公布的最小跟随距离 */
  minDistance: number;
  maxDistance: number;
  /** 近裁剪面 */
  near: number;
  /** 垂直视场角（弧度） */
  fovY: number;
  aspect: number;
  /** 近裁剪面点相对盒体的安全外皮 */
  frustumSkin: number;
  /** 缩近时间常数（秒，越小越快） */
  retractTau: number;
  /** 恢复时间常数（秒） */
  restoreTau: number;
  /** 距离死区（米），小于该差值不调整，抑制边界抖动 */
  deadZone: number;
}

export const DEFAULT_CAMERA_CONFIG: CameraCollisionConfig = {
  collisionRadius: 0.32,
  minDistance: 0.8,
  maxDistance: 9.0,
  near: 0.1,
  fovY: Math.PI / 3,
  aspect: 1.0,
  frustumSkin: 0.02,
  retractTau: 0.06,
  restoreTau: 0.35,
  deadZone: 0.03,
};

export interface CameraFrameResult {
  desiredPos: Vec3;
  actualPos: Vec3;
  /** 相机→pivot 的单位视线 */
  viewDir: Vec3;
  desiredDistance: number;
  /** 本帧碰撞求解出的最大合法距离（-1 表示光线上无合法位姿） */
  safeDistance: number;
  /** 平滑后的实际跟随距离 */
  actualDistance: number;
  /** 是否处于小于公布最小距离 / 无合法位姿的受限状态 */
  constrained: boolean;
  /** 本帧参与限制的盒子名 */
  limitingBoxes: string[];
  /** 实测相机球面到最近障碍的净距（米），触碰时约为 0 */
  minClearance: number;
  /** 近裁剪面九点检查是否判定过非法 */
  frustumClamped: boolean;
}

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };
const PITCH_LIMIT = 1.45; // 约 83°，避免万向锁
const BINARY_ITERATIONS = 18;

export class CameraCollisionSolver {
  cfg: CameraCollisionConfig;
  /** 平滑后的实际距离 */
  private smoothed: number;
  /** 上一帧合法位置（受限姿态保持用） */
  private lastGoodPos: Vec3 | null = null;
  /** 受限状态保持计时，避免状态闪烁 */
  private constrainedHold = 0;

  constructor(cfg: CameraCollisionConfig) {
    this.cfg = cfg;
    this.smoothed = (cfg.minDistance + cfg.maxDistance) * 0.5;
  }

  reset(desiredDistance: number): void {
    this.smoothed = desiredDistance;
    this.lastGoodPos = null;
    this.constrainedHold = 0;
  }

  /**
   * 每帧求解。
   * @param pivot 角色观察点
   * @param yaw 水平角（弧度），0 = 相机在 pivot 正后方（-Z）
   * @param pitch 俯仰角（弧度，正 = 俯视）
   * @param desiredDistance 滚轮设定的期望距离
   * @param dt 帧间隔（秒）
   */
  update(
    pivot: Vec3,
    yaw: number,
    pitch: number,
    desiredDistance: number,
    dt: number,
    boxes: AABB[],
  ): CameraFrameResult {
    const cfg = this.cfg;
    const clampedPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));

    // 视线方向（相机 → pivot）
    const cp = Math.cos(clampedPitch);
    const viewDir = v3.create(
      Math.sin(yaw) * cp,
      Math.sin(clampedPitch),
      Math.cos(yaw) * cp,
    );
    // pivot → 相机
    const camRay = v3.scale(v3.create(), viewDir, -1);

    const desiredPos = v3.create(
      pivot.x + camRay.x * desiredDistance,
      pivot.y + camRay.y * desiredDistance,
      pivot.z + camRay.z * desiredDistance,
    );

    // ---------- 1. 球体扫掠 ----------
    let sphereLimit = Infinity;
    const limiting = new Set<string>();
    for (const box of boxes) {
      const t = sphereSweepAABB(pivot, camRay, cfg.collisionRadius, box);
      if (t < sphereLimit) {
        sphereLimit = t;
        if (box.name) limiting.add(box.name);
      }
    }
    const upperBound = Math.min(desiredDistance, Math.max(0, sphereLimit));

    // ---------- 2. 候选位姿合法性：球体 + 近裁剪面九点 ----------
    const camAt = (d: number, out: Vec3): Vec3 =>
      v3.set(
        out,
        pivot.x + camRay.x * d,
        pivot.y + camRay.y * d,
        pivot.z + camRay.z * d,
      );

    const tmpCam = v3.create();
    const feasible = (d: number): boolean => {
      camAt(d, tmpCam);
      for (const box of boxes) {
        if (sphereToAABBClearance(tmpCam, cfg.collisionRadius, box) < -cfg.frustumSkin) {
          return false;
        }
      }
      const right = v3.normalize(v3.create(), v3.cross(v3.create(), viewDir, WORLD_UP));
      const up = v3.cross(v3.create(), right, viewDir);
      const halfH = Math.tan(cfg.fovY * 0.5) * cfg.near;
      const halfW = halfH * cfg.aspect;
      for (const sx of [-1, 0, 1]) {
        for (const sy of [-1, 0, 1]) {
          const px = tmpCam.x + viewDir.x * cfg.near + right.x * sx * halfW + up.x * sy * halfH;
          const py = tmpCam.y + viewDir.y * cfg.near + right.y * sx * halfW + up.y * sy * halfH;
          const pz = tmpCam.z + viewDir.z * cfg.near + right.z * sx * halfW + up.z * sy * halfH;
          for (const box of boxes) {
            if (pointInAABB({ x: px, y: py, z: pz }, box, -cfg.frustumSkin)) return false;
          }
        }
      }
      return true;
    };

    // ---------- 3. 最大合法距离 ----------
    let frustumClamped = false;
    let bestD = -1;
    if (feasible(0)) {
      if (feasible(upperBound)) {
        bestD = upperBound;
      } else {
        frustumClamped = true;
        let lo = 0;
        let hi = upperBound;
        for (let i = 0; i < BINARY_ITERATIONS; i++) {
          const mid = (lo + hi) * 0.5;
          if (feasible(mid)) lo = mid;
          else hi = mid;
        }
        bestD = lo;
      }
    }

    // ---------- 4. 受限判定（带保持计时，防止状态闪烁） ----------
    let constrained = false;
    if (bestD < 0 || bestD < cfg.minDistance) {
      this.constrainedHold = 0.25;
      constrained = true;
    } else if (this.constrainedHold > 0) {
      this.constrainedHold -= dt;
      constrained = this.constrainedHold > 0;
    }

    // ---------- 5. 非对称平滑 + 硬钳制 ----------
    const floor = constrained && bestD >= 0 ? Math.max(0, bestD) : cfg.minDistance;
    const target = bestD >= 0 ? Math.min(desiredDistance, bestD) : cfg.minDistance;
    if (Math.abs(target - this.smoothed) > cfg.deadZone) {
      const tau = target < this.smoothed ? cfg.retractTau : cfg.restoreTau;
      const alpha = 1 - Math.exp(-dt / tau);
      this.smoothed += (target - this.smoothed) * alpha;
    }
    if (bestD >= 0) {
      // 硬钳制：平滑结果绝不超过当前合法距离（插值不穿墙）
      this.smoothed = Math.max(floor, Math.min(this.smoothed, bestD));
    }
    this.smoothed = Math.min(this.smoothed, desiredDistance);

    // ---------- 6. 实际位姿输出 ----------
    let actualPos: Vec3;
    if (bestD < 0 && this.lastGoodPos) {
      // 光线上完全无合法位姿：冻结上一帧安全位置
      actualPos = v3.copy(v3.create(), this.lastGoodPos);
    } else if (bestD < 0) {
      // 首帧即无解：放在球体扫掠接触距离（几何上最不深入的位置，球面不穿墙），
      // 扫掠也无解（pivot 已陷入盒体）时退回最小距离并交由受限提示处理。
      const fallbackD = Number.isFinite(sphereLimit) ? Math.max(0, sphereLimit) : cfg.minDistance;
      actualPos = camAt(fallbackD, v3.create());
    } else {
      actualPos = camAt(this.smoothed, v3.create());
      this.lastGoodPos = v3.copy(v3.create(), actualPos);
    }

    // 视线始终由实际相机指向 pivot
    const actualView = v3.normalize(
      v3.create(),
      v3.sub(v3.create(), pivot, actualPos),
    );

    // 实测最小净距
    let minClearance = Infinity;
    for (const box of boxes) {
      minClearance = Math.min(
        minClearance,
        sphereToAABBClearance(actualPos, cfg.collisionRadius, box),
      );
    }

    return {
      desiredPos,
      actualPos,
      viewDir: actualView,
      desiredDistance,
      safeDistance: bestD,
      actualDistance: v3.distance(pivot, actualPos),
      constrained,
      limitingBoxes: [...limiting],
      minClearance: Number.isFinite(minClearance) ? minClearance : 0,
      frustumClamped,
    };
  }
}
