import * as THREE from 'three';

/**
 * 参考线：
 * - 相机朝向射线（相机位置沿 -Z 的 8 单位线段，带方向锥）
 * - 相机处的小坐标轴三脚架
 * - 选中牌时：相机到牌锚点的连线，确认锚点没随模式切换漂移
 */
export class ReferenceRig {
  readonly group = new THREE.Group();
  private visible = true;

  private readonly forwardLine: THREE.Line;
  private readonly forwardCone: THREE.Mesh;
  private readonly tripod: THREE.AxesHelper;
  private readonly anchorLine: THREE.Line;

  private static _forward = new THREE.Vector3();
  private static _end = new THREE.Vector3();

  constructor() {
    const forwardGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.forwardLine = new THREE.Line(
      forwardGeo,
      new THREE.LineBasicMaterial({ color: 0x66e0ff }),
    );
    this.forwardCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.4, 12),
      new THREE.MeshBasicMaterial({ color: 0x66e0ff }),
    );
    this.tripod = new THREE.AxesHelper(0.9);

    const anchorGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.anchorLine = new THREE.Line(
      anchorGeo,
      new THREE.LineDashedMaterial({
        color: 0xff5a5a,
        dashSize: 0.25,
        gapSize: 0.15,
      }),
    );
    this.anchorLine.visible = false;

    this.group.add(this.forwardLine, this.forwardCone, this.tripod, this.anchorLine);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.group.visible = v;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(camera: THREE.Camera, selectedAnchor: THREE.Vector3 | null): void {
    const pos = camera.position;
    ReferenceRig._forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    ReferenceRig._end.copy(pos).addScaledVector(ReferenceRig._forward, 8);

    const attr = this.forwardLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, pos.x, pos.y, pos.z);
    attr.setXYZ(1, ReferenceRig._end.x, ReferenceRig._end.y, ReferenceRig._end.z);
    attr.needsUpdate = true;

    this.forwardCone.position.copy(ReferenceRig._end);
    this.forwardCone.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      ReferenceRig._forward,
    );
    this.tripod.position.copy(pos);

    if (selectedAnchor) {
      this.anchorLine.visible = true;
      const a = this.anchorLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      a.setXYZ(0, pos.x, pos.y, pos.z);
      a.setXYZ(1, selectedAnchor.x, selectedAnchor.y, selectedAnchor.z);
      a.needsUpdate = true;
      this.anchorLine.computeLineDistances();
    } else {
      this.anchorLine.visible = false;
    }
  }
}
