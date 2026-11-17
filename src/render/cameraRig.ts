/**
 * 两种相机:
 * - orbit:轨道观察,围绕目标点旋转/缩放/平移;
 * - ground:地面附近移动,WASD 水平移动、Q/E 升降、拖拽转向,
 *   可选贴地(相机高度跟随统一高度场)。
 */
import * as THREE from 'three';
import { sampleHeight } from '../terrain/heightfield';

export type CameraMode = 'orbit' | 'ground';

export class CameraRig {
  mode: CameraMode = 'orbit';
  private orbit = {
    target: new THREE.Vector3(0, 4, 0),
    radius: 240,
    theta: Math.PI * 0.25,
    phi: Math.PI * 0.32,
  };
  private ground = {
    yaw: Math.PI * 0.25,
    pitch: -0.15,
    eyeHeight: 12,
    followTerrain: true,
  };
  private readonly keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private groundTarget: THREE.Vector3 | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly seed: () => number,
  ) {
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.applyOrbit();
  }

  switchMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    if (mode === 'ground') {
      // 从当前轨道相机位置切入,保持视角连续
      this.ground.yaw = this.orbit.theta + Math.PI;
      this.ground.pitch = this.orbit.phi - Math.PI / 2;
      this.groundTarget = this.camera.position.clone();
    }
    this.mode = mode;
  }

  setFollowTerrain(v: boolean): void {
    this.ground.followTerrain = v;
  }

  get followTerrain(): boolean {
    return this.ground.followTerrain;
  }

  setEyeHeight(h: number): void {
    this.ground.eyeHeight = h;
  }

  get eyeHeight(): number {
    return this.ground.eyeHeight;
  }

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onPointerUp = () => {
    this.dragging = false;
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.mode === 'orbit') {
      this.orbit.theta -= dx * 0.005;
      this.orbit.phi = THREE.MathUtils.clamp(this.orbit.phi - dy * 0.005, 0.12, Math.PI / 2 - 0.03);
      this.applyOrbit();
    } else {
      this.ground.yaw -= dx * 0.004;
      this.ground.pitch = THREE.MathUtils.clamp(this.ground.pitch - dy * 0.004, -1.2, 1.2);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.mode === 'orbit') {
      this.orbit.radius = THREE.MathUtils.clamp(this.orbit.radius * (1 + Math.sign(e.deltaY) * 0.08), 18, 460);
      this.applyOrbit();
    } else {
      this.ground.eyeHeight = THREE.MathUtils.clamp(
        this.ground.eyeHeight + Math.sign(e.deltaY) * 2,
        2,
        120,
      );
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  /** 轨道模式定位(供演示入口使用) */
  setOrbitView(radius: number, theta: number, phi: number): void {
    this.orbit.radius = radius;
    this.orbit.theta = theta;
    this.orbit.phi = phi;
    this.applyOrbit();
  }

  /** 地面模式定位 */
  setGroundPosition(x: number, z: number): void {
    this.groundTarget = new THREE.Vector3(x, 0, z);
  }

  getGroundPosition(): THREE.Vector3 {
    return (this.groundTarget ?? this.camera.position).clone();
  }

  private applyOrbit(): void {
    const { radius, theta, phi, target } = this.orbit;
    const sp = Math.sin(phi);
    this.camera.position.set(
      target.x + radius * sp * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * sp * Math.cos(theta),
    );
    this.camera.lookAt(target);
  }

  update(dt: number): void {
    if (this.mode !== 'ground') return;
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 70 : 32) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.ground.yaw), 0, -Math.cos(this.ground.yaw));
    const right = new THREE.Vector3(Math.cos(this.ground.yaw), 0, -Math.sin(this.ground.yaw));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.sub(forward);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() > 0) {
      if (move.x !== 0 || move.z !== 0) move.normalize().multiplyScalar(speed);
      else move.multiplyScalar(speed);
      if (!this.groundTarget) this.groundTarget = this.camera.position.clone();
      this.groundTarget.add(move);
      this.groundTarget.x = THREE.MathUtils.clamp(this.groundTarget.x, -158, 158);
      this.groundTarget.z = THREE.MathUtils.clamp(this.groundTarget.z, -158, 158);
    } else if (!this.groundTarget) {
      this.groundTarget = this.camera.position.clone();
    }

    let y = this.groundTarget.y;
    if (this.ground.followTerrain) {
      const groundY = sampleHeight(this.groundTarget.x, this.groundTarget.z, this.seed());
      y = groundY + this.ground.eyeHeight;
    }
    this.camera.position.set(this.groundTarget.x, y, this.groundTarget.z);
    const dir = new THREE.Vector3(
      -Math.sin(this.ground.yaw) * Math.cos(this.ground.pitch),
      Math.sin(this.ground.pitch),
      -Math.cos(this.ground.yaw) * Math.cos(this.ground.pitch),
    );
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
