import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

export type CameraMode = 'orbit' | 'fps';

/**
 * 双模式镜头：
 * - orbit：鼠标拖拽环视，单击画面做点选（点选只在这个模式生效）
 * - fps：指针锁定，WASD 移动、Shift 加速，按 Esc 回到 orbit
 * - 自动穿越：沿 z 轴 ping-pong 直线穿过雾盒前后边界，用于观察连续性
 */
export class CameraRig {
  mode: CameraMode = 'orbit';
  private readonly orbit: OrbitControls;
  private readonly fps: PointerLockControls;
  private readonly keys = new Set<string>();
  private readonly camera: THREE.PerspectiveCamera;

  // 自动穿越
  autoWalk = false;
  private walkT = 0;
  private readonly walkPathZ = [9.5, -9.5] as const;
  private readonly walkSpeed = 2.6; // 米/秒，单程约 7.3 秒

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;

    this.orbit = new OrbitControls(camera, domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.set(0, 1.6, 0);
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 1;
    this.orbit.maxDistance = 40;

    this.fps = new PointerLockControls(camera, domElement);
    this.fps.addEventListener('unlock', () => {
      if (this.mode === 'fps') this.setMode('orbit');
    });

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === 'fps') {
      this.orbit.enabled = false;
      this.autoWalk = false;
      Promise.resolve(this.fps.lock()).catch(() => {
        // 指针锁不可用（无头浏览器等）：fps 键盘移动仍可用，自动穿越也不依赖锁
      });
    } else {
      if (this.fps.isLocked) this.fps.unlock();
      this.orbit.enabled = true;
      // 回到 orbit 后，目标点取镜头前方 4 米，避免镜头突然跳位
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 4);
    }
  }

  /** 自动穿越开关：进入时切到 fps 视角并接管移动；指针锁失败也照常运行 */
  toggleAutoWalk(): boolean {
    if (!this.autoWalk) {
      this.mode = 'fps';
      this.orbit.enabled = false;
      this.autoWalk = true;
      this.walkT = 0;
      this.camera.position.set(0, 1.6, this.walkPathZ[0]);
      Promise.resolve(this.fps.lock()).catch(() => {
        /* 无头环境无 Pointer Lock：自动穿越由 update 直接驱动，不影响 */
      });
    } else {
      // 停止后回到轨道模式，镜头停在当前位置
      this.autoWalk = false;
      this.setMode('orbit');
    }
    return this.autoWalk;
  }

  /** 调试/自动化用：直接摆机位并让 OrbitControls 的 target 对齐注视点，避免阻尼把朝向拽回 */
  setCameraExternal(x: number, y: number, z: number, lookX = 0, lookY = 1.6, lookZ = 0): void {
    this.setMode('orbit');
    // 自动化需要精确的水平视线，放开交互用的俯仰限制；applyPreset 会恢复
    this.orbit.maxPolarAngle = Math.PI - 0.01;
    this.camera.position.set(x, y, z);
    this.orbit.target.set(lookX, lookY, lookZ);
    this.camera.lookAt(lookX, lookY, lookZ);
    this.camera.updateMatrixWorld();
    this.orbit.update();
  }

  /** 几个便于验收的机位 */
  applyPreset(name: 'outside' | 'inside-edge' | 'inside-deep' | 'overlook'): void {
    this.setMode('orbit');
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    const target = new THREE.Vector3(0, 1.6, 0);
    const positions: Record<typeof name, THREE.Vector3> = {
      // 雾区外正面，完整看到门框与雾盒
      outside: new THREE.Vector3(0, 2.2, 11.5),
      // 贴着雾盒前边（z=4）内侧，朝 +z 看出去：检查边界连续性
      'inside-edge': new THREE.Vector3(0, 1.7, 3.7),
      // 雾区深处回看
      'inside-deep': new THREE.Vector3(0, 1.7, -3.2),
      // 俯视全局
      overlook: new THREE.Vector3(9, 7.5, 11),
    };
    this.camera.position.copy(positions[name]);
    this.orbit.target.copy(target);
    this.orbit.update();
  }

  update(dt: number): void {
    if (this.autoWalk) {
      this.walkT += dt;
      const [zA, zB] = this.walkPathZ;
      const span = zA - zB;
      const phase = (this.walkT * this.walkSpeed) % (2 * span);
      const z = phase <= span ? zA - phase : zB + (phase - span);
      this.camera.position.set(0, 1.6, z);
      this.camera.lookAt(0, 1.6, z - 1);
      return;
    }

    if (this.mode === 'fps' && this.fps.isLocked) {
      const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = sprint ? 6 : 3;
      const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
      const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
      if (forward !== 0) this.fps.moveForward(forward * speed * dt);
      if (strafe !== 0) this.fps.moveRight(strafe * speed * dt);
      if (this.keys.has('KeyE')) this.camera.position.y += speed * dt;
      if (this.keys.has('KeyQ')) this.camera.position.y -= speed * dt;
      this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, 0.4, 8);
    } else {
      this.orbit.update();
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.orbit.dispose();
  }
}
