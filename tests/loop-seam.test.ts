import { describe, expect, it } from 'vitest';
import { createClips } from '../src/core/clips';
import { sampleClip, AnimationBlender } from '../src/core/blender';
import { createRestPose, integrateRootVelocity, quaternionDistance } from '../src/core/math';
import { BONE_NAMES } from '../src/core/skeleton';
import { createPresetMask } from '../src/core/mask';

/**
 * 验证项 2：循环接缝姿态与前进速度连续。
 * 容差：
 *  - 关节旋转接缝差 < 1e-4 rad
 *  - 根速度接缝差 < 1e-6 m/s
 *  - 速度曲线整周期积分与声明的每周期位移差 < 1e-9 m
 *  - 播放一整圈后根位移累计与声明值差 < 1e-6 m
 */
describe('循环接缝：姿态、速度在 u=0/1 处连续，不跳回原地', () => {
  const clips = createClips();

  for (const clip of [clips.walk, clips.sneak]) {
    describe(clip.label, () => {
      it('首尾关键帧姿态一致（环形包裹插值，接缝旋转差 < 1e-4 rad）', () => {
        const at0 = createRestPose();
        const at1 = createRestPose();
        sampleClip(clip, 0, at0);
        // 时长末刻（相位接近 1，会包裹回首帧）
        sampleClip(clip, clip.duration * (1 - 1e-7), at1);
        for (const name of BONE_NAMES) {
          const d = quaternionDistance(at0.get(name)!.quaternion, at1.get(name)!.quaternion);
          expect(d, `关节 ${name} 接缝旋转差`).toBeLessThan(1e-4);
        }
      });

      it('根前进速度在接缝处连续（|v(0)-v(1)| < 1e-6 m/s）', () => {
        const v0 = clip.rootVelocity(0);
        const v1 = clip.rootVelocity(1);
        expect(Math.abs(v0 - v1)).toBeLessThan(1e-6);
      });

      it('根速度恒正（角色始终向前，不会后退）', () => {
        let min = Infinity;
        for (let i = 0; i < 1000; i++) min = Math.min(min, clip.rootVelocity(i / 1000));
        expect(min).toBeGreaterThan(0);
      });

      it('速度曲线积分 = 声明的每周期位移（差 < 1e-9 m）', () => {
        const integrated = integrateRootVelocity(clip, 4096);
        expect(Math.abs(integrated - clip.rootDistancePerCycle)).toBeLessThan(1e-9);
      });

      it('hips 起伏在接缝处连续（差 < 1e-6 m）', () => {
        const a = clip.rootHipsOffset(0);
        const b = clip.rootHipsOffset(1 - 1e-7);
        expect(a.distanceTo(b)).toBeLessThan(1e-6);
      });
    });
  }

  it('完整播放一整圈：根位移累计恰为每周期距离（差 < 1e-6 m），位置不重置', () => {
    const blender = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion: true,
      timeScale: 1,
    });
    const dt = 1 / 240;
    const steps = Math.round(clips.walk.duration / dt);
    for (let i = 0; i < steps; i++) blender.step(dt);
    expect(Math.abs(blender.rootPosition - clips.walk.rootDistancePerCycle)).toBeLessThan(1e-6);
    expect(blender.loopCount).toBe(1);
    // 相位回到起点附近（用环形距离，浮点累加可能停在 0.9999… 而非恰好 0），
    // 但 rootPosition 没有被清零
    const phase = blender.phaseBase;
    const circularDist = Math.min(phase, Math.abs(1 - phase));
    expect(circularDist).toBeLessThan(0.02);
    expect(blender.rootPosition).toBeGreaterThan(1);
  });
});
