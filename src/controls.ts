import * as THREE from 'three';

/** 指针锁定 + WASD 行走控制（固定视高，水平移动） */
export class WalkControls {
  yaw = 0;
  pitch = 0;
  private keys = new Set<string>();

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    dom.addEventListener('click', () => dom.requestPointerLock());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      this.apply();
    });
    document.addEventListener('keydown', (e) => this.keys.add(e.code));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  apply(): void {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  /** 传送后从相机四元数反推 yaw/pitch，保持视角连续 */
  syncFromCamera(): void {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  update(dt: number): void {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    if (f === 0 && r === 0) return;
    const sp = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 6 : 3;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // 前向 (-sin, 0, -cos)，右向 (cos, 0, -sin)
    const dx = -sin * f + cos * r;
    const dz = -cos * f - sin * r;
    const len = Math.hypot(dx, dz) || 1;
    this.camera.position.x += (dx / len) * sp * dt;
    this.camera.position.z += (dz / len) * sp * dt;
  }
}
