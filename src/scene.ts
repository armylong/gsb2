import * as THREE from 'three';
import { OBJECT_COLORS } from './colors';
import type { SceneObject } from './types';

let nextId = 1;

function makeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#b9c4d4'),
    roughness: 0.55,
    metalness: 0.12,
  });
}

function register(group: THREE.Group, meshes: THREE.Mesh[], name: string): SceneObject {
  const id = nextId++;
  const obj: SceneObject = {
    id,
    name,
    group,
    meshes,
    color: OBJECT_COLORS[id - 1],
    hidden: false,
  };
  for (const m of meshes) {
    m.userData.pickId = id;
    m.castShadow = false;
    m.receiveShadow = false;
  }
  return obj;
}

function single(geometry: THREE.BufferGeometry, name: string): SceneObject {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, makeMaterial());
  group.add(mesh);
  return register(group, [mesh], name);
}

/** L 形凹组合物：两个盒子垂直相接（子网格接缝在描边时不应产生多余边线）。 */
function makeLShape(): SceneObject {
  const group = new THREE.Group();
  const mat = makeMaterial();
  const horizontal = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.8), mat);
  horizontal.position.set(-0.3, -0.35, 0);
  const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.3, 0.8), mat);
  vertical.position.set(0.25, 0.55, 0);
  group.add(horizontal, vertical);
  return register(group, [horizontal, vertical], 'L 形凹组合物');
}

/** U 形凹组合物：底板 + 两侧立板，三个子网格。 */
function makeUShape(): SceneObject {
  const group = new THREE.Group();
  const mat = makeMaterial();
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.4, 0.9), mat);
  bottom.position.y = -0.7;
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.4, 0.9), mat);
  left.position.set(-0.65, 0.2, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.4, 0.9), mat);
  right.position.set(0.65, 0.2, 0);
  group.add(bottom, left, right);
  return register(group, [bottom, left, right], 'U 形凹组合物');
}

/** 哑铃组合物：两端球体 + 连接圆柱，三个子网格。 */
function makeDumbbell(): SceneObject {
  const group = new THREE.Group();
  const mat = makeMaterial();
  const ballGeo = new THREE.SphereGeometry(0.48, 40, 24);
  const ballL = new THREE.Mesh(ballGeo, mat);
  ballL.position.x = -0.85;
  const ballR = new THREE.Mesh(ballGeo.clone(), mat);
  ballR.position.x = 0.85;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 24), mat);
  rod.rotation.z = Math.PI / 2;
  group.add(ballL, ballR, rod);
  return register(group, [ballL, ballR, rod], '哑铃组合物');
}

/** 带孔环（挤出成型的单网格凹形对象，内孔是真实凹口，应保留轮廓）。 */
function makeRing(): SceneObject {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 0.75, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.34, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.32,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 3,
    curveSegments: 48,
  });
  geometry.center();
  return single(geometry, '带孔环（凹形）');
}

export interface BuiltScene {
  objects: SceneObject[];
  occluder: THREE.Mesh;
}

/** 构建全部逻辑对象（共 10 个：9 个可选 + 1 个不透明挡板，不超过 12）。 */
export function buildSceneObjects(): BuiltScene {
  const objects: SceneObject[] = [
    single(new THREE.SphereGeometry(0.85, 48, 32), '球体（光滑曲面）'),
    single(new THREE.TorusGeometry(0.62, 0.24, 32, 64), '圆环体（曲面）'),
    single(new THREE.CylinderGeometry(0.55, 0.65, 1.5, 40), '圆台体（曲面）'),
    single(new THREE.TorusKnotGeometry(0.48, 0.16, 128, 20), '纽结（光滑曲面）'),
    single(new THREE.CapsuleGeometry(0.45, 0.9, 12, 24), '胶囊体（曲面）'),
    makeRing(),
    makeLShape(),
    makeUShape(),
    makeDumbbell(),
  ];

  const occluder = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 3.2, 0.18),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#8d6e63'),
      roughness: 0.8,
      metalness: 0.05,
      // 全不透明挡板：被其覆盖的对象只能通过遮挡虚线轮廓观察
    }),
  );
  occluder.name = '不透明挡板';
  occluder.userData.pickId = -1; // 挡板不可选
  occluder.position.set(0, 1.1, 0);

  return { objects, occluder };
}
