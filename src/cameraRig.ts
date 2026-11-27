import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraKind = 'perspective' | 'orthographic';

export interface CameraPose {
  id: string;
  label: string;
  kind: CameraKind;
  position: [number, number, number];
  target: [number, number, number];
  /** 正交相机的缩放（视角宽窄） */
  zoom?: number;
  /** 姿态用途说明，UI 直接展示 */
  note: string;
}

/**
 * 可复现的检查姿态：顶部 / 远景 / 半遮挡 / 近裁面 / 镜头背后，
 * 透视与正交各覆盖一组。
 */
export const POSES: CameraPose[] = [
  {
    id: 'persp-overview',
    label: '透视·环视',
    kind: 'perspective',
    position: [9, 6.5, 11],
    target: [0, 2.2, -1],
    note: '默认斜视起点，可自由绕场',
  },
  {
    id: 'persp-top',
    label: '透视·正上方',
    kind: 'perspective',
    position: [0.8, 8.6, 1.62],
    target: [0.8, 0, 1.6],
    note: '正对 C 牌竖轴上方：竖轴牌冻结且提示奇点，不翻牌',
  },
  {
    id: 'persp-far',
    label: '透视·远景',
    kind: 'perspective',
    position: [0, 9, 52],
    target: [0, 2, 0],
    note: '很远时 WORLD 牌变小、SCREEN 牌保持屏幕占比（超出最大占比则钳制）',
  },
  {
    id: 'persp-half',
    label: '透视·半遮挡',
    kind: 'perspective',
    position: [11, 2.4, 6.5],
    target: [2.4, 2.4, -3.2],
    note: '隔断墙挡住部分牌，点选只命中可见部分',
  },
  {
    id: 'persp-near',
    label: '透视·贴近近裁面',
    kind: 'perspective',
    position: [-5.6, 5.28, -5.6],
    target: [-2, 3.5, -3],
    note: '相机在 D 外侧约 0.16：D 进入近裁面淡入区并被钳制，其余牌仍在视野',
  },
  {
    id: 'persp-behind',
    label: '透视·绕到牌背后',
    kind: 'perspective',
    position: [-8.5, 2.6, 2],
    target: [-12, 3.2, 3.5],
    note: 'A 牌在相机身后（BEHIND 隐藏），越过锚点不翻转；B/D 在前方仍可见',
  },
  {
    id: 'ortho-overview',
    label: '正交·斜视',
    kind: 'orthographic',
    position: [9, 6.5, 11],
    target: [0, 2.2, -1],
    zoom: 0.9,
    note: '正交基线，远近物体投影一样大',
  },
  {
    id: 'ortho-top',
    label: '正交·俯视',
    kind: 'orthographic',
    position: [0.8, 9, 1.62],
    target: [0.8, 0, 1.6],
    zoom: 1.0,
    note: '正俯视：竖轴奇点在正交相机下同样可见',
  },
  {
    id: 'ortho-far',
    label: '正交·远景',
    kind: 'orthographic',
    position: [0, 22, 60],
    target: [0, 2, 0],
    zoom: 1.6,
    note: '正交远景：SCREEN 牌尺寸仅受 zoom 影响',
  },
  {
    id: 'ortho-half',
    label: '正交·半遮挡',
    kind: 'orthographic',
    position: [11, 2.4, 6.5],
    target: [2.4, 2.4, -3.2],
    zoom: 1.2,
    note: '正交下半遮挡与点选判定',
  },
];

export class CameraRig {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;
  readonly controlsPersp: OrbitControls;
  readonly controlsOrtho: OrbitControls;
  kind: CameraKind = 'perspective';
  /** 预设姿态应用后锁定一帧，避免 OrbitControls.update 覆盖 lookAt */
  private poseLock = false;

  constructor(domElement: HTMLElement) {
    const aspect = window.innerWidth / window.innerHeight;
    this.perspective = new THREE.PerspectiveCamera(55, aspect, 0.1, 220);
    this.perspective.position.set(9, 6.5, 11);

    const frustum = 14;
    this.orthographic = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2,
      (frustum * aspect) / 2,
      frustum / 2,
      -frustum / 2,
      0.1,
      220,
    );
    this.orthographic.position.copy(this.perspective.position);
    this.orthographic.zoom = 0.9;

    this.controlsPersp = new OrbitControls(this.perspective, domElement);
    this.controlsOrtho = new OrbitControls(this.orthographic, domElement);
    this.controlsOrtho.enabled = false;

    for (const c of [this.controlsPersp, this.controlsOrtho]) {
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      c.minDistance = 0.05;
      c.maxDistance = 180;
      c.target.set(0, 2.2, -1);
      // 用户一旦手动操作就解除预设锁定，恢复 OrbitControls 完全控制
      c.addEventListener('start', () => {
        this.poseLock = false;
      });
    }
  }

  get active(): THREE.Camera {
    return this.kind === 'perspective' ? this.perspective : this.orthographic;
  }

  get activeControls(): OrbitControls {
    return this.kind === 'perspective' ? this.controlsPersp : this.controlsOrtho;
  }

  switchKind(kind: CameraKind): void {
    if (kind === this.kind) return;
    const from = this.active;
    this.kind = kind;
    const to = this.active;
    // 位置、朝向、观察目标同步，切换相机类型时视角连续
    to.position.copy(from.position);
    to.rotation.copy(from.rotation);
    this.activeControls.target.copy(
      this.kind === 'perspective' ? this.controlsOrtho.target : this.controlsPersp.target,
    );
    this.controlsPersp.enabled = kind === 'perspective';
    this.controlsOrtho.enabled = kind === 'orthographic';
    this.activeControls.update();
  }

  applyPose(pose: CameraPose): void {
    this.switchKind(pose.kind);
    const cam = this.active;
    const controls = this.activeControls;
    cam.position.set(...pose.position);
    controls.target.set(...pose.target);
    if (pose.kind === 'orthographic') {
      this.orthographic.zoom = pose.zoom ?? 1;
      this.orthographic.updateProjectionMatrix();
    }
    // lookAt 直接确定朝向，并锁定下一帧不让 OrbitControls 用球坐标覆盖
    cam.lookAt(...pose.target);
    this.poseLock = true;
  }

  resize(): void {
    const aspect = window.innerWidth / window.innerHeight;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();

    const frustum = 14;
    this.orthographic.left = (-frustum * aspect) / 2;
    this.orthographic.right = (frustum * aspect) / 2;
    this.orthographic.top = frustum / 2;
    this.orthographic.bottom = -frustum / 2;
    this.orthographic.updateProjectionMatrix();
  }

  update(): void {
    // 预设姿态锁定期间不调用 OrbitControls.update，保留 lookAt 的确定朝向；
    // 用户触发 'start' 事件后 poseLock 解除，恢复正常轨道交互
    if (!this.poseLock) {
      this.activeControls.update();
    }
  }
}
