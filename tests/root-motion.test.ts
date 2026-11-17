import { describe, expect, it } from 'vitest';
import { createClips } from '../src/core/clips';
import { AnimationBlender } from '../src/core/blender';
import { createPresetMask } from '../src/core/mask';
import { BONE_NAMES } from '../src/core/skeleton';

/**
 * 验证项 3：连续多轮根位移、模式切换、时间拖动与重置。
 * 容差：位移累计 < 1e-6 m；重置后严格等于 0。
 */
describe('根位移：多轮累计、原地模式、拖动不累加、重置确定', () => {
  const clips = createClips();

  function makeBlender(applyRootMotion = true): AnimationBlender {
    return new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion,
      timeScale: 1,
    });
  }

  it('连续 3 个循环：累计位移 ≈ 3 × 每周期距离（误差 < 1e-6 m），单调向前', () => {
    const blender = makeBlender(true);
    const dt = 1 / 480;
    const steps = Math.round((clips.walk.duration * 3) / dt);
    let prev = 0;
    for (let i = 0; i < steps; i++) {
      blender.step(dt);
      expect(blender.rootPosition).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = blender.rootPosition;
    }
    expect(blender.loopCount).toBe(3);
    expect(Math.abs(blender.rootPosition - 3 * clips.walk.rootDistancePerCycle)).toBeLessThan(1e-6);
  });

  it('原地模式：播放任意时长根位移恒为 0', () => {
    const blender = makeBlender(false);
    for (let i = 0; i < 500; i++) blender.step(1 / 60);
    expect(blender.rootPosition).toBe(0);
  });

  it('播放中切换原地→根位移：不补累计、不瞬移，切换后继续正常积分', () => {
    const blender = makeBlender(true);
    for (let i = 0; i < 120; i++) blender.step(1 / 60);
    const atSwitch = blender.rootPosition;
    expect(atSwitch).toBeGreaterThan(0);

    blender.applyRootMotion = false;
    for (let i = 0; i < 120; i++) blender.step(1 / 60);
    expect(blender.rootPosition).toBeCloseTo(atSwitch, 12); // 原地期间冻结

    blender.applyRootMotion = true;
    for (let i = 0; i < 120; i++) blender.step(1 / 60);
    expect(blender.rootPosition).toBeGreaterThan(atSwitch); // 恢复后继续前进
  });

  it('时间拖动只改姿态不累计位移（往返拖动后 rootPosition 不变）', () => {
    const blender = makeBlender(true);
    for (let i = 0; i < 60; i++) blender.step(1 / 60);
    const before = blender.rootPosition;

    for (let t = 0; t <= clips.walk.duration; t += 0.05) {
      blender.scrub(t, (t / clips.walk.duration) * clips.sneak.duration);
    }
    for (let t = clips.walk.duration; t >= 0; t -= 0.05) {
      blender.scrub(t, (t / clips.walk.duration) * clips.sneak.duration);
    }
    expect(blender.rootPosition).toBeCloseTo(before, 12);

    // 拖动后恢复播放，循环继续，位移重新单调增长
    const beforeResume = blender.rootPosition;
    for (let i = 0; i < 60; i++) blender.step(1 / 60);
    expect(blender.rootPosition).toBeGreaterThan(beforeResume);
  });

  it('暂停与单步：暂停（step(0) 仅采样）不增长，单步恰好增长一帧的积分量', () => {
    const blender = makeBlender(true);
    const frozen = blender.rootPosition;
    blender.step(0); // 暂停时主循环只做零时长采样
    expect(blender.rootPosition).toBe(frozen);

    const sample = blender.singleStep(1 / 60);
    expect(blender.rootPosition - frozen).toBeCloseTo(sample.rootDelta, 12);
    expect(sample.rootDelta).toBeGreaterThan(0);
  });

  it('重置后回到确定的初始位置与相位：root=0、相位=0、权重=0', () => {
    const blender = makeBlender(true);
    for (let i = 0; i < 400; i++) blender.step(1 / 60);
    blender.startFade('sneak');
    for (let i = 0; i < 10; i++) blender.step(1 / 60);
    expect(blender.rootPosition).toBeGreaterThan(0);

    blender.reset({
      fadeDuration: 0.6,
      mask: createPresetMask('all'),
      applyRootMotion: true,
      timeScale: 1,
    });
    expect(blender.rootPosition).toBe(0);
    expect(blender.timeA).toBe(0);
    expect(blender.timeB).toBe(0);
    expect(blender.globalWeight).toBe(0);
    expect(blender.phaseBase).toBe(0);
    expect(blender.loopCount).toBe(0);
    expect(BONE_NAMES.every((n) => blender.mask.get(n) === 1)).toBe(true);
  });

  it('慢放 0.25×：相同墙钟时间的播放头推进为全速的 1/4，根位移同比例', () => {
    const full = makeBlender(true);
    const slow = makeBlender(true);
    slow.timeScale = 0.25;
    for (let i = 0; i < 240; i++) {
      full.step(1 / 60);
      slow.step(1 / 60);
    }
    // 播放头推进严格满足 timeScale 比例（无积分误差）
    expect(slow.timeA * 4).toBeCloseTo(full.timeA, 9);
    expect(slow.timeB * 4).toBeCloseTo(full.timeB, 9);
    // 根位移按相同比例缩放（恒定速度段的精确关系，误差来自谐波采样混叠）
    expect(Math.abs(slow.rootPosition * 4 - full.rootPosition)).toBeLessThan(0.02);
    expect(slow.rootPosition).toBeLessThan(full.rootPosition * 0.3);
  });

  it('timeScale 对恒定速度场景的根位移严格成比例（误差 < 1e-9 m）', () => {
    // 用恒速验证 timeScale 本身的线性：临时替换速度曲线为常量
    const full = makeBlender(true);
    const slow = makeBlender(true);
    slow.timeScale = 0.25;
    const constV = () => 1;
    full.clipA.rootVelocity = constV;
    slow.clipA.rootVelocity = constV;
    for (let i = 0; i < 240; i++) {
      full.step(1 / 60);
      slow.step(1 / 60);
    }
    expect(Math.abs(slow.rootPosition * 4 - full.rootPosition)).toBeLessThan(1e-9);
  });
});
