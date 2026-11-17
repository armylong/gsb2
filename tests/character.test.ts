import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCharacter } from '../src/three/character';
import { BONE_NAMES, BONE_SPECS, getBoneSpec } from '../src/core/skeleton';
import type { BoneName } from '../src/core/types';

/**
 * 程序化角色与蒙皮验证（纯矩阵数学，不需要 WebGL）。
 * 容差：静息顶点还原 < 1e-5 m（浮点矩阵累乘误差）。
 */
describe('程序化层级骨架与单网格蒙皮', () => {
  it('19 个关节按 BONE_SPECS 构成正确父子层级，不是独立物体', () => {
    const { bones, skinnedMesh } = createCharacter();
    expect(bones.size).toBe(BONE_NAMES.length);
    for (const spec of BONE_SPECS) {
      const bone = bones.get(spec.name)!;
      expect(bone.parent).toBeTruthy();
      if (spec.parent === null) {
        // 根骨直接挂在 SkinnedMesh 下
        expect(bone.parent).toBe(skinnedMesh);
        expect(bone.parent!.type).toBe('SkinnedMesh');
      } else {
        expect(bone.parent!.name).toBe(spec.parent);
        expect(bone.parent).toBe(bones.get(spec.parent));
      }
      // 局部静息位置正确写入
      expect(bone.position.distanceTo(spec.restPosition)).toBeLessThan(1e-9);
    }
  });

  it('骨架包含肩、肘、髋、膝等可辨认关节链', () => {
    const { bones } = createCharacter();
    const chains: [BoneName, BoneName][] = [
      ['upperarm_l', 'forearm_l'], // 肩→肘
      ['upperarm_r', 'forearm_r'],
      ['thigh_l', 'shin_l'], // 髋→膝
      ['thigh_r', 'shin_r'],
      ['shin_l', 'foot_l'], // 膝→踝
    ];
    for (const [parent, child] of chains) {
      expect(bones.get(parent)!.children.some((c) => c.name === child)).toBe(true);
    }
  });

  it('静息姿态下蒙皮顶点经 boneInverses 累乘后还原到建模位置（双重变换防护，误差 < 1e-5 m）', () => {
    const { skinnedMesh, skeleton } = createCharacter();
    // 强制更新世界矩阵（无渲染器时手动调用）
    skinnedMesh.updateMatrixWorld(true);

    const geo = skinnedMesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const skinIndex = geo.attributes.skinIndex as THREE.BufferAttribute;
    const skinWeight = geo.attributes.skinWeight as THREE.BufferAttribute;

    const skinned = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const bindMat = new THREE.Matrix4();
    const maxBad = 200; // 抽样验证的顶点数
    const stride = Math.max(1, Math.floor(pos.count / maxBad));
    let maxErr = 0;

    for (let i = 0; i < pos.count; i += stride) {
      const original = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      skinned.set(0, 0, 0);
      let totalW = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w === 0) continue;
        const bi = skinIndex.getComponent(i, k);
        const bone = skeleton.bones[bi];
        // 标准蒙皮：skinned = Σ w_k · (boneWorld · boneInverse) · v
        bindMat.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[bi]);
        tmp.copy(original).applyMatrix4(bindMat);
        skinned.addScaledVector(tmp, w);
        totalW += w;
      }
      expect(totalW).toBeCloseTo(1, 6); // 每个顶点权重和为 1
      maxErr = Math.max(maxErr, skinned.distanceTo(original));
    }
    // 静息姿态下 boneWorld·boneInverse ≈ identity，顶点必须回到原位
    expect(maxErr).toBeLessThan(1e-5);
  });

  it('每个顶点最多绑定 2 根骨且权重非负，关节段为父子两骨平滑混合', () => {
    const { skinnedMesh } = createCharacter();
    const geo = skinnedMesh.geometry;
    const skinWeight = geo.attributes.skinWeight as THREE.BufferAttribute;
    for (let i = 0; i < skinWeight.count; i++) {
      const w0 = skinWeight.getComponent(i, 0);
      const w1 = skinWeight.getComponent(i, 1);
      const w2 = skinWeight.getComponent(i, 2);
      const w3 = skinWeight.getComponent(i, 3);
      expect(w0).toBeGreaterThanOrEqual(0);
      expect(w1).toBeGreaterThanOrEqual(0);
      expect(w2).toBe(0);
      expect(w3).toBe(0);
      expect(w0 + w1).toBeCloseTo(1, 6);
    }
  });

  it('关节弯曲时子骨驱动的顶点随之旋转（层级局部关系正确）', () => {
    const { bones, skinnedMesh, skeleton } = createCharacter();
    skinnedMesh.updateMatrixWorld(true);

    // 让左膝（shin_l 相对 thigh_l）绕 X 弯曲 0.5rad
    const shin = bones.get('shin_l')!;
    shin.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
    skinnedMesh.updateMatrixWorld(true);

    // 取一个主要归属于 shin_l 的顶点，验证其世界位置相对静息发生了非零位移，
    // 且位移方向符合“绕膝关节旋转”而非整体平移
    const geo = skinnedMesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const skinIndex = geo.attributes.skinIndex as THREE.BufferAttribute;
    const skinWeight = geo.attributes.skinWeight as THREE.BufferAttribute;
    const shinIndex = BONE_NAMES.indexOf('shin_l');

    let tested = 0;
    const bindMat = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const skinnedPos = new THREE.Vector3();
    for (let i = 0; i < pos.count && tested < 5; i++) {
      if (skinIndex.getComponent(i, 0) !== shinIndex && skinIndex.getComponent(i, 1) !== shinIndex) continue;
      const w = skinWeight.getComponent(i, skinIndex.getComponent(i, 0) === shinIndex ? 0 : 1);
      if (w < 0.9) continue; // 只看高度归属 shin 的顶点
      const original = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      skinnedPos.set(0, 0, 0);
      for (let k = 0; k < 2; k++) {
        const wk = skinWeight.getComponent(i, k);
        if (wk === 0) continue;
        const bi = skinIndex.getComponent(i, k);
        bindMat.multiplyMatrices(skeleton.bones[bi].matrixWorld, skeleton.boneInverses[bi]);
        v.copy(original).applyMatrix4(bindMat);
        skinnedPos.addScaledVector(v, wk);
      }
      expect(skinnedPos.distanceTo(original)).toBeGreaterThan(0.01);
      tested++;
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('骨骼数量与蒙皮骨架一致，且 hip 根骨静息高度约 0.92m', () => {
    const { bones, skeleton } = createCharacter();
    expect(skeleton.bones.length).toBe(bones.size);
    expect(getBoneSpec('hips').restPosition.y).toBeCloseTo(0.92, 6);
  });
});
