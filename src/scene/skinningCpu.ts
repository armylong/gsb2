/**
 * CPU 端线性混合蒙皮(LBS),与 three.js SkinnedMesh 的 GPU 蒙皮使用同一公式:
 *   skinned = Σ_i w_i * (boneMatrix_i * bindInverse_i) * bindPosition
 *
 * 用于:
 *   - 热力图点位跟随变形后的网格;
 *   - 顶点点击拾取与笔刷的世界空间距离计算。
 */

import * as THREE from 'three';

const _boneMatrix = new THREE.Matrix4();
const _bind = new THREE.Vector3();
const _transformed = new THREE.Vector3();
const _skinned = new THREE.Vector3();

export function computeSkinnedPositions(
  geometry: THREE.BufferGeometry,
  skeleton: THREE.Skeleton,
  out: Float32Array,
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const { boneInverses, bones } = skeleton;

  for (let i = 0; i < position.count; i++) {
    _bind.fromBufferAttribute(position, i);
    _skinned.set(0, 0, 0);

    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w === 0) continue;
      const boneIndex = skinIndex.getComponent(i, k);
      _boneMatrix.multiplyMatrices(bones[boneIndex].matrixWorld, boneInverses[boneIndex]);
      _transformed.copy(_bind).applyMatrix4(_boneMatrix).multiplyScalar(w);
      _skinned.add(_transformed);
    }

    out[i * 3 + 0] = _skinned.x;
    out[i * 3 + 1] = _skinned.y;
    out[i * 3 + 2] = _skinned.z;
  }
}
