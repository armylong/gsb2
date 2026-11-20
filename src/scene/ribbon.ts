/**
 * 程序化生成带状网格 + 三节骨骼链 + 蒙皮绑定。
 *
 * 带沿 +X 方向,宽度沿 Z,厚度通过双层顶点表现为一个扁平条带;
 * 骨骼沿 X 轴等分,每个骨骼以关节为旋转中心(旋转姿态互相独立)。
 */

import * as THREE from 'three';

export interface RibbonBuildResult {
  geometry: THREE.BufferGeometry;
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  bones: THREE.Bone[];
  /** 每个顶点的绑定姿态 X 坐标(权重预设按它计算),长度 = 顶点数 */
  bindXs: Float32Array;
  /** 关节世界坐标(绑定姿态下),用于拾取与可视化 */
  jointPositions: THREE.Vector3[];
  vertexCount: number;
  length: number;
}

export interface RibbonOptions {
  /** 带总长(X 方向) */
  length?: number;
  /** 带宽(Z 方向) */
  width?: number;
  /** 沿长度方向的分段数 */
  segmentsX?: number;
  /** 沿宽度方向的分段数 */
  segmentsZ?: number;
}

export function buildRibbon(options: RibbonOptions = {}): RibbonBuildResult {
  const length = options.length ?? 6;
  const width = options.width ?? 0.8;
  const segmentsX = options.segmentsX ?? 48;
  const segmentsZ = options.segmentsZ ?? 2;

  // ---- 几何:规则栅格,顶点索引 v = ix * (segmentsZ + 1) + iz ----
  const vertsX = segmentsX + 1;
  const vertsZ = segmentsZ + 1;
  const vertexCount = vertsX * vertsZ;

  const positions = new Float32Array(vertexCount * 3);
  const bindXs = new Float32Array(vertexCount);
  const skinIndex = new Float32Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);

  let v = 0;
  for (let ix = 0; ix < vertsX; ix++) {
    const x = (ix / segmentsX) * length;
    for (let iz = 0; iz < vertsZ; iz++) {
      const z = (iz / segmentsZ - 0.5) * width;
      positions[v * 3 + 0] = x;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = z;
      bindXs[v] = x;
      // 蒙皮属性先给占位值,权重由 WeightModel 同步进来
      skinIndex[v * 4 + 0] = 0;
      skinIndex[v * 4 + 1] = 1;
      skinIndex[v * 4 + 2] = 2;
      skinIndex[v * 4 + 3] = 0;
      skinWeight[v * 4 + 0] = 1;
      v++;
    }
  }

  const indices: number[] = [];
  for (let ix = 0; ix < segmentsX; ix++) {
    for (let iz = 0; iz < segmentsZ; iz++) {
      const a = ix * vertsZ + iz;
      const b = (ix + 1) * vertsZ + iz;
      const c = (ix + 1) * vertsZ + iz + 1;
      const d = ix * vertsZ + iz + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // ---- 三节骨骼:bone0 原点起步,每节长度 length/3,沿 +X ----
  const segLen = length / 3;
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < 3; i++) {
    const bone = new THREE.Bone();
    bone.name = `bone_${i}`;
    bone.position.set(i === 0 ? 0 : segLen, 0, 0);
    bones.push(bone);
  }
  bones[0].add(bones[1]);
  bones[1].add(bones[2]);

  const skeleton = new THREE.Skeleton(bones);
  const jointPositions = bones.map((b) => b.position.clone());

  const material = new THREE.MeshStandardMaterial({
    color: 0x9fb4c8,
    metalness: 0.1,
    roughness: 0.55,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(bones[0]);
  mesh.bind(skeleton);
  mesh.castShadow = false;

  return {
    geometry,
    mesh,
    skeleton,
    bones,
    bindXs,
    jointPositions,
    vertexCount,
    length,
  };
}

/** 把 WeightModel 的扁平权重写回几何的 skinWeight 属性(第 4 槽始终为 0) */
export function syncSkinWeights(geometry: THREE.BufferGeometry, data: Float32Array, vertexCount: number): void {
  const attr = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  for (let i = 0; i < vertexCount; i++) {
    attr.setXYZW(
      i,
      data[i * 3 + 0],
      data[i * 3 + 1],
      data[i * 3 + 2],
      0,
    );
  }
  attr.needsUpdate = true;
}
