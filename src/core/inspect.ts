import { Euler, Quaternion, Vector3 } from 'three';
import type { Skeleton } from './skeleton';
import { vToArray } from './math';
import type { Vec3 } from './math';

export interface AxesReport {
  /** 当前世界姿势下，局部三根坐标轴在世界空间中的指向 */
  x: Vec3;
  y: Vec3;
  z: Vec3;
  /** 当前局部旋转（相对父关节）的欧拉角，度 */
  localEulerDeg: Vec3;
  /** 静止局部旋转的欧拉角，度 */
  restLocalEulerDeg: Vec3;
}

export interface JointInspection {
  sourceName: string;
  targetName: string;
  source: AxesReport;
  target: AxesReport;
  sourceRestBoneDir: Vec3;
  targetRestBoneDir: Vec3;
  sourceCurrentBoneDir: Vec3;
  targetCurrentBoneDir: Vec3;
  /** 出骨头相对静止指向的弯曲角，度 */
  sourceBendDeg: number;
  targetBendDeg: number;
  /** 静止时两边每根局部坐标轴是否反向（true 即该轴在两个骨架里朝向相反） */
  oppositeAxes: { x: boolean; y: boolean; z: boolean };
}

const X = (): Vector3 => new Vector3(1, 0, 0);
const Y = (): Vector3 => new Vector3(0, 1, 0);
const Z = (): Vector3 => new Vector3(0, 0, 1);

function axesOf(sk: Skeleton, index: number): AxesReport {
  const q = sk.worldRot[index];
  const e = new Euler().setFromQuaternion(sk.localRot[index]);
  const er = new Euler().setFromQuaternion(sk.restLocalRot[index]);
  const rad2deg = 180 / Math.PI;
  return {
    x: vToArray(X().applyQuaternion(q)),
    y: vToArray(Y().applyQuaternion(q)),
    z: vToArray(Z().applyQuaternion(q)),
    localEulerDeg: [e.x * rad2deg, e.y * rad2deg, e.z * rad2deg],
    restLocalEulerDeg: [er.x * rad2deg, er.y * rad2deg, er.z * rad2deg],
  };
}

export function inspectPair(
  source: Skeleton,
  target: Skeleton,
  sourceName: string,
  targetName: string,
): JointInspection {
  const si = source.jointIndex(sourceName);
  const ti = target.jointIndex(targetName);
  const srcRestDir = source.outgoingBoneRestDirection(sourceName);
  const tgtRestDir = target.outgoingBoneRestDirection(targetName);
  const srcCurDir = source.outgoingBoneCurrentDirection(sourceName);
  const tgtCurDir = target.outgoingBoneCurrentDirection(targetName);

  const axisWorld = (q: Quaternion, axis: Vector3): Vector3 =>
    axis.clone().applyQuaternion(q);
  const opp = (a: Vector3, b: Vector3): boolean => a.dot(b) < -0.5;
  const sr = source.restWorldRot[si];
  const tr = target.restWorldRot[ti];
  const oppositeAxes = {
    x: opp(axisWorld(sr, X()), axisWorld(tr, X())),
    y: opp(axisWorld(sr, Y()), axisWorld(tr, Y())),
    z: opp(axisWorld(sr, Z()), axisWorld(tr, Z())),
  };

  return {
    sourceName,
    targetName,
    source: axesOf(source, si),
    target: axesOf(target, ti),
    sourceRestBoneDir: vToArray(srcRestDir),
    targetRestBoneDir: vToArray(tgtRestDir),
    sourceCurrentBoneDir: vToArray(srcCurDir),
    targetCurrentBoneDir: vToArray(tgtCurDir),
    sourceBendDeg: (srcRestDir.angleTo(srcCurDir) * 180) / Math.PI,
    targetBendDeg: (tgtRestDir.angleTo(tgtCurDir) * 180) / Math.PI,
    oppositeAxes,
  };
}

export function formatVec3(v: Vec3): string {
  return `[${v.map((n) => n.toFixed(3)).join(', ')}]`;
}
