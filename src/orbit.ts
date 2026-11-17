import * as THREE from 'three';

/**
 * 轻量轨道控制器（自包含，不依赖 three/examples 的 OrbitControls）。
 * 被操控对象是 rig.root（Group，而非 Camera）；OrbitControls 内部依赖相机专属的
 * matrixWorldInverse，套在 Group 上会产生错误矩阵，故自行实现。
 *
 * 核心不变量：rig.root 永远位于世界原点 (0,0,0)，只改变旋转（yaw/pitch）。
 * 所有场景标记都是 rig 的子节点，因此无论怎么旋转，标记相对 rig/相机的
 * 局部坐标与深度读数保持稳定，符合“先固定深度再观察视差”的实验目的。
 */
export class SimpleOrbit {
  /** 观察目标（世界坐标，固定高度点，用于读数展示） */
  readonly target = new THREE.Vector3(0, 1.6, 0);
  enabled = true;
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly damping = 0.14;
  private targetYaw = 0;
  private targetPitch = 0;

  constructor(private readonly object: THREE.Object3D, private readonly dom: HTMLElement) {
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.applyImmediate();
  }

  /** 直接设置视角（弧度） */
  setView(yaw: number, pitch: number): void {
    this.yaw = this.targetYaw = yaw;
    this.pitch = this.targetPitch = pitch;
    this.applyImmediate();
  }

  getView(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /** 恢复固定观察姿态：正对场景、零偏航/俯仰 */
  reset(): void {
    this.setView(0, 0);
  }

  private applyImmediate(): void {
    this.object.position.set(0, 0, 0);
    this.object.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.object.updateMatrixWorld(true);
  }

  update(): void {
    this.targetYaw = THREE.MathUtils.clamp(this.targetYaw, -Math.PI * 2, Math.PI * 2);
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch, -1.35, 1.35);
    this.yaw += (this.targetYaw - this.yaw) * this.damping;
    this.pitch += (this.targetPitch - this.pitch) * this.damping;
    this.applyImmediate();
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.targetYaw -= dx * 0.005;
    this.targetPitch -= dy * 0.005;
  };

  private onUp = (): void => { this.dragging = false; };

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  }
}
