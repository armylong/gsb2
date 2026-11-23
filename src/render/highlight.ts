import * as THREE from 'three';

/**
 * 沿线段画一根圆柱。LineBasicMaterial 的 linewidth 在多数平台被忽略,
 * 用细圆柱才能在任意缩放下都保持可见。
 */
export function makeCylinderAlong(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const start = new THREE.Vector3(a[0], a[1], a[2]);
  const end = new THREE.Vector3(b[0], b[1], b[2]);
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = Math.max(direction.length(), 1e-5);
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 8, 1, false);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start.clone().add(end).multiplyScalar(0.5));
  if (direction.lengthSq() > 1e-16) {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  }
  return mesh;
}