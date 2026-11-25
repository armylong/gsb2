import { Quaternion, Vector3 } from 'three';
import type { PoseFrame } from './skeleton';
import type { Skeleton } from './skeleton';
import { eulerQuat, qToArray, vToArray } from './math';
import type { Quat, Vec3 } from './math';

/** 关键帧：rootPos 为绝对世界位置（避免来回拖时间条累计位移）；角度均为相对静止局部系的增量，单位度 */
export interface Keyframe {
  time: number;
  rootPos?: Vec3;
  rootEuler?: [number, number, number];
  bends?: Record<string, [number, number, number]>;
}

export interface MotionClip {
  id: string;
  name: string;
  duration: number;
  keyframes: Keyframe[];
}

interface BakedKey {
  time: number;
  rootPos: Vector3;
  rootDelta: Quaternion;
  locals: Map<string, Quaternion>;
}

function bakeKey(kf: Keyframe): BakedKey {
  const locals = new Map<string, Quaternion>();
  for (const [name, e] of Object.entries(kf.bends ?? {})) {
    locals.set(name, eulerQuat(e[0], e[1], e[2]));
  }
  const re = kf.rootEuler ?? [0, 0, 0];
  return {
    time: kf.time,
    rootPos: kf.rootPos ? new Vector3(...kf.rootPos) : new Vector3(0, 0, 0),
    rootDelta: eulerQuat(re[0], re[1], re[2]),
    locals,
  };
}

const IDENTITY_Q = (): Quaternion => new Quaternion();

export class ClipSampler {
  readonly clip: MotionClip;
  private readonly baked: BakedKey[];

  constructor(clip: MotionClip) {
    this.clip = clip;
    this.baked = clip.keyframes.map(bakeKey).sort((a, b) => a.time - b.time);
  }

  get duration(): number {
    return this.clip.duration;
  }

  /** 采样到给定骨架的姿势帧（绝对量、无状态，反复拖时间条不会累计） */
  sample(t: number, skeleton: Skeleton): PoseFrame {
    const tt = Math.min(Math.max(t, 0), this.clip.duration);
    let a = this.baked[0];
    let b = this.baked[this.baked.length - 1];
    for (let i = 0; i < this.baked.length - 1; i++) {
      if (tt >= this.baked[i].time && tt <= this.baked[i + 1].time) {
        a = this.baked[i];
        b = this.baked[i + 1];
        break;
      }
    }
    const span = b.time - a.time;
    const u = span <= 1e-8 ? 0 : (tt - a.time) / span;

    const rootRestPos = skeleton.restLocalPos[0];
    const rootPos = new Vector3().copy(a.rootPos).lerp(b.rootPos, u).add(rootRestPos);

    const rootDelta = IDENTITY_Q().slerpQuaternions(a.rootDelta, b.rootDelta, u);
    const rootRot = skeleton.restLocalRot[0].clone().multiply(rootDelta);

    const locals: Record<string, Quat> = {};
    for (let i = 1; i < skeleton.count; i++) {
      const name = skeleton.jointNames[i];
      const qa = a.locals.get(name) ?? IDENTITY_Q();
      const qb = b.locals.get(name) ?? IDENTITY_Q();
      locals[name] = qToArray(IDENTITY_Q().slerpQuaternions(qa, qb, u));
    }
    return {
      time: tt,
      rootPos: vToArray(rootPos),
      rootRot: qToArray(rootRot),
      locals,
    };
  }
}

/**
 * 弯曲符号约定（frameAlong：局部 +Y 沿骨头、+Z 沿弯曲方向、+X = +Y × +Z）：
 * 绕局部 +X 正转把骨头从 +Y 弯向 +Z。
 * - 肘：+Z 朝身前，屈肘为正 X
 * - 膝：+Z 朝身后，屈膝为正 X；胯前摆为负 X
 * - 肩侧平举：绕局部 +Z，左臂正、右臂负
 */

/** 片段 A：抬臂 + 转身（末帧回到静止朝向，中段有明显转身；起手与收手都留过渡，角速度不突变） */
export function createArmTurnClip(): MotionClip {
  const armsUp = {
    lshoulder: [0, 0, 105],
    rshoulder: [0, 0, -105],
    lelbow: [35, 0, 0],
    relbow: [35, 0, 0],
  } as Record<string, [number, number, number]>;
  return {
    id: 'arm-turn',
    name: '抬臂转身',
    duration: 3.2,
    keyframes: [
      { time: 0.0, rootPos: [0, 0, 0] },
      { time: 0.9, rootPos: [0, 0, 0], bends: armsUp },
      {
        time: 1.7,
        rootPos: [0, 0, 0],
        rootEuler: [0, 150, 0],
        bends: armsUp,
      },
      // 收手与转回在各自独立区间内完成，避免同一帧同时跳两个自由度
      { time: 2.3, rootPos: [0, 0, 0], rootEuler: [0, 150, 0] },
      { time: 2.8, rootPos: [0, 0, 0] },
      { time: 3.2, rootPos: [0, 0, 0] },
    ],
  };
}

/** 片段 B：带前进的蹲起（有根位移、下蹲与步幅） */
export function createSquatWalkClip(): MotionClip {
  return {
    id: 'squat-walk',
    name: '蹲起前进',
    duration: 3.6,
    keyframes: [
      { time: 0.0, rootPos: [0, 0, 0] },
      {
        time: 0.6,
        rootPos: [0, -0.16, 0],
        bends: {
          lhip: [-38, 0, 0],
          rhip: [-38, 0, 0],
          lknee: [75, 0, 0],
          rknee: [75, 0, 0],
          lankle: [30, 0, 0],
          rankle: [30, 0, 0],
          spine: [12, 0, 0],
        },
      },
      {
        time: 1.3,
        rootPos: [0, 0, 0.35],
        bends: {
          lhip: [-28, 0, 0],
          lknee: [18, 0, 0],
          rhip: [28, 0, 0],
          rknee: [40, 0, 0],
          lankle: [8, 0, 0],
          rankle: [22, 0, 0],
        },
      },
      {
        time: 2.0,
        rootPos: [0, 0, 0.72],
        bends: {
          lhip: [28, 0, 0],
          lknee: [40, 0, 0],
          rhip: [-28, 0, 0],
          rknee: [18, 0, 0],
          lankle: [22, 0, 0],
          rankle: [8, 0, 0],
        },
      },
      {
        time: 2.7,
        rootPos: [0, -0.1, 1.08],
        bends: {
          lhip: [-30, 0, 0],
          rhip: [-30, 0, 0],
          lknee: [60, 0, 0],
          rknee: [60, 0, 0],
          lankle: [24, 0, 0],
          rankle: [24, 0, 0],
        },
      },
      { time: 3.6, rootPos: [0, 0, 1.4] },
    ],
  };
}

export function createClips(): MotionClip[] {
  return [createArmTurnClip(), createSquatWalkClip()];
}
