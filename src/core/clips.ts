import { Vector3 } from 'three';
import type { ProceduralClip } from './types';
import { buildHarmonicKeyframes, type BoneHarmonics, type HarmonicTerm } from './math';

/** 便捷构造谐波项 */
function h(k: number, amp: number, phase = 0): HarmonicTerm {
  return { k, amp, phase };
}

/* ------------------------------------------------------------------ */
/* 动作 A：正常行走                                                    */
/* - 周期 0.9s，每周期前进 1.10m（平均速度 ≈1.22 m/s）                 */
/* - 大幅前后摆腿、对侧摆臂、躯干扭转、hips 上下起伏                   */
/* ------------------------------------------------------------------ */

const WALK_HARMONICS: BoneHarmonics = {
  // 下肢：左右腿相差半周期
  thigh_l: { x: h(1, 0.52, 0) },
  thigh_r: { x: h(1, 0.52, Math.PI) },
  // 膝盖主要在支撑相弯曲（二次谐波 + 静态微屈）
  shin_l: { x: h(2, 0.45, Math.PI / 2), z: h(1, 0.05, 0) },
  shin_r: { x: h(2, 0.45, Math.PI / 2), z: h(1, 0.05, Math.PI) },
  // 脚踝俯仰补偿，脚掌尽量平稳
  foot_l: { x: h(1, 0.18, Math.PI / 2) },
  foot_r: { x: h(1, 0.18, Math.PI / 2 + Math.PI) },

  // 上肢：对侧摆动（左臂配右腿），肘部始终朝后弯
  upperarm_l: { x: h(1, 0.42, Math.PI) },
  upperarm_r: { x: h(1, 0.42, 0) },
  forearm_l: { x: h(2, 0.22, -Math.PI / 2) },
  forearm_r: { x: h(2, 0.22, -Math.PI / 2) },

  // 躯干：胸部绕 Y 左右扭转（对侧肩-髋），轻微侧倾
  chest: { y: h(1, 0.16, 0), z: h(1, 0.05, Math.PI / 2) },
  spine: { y: h(1, 0.06, Math.PI) },
  // 头部反向微调，视线稳定
  neck: { y: h(1, 0.05, Math.PI) },
  // 髋部绕 Y 小幅反向扭转
  hips: { y: h(1, 0.07, Math.PI), z: h(1, 0.035, -Math.PI / 2) },
};

/* ------------------------------------------------------------------ */
/* 动作 B：潜行（不同步态 + 夸张上肢摆动）                            */
/* - 周期 1.35s（更慢），每周期前进 0.72m（平均速度 ≈0.53 m/s）       */
/* - 重心下沉（k=0 常量屈膝，周期函数的合法形式）、身体前倾            */
/* - 高抬膝、大幅摆臂、更明显的左右重心转移                            */
/* ------------------------------------------------------------------ */

const SNEAK_HARMONICS: BoneHarmonics = {
  // 静态屈膝 0.62rad（k=0 常量）+ 高抬膝摆动
  thigh_l: { x: h(1, 0.34, Math.PI / 2), z: h(1, 0.08, 0) },
  thigh_r: { x: h(1, 0.34, Math.PI / 2 + Math.PI), z: h(1, 0.08, Math.PI) },
  shin_l: { x: [h(0, 0.62), h(2, 0.55, 0)], y: h(1, 0.05, 0) },
  shin_r: { x: [h(0, 0.62), h(2, 0.55, 0)], y: h(1, 0.05, Math.PI) },
  foot_l: { x: h(1, 0.24, 0) },
  foot_r: { x: h(1, 0.24, Math.PI) },

  // 潜行时手臂夸张摆动且略外展，肘部持续弯曲
  upperarm_l: { x: h(1, 0.62, Math.PI / 2 + Math.PI), z: h(0, 0.18) },
  upperarm_r: { x: h(1, 0.62, Math.PI / 2), z: h(0, -0.18) },
  forearm_l: { x: h(0, 0.55), y: h(1, 0.12, 0) },
  forearm_r: { x: h(0, 0.55), y: h(1, 0.12, Math.PI) },

  // 身体前倾 + 更小心的扭转
  chest: { x: h(0, 0.16), y: h(1, 0.1, Math.PI / 2), z: h(1, 0.09, 0) },
  spine: { x: h(0, 0.1), y: h(1, 0.05, Math.PI / 2) },
  neck: { x: h(0, -0.12), y: h(1, 0.06, -Math.PI / 2) },
  // 髋部下沉 + 左右重心转移
  hips: { y: h(1, 0.05, Math.PI / 2), z: h(1, 0.075, Math.PI / 2) },
};

function createWalkClip(): ProceduralClip {
  const duration = 0.9;
  const distance = 1.1;
  return {
    id: 'walk',
    label: '动作 A · 正常行走',
    duration,
    rotationKeyframes: buildHarmonicKeyframes(WALK_HARMONICS, 24),
    rootDistancePerCycle: distance,
    // 归一化速度曲线：平均值为 1，乘 distance/duration 得瞬时速度。
    // 二次谐波让双脚支撑相稍慢、摆动相稍快；周期函数，接缝处速度连续。
    rootVelocity: (u) =>
      (distance / duration) * (1 + 0.18 * Math.cos(2 * Math.PI * 2 * u + Math.PI / 3)),
    // hips 循环内起伏：竖直 bob + 左右重心轻移；周期函数，不含累积位移
    rootHipsOffset: (u) =>
      new Vector3(
        0.025 * Math.sin(2 * Math.PI * u + Math.PI / 2),
        0.028 * Math.sin(2 * Math.PI * 2 * u - Math.PI / 2),
        0,
      ),
  };
}

function createSneakClip(): ProceduralClip {
  const duration = 1.35;
  const distance = 0.72;
  return {
    id: 'sneak',
    label: '动作 B · 潜行',
    duration,
    rotationKeyframes: buildHarmonicKeyframes(SNEAK_HARMONICS, 24),
    rootDistancePerCycle: distance,
    // 潜行速度更均匀，轻微二次起伏
    rootVelocity: (u) =>
      (distance / duration) * (1 + 0.1 * Math.cos(2 * Math.PI * 2 * u)),
    // 重心整体下沉 0.16m（常量）+ 潜行式左右摇摆
    rootHipsOffset: (u) =>
      new Vector3(
        0.045 * Math.sin(2 * Math.PI * u),
        -0.16 + 0.035 * Math.sin(2 * Math.PI * 2 * u + Math.PI / 2),
        0,
      ),
  };
}

export function createClips(): { walk: ProceduralClip; sneak: ProceduralClip } {
  return { walk: createWalkClip(), sneak: createSneakClip() };
}
