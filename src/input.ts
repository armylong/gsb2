import * as THREE from 'three';
import type { CameraMode } from './camera';
import type { PanelDef } from './types';

/**
 * 键盘输入。WASD 的方向始终按“当前镜头看到的屏幕参照”解释：
 * W=屏幕上方、S=屏幕下方、D=屏幕右方、A=屏幕左方，
 * 再把屏幕方向投影到当前吸附面的切平面上 —— 换面后同一按键的含义
 * 随可见参照自动变化，不需要玩家在头脑里做坐标变换。
 */
export class InputState {
  private keys = new Set<string>();
  /** 外部（自动驾驶）注入的世界空间意图，优先级高于键盘 */
  injected: THREE.Vector3 | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  attach() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }
  detach() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  get spacePressed() {
    return this.keys.has('Space');
  }

  /** 屏幕参照下的二维意图（x=右，y=上） */
  screenIntent(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW')) y += 1;
    if (this.keys.has('KeyS')) y -= 1;
    if (this.keys.has('KeyD')) x += 1;
    if (this.keys.has('KeyA')) x -= 1;
    return { x, y };
  }

  /**
   * 把屏幕意图转换为当前吸附面切平面内的世界向量。
   * 取相机的右向量与上向量分别投影到切平面，退化（投影几乎为零）时
   * 用面板自身轴兜底。
   */
  worldIntent(
    camera: THREE.Camera,
    panel: PanelDef | null,
    _mode: CameraMode,
  ): { intent: THREE.Vector3; screenUpOnFace: THREE.Vector3; screenRightOnFace: THREE.Vector3 } {
    if (this.injected) {
      const v = this.injected.clone();
      return { intent: v, screenUpOnFace: v.clone(), screenRightOnFace: v.clone() };
    }
    const { x, y } = this.screenIntent();
    if (!panel) {
      return {
        intent: new THREE.Vector3(x, 0, -y),
        screenUpOnFace: new THREE.Vector3(0, 0, -1),
        screenRightOnFace: new THREE.Vector3(1, 0, 0),
      };
    }

    const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const n = panel.normal;

    let rightOnFace = camRight.addScaledVector(n, -camRight.dot(n));
    if (rightOnFace.lengthSq() < 1e-4) rightOnFace = panel.uAxis.clone();
    rightOnFace.normalize();

    let upOnFace = camUp.addScaledVector(n, -camUp.dot(n));
    if (upOnFace.lengthSq() < 1e-4) upOnFace = panel.vAxis.clone();
    upOnFace.normalize();

    const intent = upOnFace.clone().multiplyScalar(y).addScaledVector(rightOnFace, x);
    if (intent.lengthSq() > 1) intent.normalize();
    return { intent, screenUpOnFace: upOnFace, screenRightOnFace: rightOnFace };
  }
}
