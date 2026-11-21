import {
  Box3,
  BoxGeometry,
  ConeGeometry,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  Sphere,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';

export interface MeshEntity {
  id: string;
  mesh: Mesh;
  material: MeshStandardMaterial;
  /** 每帧根据当前 worldMatrix 重算，变换后实时更新。 */
  worldSphere: Sphere;
  worldBox: Box3;
  /** 固定路径用的初始局部变换。 */
  baseLocalPosition: Vector3;
  baseLocalRotation: Euler;
}

export interface GroupEntity {
  id: string;
  label: string;
  group: Group;
  members: MeshEntity[];
  /** 组合包围体，成员变换后重算。 */
  worldSphere: Sphere;
  worldBox: Box3;
  basePosition: Vector3;
}

export interface SampleScene {
  root: Group;
  groups: GroupEntity[];
  meshes: MeshEntity[];
  seed: number;
}

/** 可复现的伪随机数（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GEOMETRY_KINDS = ['box', 'sphere', 'cone', 'octa', 'torus'] as const;
type GeometryKind = (typeof GEOMETRY_KINDS)[number];

function makeGeometry(kind: GeometryKind, rng: () => number): {
  geometry: BoxGeometry | SphereGeometry | ConeGeometry | OctahedronGeometry | TorusGeometry;
} {
  const s = 0.55 + rng() * 0.5;
  switch (kind) {
    case 'box':
      return { geometry: new BoxGeometry(s, s * (0.8 + rng() * 0.6), s) };
    case 'sphere':
      return { geometry: new SphereGeometry(s * 0.75, 20, 14) };
    case 'cone':
      return { geometry: new ConeGeometry(s * 0.7, s * 1.5, 18) };
    case 'octa':
      return { geometry: new OctahedronGeometry(s * 0.8) };
    case 'torus':
      return { geometry: new TorusGeometry(s * 0.6, s * 0.22, 12, 24) };
  }
}

/** 六组摆件：覆盖完全可见、边界交叉、完全出界、超远距等情形。 */
const GROUP_LAYOUT: { id: string; label: string; position: [number, number, number] }[] = [
  { id: 'G1', label: '组1 视锥中心', position: [0, 0, -12] },
  { id: 'G2', label: '组2 右边界', position: [9.5, 2, -14] },
  { id: 'G3', label: '组3 左边界', position: [-9.5, -2, -16] },
  { id: 'G4', label: '组4 上边界', position: [4, 6.5, -20] },
  { id: 'G5', label: '组5 下/远边界', position: [-4, -7, -26] },
  { id: 'G6', label: '组6 远平面之外', position: [0, 0, -44] },
];

export const SCENE_SEED = 14373;
export const MEMBERS_PER_GROUP = 4;

export function buildSampleScene(seed: number = SCENE_SEED): SampleScene {
  const rng = mulberry32(seed);
  const root = new Group();
  root.name = 'sample-root';

  const groups: GroupEntity[] = [];
  const meshes: MeshEntity[] = [];

  GROUP_LAYOUT.forEach((layout, gi) => {
    const group = new Group();
    group.name = layout.id;
    const basePosition = new Vector3(...layout.position);
    group.position.copy(basePosition);
    root.add(group);

    const members: MeshEntity[] = [];
    const hue = gi / GROUP_LAYOUT.length;
    for (let mi = 0; mi < MEMBERS_PER_GROUP; mi++) {
      const kind = GEOMETRY_KINDS[(gi + mi) % GEOMETRY_KINDS.length];
      const { geometry } = makeGeometry(kind, rng);
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();

      const material = new MeshStandardMaterial({
        roughness: 0.55,
        metalness: 0.15,
      });
      // HSL 取色，同组同色系，便于在总览相机里辨认归属。
      material.color.setHSL(hue, 0.55, 0.45 + rng() * 0.15);

      const mesh = new Mesh(geometry, material);
      mesh.name = `${layout.id}-M${mi + 1}`;
      const angle = (mi / MEMBERS_PER_GROUP) * Math.PI * 2 + rng() * 0.5;
      const radius = 1.1 + rng() * 1.4;
      const baseLocalPosition = new Vector3(
        Math.cos(angle) * radius,
        (rng() - 0.5) * 2.2,
        Math.sin(angle) * radius,
      );
      mesh.position.copy(baseLocalPosition);
      const baseLocalRotation = new Euler(
        rng() * Math.PI,
        rng() * Math.PI,
        rng() * Math.PI,
      );
      mesh.rotation.copy(baseLocalRotation);
      mesh.userData.entityId = mesh.name;

      group.add(mesh);
      const entity: MeshEntity = {
        id: mesh.name,
        mesh,
        material,
        worldSphere: new Sphere(),
        worldBox: new Box3(),
        baseLocalPosition,
        baseLocalRotation,
      };
      members.push(entity);
      meshes.push(entity);
    }

    groups.push({
      id: layout.id,
      label: layout.label,
      group,
      members,
      worldSphere: new Sphere(),
      worldBox: new Box3(),
      basePosition,
    });
  });

  const scene: SampleScene = { root, groups, meshes, seed };
  root.updateMatrixWorld(true);
  updateWorldBounds(scene);
  return scene;
}

const _box = new Box3();
const _sphere = new Sphere();

/**
 * 重新计算所有实体的世界空间包围体。
 * TransformControls / 固定路径改变任何变换后都必须调用，保证边界交叉对象不漏判。
 */
export function updateWorldBounds(scene: SampleScene): void {
  scene.root.updateMatrixWorld(true);
  for (const entity of scene.meshes) {
    const { geometry, matrixWorld } = entity.mesh;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    entity.worldSphere.copy(geometry.boundingSphere as Sphere).applyMatrix4(matrixWorld);
    _box.copy(geometry.boundingBox as Box3).applyMatrix4(matrixWorld);
    entity.worldBox.copy(_box);
  }
  for (const groupEntity of scene.groups) {
    groupEntity.worldBox.makeEmpty();
    for (const member of groupEntity.members) {
      groupEntity.worldBox.union(member.worldBox);
    }
    groupEntity.worldBox.getCenter(_sphere.center);
    let radius = 0;
    for (const member of groupEntity.members) {
      radius = Math.max(
        radius,
        _sphere.center.distanceTo(member.worldSphere.center) + member.worldSphere.radius,
      );
    }
    _sphere.radius = radius;
    groupEntity.worldSphere.copy(_sphere);
  }
}
