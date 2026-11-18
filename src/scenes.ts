import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  Group,
  Color,
  DirectionalLight,
  AmbientLight,
  HemisphereLight,
} from 'three';
import type { SceneId } from './types';

/**
 * 程序化生成三组场景，每组物体数 <= 30。
 * 仅使用简单固定光照（环境光 + 半球光 + 一个方向光，无实时阴影），
 * 材质为中性色 MeshStandardMaterial，避免花哨颜色干扰暗部判断。
 */

const MAT_GROUND = new MeshStandardMaterial({ color: new Color('#c9ccd4'), roughness: 0.95, metalness: 0 });
const MAT_WALL = new MeshStandardMaterial({ color: new Color('#b9bec9'), roughness: 0.95, metalness: 0 });
const MAT_OBJ = new MeshStandardMaterial({ color: new Color('#8f9bb3'), roughness: 0.85, metalness: 0 });
const MAT_OBJ2 = new MeshStandardMaterial({ color: new Color('#a88f7a'), roughness: 0.9, metalness: 0 });

export interface BuiltScene {
  group: Group;
  objectCount: number;
  /** 返回悬空球（供 gap 调节与验证使用），没有则为 null */
  getSphere: () => Mesh | null;
}

/** 固定光照，三个场景一致，保证“只改 SSAO、不改灯光”的对照 */
function addFixedLights(group: Group): void {
  group.add(new AmbientLight(0xffffff, 0.55));
  const hemi = new HemisphereLight(0xffffff, 0x8a8f99, 0.45);
  hemi.position.set(0, 10, 0);
  group.add(hemi);
  const dir = new DirectionalLight(0xffffff, 1.15);
  dir.position.set(5, 9, 6);
  group.add(dir);
}

function makeGround(size = 24): Mesh {
  const geo = new PlaneGeometry(size, size);
  const mesh = new Mesh(geo, MAT_GROUND);
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'ground';
  return mesh;
}

/** 场景 1：墙角 —— 地面 + 两面墙 + 若干靠墙物体，重点观察内角接触线 */
function buildCorner(): BuiltScene {
  const group = new Group();
  addFixedLights(group);
  let count = 0;

  const ground = makeGround(20);
  group.add(ground);
  count++;

  const wallGeo = new BoxGeometry(10, 6, 0.4);
  const back = new Mesh(wallGeo, MAT_WALL);
  back.position.set(0, 3, -4.8);
  back.name = 'wallBack';
  group.add(back);
  count++;

  const side = new Mesh(wallGeo, MAT_OBJ2);
  side.rotation.y = Math.PI / 2;
  side.position.set(-4.8, 3, 0);
  side.name = 'wallSide';
  group.add(side);
  count++;

  // 靠墙角摆放的方块，制造内角与堆叠缝隙
  const boxGeo = new BoxGeometry(1.4, 1.4, 1.4);
  const spots: Array<[number, number, number]> = [
    [-3.4, 0.7, -3.4],
    [-1.7, 0.7, -3.6],
    [-3.6, 0.7, -1.6],
    [-3.4, 2.1, -3.4],
    [-1.6, 2.1, -3.5],
  ];
  for (const [x, y, z] of spots) {
    const m = new Mesh(boxGeo, MAT_OBJ);
    m.position.set(x, y, z);
    group.add(m);
    count++;
  }

  const cyl = new Mesh(new CylinderGeometry(0.6, 0.6, 1.6, 24), MAT_OBJ2);
  cyl.position.set(-0.8, 0.8, -2.6);
  group.add(cyl);
  count++;

  const pillar = new Mesh(new BoxGeometry(0.9, 2.4, 0.9), MAT_OBJ);
  pillar.position.set(-4.2, 1.2, 0.4);
  group.add(pillar);
  count++;

  return { group, objectCount: count, getSphere: () => null };
}

/** 场景 2：悬空球 —— 地面上一个球，gap 控制球与地面间距，专门看接触区随间距变化 */
function buildSphere(): BuiltScene {
  const group = new Group();
  addFixedLights(group);
  let count = 0;

  const ground = makeGround(24);
  group.add(ground);
  count++;

  const radius = 1.2;
  const sphere = new Mesh(new SphereGeometry(radius, 48, 32), MAT_OBJ);
  sphere.name = 'floatingSphere';
  sphere.userData.radius = radius;
  group.add(sphere);
  count++;

  // 远处两个参照方块，确认无遮挡平面保持原亮度
  const refGeo = new BoxGeometry(1, 1, 1);
  const r1 = new Mesh(refGeo, MAT_OBJ2);
  r1.position.set(3.4, 0.5, 2.6);
  group.add(r1);
  count++;
  const r2 = new Mesh(refGeo, MAT_OBJ);
  r2.position.set(-3.2, 0.5, -2.2);
  group.add(r2);
  count++;

  return {
    group,
    objectCount: count,
    getSphere: () => sphere,
  };
}

/** 场景 3：密排方块 —— 5x5 矮方块阵列，缝隙密集，共 25 + 地面 = 26 个 */
function buildCubes(): BuiltScene {
  const group = new Group();
  addFixedLights(group);
  let count = 0;

  const ground = makeGround(24);
  group.add(ground);
  count++;

  const geo = new BoxGeometry(0.85, 0.9, 0.85);
  const n = 5;
  const spacing = 1.15;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const mat = (i + j) % 2 === 0 ? MAT_OBJ : MAT_OBJ2;
      const m = new Mesh(geo, mat);
      m.position.set((i - (n - 1) / 2) * spacing, 0.45, (j - (n - 1) / 2) * spacing);
      group.add(m);
      count++;
    }
  }

  return { group, objectCount: count, getSphere: () => null };
}

export function buildScene(id: SceneId): BuiltScene {
  switch (id) {
    case 'corner':
      return buildCorner();
    case 'sphere':
      return buildSphere();
    case 'cubes':
      return buildCubes();
  }
}
