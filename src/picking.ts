import * as THREE from 'three';
import type { Sign } from './Sign';

/**
 * 点选/悬停：把牌面与遮挡物放进同一次射线检测，按“屏幕实际先碰到谁”
 * 返回结果——墙在牌前面时命中墙，牌不可点；不可见（近裁面/背后）的牌
 * 不参与检测。透视与正交相机都走同一套 raycaster。
 */
export class Picker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  pick(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    signs: Sign[],
    occluders: THREE.Object3D[],
  ): Sign | null {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);

    const targets: THREE.Object3D[] = [];
    for (const sign of signs) {
      if (sign.mesh.visible) targets.push(sign.mesh);
    }
    for (const oc of occluders) targets.push(oc);

    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;

    const first = hits[0].object;
    if (first.userData.occluder) return null; // 被墙/架子挡住
    const id = first.userData.signId as string | undefined;
    return signs.find((s) => s.id === id) ?? null;
  }

  /**
   * 对照方法：只对牌面做射线，完全忽略遮挡物。
   * 与 pick() 结果对比即可证明“同一个像素，有墙时不可点、无墙时可点”。
   */
  pickIgnoringOccluders(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    signs: Sign[],
  ): Sign | null {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    const targets = signs.filter((s) => s.mesh.visible).map((s) => s.mesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const id = hits[0].object.userData.signId as string | undefined;
    return signs.find((s) => s.id === id) ?? null;
  }
}
