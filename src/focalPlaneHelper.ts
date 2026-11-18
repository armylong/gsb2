import * as THREE from 'three';

/**
 * 焦平面辅助物：独立场景中的半透明平面 + 边框 + 距离标签。
 *
 * - 始终垂直于相机朝向、位于相机前方 focusDistance 处；
 * - depthWrite = false，不写入任何深度纹理，因此不参与景深计算；
 * - 独立场景 + 显式拾取白名单，保证它永远不会被点选（需求 3）。
 */
export class FocalPlaneHelper {
  readonly scene = new THREE.Scene();
  private plane: THREE.Mesh;
  private frame: THREE.LineSegments;
  private label: THREE.Sprite;
  private labelCanvas: HTMLCanvasElement;
  private labelCtx: CanvasRenderingContext2D;
  private labelTexture: THREE.CanvasTexture;

  constructor(width = 26, height = 17) {
    const geo = new THREE.PlaneGeometry(width, height);

    this.plane = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0x5ec8ff,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.plane.renderOrder = 900;
    this.scene.add(this.plane);

    this.frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({
        color: 0x8fd8ff,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    this.frame.renderOrder = 901;
    this.scene.add(this.frame);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = 512;
    this.labelCanvas.height = 96;
    this.labelCtx = this.labelCanvas.getContext('2d')!;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;

    const labelMat = new THREE.SpriteMaterial({
      map: this.labelTexture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.label = new THREE.Sprite(labelMat);
    this.label.scale.set(4.4, 0.825, 1);
    this.label.renderOrder = 902;
    this.scene.add(this.label);

    this.setLabel(14);
  }

  private setLabel(distance: number): void {
    const ctx = this.labelCtx;
    ctx.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    ctx.fillStyle = 'rgba(10, 22, 32, 0.82)';
    ctx.strokeStyle = 'rgba(143, 216, 255, 0.9)';
    ctx.lineWidth = 4;
    const r = 14;
    const w = this.labelCanvas.width;
    const h = this.labelCanvas.height;
    ctx.beginPath();
    ctx.moveTo(r, 2);
    ctx.lineTo(w - r, 2);
    ctx.arc(w - r, r + 2, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(r, h - 2);
    ctx.arc(r, h - r - 2, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#bfe8ff';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`焦平面 · ${distance.toFixed(1)} m`, w / 2, h / 2);
    this.labelTexture.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.plane.visible = visible;
    this.frame.visible = visible;
    this.label.visible = visible;
  }

  /** 每帧按相机位置/朝向更新平面位置与标签读数 */
  update(camera: THREE.PerspectiveCamera, focusDistance: number): void {
    const position = camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(focusDistance));
    this.plane.position.copy(position);
    this.frame.position.copy(position);
    this.plane.quaternion.copy(camera.quaternion);
    this.frame.quaternion.copy(camera.quaternion);

    this.label.position.copy(position).add(new THREE.Vector3(0, 9.0, 0));
    this.setLabel(focusDistance);
  }

  dispose(): void {
    this.plane.geometry.dispose();
    (this.plane.material as THREE.Material).dispose();
    this.frame.geometry.dispose();
    (this.frame.material as THREE.Material).dispose();
    this.labelTexture.dispose();
    (this.label.material as THREE.Material).dispose();
  }
}
