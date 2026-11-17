import * as THREE from 'three';

/**
 * 场景标记定义。
 * Three.js 相机看向局部 −Z，因此“前方深度”对应负的局部/世界 Z：
 * 定义时第三个数是“深度（米，正值）”，内部存为 (x, y, −depth)。
 * 几何读数中的 depth = −localZ，恒为正值。
 * 三组“已知深度”标记：近(红) / 中(绿，默认落在会聚面 12m) / 远(蓝)，
 * 外加一个可拖动的紫色球体（movable）。
 */

export type MarkerId = string;

export interface MarkerDef {
  id: MarkerId;
  label: string;
  group: 'near' | 'mid' | 'far' | 'movable';
  /** rig 局部坐标（前方为 −Z） */
  position: THREE.Vector3;
  /** 球面标记半径，m */
  radius: number;
  color: number;
  movable: boolean;
}

export const GROUP_COLORS: Record<MarkerDef['group'], number> = {
  near: 0xff5a52,
  mid: 0x3fb950,
  far: 0x4aa8ff,
  movable: 0xa371f7,
};

export const GROUP_LABELS: Record<MarkerDef['group'], string> = {
  near: '近景组',
  mid: '中景组（默认在会聚面）',
  far: '远景组',
  movable: '可移动物体',
};

export function buildDefaultMarkers(): MarkerDef[] {
  const defs: MarkerDef[] = [];
  const mk = (
    id: string, label: string, group: MarkerDef['group'],
    x: number, y: number, depth: number, radius = 0.22,
  ) => defs.push({
    id, label, group,
    position: new THREE.Vector3(x, y, -depth),
    radius, color: GROUP_COLORS[group], movable: group === 'movable',
  });

  // 近景深度 6m（会聚面 12m 之前 → 正视差）
  mk('n1', '近-左', 'near', -2.2, 1.6, 6);
  mk('n2', '近-中', 'near', 0, 2.6, 6);
  mk('n3', '近-右', 'near', 2.2, 1.6, 6);

  // 中景深度 12m（默认会聚距离 → 零视差）
  mk('m1', '中-左', 'mid', -3.2, 1.2, 12);
  mk('m2', '中-中', 'mid', 0, 3.0, 12);
  mk('m3', '中-右', 'mid', 3.2, 1.2, 12);

  // 远景深度 24m（会聚面之后 → 负视差）
  mk('f1', '远-左', 'far', -5.0, 1.0, 24);
  mk('f2', '远-中', 'far', 0, 3.4, 24);
  mk('f3', '远-右', 'far', 5.0, 1.0, 24);

  // 可移动物体：起点放在会聚面上（深度 12m）
  mk('obj', '可移动物体', 'movable', 0, 1.6, 12, 0.35);
  return defs;
}

/** 会聚面上的零视差参考小点（随会聚距离移动，z 由场景模块设置为 −zc） */
export interface ConvergenceDot {
  offset: THREE.Vector3;
}

export const CONVERGENCE_DOTS: ConvergenceDot[] = [
  { offset: new THREE.Vector3(-1.6, 0, 0) },
  { offset: new THREE.Vector3(1.6, 0, 0) },
  { offset: new THREE.Vector3(0, 1.4, 0) },
  { offset: new THREE.Vector3(0, -1.4, 0) },
];
