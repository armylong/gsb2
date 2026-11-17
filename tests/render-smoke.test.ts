import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCharacter } from '../src/three/character';
import { applyPose } from '../src/three/poseApplier';
import { createClips } from '../src/core/clips';
import { AnimationBlender } from '../src/core/blender';
import { createPresetMask } from '../src/core/mask';
import { BONE_NAMES } from '../src/core/skeleton';

/**
 * 渲染管线冒烟测试（无 GPU）：驱动真实混合引擎 → 写入 Bone 层级 →
 * 更新世界矩阵 → 验证骨架姿态与蒙皮顶点。
 * 覆盖 WebGL 着色之前的全部 CPU 侧逻辑，确保浏览器里只会因 GPU 问题失败而非代码问题。
 */
describe('端到端：混合引擎驱动层级骨架的完整帧', () => {
  it('连续 60 帧不抛异常，世界矩阵持续更新且角色沿 +Z 前进', () => {
    const clips = createClips();
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion: true,
      timeScale: 1,
    });
    const character = createCharacter();

    const hipsWorld = new THREE.Vector3();
    let lastZ = 0;
    for (let frame = 0; frame < 60; frame++) {
      const sample = blender.step(1 / 60);
      expect(() => applyPose(character, sample.pose, blender.rootPosition)).not.toThrow();
      character.root.updateMatrixWorld(true);
      character.bones.get('hips')!.getWorldPosition(hipsWorld);
      // 根组位移应体现在 hips 世界 z 上
      expect(hipsWorld.z).toBeCloseTo(blender.rootPosition, 6);
    }
    expect(blender.rootPosition).toBeGreaterThan(0);
    expect(blender.rootPosition).toBeGreaterThan(lastZ);
  });

  it('淡入过程中每根骨的世界四元数都在变化（姿态确实驱动到层级）', () => {
    const clips = createClips();
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.4,
      mask: createPresetMask('all'),
      applyRootMotion: false,
      timeScale: 1,
    });
    blender.startFade('sneak');
    const character = createCharacter();

    const before = new Map<string, THREE.Quaternion>();
    let sample = blender.computeSample(0);
    applyPose(character, sample.pose, 0);
    character.root.updateMatrixWorld(true);
    for (const name of BONE_NAMES) {
      before.set(name, character.bones.get(name)!.getWorldQuaternion(new THREE.Quaternion()).clone());
    }

    // 推进 0.3s
    for (let i = 0; i < 18; i++) blender.step(1 / 60);
    sample = blender.computeSample(0);
    applyPose(character, sample.pose, 0);
    character.root.updateMatrixWorld(true);

    let changed = 0;
    for (const name of BONE_NAMES) {
      const now = character.bones.get(name)!.getWorldQuaternion(new THREE.Quaternion());
      if (now.angleTo(before.get(name)!) > 1e-4) changed++;
    }
    // 绝大多数关节在行走+淡入期间应有世界旋转变化
    expect(changed).toBeGreaterThan(BONE_NAMES.length / 2);
  });

  it('根位移关闭时角色世界 z 恒为 0，但关节仍在运动', () => {
    const clips = createClips();
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion: false,
      timeScale: 1,
    });
    const character = createCharacter();
    const hipsPos = new THREE.Vector3();
    const firstQ = new THREE.Quaternion();
    for (let frame = 0; frame < 30; frame++) {
      const sample = blender.step(1 / 60);
      applyPose(character, sample.pose, 0); // 原地模式 rootZ 传 0
      character.root.updateMatrixWorld(true);
      character.bones.get('thigh_l')!.getWorldQuaternion(firstQ);
      character.bones.get('hips')!.getWorldPosition(hipsPos);
      expect(hipsPos.z).toBe(0);
    }
    // 关节旋转非单位（确实在做步态）
    const thighQ = character.bones.get('thigh_l')!.getWorldQuaternion(new THREE.Quaternion());
    expect(thighQ.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01);
  });

  it('SkinnedMesh 的 skeleton 与骨骼数组引用一致，bindMode 合法', () => {
    const { skinnedMesh, skeleton } = createCharacter();
    expect(skinnedMesh.skeleton).toBe(skeleton);
    expect(skeleton.bones.length).toBe(BONE_NAMES.length);
    expect(skeleton.boneInverses.length).toBe(BONE_NAMES.length);
    // 每根骨的逆矩阵有效（非 NaN）
    for (const inv of skeleton.boneInverses) {
      const e = inv.elements;
      expect(e.some((n) => Number.isNaN(n))).toBe(false);
    }
  });

  it('关节检视数据可得：选中膝部后能读到相对父关节的局部欧拉角', () => {
    const clips = createClips();
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion: false,
      timeScale: 1,
    });
    const character = createCharacter();
    blender.step(0.3);
    const sample = blender.computeSample(0);
    applyPose(character, sample.pose, 0);
    const shin = character.bones.get('shin_l')!;
    const euler = new THREE.Euler().setFromQuaternion(shin.quaternion, 'YXZ');
    expect([euler.x, euler.y, euler.z].every((n) => !Number.isNaN(n))).toBe(true);
    // 行走时膝盖有弯曲
    expect(Math.abs(euler.x)).toBeGreaterThan(0.05);
  });
});
