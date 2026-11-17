import { describe, expect, it } from 'vitest';
import { createClips } from '../src/core/clips';
import { AnimationBlender, sampleClip } from '../src/core/blender';
import { createPresetMask } from '../src/core/mask';
import { createRestPose } from '../src/core/math';
import { getBoneSpec } from '../src/core/skeleton';

/**
 * 验证项：上半身遮罩的父子分区隔离。
 * 容差：位置/速度差 < 1e-9（hips 权重为 0，必须严格等于基础动作）。
 */
describe('上半身遮罩：下肢与根保持基础动作，上肢采用目标动作', () => {
  const clips = createClips();

  function makeUpperMaskBlender(): AnimationBlender {
    const b = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('upper'),
      applyRootMotion: true,
      timeScale: 1,
    });
    b.startFade('sneak');
    b.globalWeight = 1; // 淡入推满：差异完全由遮罩决定
    return b;
  }

  it('hips 遮罩权重为 0 时，hips 局部位移严格等于行走（基础）动作', () => {
    const b = makeUpperMaskBlender();
    b.timeA = 0.37;
    b.timeB = 0.55; // 故意让两动作处于不同相位
    const sample = b.computeSample(0);

    const walkPose = createRestPose();
    sampleClip(clips.walk, b.timeA, walkPose);
    const blendedHips = sample.pose.get('hips')!.position;
    const walkHips = walkPose.get('hips')!.position;
    expect(blendedHips.distanceTo(walkHips)).toBeLessThan(1e-9);
  });

  it('根前进速度严格采用基础（行走）步态，与潜行速度无关', () => {
    const b = makeUpperMaskBlender();
    b.timeA = 0.37;
    b.timeB = 0.55;
    const sample = b.computeSample(1 / 60);
    const uWalk = (b.timeA / clips.walk.duration) % 1;
    const expectedV = clips.walk.rootVelocity(uWalk);
    expect(sample.rootDelta).toBeCloseTo(expectedV / 60, 9);
  });

  it('下肢关节（thigh/shin/foot）保持行走，上肢关节（upperarm/forearm）采用潜行', () => {
    const b = makeUpperMaskBlender();
    b.timeA = 0.37;
    b.timeB = 0.55;
    const sample = b.computeSample(0);

    const walkPose = createRestPose();
    const sneakPose = createRestPose();
    sampleClip(clips.walk, b.timeA, walkPose);
    sampleClip(clips.sneak, b.timeB, sneakPose);

    const lowerBones = ['thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'foot_l', 'foot_r'] as const;
    const upperBones = ['upperarm_l', 'upperarm_r', 'forearm_l', 'forearm_r', 'chest'] as const;

    for (const name of lowerBones) {
      const angle = sample.pose.get(name)!.quaternion.angleTo(walkPose.get(name)!.quaternion);
      expect(angle, `下肢 ${name} 应保持行走`).toBeLessThan(1e-6);
    }
    for (const name of upperBones) {
      const angle = sample.pose.get(name)!.quaternion.angleTo(sneakPose.get(name)!.quaternion);
      expect(angle, `上肢 ${name} 应采用潜行`).toBeLessThan(1e-6);
    }
  });

  it('hips 静息高度常量在混合中保持（不会因遮罩丢失根骨高度）', () => {
    const b = makeUpperMaskBlender();
    const sample = b.computeSample(0);
    // hips 位置 y 应在静息高度附近（行走起伏量级 ±0.03）
    expect(Math.abs(sample.pose.get('hips')!.position.y - getBoneSpec('hips').restPosition.y)).toBeLessThan(0.1);
  });

  it('下半身预设则反过来：下肢采用潜行、上肢保持行走', () => {
    const b = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('lower'),
      applyRootMotion: true,
      timeScale: 1,
    });
    b.startFade('sneak');
    b.globalWeight = 1;
    b.timeA = 0.37;
    b.timeB = 0.55;
    const sample = b.computeSample(0);

    const walkPose = createRestPose();
    const sneakPose = createRestPose();
    sampleClip(clips.walk, b.timeA, walkPose);
    sampleClip(clips.sneak, b.timeB, sneakPose);

    // 大腿采用潜行
    expect(sample.pose.get('thigh_l')!.quaternion.angleTo(sneakPose.get('thigh_l')!.quaternion)).toBeLessThan(1e-6);
    // 上臂保持行走
    expect(sample.pose.get('upperarm_l')!.quaternion.angleTo(walkPose.get('upperarm_l')!.quaternion)).toBeLessThan(1e-6);
  });
});
