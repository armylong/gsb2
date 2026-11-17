import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { BoneName, LocalPose, PoseKeyframe, ProceduralClip } from './types';
import { BONE_NAMES, getBoneSpec } from './skeleton';

/** 把相位归一化到 [0,1) */
export function wrap01(u: number): number {
  return u - Math.floor(u);
}

const EULER_ORDER = 'YXZ';

/**
 * 周期关键帧姿态采样。
 * 关键帧按相位 u 排序，采用“环形包裹”插值：
 * 末帧与首帧在 u=0/1 处视为同一姿态，循环接缝天然连续。
 */
export function sampleRotationKeyframes(keyframes: PoseKeyframe[], u: number, target: LocalPose): LocalPose {
  const phase = wrap01(u);
  const n = keyframes.length;
  // 找到 phase 所在的环形区间 [i, i+1]
  let i = 0;
  for (let k = 0; k < n; k++) {
    if (keyframes[k].u <= phase) i = k;
  }
  const next = (i + 1) % n;
  const a = keyframes[i];
  const b = keyframes[next];
  const uA = a.u;
  const uB = next === 0 ? b.u + 1 : b.u; // 跨接缝时把首帧相位抬到 1+
  const span = uB - uA;
  const t = span <= 1e-9 ? 0 : MathUtils.clamp((phase - uA) / span, 0, 1);

  for (const name of BONE_NAMES) {
    const ta = a.pose.get(name)!;
    const tb = b.pose.get(name)!;
    const out = target.get(name)!;
    out.quaternion.slerpQuaternions(ta.quaternion, tb.quaternion, t);
    // 局部位移仅 hips 会被动作修改（起伏），其余保持静息位置
    out.position.lerpVectors(ta.position, tb.position, t);
  }
  return target;
}

/**
 * 两个局部姿态按权重 w 做逐关节混合。
 * 旋转用四元数 SLERP —— 中间权重是最短弧匀速插值，
 * 不会出现欧拉角插值的翻转/万向节问题，也不会产生缩放。
 */
export function blendPose(a: LocalPose, b: LocalPose, perBoneWeight: Map<BoneName, number>, target: LocalPose): LocalPose {
  for (const name of BONE_NAMES) {
    const w = MathUtils.clamp(perBoneWeight.get(name) ?? 0, 0, 1);
    const ta = a.get(name)!;
    const tb = b.get(name)!;
    const out = target.get(name)!;
    out.quaternion.slerpQuaternions(ta.quaternion, tb.quaternion, w);
    out.position.lerpVectors(ta.position, tb.position, w);
  }
  return target;
}

/** 深拷贝一副局部姿态 */
export function clonePose(pose: LocalPose): LocalPose {
  const out = new Map<BoneName, { quaternion: Quaternion; position: Vector3 }>();
  for (const [name, t] of pose) {
    out.set(name, { quaternion: t.quaternion.clone(), position: t.position.clone() });
  }
  return out;
}

/** 创建静息姿态（单位旋转 + 骨架静息位移） */
export function createRestPose(): LocalPose {
  const pose = new Map<BoneName, { quaternion: Quaternion; position: Vector3 }>();
  for (const name of BONE_NAMES) {
    pose.set(name, {
      quaternion: new Quaternion(),
      position: getBoneSpec(name).restPosition.clone(),
    });
  }
  return pose;
}

/** 为每副姿态预分配可复用对象，避免播放中产生 GC 压力 */
export function createPosePool(size: number): LocalPose[] {
  return Array.from({ length: size }, () => createRestPose());
}

/**
 * 谐波旋转构建器：给定各关节的欧拉角谐波参数，生成一副关键帧姿态。
 * 全部由 sin/cos 周期函数构成，保证任意相位（含接缝）姿态连续。
 */
export interface HarmonicTerm {
  /** 谐波次数 k：sin(2π·k·u + φ)，k=0 为常量偏移 */
  k: number;
  /** 振幅（弧度） */
  amp: number;
  /** 相位（弧度） */
  phase: number;
}

/** 一个旋转轴上的谐波项（单条或多条叠加） */
export type HarmonicAxis = HarmonicTerm | HarmonicTerm[];

export type BoneHarmonics = Partial<Record<BoneName, { x?: HarmonicAxis; y?: HarmonicAxis; z?: HarmonicAxis }>>;

function evalTerm(term: HarmonicAxis | undefined, u: number): number {
  if (!term) return 0;
  const terms = Array.isArray(term) ? term : [term];
  let sum = 0;
  for (const t of terms) {
    sum += t.amp * Math.sin(2 * Math.PI * t.k * u + t.phase);
  }
  return sum;
}

const _euler = new Euler(0, 0, 0, EULER_ORDER);

/**
 * 在整周期均匀采样 n 个关键帧，由谐波参数生成旋转关键帧。
 * n 取足够大（默认 24）以精确还原谐波，接缝靠环形插值闭合。
 */
export function buildHarmonicKeyframes(harmonics: BoneHarmonics, samples = 24): PoseKeyframe[] {
  const keyframes: PoseKeyframe[] = [];
  for (let i = 0; i < samples; i++) {
    const u = i / samples;
    const pose = createRestPose();
    for (const name of BONE_NAMES) {
      const h = harmonics[name];
      if (!h) continue;
      _euler.set(evalTerm(h.x, u), evalTerm(h.y, u), evalTerm(h.z, u));
      pose.get(name)!.quaternion.setFromEuler(_euler);
    }
    keyframes.push({ u, pose });
  }
  return keyframes;
}

/**
 * 根速度曲线在一个周期内的积分，用于校验 rootDistancePerCycle 的一致性。
 */
export function integrateRootVelocity(clip: ProceduralClip, steps = 256): number {
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    sum += clip.rootVelocity(i / steps);
  }
  return (sum / steps) * clip.duration;
}

/**
 * 计算某动作在相位 u 处、时间增量 dt 内的根前进增量。
 * v(u) 是瞬时速度（米/秒），乘 dt 得到位移；
 * 播放头在调用方推进，速度按推进后的相位采样即可。
 */
export function rootDeltaFor(clip: ProceduralClip, u: number, dt: number): number {
  return clip.rootVelocity(wrap01(u)) * dt;
}

/** 线性缓动（交叉淡入权重曲线），集中在一处便于测试与替换 */
export function linearFade(progress01: number): number {
  return MathUtils.clamp(progress01, 0, 1);
}

export function quaternionDistance(a: Quaternion, b: Quaternion): number {
  // 角度差（弧度），范围 [0, π]；取绝对值消去 q 与 -q 的双重覆盖
  const dot = Math.abs(a.dot(b));
  return 2 * Math.acos(MathUtils.clamp(dot, 0, 1));
}
