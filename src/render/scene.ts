import * as THREE from 'three';
import type { AABB } from '../math/aabb';
import type { LevelDef } from '../math/levels';

export interface SceneBuild {
  group: THREE.Group;
  boxMeshes: Map<string, THREE.Mesh>;
  character: THREE.Group;
  /** 角色朝向标记（小鼻子），用于显示移动方向 */
  facing: THREE.Object3D;
}

const WALL_COLOR = 0x8fa3b8;
const CEILING_COLOR = 0xb08968;
const GROUND_COLOR = 0x4a5560;
const GRID_COLOR = 0x6b7a8a;

function aabbSize(box: AABB): THREE.Vector3 {
  return new THREE.Vector3(
    box.max.x - box.min.x,
    box.max.y - box.min.y,
    box.max.z - box.min.z,
  );
}

function aabbCenter(box: AABB): THREE.Vector3 {
  return new THREE.Vector3(
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2,
  );
}

/** 由纯数据 AABB 生成带边线的盒网格；顶板半透明便于观察低顶碰撞。 */
export function buildBoxMesh(box: AABB): THREE.Mesh {
  const size = aabbSize(box);
  const isGround = box.name === '地面';
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshStandardMaterial({
    color: isGround ? GROUND_COLOR : box.isCeiling ? CEILING_COLOR : WALL_COLOR,
    transparent: !!box.isCeiling,
    opacity: box.isCeiling ? 0.72 : 1,
    roughness: 0.85,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(aabbCenter(box));
  mesh.name = box.name ?? 'box';
  mesh.castShadow = !isGround;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x22303c }),
  );
  mesh.add(edges);
  return mesh;
}

/** 程序化角色：胶囊身体 + 球形头 + 朝向锥，无动画。 */
export function buildCharacter(): { group: THREE.Group; facing: THREE.Object3D } {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe07a5f, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.8, 6, 16), bodyMat);
  body.position.y = 0.85;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xf2cc8f, roughness: 0.5 }),
  );
  head.position.y = 1.55;
  head.castShadow = true;
  group.add(head);

  // 朝向锥（鼻子），指向角色局部 +Z 的反方向即前进朝向 -Z
  const facing = new THREE.Object3D();
  facing.position.y = 1.55;
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a9d8f }),
  );
  nose.rotation.x = -Math.PI / 2; // 锥尖指向 -Z
  nose.position.z = -0.28;
  facing.add(nose);
  group.add(facing);

  return { group, facing };
}

export function buildLevelScene(level: LevelDef): SceneBuild {
  const group = new THREE.Group();
  const boxMeshes = new Map<string, THREE.Mesh>();
  for (const box of level.boxes) {
    const mesh = buildBoxMesh(box);
    group.add(mesh);
    if (box.name) boxMeshes.set(box.name, mesh);
  }

  // 地面网格线，辅助判断空间关系
  const grid = new THREE.GridHelper(36, 36, GRID_COLOR, GRID_COLOR);
  (grid.material as THREE.Material).opacity = 0.35;
  (grid.material as THREE.Material).transparent = true;
  grid.position.y = 0.01;
  group.add(grid);

  const { group: character, facing } = buildCharacter();
  group.add(character);

  return { group, boxMeshes, character, facing };
}
