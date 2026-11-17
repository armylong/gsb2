import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type TargetType = 'plane' | 'box' | 'sphere' | 'doublePlane';

export const TARGET_LABELS: Record<TargetType, string> = {
  plane: '平面 3×3',
  box: '立方体 2³',
  sphere: '低面数曲面(球 10×7)',
  doublePlane: '前后叠放双面',
};

/** 刚性程序几何;法线均为逐面平直法线(曲面转非索引后重算)。 */
export function createTargetGeometry(type: TargetType): THREE.BufferGeometry {
  switch (type) {
    case 'plane':
      return new THREE.PlaneGeometry(3, 3);
    case 'box':
      return new THREE.BoxGeometry(2, 2, 2);
    case 'sphere': {
      const g = new THREE.SphereGeometry(1.3, 10, 7).toNonIndexed();
      g.computeVertexNormals(); // 平直法线,低面数棱面清晰
      return g;
    }
    case 'doublePlane': {
      // 同一目标的两个叠放面:前小后大,均朝 +Z
      const front = new THREE.PlaneGeometry(1.4, 1.4).translate(0, 0, 0.3);
      const back = new THREE.PlaneGeometry(3, 3).translate(0, 0, -0.4);
      return mergeGeometries([front, back])!;
    }
  }
}
