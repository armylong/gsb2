/**
 * 视角预设与飞行过渡。
 *
 * 预设之间沿球面插值（绕目标点转），避免镜头从零件中间穿过去；
 * 飞行期间 `isFlying === true`，主循环据此认为这是一次「突然换视角」，
 * 不沿用上一帧的标签粘滞位。
 */

import * as THREE from 'three';

export type ViewPresetName = 'front' | 'back' | 'side' | 'crowd';

export interface ViewPreset {
  name: ViewPresetName;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const VIEW_PRESETS: Record<ViewPresetName, ViewPreset> = {
  front: {
    name: 'front',
    label: '正面',
    position: [1.2, 7.2, 16.5],
    target: [0.2, 2.2, 0.2],
    fov: 40,
  },
  back: {
    name: 'back',
    label: '背面',
    position: [-1.0, 7.0, -17.0],
    target: [0.0, 2.2, -0.6],
    fov: 40,
  },
  side: {
    name: 'side',
    label: '侧面',
    position: [17.5, 6.4, 2.2],
    target: [0.4, 2.3, -0.4],
    fov: 40,
  },
  crowd: {
    name: 'crowd',
    label: '拥挤角落',
    position: [11.6, 6.2, 9.6],
    target: [4.5, 1.15, 2.55],
    fov: 38,
  },
};

export interface CameraDirectorOptions {
  duration?: number;
  controls?: {
    enableDamping: boolean;
    update(delta?: number | null): boolean;
    target: THREE.Vector3;
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class CameraDirector {
  private flying = false;
  private elapsed = 0;
  private duration: number;
  private readonly startTarget = new THREE.Vector3();
  private readonly endTarget = new THREE.Vector3();
  private readonly startSpherical = new THREE.Spherical();
  private readonly endSpherical = new THREE.Spherical();
  private startFov = 40;
  private endFov = 40;
  private savedDamping = true;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly options: CameraDirectorOptions = {},
  ) {
    this.duration = options.duration ?? 0.85;
  }

  get isFlying(): boolean {
    return this.flying;
  }

  /** 立即切换（不做动画），主要用于初始化。 */
  snapTo(preset: ViewPreset): void {
    const target = new THREE.Vector3(...preset.target);
    this.camera.position.set(...preset.position);
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    if (this.options.controls) {
      this.options.controls.target.copy(target);
      this.options.controls.update();
    }
    this.flying = false;
    this.restoreDamping();
  }

  flyTo(preset: ViewPreset, fromTarget?: THREE.Vector3): void {
    if (this.options.controls) {
      this.savedDamping = this.options.controls.enableDamping;
      this.options.controls.enableDamping = false;
    }

    this.startTarget.copy(
      fromTarget ?? this.options.controls?.target ?? new THREE.Vector3(0, 2.2, 0),
    );
    this.endTarget.set(...preset.target);
    this.startSpherical.setFromVector3(
      this.tmp.copy(this.camera.position).sub(this.startTarget),
    );
    this.endSpherical.setFromVector3(
      this.tmp.set(...preset.position).sub(this.endTarget),
    );
    this.startFov = this.camera.fov;
    this.endFov = preset.fov;
    this.elapsed = 0;
    this.flying = true;
  }

  update(dt: number): boolean {
    if (!this.flying) return false;
    this.elapsed += Math.max(0, dt);
    const raw = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
    const t = easeInOutCubic(raw);

    const target = this.tmp.lerpVectors(this.startTarget, this.endTarget, t).clone();

    const radius = THREE.MathUtils.lerp(this.startSpherical.radius, this.endSpherical.radius, t);
    const phi = THREE.MathUtils.lerp(this.startSpherical.phi, this.endSpherical.phi, t);
    const theta =
      this.startSpherical.theta +
      shortestAngleDelta(this.startSpherical.theta, this.endSpherical.theta) * t;

    const sph = new THREE.Spherical(radius, phi, theta);
    const offset = new THREE.Vector3().setFromSpherical(sph);
    this.camera.position.copy(target).add(offset);

    const fov = THREE.MathUtils.lerp(this.startFov, this.endFov, t);
    if (Math.abs(fov - this.camera.fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.lookAt(target);
    if (this.options.controls) {
      this.options.controls.target.copy(target);
      this.options.controls.update();
    }

    if (raw >= 1) {
      this.flying = false;
      this.restoreDamping();
    }
    return true;
  }

  /** 用户开始拖拽时中止飞行。 */
  cancel(): void {
    if (!this.flying) return;
    this.flying = false;
    this.restoreDamping();
  }

  private restoreDamping(): void {
    if (this.options.controls) {
      this.options.controls.enableDamping = this.savedDamping;
    }
  }
}
