import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BONE_NAMES, BONE_SPECS, getBoneSpec, getChildren, type BoneSpec } from '../core/skeleton';
import type { BoneName } from '../core/types';

/**
 * 程序化角色：一副真正的层级 THREE.Bone 骨架 + 单个 SkinnedMesh 蒙皮。
 *
 * 蒙皮做法（无任何外部模型）：
 * - 为每个关节生成一段沿“父→子”方向的胶囊几何，在静息世界空间建模；
 * - 顶点写入 skinIndex/skinWeight，关节附近的顶点在相邻两骨间平滑分配权重，
 *   因此关节弯曲时网格是连续变形的，而不是若干独立刚体；
 * - 用骨架静息逆矩阵绑定（bindMatrix），SkinnedMesh 按层级骨骼变换驱动。
 */
export interface ProceduralCharacter {
  root: THREE.Group;
  bones: Map<BoneName, THREE.Bone>;
  skinnedMesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  /** 每个关节的不可见拾取球（用于点击选择） */
  pickMeshes: Map<BoneName, THREE.Mesh>;
}

interface SkinnedPart {
  geometry: THREE.BufferGeometry;
  boneIndex: number;
  /** 混合权重：非空时顶点权重在 boneIndex 与 secondBoneIndex 间按段分配 */
  secondBoneIndex?: number;
}

const REST_Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** 计算某关节在静息姿态下的世界矩阵（沿骨架层级累乘） */
function restWorldMatrix(name: BoneName, cache: Map<BoneName, THREE.Matrix4>): THREE.Matrix4 {
  const cached = cache.get(name);
  if (cached) return cached;
  const spec = getBoneSpec(name);
  const local = new THREE.Matrix4().makeTranslation(spec.restPosition.x, spec.restPosition.y, spec.restPosition.z);
  const world = spec.parent ? restWorldMatrix(spec.parent, cache).clone().multiply(local) : local.clone();
  cache.set(name, world);
  return world;
}

/**
 * 生成连接 parent→child 骨骼的胶囊段，在静息世界空间中定位。
 * 沿段方向的顶点权重从 parent 渐变到 child，保证肘部/膝部弯曲时平滑。
 */
