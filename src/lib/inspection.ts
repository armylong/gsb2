/**
 * 点击检查标记：简化表面上的命中点、原始表面上的最近点，以及二者连线。
 * 生命周期由主控制器管理：更换样例或重新简化时调用 clear() 清理。
 */
import * as THREE from 'three';

export interface InspectionMark {
  group: THREE.Group;
  hitPoint: THREE.Vector3;
  nearestPoint: THREE.Vector3;
  distance: number;
  faceIndex: number;
}

export class InspectionMarks {
  private readonly root = new THREE.Group();
  private current: InspectionMark | null = null;

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.root);
  }

  /**
   * 放置新检查点。任何旧标记先移除，保证画面上最多一个当前检查。
   */
  place(
    hitPoint: THREE.Vector3,
    nearestPoint: THREE.Vector3,
    distance: number,
    faceIndex: number,
  ): InspectionMark {
    this.clear();
    const group = new THREE.Group();

    // 命中点（简化表面）：橙色实心球
    const hitMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffa646, depthTest: true }),
    );
    hitMarker.position.copy(hitPoint);
    hitMarker.renderOrder = 5;

    // 原表面最近点：蓝色小球
    const nearestMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x4ea1ff, depthTest: true }),
    );
    nearestMarker.position.copy(nearestPoint);
    nearestMarker.renderOrder = 5;

    // 连线
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([hitPoint, nearestPoint]);
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineDashedMaterial({
        color: 0xffe08a,
        dashSize: 0.08,
        gapSize: 0.05,
        depthTest: true,
      }),
    );
    line.computeLineDistances();
    line.renderOrder = 4;

    group.add(hitMarker, nearestMarker, line);
    this.root.add(group);
    this.current = {
      group,
      hitPoint: hitPoint.clone(),
      nearestPoint: nearestPoint.clone(),
      distance,
      faceIndex,
    };
    return this.current;
  }

  clear(): void {
    if (!this.current) return;
    this.root.remove(this.current.group);
    this.current.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.current = null;
  }

  getCurrent(): InspectionMark | null {
    return this.current;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.root);
  }
}
