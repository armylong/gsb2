/**
 * 核心 MeshData（纯 TS）→ three.js BufferGeometry 的适配层。
 */
import * as THREE from 'three';
import { MeshData, computeNormals } from './surface';

export function meshToGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const positionArray = new Float32Array(mesh.positions.length * 3);
  mesh.positions.forEach((p, i) => {
    positionArray[i * 3] = p.x;
    positionArray[i * 3 + 1] = p.y;
    positionArray[i * 3 + 2] = p.z;
  });
  const normals = computeNormals(mesh);
  const normalArray = new Float32Array(normals.length * 3);
  normals.forEach((n, i) => {
    normalArray[i * 3] = n.x;
    normalArray[i * 3 + 1] = n.y;
    normalArray[i * 3 + 2] = n.z;
  });
  geo.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
  geo.setIndex(mesh.indices);
  geo.computeBoundingSphere();
  return geo;
}

/** 边折线转 LineSegments，用于高亮裂缝（红色）与修正后的缝（绿色） */
export function edgeLineGeometry(mesh: MeshData): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let k = 0; k < mesh.edgeIndices.length - 1; k++) {
    const a = mesh.positions[mesh.edgeIndices[k]];
    const b = mesh.positions[mesh.edgeIndices[k + 1]];
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}
