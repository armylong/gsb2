import { Vector3 } from 'three';
import { SampleScene } from './sampleScene';

export const TOTAL_FRAMES = 180;

export interface CameraPathFrame {
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

export interface ObjectPathFrame {
  /** 组整体平移（叠加在基座标上）。 */
  groupOffset: [number, number, number];
  /** 组整体绕 Y 轴旋转（弧度）。 */
  groupRotationY: number;
  /** 成员相对初始局部位姿的旋转（弧度，三轴）。 */
  memberRotation: [number, number, number];
}

/** 观察相机走的固定路径：平动 + 扫视 + 变焦 + 拉近拉远，确定性可复现。 */
export function cameraPathAt(frame: number): CameraPathFrame {
  const t = (frame / TOTAL_FRAMES) * Math.PI * 2;
  const position: [number, number, number] = [
    Math.sin(t * 0.7) * 7,
    Math.sin(t * 0.45) * 3,
    Math.cos(t * 0.5) * 2.5,
  ];
  const lookAt: [number, number, number] = [
    Math.sin(t * 0.3) * 3,
    Math.cos(t * 0.35) * 1.6,
    -16 + Math.sin(t * 0.25) * 4,
  ];
  // fov/near/far 也在路径上变化，专门制造远平面裁剪与边界交叉。
  const fov = 52 + Math.sin(t * 0.9) * 14;
  const near = 0.4 + (Math.sin(t * 1.3) + 1) * 0.4;
  const far = 34 + (Math.sin(t * 0.6) + 1) * 12;
  return { position, lookAt, fov, near, far };
}

/**
 * 摆件变换路径：整组漂移（让组在视锥边缘反复进出）+ 成员自转。
 * 组 2/3/5 振幅更大，专门制造「组局部可见、部分子对象出界」的情形。
 */
export function objectPathAt(frame: number, groupIndex: number): ObjectPathFrame {
  const t = (frame / TOTAL_FRAMES) * Math.PI * 2;
  const amp = groupIndex === 0 ? 0.8 : 2.2 + (groupIndex % 3) * 0.9;
  const groupOffset: [number, number, number] = [
    Math.sin(t * (0.55 + groupIndex * 0.07)) * amp,
    Math.cos(t * (0.4 + groupIndex * 0.09)) * amp * 0.55,
    Math.sin(t * (0.3 + groupIndex * 0.05) + groupIndex) * amp * 0.8,
  ];
  const groupRotationY = t * (0.25 + groupIndex * 0.04);
  const spin = t * (0.8 + groupIndex * 0.1);
  const memberRotation: [number, number, number] = [
    Math.sin(spin) * 0.6,
    spin,
    Math.cos(spin * 0.8) * 0.6,
  ];
  return { groupOffset, groupRotationY, memberRotation };
}

/** 把第 frame 帧的确定性变换写进场景（之后需调用 updateWorldBounds）。 */
export function applyObjectPath(scene: SampleScene, frame: number): void {
  scene.groups.forEach((groupEntity, gi) => {
    const path = objectPathAt(frame, gi);
    groupEntity.group.position.copy(groupEntity.basePosition);
    groupEntity.group.position.add(
      new Vector3(path.groupOffset[0], path.groupOffset[1], path.groupOffset[2]),
    );
    groupEntity.group.rotation.set(0, path.groupRotationY, 0);

    groupEntity.members.forEach((member) => {
      member.mesh.position.copy(member.baseLocalPosition);
      member.mesh.rotation.set(
        member.baseLocalRotation.x + path.memberRotation[0],
        member.baseLocalRotation.y + path.memberRotation[1],
        member.baseLocalRotation.z + path.memberRotation[2],
      );
    });
  });
}

/** 把固定路径的相机参数写进观察相机。 */
export function applyCameraPath(
  camera: {
    position: Vector3;
    fov: number;
    near: number;
    far: number;
    updateProjectionMatrix(): void;
  },
  lookTarget: Vector3,
  frame: number,
): void {
  const path = cameraPathAt(frame);
  camera.position.set(...path.position);
  lookTarget.set(...path.lookAt);
  camera.fov = path.fov;
  camera.near = path.near;
  camera.far = path.far;
  camera.updateProjectionMatrix();
}
