// 程序化几何体工厂：全部由 three 内置几何体生成，不依赖外部模型
import * as THREE from 'three';

export function createGeometry(def) {
  switch (def.kind) {
    case 'box':
      return new THREE.BoxGeometry(...def.size);
    case 'sphere':
      return new THREE.SphereGeometry(def.radius, 32, 24);
    case 'cylinder':
      return new THREE.CylinderGeometry(def.radius, def.radius, def.height, 32);
    case 'cone':
      return new THREE.ConeGeometry(def.radius, def.height, 32);
    case 'torus':
      return new THREE.TorusGeometry(def.radius, def.tube, 20, 40);
    case 'capsule':
      return new THREE.CapsuleGeometry(def.radius, def.length, 12, 24);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

export function createMesh(def) {
  const geo = createGeometry(def);
  const mat = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: 0.65,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.fromArray(def.position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.id = def.id;
  return mesh;
}

export function createGround(size) {
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd8dde6,
    roughness: 0.95,
    metalness: 0,
  });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  return ground;
}

/** 网格参考线（1 单位一格，每 5 单位加粗） */
export function createGrid(size) {
  const grid = new THREE.GridHelper(size, size, 0x8a93a6, 0xb8bfcc);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  return grid;
}
