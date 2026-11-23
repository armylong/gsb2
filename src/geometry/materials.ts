/** 统一的 PBR 材质表, 颜色区分零件分组, 爆炸高亮时可直接替换 emissive */
import * as THREE from 'three';

export interface PartMaterials {
  base: THREE.MeshStandardMaterial;
}

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, ...opts });
}

export function createMaterials(): Record<string, THREE.MeshStandardMaterial> {
  return {
    housing: mat(0x5b7a99, { roughness: 0.45, metalness: 0.35 }),
    housingDark: mat(0x30465c, { roughness: 0.5, metalness: 0.4 }),
    cover: mat(0xd8763c, { roughness: 0.5, metalness: 0.2 }),
    coverDark: mat(0x9c4f22, { roughness: 0.55, metalness: 0.25 }),
    bracket: mat(0x7f8c8d, { roughness: 0.35, metalness: 0.7 }),
    steel: mat(0xc8ccd1, { roughness: 0.25, metalness: 0.9 }),
    washer: mat(0x9aa3ab, { roughness: 0.3, metalness: 0.85 }),
    slot: mat(0x1c1c1e, { roughness: 0.6, metalness: 0.1 }),
    screen: mat(0x0e2a3f, { roughness: 0.15, metalness: 0.1, emissive: 0x123a5c, emissiveIntensity: 0.6 }),
    glass: mat(0x8fd3ff, { roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.35 }),
  };
}

export type MaterialTable = ReturnType<typeof createMaterials>;

/** 给硬边零件加一圈暗色描边, 强化 CAD 观感 */
export function addEdges(mesh: THREE.Mesh, color = 0x1f2d3a, opacity = 0.35): THREE.LineSegments {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, 25),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  mesh.add(edges);
  return edges;
}