function makeLimbSegment(
  parentName: BoneName,
  childName: BoneName,
  radius: number,
  restCache: Map<BoneName, THREE.Matrix4>,
  indexOf: (n: BoneName) => number,
): SkinnedPart {
  const pWorld = new THREE.Vector3().setFromMatrixPosition(restWorldMatrix(parentName, restCache));
  const cWorld = new THREE.Vector3().setFromMatrixPosition(restWorldMatrix(childName, restCache));
  const dir = new THREE.Vector3().subVectors(cWorld, pWorld);
  const len = dir.length();

  const geo = new THREE.CapsuleGeometry(radius, Math.max(len - radius * 2, 0.02), 6, 12);
  // CapsuleGeometry 默认沿 Y 轴；平移到段中点并旋转对齐父→子方向
  const mid = new THREE.Vector3().addVectors(pWorld, cWorld).multiplyScalar(0.5);
  _q.setFromUnitVectors(REST_Y, dir.clone().normalize());
  _m.compose(mid, _q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(_m);

  // 按顶点在段上的高度分配两骨权重
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  const pi = indexOf(parentName);
  const ci = indexOf(childName);
  for (let i = 0; i < count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const t = THREE.MathUtils.clamp(new THREE.Vector3(vx, vy, vz).sub(pWorld).dot(dir) / (len * len), 0, 1);
    indices[i * 4] = pi;
    indices[i * 4 + 1] = ci;
    weights[i * 4] = 1 - t;
    weights[i * 4 + 1] = t;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  return { geometry: geo, boneIndex: pi, secondBoneIndex: ci };
}

/** 单骨刚体部件（头、手、脚、躯干盒等），全部顶点 100% 归属于一根骨 */
function makeRigidPart(
  boneName: BoneName,
  geometry: THREE.BufferGeometry,
  restCache: Map<BoneName, THREE.Matrix4>,
  indexOf: (n: BoneName) => number,
): SkinnedPart {
  const world = restWorldMatrix(boneName, restCache);
  geometry.applyMatrix4(world);
  const count = geometry.attributes.position.count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  const bi = indexOf(boneName);
  for (let i = 0; i < count; i++) {
    indices[i * 4] = bi;
    weights[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  return { geometry, boneIndex: bi };
}

/** 躯干用沿 Y 的胶囊（跨 spine/chest，统一归属 chest，躯干形变主要来自脊柱旋转） */
function makeTorsoPart(restCache: Map<BoneName, THREE.Matrix4>, indexOf: (n: BoneName) => number): SkinnedPart {
  const hipsWorld = new THREE.Vector3().setFromMatrixPosition(restWorldMatrix('hips', restCache));
  const chestWorld = new THREE.Vector3().setFromMatrixPosition(restWorldMatrix('chest', restCache));
  const mid = new THREE.Vector3().addVectors(hipsWorld, chestWorld).multiplyScalar(0.5);
  const len = chestWorld.y - hipsWorld.y;
  const geo = new THREE.CapsuleGeometry(0.105, Math.max(len - 0.12, 0.05), 8, 14);
  _m.compose(mid, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(_m);
  return makeRigidPart('chest', geo, restCache, indexOf);
}

/** 髋部盒体 */
function makeHipsPart(restCache: Map<BoneName, THREE.Matrix4>, indexOf: (n: BoneName) => number): SkinnedPart {
  const geo = new THREE.CapsuleGeometry(0.095, 0.1, 6, 12);
  return makeRigidPart('hips', geo, restCache, indexOf);
}

function buildSkinnedGeometry(restCache: Map<BoneName, THREE.Matrix4>): THREE.BufferGeometry {
  const indexOf = (n: BoneName) => BONE_NAMES.indexOf(n);
  const parts: SkinnedPart[] = [];

  // 肢体段：每个有子关节的骨，沿每条父子边生成胶囊
  for (const spec of BONE_SPECS as BoneSpec[]) {
    for (const childName of getChildren(spec.name)) {
      const childSpec = getBoneSpec(childName);
      // 头/手/脚用独立刚体部件，不生成细胶囊
      if (childName === 'head' || childName === 'hand_l' || childName === 'hand_r' || childName === 'foot_l' || childName === 'foot_r') {
        continue;
      }
      const radius = Math.min(spec.radius, childSpec.radius) + 0.004;
      parts.push(makeLimbSegment(spec.name, childName, radius, restCache, indexOf));
    }
  }

  // 躯干与髋
  parts.push(makeTorsoPart(restCache, indexOf));
  parts.push(makeHipsPart(restCache, indexOf));

  // 头、手、脚
  parts.push(makeRigidPart('head', new THREE.SphereGeometry(0.088, 16, 12), restCache, indexOf));
  for (const hand of ['hand_l', 'hand_r'] as BoneName[]) {
    const g = new THREE.SphereGeometry(0.04, 10, 8);
    g.scale(0.8, 1.15, 0.8);
    parts.push(makeRigidPart(hand, g, restCache, indexOf));
  }
  for (const foot of ['foot_l', 'foot_r'] as BoneName[]) {
    const g = new THREE.BoxGeometry(0.075, 0.05, 0.16);
    g.translate(0, -0.015, 0.055);
    parts.push(makeRigidPart(foot, g, restCache, indexOf));
  }

  const merged = mergeGeometries(parts.map((p) => p.geometry), false);
  if (!merged) throw new Error('蒙皮几何合并失败');
  merged.computeVertexNormals();
  return merged;
}

export function createCharacter(): ProceduralCharacter {
  // 角色根组：根位移作用在这一层（applyPose 移动 root.position.z）
  const root = new THREE.Group();
  root.name = 'character-root';

  // SkinnedMesh 固定在角色组原点（identity），使骨架局部空间 == 几何建模空间，
  // 这是 Three.js 蒙皮的标准绑定方式，可避免双重变换。
  const skinnedMesh = new THREE.SkinnedMesh();
  skinnedMesh.name = 'character-skinned';
  root.add(skinnedMesh);

  // 1) 构建层级 Bone 树，根骨挂在 SkinnedMesh 下
  const bones = new Map<BoneName, THREE.Bone>();
  for (const name of BONE_NAMES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bones.set(name, bone);
  }
  for (const spec of BONE_SPECS) {
    const bone = bones.get(spec.name)!;
    bone.position.copy(spec.restPosition);
    if (spec.parent) {
      bones.get(spec.parent)!.add(bone);
    } else {
      skinnedMesh.add(bone);
    }
  }

  // 2) 静息世界矩阵缓存 & 蒙皮几何（几何建在骨架静息空间，与 boneInverses 同空间）
  const restCache = new Map<BoneName, THREE.Matrix4>();
  for (const name of BONE_NAMES) restWorldMatrix(name, restCache);
  const geometry = buildSkinnedGeometry(restCache);
  skinnedMesh.geometry = geometry;
  skinnedMesh.material = new THREE.MeshStandardMaterial({
    color: 0x6fb1e6,
    roughness: 0.55,
    metalness: 0.08,
  });
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;

  // 3) 骨架绑定：此时各 Bone 的世界矩阵即静息矩阵，
  // calculateInverses 得到的 boneInverses 与几何建模空间一致
  const skeleton = new THREE.Skeleton(BONE_NAMES.map((n) => bones.get(n)!));
  skinnedMesh.bind(skeleton);
  skinnedMesh.frustumCulled = false;

  // 4) 关节拾取球（不可见，但可被射线检测）
  const pickMeshes = new Map<BoneName, THREE.Mesh>();
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const name of BONE_NAMES) {
    const pick = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), pickMat);
    pick.name = `pick-${name}`;
    pick.userData.boneName = name;
    bones.get(name)!.add(pick);
    pickMeshes.set(name, pick);
  }

  return { root, bones, skinnedMesh, skeleton, pickMeshes };
}
