import { Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from './math';
import { qFromArray, vFromArray } from './math';

export interface JointRestDef {
  name: string;
  parent: string | null;
  /** 静止姿势下的世界位置 */
  restPos: Vec3;
  /** 静止姿势下的世界朝向（局部坐标轴在世界中的方向） */
  restRot: Quat;
}

export interface SkeletonDef {
  name: string;
  /** 身高（米），用于根位移按身高换算 */
  height: number;
  joints: JointRestDef[];
}

/** 一个采样帧：根用世界量，其余关节用相对静止局部系的增量四元数 d，实际局部旋转 = 静止局部旋转 * d */
export interface PoseFrame {
  time: number;
  rootPos: Vec3;
  rootRot: Quat;
  locals: Record<string, Quat>;
}

export class Skeleton {
  readonly name: string;
  readonly height: number;
  readonly jointNames: string[];
  readonly index = new Map<string, number>();
  readonly parentIndex: Int32Array;
  readonly children: number[][];
  readonly restWorldPos: Vector3[];
  readonly restWorldRot: Quaternion[];
  readonly restLocalPos: Vector3[];
  readonly restLocalRot: Quaternion[];
  /** 运行时：局部（相对父节点） */
  localPos: Vector3[];
  localRot: Quaternion[];
  /** 运行时：世界 */
  worldPos: Vector3[];
  worldRot: Quaternion[];

  constructor(def: SkeletonDef) {
    this.name = def.name;
    this.height = def.height;
    const n = def.joints.length;
    this.jointNames = def.joints.map((j) => j.name);
    this.jointNames.forEach((nm, i) => this.index.set(nm, i));
    this.parentIndex = new Int32Array(n);
    this.children = Array.from({ length: n }, () => []);
    this.restWorldPos = [];
    this.restWorldRot = [];
    this.restLocalPos = [];
    this.restLocalRot = [];

    for (const j of def.joints) {
      const i = this.index.get(j.name)!;
      this.parentIndex[i] = j.parent === null ? -1 : this.index.get(j.parent)!;
      if (j.parent !== null) this.children[this.parentIndex[i]].push(i);
      this.restWorldPos[i] = vFromArray(j.restPos);
      this.restWorldRot[i] = qFromArray(j.restRot);
    }
    for (let i = 0; i < n; i++) {
      const p = this.parentIndex[i];
      if (p < 0) {
        this.restLocalPos[i] = this.restWorldPos[i].clone();
        this.restLocalRot[i] = this.restWorldRot[i].clone();
      } else {
        const invP = this.restWorldRot[p].clone().invert();
        this.restLocalPos[i] = this.restWorldPos[i].clone()
          .sub(this.restWorldPos[p])
          .applyQuaternion(invP);
        this.restLocalRot[i] = invP.clone().multiply(this.restWorldRot[i]);
      }
    }
    this.localPos = this.restLocalPos.map((v) => v.clone());
    this.localRot = this.restLocalRot.map((q) => q.clone());
    this.worldPos = this.restWorldPos.map((v) => v.clone());
    this.worldRot = this.restWorldRot.map((q) => q.clone());
  }

  get count(): number {
    return this.jointNames.length;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  jointIndex(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`关节不存在: ${name}`);
    return i;
  }

  /** 骨长 = 静止姿势下父关节到本关节的距离（目标骨架永远保留该长度） */
  boneLength(name: string): number {
    const i = this.jointIndex(name);
    const p = this.parentIndex[i];
    if (p < 0) return 0;
    return this.restWorldPos[i].distanceTo(this.restWorldPos[p]);
  }

  /** 静止姿势下该骨头在世界中实际指向（父 -> 子） */
  restBoneDirection(name: string): Vector3 {
    const i = this.jointIndex(name);
    const p = this.parentIndex[i];
    if (p < 0) return new Vector3(0, 1, 0);
    return this.restWorldPos[i].clone().sub(this.restWorldPos[p]).normalize();
  }

  /** 当前姿势下该骨头在世界中实际指向 */
  currentBoneDirection(name: string): Vector3 {
    const i = this.jointIndex(name);
    const p = this.parentIndex[i];
    if (p < 0) return new Vector3(0, 1, 0);
    return this.worldPos[i].clone().sub(this.worldPos[p]).normalize();
  }

  /** 该关节的出骨头（指向第一个子关节）：铰链弯曲要看这根，而不是入骨头 */
  outgoingBoneRestDirection(name: string): Vector3 {
    const i = this.jointIndex(name);
    const child = this.children[i][0];
    if (child === undefined) return new Vector3(0, 1, 0);
    return this.restWorldPos[child].clone().sub(this.restWorldPos[i]).normalize();
  }

  outgoingBoneCurrentDirection(name: string): Vector3 {
    const i = this.jointIndex(name);
    const child = this.children[i][0];
    if (child === undefined) return new Vector3(0, 1, 0);
    return this.worldPos[child].clone().sub(this.worldPos[i]).normalize();
  }

  applyRest(): void {
    for (let i = 0; i < this.count; i++) {
      this.localPos[i].copy(this.restLocalPos[i]);
      this.localRot[i].copy(this.restLocalRot[i]);
    }
    this.update();
  }

  applyFrame(frame: PoseFrame): void {
    const root = 0;
    this.localPos[root].copy(vFromArray(frame.rootPos));
    this.localRot[root].copy(qFromArray(frame.rootRot));
    for (let i = 1; i < this.count; i++) {
      // 骨长恒定：平移始终取静止值；没有增量数据的关节保持当前/静止局部旋转
      this.localPos[i].copy(this.restLocalPos[i]);
      const d = frame.locals[this.jointNames[i]];
      if (d) {
        this.localRot[i].copy(this.restLocalRot[i]).multiply(qFromArray(d));
      } else {
        this.localRot[i].copy(this.restLocalRot[i]);
      }
    }
    this.update();
  }

  update(): void {
    for (let i = 0; i < this.count; i++) {
      const p = this.parentIndex[i];
      if (p < 0) {
        this.worldPos[i].copy(this.localPos[i]);
        this.worldRot[i].copy(this.localRot[i]);
      } else {
        this.worldRot[i].copy(this.parentWorldRot(i)).multiply(this.localRot[i]);
        this.worldPos[i]
          .copy(this.localPos[i])
          .applyQuaternion(this.parentWorldRot(i))
          .add(this.worldPos[p]);
      }
    }
  }

  private parentWorldRot(i: number): Quaternion {
    return this.worldRot[this.parentIndex[i]];
  }
}
