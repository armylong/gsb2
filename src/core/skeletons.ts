import { Vector3 } from 'three';
import type { SkeletonDef } from './skeleton';
import { frameAlong, qToArray, twisted, vec } from './math';

/**
 * 两个骨架共用同一套关节层次（名字一致即可建立默认对应）：
 * root -> spine -> chest -> neck -> head
 *                 chest -> l/r shoulder -> elbow -> wrist
 * root  -> l/r hip -> knee -> ankle
 */
export const JOINT_LABELS: Record<string, string> = {
  root: '根（骨盆）',
  spine: '下脊',
  chest: '胸腔',
  neck: '脖子',
  head: '头',
  lshoulder: '左肩',
  lelbow: '左肘',
  lwrist: '左手腕',
  rshoulder: '右肩',
  relbow: '右肘',
  rwrist: '右手腕',
  lhip: '左胯',
  lknee: '左膝',
  lankle: '左脚踝',
  rhip: '右胯',
  rknee: '右膝',
  rankle: '右脚踝',
};

export const ROOT_NAME = 'root';

interface ParentDef {
  name: string;
  parent: string | null;
}

const HIERARCHY: ParentDef[] = [
  { name: 'root', parent: null },
  { name: 'spine', parent: 'root' },
  { name: 'chest', parent: 'spine' },
  { name: 'neck', parent: 'chest' },
  { name: 'head', parent: 'neck' },
  { name: 'lshoulder', parent: 'chest' },
  { name: 'lelbow', parent: 'lshoulder' },
  { name: 'lwrist', parent: 'lelbow' },
  { name: 'rshoulder', parent: 'chest' },
  { name: 'relbow', parent: 'rshoulder' },
  { name: 'rwrist', parent: 'relbow' },
  { name: 'lhip', parent: 'root' },
  { name: 'lknee', parent: 'lhip' },
  { name: 'lankle', parent: 'lknee' },
  { name: 'rhip', parent: 'root' },
  { name: 'rknee', parent: 'rhip' },
  { name: 'rankle', parent: 'rknee' },
];

const FORWARD = (): Vector3 => vec(0, 0, 1);
const BACKWARD = (): Vector3 => vec(0, 0, -1);
const UP = (): Vector3 => vec(0, 1, 0);
const DOWN = (): Vector3 => vec(0, -1, 0);

function boneDir(pos: Record<string, Vector3>, name: string, parent: string | null): Vector3 {
  if (parent === null) return UP();
  return pos[name].clone().sub(pos[parent]).normalize();
}

/** 计算每个关节静止世界朝向：+Y 沿骨头，+Z 沿弯曲方向 */
function buildFrames(
  pos: Record<string, Vector3>,
  bend: Record<string, Vector3>,
  twists: ReadonlySet<string>,
): Record<string, ReturnType<typeof frameAlong>> {
  const frames: Record<string, ReturnType<typeof frameAlong>> = {};
  for (const { name, parent } of HIERARCHY) {
    const dir = boneDir(pos, name, parent);
    let q = frameAlong(dir, bend[name].clone());
    if (twists.has(name)) {
      // 绕骨头自身 +Y 轴拧 180°：左右骨的局部坐标轴因此正好相反
      q = twisted(q, dir, Math.PI);
    }
    frames[name] = q;
  }
  return frames;
}

function toDef(
  name: string,
  height: number,
  pos: Record<string, Vector3>,
  frames: Record<string, ReturnType<typeof frameAlong>>,
): SkeletonDef {
  return {
    name,
    height,
    joints: HIERARCHY.map(({ name: jn, parent }) => ({
      name: jn,
      parent,
      restPos: [pos[jn].x, pos[jn].y, pos[jn].z],
      restRot: qToArray(frames[jn]),
    })),
  };
}

/** 矮纸偶（源）：T 字站姿，身高 1.20 */
export function createSourceDef(): SkeletonDef {
  const p: Record<string, Vector3> = {
    root: vec(0, 0.78, 0),
    spine: vec(0, 0.9, 0),
    chest: vec(0, 0.99, 0),
    neck: vec(0, 1.06, 0),
    head: vec(0, 1.13, 0),
    lshoulder: vec(0.13, 0.97, 0),
    lelbow: vec(0.31, 0.97, 0),
    lwrist: vec(0.47, 0.97, 0),
    rshoulder: vec(-0.13, 0.97, 0),
    relbow: vec(-0.31, 0.97, 0),
    rwrist: vec(-0.47, 0.97, 0),
    lhip: vec(0.09, 0.78, 0),
    lknee: vec(0.09, 0.42, 0),
    lankle: vec(0.09, 0.06, 0),
    rhip: vec(-0.09, 0.78, 0),
    rknee: vec(-0.09, 0.42, 0),
    rankle: vec(-0.09, 0.06, 0),
  };
  const bend: Record<string, Vector3> = {};
  for (const jn of Object.keys(p)) bend[jn] = FORWARD();
  bend.lhip = BACKWARD();
  bend.rhip = BACKWARD();
  bend.lknee = BACKWARD();
  bend.rknee = BACKWARD();
  bend.lankle = BACKWARD();
  bend.rankle = BACKWARD();
  // 源骨架不做额外扭转：标准右手系
  const frames = buildFrames(p, bend, new Set());
  return toDef('矮纸偶（源）', 1.2, p, frames);
}

/** 细长纸偶（目标）：A 字站姿、骨长更长，多处关节局部轴与源相反 */
export function createTargetDef(): SkeletonDef {
  const a = 12 * (Math.PI / 180);
  const arm = (from: Vector3, len: number, side: number): Vector3 =>
    from.clone().add(vec(side * len * Math.cos(a), -len * Math.sin(a), 0));
  const lShoulder = vec(0.16, 1.47, 0);
  const rShoulder = vec(-0.16, 1.47, 0);
  const lElbow = arm(lShoulder, 0.34, 1);
  const rElbow = arm(rShoulder, 0.34, -1);
  const lWrist = arm(lElbow, 0.31, 1);
  const rWrist = arm(rElbow, 0.31, -1);

  const p: Record<string, Vector3> = {
    root: vec(0, 1.14, 0),
    spine: vec(0, 1.34, 0),
    chest: vec(0, 1.5, 0),
    neck: vec(0, 1.61, 0),
    head: vec(0, 1.72, 0),
    lshoulder: lShoulder,
    lelbow: lElbow,
    lwrist: lWrist,
    rshoulder: rShoulder,
    relbow: rElbow,
    rwrist: rWrist,
    lhip: vec(0.11, 1.14, 0),
    lknee: vec(0.11, 0.6, 0),
    lankle: vec(0.11, 0.08, 0),
    rhip: vec(-0.11, 1.14, 0),
    rknee: vec(-0.11, 0.6, 0),
    rankle: vec(-0.11, 0.08, 0),
  };
  const bend: Record<string, Vector3> = {};
  for (const jn of Object.keys(p)) bend[jn] = FORWARD();
  bend.lhip = BACKWARD();
  bend.rhip = BACKWARD();
  bend.lknee = BACKWARD();
  bend.rknee = BACKWARD();
  bend.lankle = BACKWARD();
  bend.rankle = BACKWARD();
  // 目标骨架：左肘整条、左膝整条相对源拧 180°，制造相反的局部坐标轴
  const twists = new Set(['lelbow', 'lwrist', 'lknee', 'lankle']);
  const frames = buildFrames(p, bend, twists);
  return toDef('细长纸偶（目标）', 1.8, p, frames);
}

export { UP, DOWN, FORWARD, BACKWARD };
