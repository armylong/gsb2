import * as THREE from 'three';

export type CameraMode = 'follow' | 'top' | 'side';

// 从结构外侧（场地前方 -z、偏上）看向圆盘，避免穿进立墙/顶面
const FOLLOW_OFFSET = new THREE.Vector3(7, 6.5, -11);
const TOP_POS = new THREE.Vector3(0, 18, 0);
const TOP_LOOK = new THREE.Vector3(0, 0, 0);
const SIDE_POS = new THREE.Vector3(17, 4.5, 4);
const SIDE_LOOK = new THREE.Vector3(0, 3, 4);
const LOOK_TARGET = new THREE.Vector3(0, 3, 4);

/**
 * 三种镜头：
 * - follow：跟随圆盘的斜后方视角，默认
 * - top：正上方俯视，检验两个外角处方向是否正确衔接
 * - side：侧视，检验地面→立墙→顶面的高度面切换
 */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'follow';
  private desiredPos = new THREE.Vector3();
  private desiredLook = new THREE.Vector3();
  private currentLook = LOOK_TARGET.clone();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 120);
    this.camera.position.copy(FOLLOW_OFFSET);
    this.camera.lookAt(LOOK_TARGET);
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
  }

  cycle() {
    this.mode = this.mode === 'follow' ? 'top' : this.mode === 'top' ? 'side' : 'follow';
    return this.mode;
  }

  update(dt: number, discPos: THREE.Vector3) {
    if (this.mode === 'follow') {
      this.desiredPos.copy(discPos).add(FOLLOW_OFFSET);
      this.desiredLook.copy(discPos).lerp(LOOK_TARGET, 0.25);
    } else if (this.mode === 'top') {
      this.desiredPos.copy(TOP_POS);
      this.desiredLook.copy(TOP_LOOK);
    } else {
      this.desiredPos.copy(SIDE_POS);
      this.desiredLook.copy(SIDE_LOOK);
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(this.desiredPos, k);
    this.currentLook.lerp(this.desiredLook, k);
    this.camera.lookAt(this.currentLook);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
