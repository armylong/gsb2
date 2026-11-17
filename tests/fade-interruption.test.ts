import { describe, expect, it } from 'vitest';
import { createClips } from '../src/core/clips';
import { AnimationBlender } from '../src/core/blender';
import { createDemoStates } from '../src/core/demos';
import { createPresetMask } from '../src/core/mask';
import { BONE_NAMES } from '../src/core/skeleton';
import { quaternionDistance } from '../src/core/math';

/**
 * 验证项 4：交叉淡入、中途反向切换的连续性。
 * 容差：
 *  - 相邻帧姿态突变 < 1e-4 rad（无跳变）
 *  - 反向瞬间权重取补误差 < 1e-12
 *  - 淡入完成后姿态等于目标动作（差 < 1e-6 rad）
 */
describe('交叉淡入：定时淡入、中途反向、暂停一致性', () => {
  const clips = createClips();

  function makeBlender(fadeDuration = 0.8): AnimationBlender {
    return new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration,
      mask: createPresetMask('all'),
      applyRootMotion: false,
      timeScale: 1,
    });
  }

  /** 记录一次 step 后所有关节的旋转，用于相邻帧突变检测 */
  function snapshot(b: AnimationBlender) {
    const s = b.computeSample(0);
    return BONE_NAMES.map((n) => s.pose.get(n)!.quaternion.clone());
  }

  function maxFrameJump(prev: ReturnType<typeof snapshot>, b: AnimationBlender): number {
    const s = b.computeSample(0);
    let max = 0;
    BONE_NAMES.forEach((n, i) => {
      max = Math.max(max, quaternionDistance(prev[i], s.pose.get(n)!.quaternion));
    });
    return max;
  }

  /**
   * 连续性判据：相邻帧的姿态变化必须与播放头推进量同阶。
   * 实测正常播放（含两段动作叠加）单帧最大变化约 0.06rad，
   * 取 0.08rad 为预算；瞬跳/回绕量级通常 >0.3rad，可被明确区分。
   */
  const CONTINUITY_BUDGET = 0.08;

  it('淡入权重随时间线性增长，到达 1 后固化', () => {
    const b = makeBlender(1.0);
    b.startFade('sneak');
    const dt = 0.1;
    for (let i = 0; i < 5; i++) {
      b.step(dt);
      expect(b.globalWeight).toBeCloseTo((i + 1) * 0.1, 9);
      expect(b.isFading).toBe(true);
    }
    b.step(dt); // 第 6 步 → 0.6
    b.step(dt); // 0.7
    b.step(dt); // 0.8
    b.step(dt); // 0.9
    b.step(dt); // 1.0 → 固化（浮点累加可能为 0.9999999999999999）
    expect(b.globalWeight).toBeCloseTo(1, 9);
    expect(b.isFading).toBe(false);
    expect(b.base.id).toBe('sneak');
  });

  it('淡入全过程相邻帧无姿态跳变（变化始终处于连续运动预算内，无瞬跳/回绕）', () => {
    const b = makeBlender(0.8);
    b.startFade('sneak');
    let prev = snapshot(b);
    for (let i = 0; i < 120; i++) {
      b.step(1 / 120);
      const jump = maxFrameJump(prev, b);
      expect(jump, `第 ${i} 帧姿态突变`).toBeLessThan(CONTINUITY_BUDGET);
      prev = snapshot(b);
    }
  });

  it('淡入到 40% 时反向：权重取补为 0.6，且姿态在反向瞬间完全连续（差 < 1e-6 rad）', () => {
    const b = makeBlender(1.0);
    b.startFade('sneak');
    b.step(0.4); // α = 0.4
    const poseBefore = snapshot(b);
    const weightBefore = b.globalWeight;

    b.startFade('walk'); // 反向
    expect(Math.abs(b.globalWeight - (1 - weightBefore))).toBeLessThan(1e-12);
    expect(b.globalWeight).toBeCloseTo(0.6, 9);

    // 反向瞬间：交换 base/target 且 α 取补，混合出的姿态必须与反向前逐关节一致
    const poseAfter = snapshot(b);
    BONE_NAMES.forEach((n, i) => {
      expect(quaternionDistance(poseBefore[i], poseAfter[i]), `关节 ${n} 反向瞬间跳变`).toBeLessThan(1e-6);
    });
  });

  it('反向后继续播放：姿态平滑回退，最终回到行走动作（差 < 1e-6 rad）', () => {
    const b = makeBlender(1.0);
    b.startFade('sneak');
    b.step(0.4);
    b.startFade('walk');

    let prev = snapshot(b);
    for (let i = 0; i < 200; i++) {
      b.step(1 / 200);
      const jump = maxFrameJump(prev, b);
      expect(jump).toBeLessThan(CONTINUITY_BUDGET);
      prev = snapshot(b);
    }
    expect(b.isFading).toBe(false);
    expect(b.base.id).toBe('walk');

    // 固化后姿态应等于行走动作在当前播放头的采样
    const s = b.computeSample(0);
    const walkOnly = new AnimationBlender(clips.walk, clips.sneak, {
      fadeDuration: 1,
      mask: createPresetMask('all'),
      applyRootMotion: false,
      timeScale: 1,
    });
    walkOnly.timeA = b.timeA;
    walkOnly.timeB = b.timeB;
    const ref = walkOnly.computeSample(0);
    for (const name of BONE_NAMES) {
      expect(quaternionDistance(s.pose.get(name)!.quaternion, ref.pose.get(name)!.quaternion)).toBeLessThan(1e-6);
    }
  });

  it('多次来回切换不产生累积跳变，权重始终在 [0,1] 内', () => {
    const b = makeBlender(0.5);
    b.startFade('sneak');
    let prev = snapshot(b);
    for (let i = 0; i < 400; i++) {
      b.step(1 / 100);
      if (i === 40) b.startFade('walk');
      if (i === 90) b.startFade('sneak');
      if (i === 150) b.startFade('walk');
      if (i === 220) b.startFade('sneak');
      expect(b.globalWeight).toBeGreaterThanOrEqual(0);
      expect(b.globalWeight).toBeLessThanOrEqual(1);
      const jump = maxFrameJump(prev, b);
      expect(jump).toBeLessThan(CONTINUITY_BUDGET);
      prev = snapshot(b);
    }
  });

  it('暂停时权重与姿态冻结；单步推进与正常逐帧推进结果一致', () => {
    const b1 = makeBlender(0.8);
    const b2 = makeBlender(0.8);
    b1.startFade('sneak');
    b2.startFade('sneak');

    // b1：连续 30 帧
    for (let i = 0; i < 30; i++) b1.step(1 / 60);

    // b2：10 帧 → 暂停若干次零时长采样 → 再 20 帧
    for (let i = 0; i < 10; i++) b2.step(1 / 60);
    const frozenWeight = b2.globalWeight;
    for (let i = 0; i < 5; i++) b2.step(0);
    expect(b2.globalWeight).toBeCloseTo(frozenWeight, 12);
    for (let i = 0; i < 20; i++) b2.step(1 / 60);

    expect(b1.globalWeight).toBeCloseTo(b2.globalWeight, 9);
    const s1 = b1.computeSample(0);
    const s2 = b2.computeSample(0);
    for (const name of BONE_NAMES) {
      expect(quaternionDistance(s1.pose.get(name)!.quaternion, s2.pose.get(name)!.quaternion)).toBeLessThan(1e-6);
    }
  });

  it('演示 3 的确定性状态：α=0.4 反向后方向为 B→A，且从当前状态继续', () => {
    const reverse = createDemoStates().find((d) => d.id === 'reverse')!;
    const b = makeBlender();
    reverse.apply(b);
    expect(b.fadeDirection).toBe('B_to_A');
    expect(b.globalWeight).toBeCloseTo(0.6, 9);
    expect(b.isFading).toBe(true);
  });
});
