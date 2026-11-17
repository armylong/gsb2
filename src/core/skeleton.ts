import { Vector3 } from 'three';
import type { BoneName } from './types';

export interface BoneSpec {
  name: BoneName;
  parent: BoneName | null;
  /** 静息姿态（T-Pose）下相对父节点的本地位置（米） */
  restPosition: Vector3;
  /** 肢体段粗细（用于程序化蒙皮几何），半径（米） */
  radius: number;
  /** 显示用中文名 */
  label: string;
  /** 身体分区，用于上/下身预设 */
  region: 'root' | 'upper' | 'lower';
}

/**
 * 程序化骨架定义（19 关节）。
 * 坐标系：角色面朝 +Z，头顶 +Y，角色左侧 +X。
 * hips 位于 y≈0.92m，总高约 1.75m，T-Pose 手臂平举。
 */
export const BONE_SPECS: BoneSpec[] = [
  { name: 'hips', parent: null, restPosition: new Vector3(0, 0.92, 0), radius: 0.095, label: '髋（根）', region: 'root' },

  { name: 'spine', parent: 'hips', restPosition: new Vector3(0, 0.12, 0), radius: 0.085, label: '脊柱', region: 'upper' },
  { name: 'chest', parent: 'spine', restPosition: new Vector3(0, 0.14, 0), radius: 0.09, label: '胸', region: 'upper' },
  { name: 'neck', parent: 'chest', restPosition: new Vector3(0, 0.16, 0), radius: 0.045, label: '颈', region: 'upper' },
  { name: 'head', parent: 'neck', restPosition: new Vector3(0, 0.09, 0.01), radius: 0.085, label: '头', region: 'upper' },

  { name: 'shoulder_l', parent: 'chest', restPosition: new Vector3(0.07, 0.13, 0), radius: 0.05, label: '左肩', region: 'upper' },
  { name: 'upperarm_l', parent: 'shoulder_l', restPosition: new Vector3(0.085, 0, 0), radius: 0.045, label: '左上臂', region: 'upper' },
  { name: 'forearm_l', parent: 'upperarm_l', restPosition: new Vector3(0.25, 0, 0), radius: 0.038, label: '左前臂', region: 'upper' },
  { name: 'hand_l', parent: 'forearm_l', restPosition: new Vector3(0.23, 0, 0), radius: 0.032, label: '左手', region: 'upper' },

  { name: 'shoulder_r', parent: 'chest', restPosition: new Vector3(-0.07, 0.13, 0), radius: 0.05, label: '右肩', region: 'upper' },
  { name: 'upperarm_r', parent: 'shoulder_r', restPosition: new Vector3(-0.085, 0, 0), radius: 0.045, label: '右上臂', region: 'upper' },
  { name: 'forearm_r', parent: 'upperarm_r', restPosition: new Vector3(-0.25, 0, 0), radius: 0.038, label: '右前臂', region: 'upper' },
  { name: 'hand_r', parent: 'forearm_r', restPosition: new Vector3(-0.23, 0, 0), radius: 0.032, label: '右手', region: 'upper' },

  { name: 'thigh_l', parent: 'hips', restPosition: new Vector3(0.09, -0.04, 0), radius: 0.058, label: '左大腿', region: 'lower' },
  { name: 'shin_l', parent: 'thigh_l', restPosition: new Vector3(0, -0.43, 0), radius: 0.046, label: '左小腿', region: 'lower' },
  { name: 'foot_l', parent: 'shin_l', restPosition: new Vector3(0, -0.40, 0.03), radius: 0.04, label: '左脚', region: 'lower' },

  { name: 'thigh_r', parent: 'hips', restPosition: new Vector3(-0.09, -0.04, 0), radius: 0.058, label: '右大腿', region: 'lower' },
  { name: 'shin_r', parent: 'thigh_r', restPosition: new Vector3(0, -0.43, 0), radius: 0.046, label: '右小腿', region: 'lower' },
  { name: 'foot_r', parent: 'shin_r', restPosition: new Vector3(0, -0.40, 0.03), radius: 0.04, label: '右脚', region: 'lower' },
];

export const BONE_NAMES: BoneName[] = BONE_SPECS.map((s) => s.name);

const SPEC_BY_NAME = new Map<BoneName, BoneSpec>(BONE_SPECS.map((s) => [s.name, s]));
const CHILDREN = new Map<BoneName, BoneName[]>();
for (const spec of BONE_SPECS) {
  if (spec.parent) {
    const list = CHILDREN.get(spec.parent) ?? [];
    list.push(spec.name);
    CHILDREN.set(spec.parent, list);
  }
}

export function getBoneSpec(name: BoneName): BoneSpec {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) throw new Error(`未知关节: ${name}`);
  return spec;
}

export function getChildren(name: BoneName): BoneName[] {
  return CHILDREN.get(name) ?? [];
}

export function getParent(name: BoneName): BoneName | null {
  return SPEC_BY_NAME.get(name)?.parent ?? null;
}

/**
 * 返回某关节及其全部子孙（遮罩中“父关节采用目标动作时，子孙跟随”所需）。
 */
export function getSubtree(root: BoneName): BoneName[] {
  const out: BoneName[] = [];
  const walk = (n: BoneName) => {
    out.push(n);
    for (const c of getChildren(n)) walk(c);
  };
  walk(root);
  return out;
}
