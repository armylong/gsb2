import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createPresetMask, resolvePerBoneWeight } from '../src/core/mask';
import { BONE_NAMES, getBoneSpec } from '../src/core/skeleton';
import { createClips } from '../src/core/clips';
import { AnimationBlender, sampleClip } from '../src/core/blender';
import { createRestPose, blendPose } from '../src/core/math';

/**
 * 验证项 1：逐关节遮罩两端权重。
 * 容差：权重比较 1e-9；旋转角度差 1e-6 rad（SLERP 端点应恒等）。
 */
describe('逐关节遮罩：权重为 0 保持基础动作，权重为 1 完整采用目标动作', () => {
  const clips = createClips();

  it('上半身预设：上身为 1、下身为 0、髋根为 0', () => {
    const mask = createPresetMask('upper');
    for (const name of BONE_NAMES) {
      const w = mask.get(name)!;
      const region = getBoneSpec(name).region;
      if (region === 'upper') expect(w).toBe(1);
      else expect(w).toBe(0);
    }
    // 关键关节抽查
    expect(mask.get('upperarm_l')).toBe(1);
    expect(mask.get('forearm_r')).toBe(1);
    expect(mask.get('thigh_l')).toBe(0);
    expect(mask.get('shin_r')).toBe(0);
    expect(mask.get('hips')).toBe(0);
  });

  it('下半身预设：下肢与髋根为 1、上身为 0', () => {
    const mask = createPresetMask('lower');
    expect(mask.get('thigh_l')).toBe(1);
    expect(mask.get('foot_r')).toBe(1);
    expect(mask.get('hips')).toBe(1);
    expect(mask.get('chest')).toBe(0);
    expect(mask.get('hand_l')).toBe(0);
  });

  it('全身预设全部为 1，全关预设全部为 0', () => {
    const all = createPresetMask('all');
    const none = createPresetMask('none');
    for (const name of BONE_NAMES) {
      expect(all.get(name)).toBe(1);
      expect(none.get(name)).toBe(0);
    }
  });

  it('resolvePerBoneWeight = 全局 α × 关节遮罩', () => {
    const mask = createPresetMask('upper');
    const perBone = resolvePerBoneWeight(0.37, mask);
    expect(perBone.get('chest')).toBeCloseTo(0.37, 9);
    expect(perBone.get('thigh_l')).toBeCloseTo(0, 9);
  });

  it('权重 0 端：混合姿态与基础动作完全一致（旋转差 < 1e-6 rad）', () => {
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('none'),
      applyRootMotion: false,
      timeScale: 1,
    });
    blender.startFade('sneak');
    blender.globalWeight = 1; // α=1 但遮罩全 0 → 仍是基础动作
    const sample = blender.computeSample(0);

    const expected = createRestPose();
    sampleClip(clips.walk, blender.timeA, expected);
    for (const name of BONE_NAMES) {
      const angle = sample.pose.get(name)!.quaternion.angleTo(expected.get(name)!.quaternion);
      expect(angle).toBeLessThan(1e-6);
    }
  });

  it('权重 1 端：混合姿态与目标动作完全一致（旋转差 < 1e-6 rad）', () => {
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion: false,
      timeScale: 1,
    });
    blender.startFade('sneak');
    blender.globalWeight = 1;
    const sample = blender.computeSample(0);

    const expected = createRestPose();
    sampleClip(clips.sneak, blender.timeB, expected);
    for (const name of BONE_NAMES) {
      const angle = sample.pose.get(name)!.quaternion.angleTo(expected.get(name)!.quaternion);
      expect(angle).toBeLessThan(1e-6);
    }
  });

  it('中间权重不产生缩放或翻转：四元数始终归一，且落在两姿态最短弧上', () => {
    const poseA = createRestPose();
    const poseB = createRestPose();
    poseB.get('upperarm_l')!.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.8);
    const out = createRestPose();
    const weights = new Map(BONE_NAMES.map((n) => [n, 0.5]));
    blendPose(poseA, poseB, weights, out);
    const q = out.get('upperarm_l')!.quaternion;
    expect(Math.abs(q.length() - 1)).toBeLessThan(1e-9); // 无缩放
    const angle = q.angleTo(poseA.get('upperarm_l')!.quaternion);
    expect(angle).toBeCloseTo(0.4, 6); // 最短弧中点，无翻转绕远路
  });
});
