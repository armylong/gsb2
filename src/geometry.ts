import * as THREE from 'three';
import type { Fragment } from './blend';
import type { Preset, SurfaceParams, OccluderParams } from './presets';
import { hexToRgb } from './presets';

export interface SceneMeshes {
  transparent: THREE.Mesh[];
  occluder: THREE.Mesh | null;
  /** 参数表,id -> 参数(颜色/透明度以参数为准,而非材质) */
  surfaceParams: Map<string, SurfaceParams>;
  occluderParams: OccluderParams | null;
}

/**
 * 检查点解析:从相机过 NDC 点构造世界空间射线,对场景网格做射线求交,
 * 返回该像素(子像素中心)涉及的全部片元,含相机空间深度与当前参数颜色。
 *
 * 这是与 GPU 光栅化相互独立的一条解析路径,因此可以作为预期值来源;
 * 测试用例也直接调用它验证几何前后关系。
 */
export function evaluateRay(
  camera: THREE.PerspectiveCamera,
  meshes: SceneMeshes,
  ndcX: number,
  ndcY: number,
): Fragment[] {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

  const targets: THREE.Mesh[] = [...meshes.transparent];
  if (meshes.occluder) targets.push(meshes.occluder);

  const hits = raycaster.intersectObjects(targets, false);

  // DoubleSide 平面的正反两面各产生一个交点;同一网格只保留最近的那个
  const nearestById = new Map<string, THREE.Intersection>();
  for (const hit of hits) {
    const id = hit.object.name;
    const prev = nearestById.get(id);
    if (!prev || hit.distance < prev.distance) nearestById.set(id, hit);
  }

  const fragments: Fragment[] = [];
  for (const hit of nearestById.values()) {
    const mesh = hit.object as THREE.Mesh;
    const id = mesh.name;
    const viewPoint = hit.point.clone().applyMatrix4(camera.matrixWorldInverse);
    // 相机空间中可见点的 z 为负,取 -z 作为"离相机距离":值越大越远
    const depth = -viewPoint.z;

    const sp = meshes.surfaceParams.get(id);
    if (sp) {
      fragments.push({
        id,
        name: sp.name,
        color: hexToRgb(sp.color),
        alpha: sp.opacity,
        depth,
        opaque: false,
      });
      continue;
    }
    if (meshes.occluderParams && id === meshes.occluderParams.id) {
      const op = meshes.occluderParams;
      fragments.push({
        id,
        name: op.name,
        color: hexToRgb(op.color),
        alpha: 1,
        depth,
        opaque: true,
      });
    }
  }
  return fragments;
}

/** 由预设参数同步网格的变换与材质(参数被面板修改后调用) */
export function syncMeshesToParams(preset: Preset, meshes: SceneMeshes): void {
  for (const mesh of meshes.transparent) {
    const p = preset.surfaces.find((s) => s.id === mesh.name);
    if (!p) continue;
    mesh.position.set(...p.position);
    mesh.rotation.set(...p.rotation);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.setHex(p.color);
    mat.opacity = p.opacity;
    mesh.updateMatrixWorld(true);
  }
  if (meshes.occluder && preset.occluder) {
    const p = preset.occluder;
    meshes.occluder.position.set(...p.position);
    meshes.occluder.rotation.set(...p.rotation);
    meshes.occluder.updateMatrixWorld(true);
  }
}

export function buildMeshes(preset: Preset): SceneMeshes {
  const transparent = preset.surfaces.map((s) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(s.size[0], s.size[1]),
      new THREE.MeshBasicMaterial({
        color: s.color,
        opacity: s.opacity,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    mesh.name = s.id;
    mesh.position.set(...s.position);
    mesh.rotation.set(...s.rotation);
    return mesh;
  });

  let occluder: THREE.Mesh | null = null;
  if (preset.occluder) {
    const p = preset.occluder;
    occluder = new THREE.Mesh(
      new THREE.PlaneGeometry(p.size[0], p.size[1]),
      new THREE.MeshBasicMaterial({
        color: p.color,
        transparent: false,
        side: THREE.DoubleSide,
        depthWrite: true,
      }),
    );
    occluder.name = p.id;
    occluder.position.set(...p.position);
    occluder.rotation.set(...p.rotation);
  }

  const surfaceParams = new Map(preset.surfaces.map((s) => [s.id, s]));
  return {
    transparent,
    occluder,
    surfaceParams,
    occluderParams: preset.occluder ?? null,
  };
}
