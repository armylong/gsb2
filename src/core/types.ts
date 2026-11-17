import type { Quaternion, Vector3 } from 'three';

/** 关节逻辑名（层级骨架的节点标识） */
export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulder_l'
  | 'upperarm_l'
  | 'forearm_l'
  | 'hand_l'
  | 'shoulder_r'
  | 'upperarm_r'
  | 'forearm_r'
  | 'hand_r'
  | 'thigh_l'
  | 'shin_l'
  | 'foot_l'
  | 'thigh_r'
  | 'shin_r'
  | 'foot_r';

/** 一个关节在某时刻的局部姿态：相对父节点的旋转 + 相对父节点的位移 */
export interface LocalTransform {
  quaternion: Quaternion;
  position: Vector3;
}

/** 某一时刻整副骨架的局部姿态，按关节名索引 */
export type LocalPose = Map<BoneName, LocalTransform>;

/** 关键帧：周期相位 u ∈ [0,1) 上的一个局部姿态采样 */
export interface PoseKeyframe {
  u: number;
  pose: LocalPose;
}

/** 程序化动作片段 */
export interface ProceduralClip {
  id: 'walk' | 'sneak';
  label: string;
  /** 单次循环时长（秒），两段动作可以不同 */
  duration: number;
  /** 旋转关键帧（周期包裹插值，保证接缝连续） */
  rotationKeyframes: PoseKeyframe[];
  /**
   * 根位移：每周期前进距离（米，沿角色本地 +Z）。
   * 根位移以速度曲线积分得到，速度在接缝处连续。
   */
  rootDistancePerCycle: number;
  /** 根前进速度曲线 v(u)，必须为周期函数（v(0)=v(1)）且恒正 */
  rootVelocity: (u: number) => number;
  /** 根（hips）在循环内的上下/前后起伏，周期函数，单位米 */
  rootHipsOffset: (u: number) => Vector3;
}

/** 逐关节遮罩权重，0 = 保持基础动作，1 = 完整采用目标动作 */
export type JointMask = Map<BoneName, number>;

/** 一次混合计算的输出 */
export interface BlendSample {
  /** 混合后的局部姿态 */
  pose: LocalPose;
  /** 本帧根前进增量（米，沿 +Z），已按混合权重插值 */
  rootDelta: number;
  /** 当前全局淡入权重 α ∈ [0,1]（未经关节遮罩缩放） */
  globalWeight: number;
}
