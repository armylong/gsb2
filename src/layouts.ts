import * as THREE from 'three';
import type { LayoutName, SceneObject } from './types';

export interface CameraPreset {
  position: [number, number, number];
  target: [number, number, number];
}

interface ObjectPlacement {
  position: [number, number, number];
  rotation: [number, number, number];
}

interface LayoutDef {
  camera: CameraPreset;
  occluderZ: number;
  placements: Record<number, ObjectPlacement>;
}

const deg = THREE.MathUtils.degToRad;

/**
 * 三种布局：
 * - separated：9 个对象相互分离铺开
 * - occlusion：挡板位于相机与对象之间，4 个对象在挡板后方（含完全被覆盖者）
 * - touch：两个选中对象在中心相接，挡板移出视野
 */
const LAYOUTS: Record<LayoutName, LayoutDef> = {
  separated: {
    camera: { position: [0, 3.4, 11.2], target: [0, 1.0, 0] },
    occluderZ: -6.5,
    placements: {
      1: { position: [-5.2, 1.0, 0.0], rotation: [0, 0, 0] },
      2: { position: [-2.6, 1.0, 0.6], rotation: [deg(65), 0, 0] },
      3: { position: [0.0, 1.0, -0.4], rotation: [0, 0, 0] },
      4: { position: [2.7, 1.0, 0.4], rotation: [0, 0, 0] },
      5: { position: [5.3, 1.0, -0.2], rotation: [0, 0, deg(20)] },
      6: { position: [-4.0, -0.9, 1.0], rotation: [deg(20), deg(30), 0] },
      7: { position: [-1.3, -0.9, 0.4], rotation: [0, deg(15), 0] },
      8: { position: [1.5, -0.9, 0.8], rotation: [0, 0, 0] },
      9: { position: [4.5, -0.9, 0.2], rotation: [0, 0, 0] },
    },
  },
  occlusion: {
    camera: { position: [0, 2.6, 11.5], target: [0, 1.1, 0] },
    occluderZ: 0.0,
    placements: {
      // 挡板后方（z < 0）
      1: { position: [-1.1, 1.3, -1.6], rotation: [0, 0, 0] }, // 大半被覆盖
      2: { position: [1.2, 1.5, -1.8], rotation: [deg(70), 0, 0] }, // 部分露出边缘
      3: { position: [0.0, 1.0, -2.0], rotation: [0, 0, 0] }, // 完全隐藏（挡板中心）
      4: { position: [0.0, 3.4, -1.7], rotation: [0, 0, 0] }, // 挡板上方露出
      // 挡板前方 / 侧前方
      5: { position: [-2.6, 0.4, 1.4], rotation: [0, 0, deg(25)] },
      6: { position: [2.7, 0.6, 1.2], rotation: [deg(15), deg(20), 0] },
      7: { position: [-3.4, -1.0, 0.8], rotation: [0, deg(15), 0] },
      8: { position: [0.6, -1.0, 1.0], rotation: [0, 0, 0] },
      9: { position: [3.4, -0.9, 0.6], rotation: [0, 0, 0] },
    },
  },
  touch: {
    camera: { position: [0, 2.2, 8.2], target: [0, 1.0, 0] },
    occluderZ: -7.0,
    placements: {
      // 两个对象在中心相接：L 形竖板外侧面 x=0.5，U 形左立板外侧面 x=0.5
      7: { position: [-1.15, 1.0, 0.0], rotation: [0, 0, 0] },
      8: { position: [1.35, 1.0, 0.0], rotation: [0, 0, 0] },
      1: { position: [-4.2, 1.0, 0.4], rotation: [0, 0, 0] },
      2: { position: [4.2, 1.0, -0.3], rotation: [deg(70), 0, 0] },
      3: { position: [-3.2, -1.0, 0.8], rotation: [0, 0, 0] },
      4: { position: [3.4, -1.0, 0.6], rotation: [0, 0, 0] },
      5: { position: [0.0, 3.3, 0.0], rotation: [0, 0, deg(20)] },
      6: { position: [0.0, -1.2, 0.6], rotation: [deg(25), 0, 0] },
      9: { position: [0.0, 1.0, -2.6], rotation: [0, deg(40), 0] },
    },
  },
};

export function applyLayout(
  name: LayoutName,
  objects: SceneObject[],
  occluder: THREE.Object3D,
): LayoutDef {
  const def = LAYOUTS[name];
  for (const obj of objects) {
    const p = def.placements[obj.id];
    if (!p) continue;
    obj.group.position.set(...p.position);
    obj.group.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
  }
  occluder.position.set(0, 1.1, def.occluderZ);
  return def;
}

export function getLayoutCamera(name: LayoutName): CameraPreset {
  return LAYOUTS[name].camera;
}

/** 验证机位：与 occlusion 布局同机位，保证挡板覆盖关系固定可复现。 */
export const VERIFY_CAMERA: CameraPreset = LAYOUTS.occlusion.camera;
