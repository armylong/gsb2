import { Vector3 } from 'three';
import type { BlendSample, JointMask, LocalPose, ProceduralClip } from './types';
import { BONE_NAMES, getBoneSpec } from './skeleton';
import { blendPose, createPosePool, sampleRotationKeyframes, wrap01 } from './math';
import { resolvePerBoneWeight } from './mask';

export interface BlenderConfig {
  fadeDuration: number;
  mask: JointMask;
  applyRootMotion: boolean;
  timeScale: number;
}

/**
 * 动画混合引擎（与渲染解耦，纯逻辑，可在 Node 下直接单测）。
 *
 * 职责：
 * - 维护两个动作各自独立的播放头（相位），淡入期间两个播放头都继续前进，
 *   因此中途反向切换是“从当前权重继续走”，不会跳回任一动作的起点。
 * - 维护全局淡入权重 α（线性缓动），逐关节最终权重 = α × mask。
 * - 根位移以“每帧速度增量积分”的方式累计，只在真实播放时累计，
 *   时间拖动（scrub）只改姿态不累计位移。
 */
export class AnimationBlender {
  readonly clipA: ProceduralClip;
  readonly clipB: ProceduralClip;

  /** 当前基础动作（权重 1-α 的一侧） */
  base: ProceduralClip;
  /** 当前目标动作（权重 α 的一侧）；无淡入时与 base 相同 */
  target: ProceduralClip;

  /** 各动作累计播放时间（秒），相位 = time / duration 取模 */
  timeA = 0;
  timeB = 0;

  /** 全局淡入权重 0..1（相对当前 target 的占比；固化后两动作相同时数值无影响） */
  globalWeight = 0;
  /** 正在进行的淡入：1 表示 α 正在向 1 推进，0 表示空闲 */
  private fading = false;
  fadeDuration = 0.6;

  mask: JointMask;
  applyRootMotion = true;
  timeScale = 1;
  playing = true;

  /** 根节点世界前进距离（米，沿 +Z），只由播放增量驱动 */
  rootPosition = 0;
  /** 累计经历的循环数（按基础动作计），用于 UI 与测试 */
  loopCount = 0;

  // 可复用的姿态对象池（3 个完整姿态）与 hips 起伏临时向量
  private pool: LocalPose[];
  private readonly offsetBase = new Vector3();
  private readonly offsetTarget = new Vector3();
  private readonly offsetBlended = new Vector3();

  constructor(clipA: ProceduralClip, clipB: ProceduralClip, config: BlenderConfig) {
    this.clipA = clipA;
    this.clipB = clipB;
    this.base = clipA;
    this.target = clipA;
    this.fadeDuration = config.fadeDuration;
    this.mask = config.mask;
    this.applyRootMotion = config.applyRootMotion;
    this.timeScale = config.timeScale;
    this.pool = createPosePool(3);
  }

  /** 当前基础动作的相位 0..1 */
  get phaseBase(): number {
    return wrap01(this.base.id === 'walk' ? this.timeA / this.clipA.duration : this.timeB / this.clipB.duration);
  }

  /** 当前目标动作的相位 0..1 */
  get phaseTarget(): number {
    return wrap01(this.target.id === 'walk' ? this.timeA / this.clipA.duration : this.timeB / this.clipB.duration);
  }

  get isFading(): boolean {
    return this.fading;
  }

  /** 淡入方向的可读标识，供 UI/演示状态使用 */
  get fadeDirection(): 'A_to_B' | 'B_to_A' | 'idle' {
    if (!this.fading) return 'idle';
    return this.target.id === this.clipB.id ? 'A_to_B' : 'B_to_A';
  }

  private timeOf(clip: ProceduralClip): number {
    return clip.id === 'walk' ? this.timeA : this.timeB;
  }

  private advancePlayhead(clip: ProceduralClip, dt: number): void {
    if (clip.id === 'walk') this.timeA += dt;
    else this.timeB += dt;
  }

  /**
   * 启动一次交叉淡入。
   * 若淡入尚未结束就反向调用：交换 base/target、把 α 取补（1-α），
   * 从当前姿态沿反方向继续淡入 —— 不会跳回任一动作的起点。
   */
  startFade(toId: 'walk' | 'sneak'): void {
    const desired = toId === this.clipA.id ? this.clipA : this.clipB;

    if (!this.fading) {
      // 已固化在单一动作上：新淡入必须从 α=0 重新开始，
      // 否则残留的 α=1 会让新淡入在一帧内“瞬间完成”，造成姿态瞬跳
      if (desired.id === this.base.id) return;
      this.target = desired;
      this.globalWeight = 0;
      this.fading = true;
      return;
    }

    // 淡入进行中
    if (desired.id === this.target.id) return; // 同向重复请求
    // 反向：交换两侧，α 取补后继续朝 1 推进（新 target 的占比 = 1-α）
    const prevBase = this.base;
    this.base = this.target;
    this.target = prevBase;
    this.globalWeight = 1 - this.globalWeight;
    this.fading = true;
  }

  private updateFade(dt: number): void {
    if (!this.fading) return;
    const dur = Math.max(this.fadeDuration, 1e-4);
    const next = this.globalWeight + dt / dur;
    if (next >= 1 - 1e-9) {
      // 吸附到精确终点，避免 0.9999999999999999 这类浮点尾巴
      this.globalWeight = 1;
      this.base = this.target;
      this.fading = false;
    } else {
      this.globalWeight = next;
    }
  }

  /**
   * 推进一帧（真实时间 dt，已含外部时钟；内部再乘 timeScale）。
   * 暂停时调用 step(0) 也能安全采样当前姿态。
   */
  step(wallDt: number): BlendSample {
    const dt = wallDt * this.timeScale;

    if (dt > 0) {
      // 两个播放头始终各自独立前进（包括淡入期间）
      this.advancePlayhead(this.clipA, dt);
      this.advancePlayhead(this.clipB, dt);
      this.updateFade(dt);
      this.trackLoopCount(dt);
    }

    const sample = this.computeSample(dt);

    if (dt > 0 && this.applyRootMotion) {
      // 仅真实播放且开启根位移时累计；scrub/暂停不进入此分支
      this.rootPosition += sample.rootDelta;
    }
    return sample;
  }

  private trackLoopCount(dt: number): void {
    // 用取整后的循环号比较，避免浮点累加落在 duration 整数倍边界时漏计
    const before = Math.floor((this.timeOf(this.base) - dt) / this.base.duration + 1e-9);
    const after = Math.floor(this.timeOf(this.base) / this.base.duration + 1e-9);
    if (after > before) {
      this.loopCount += after - before;
    }
  }

  /** 计算当前时刻的混合姿态与根增量（不修改任何状态） */
  computeSample(dt: number): BlendSample {
    const [poseBase, poseTarget, poseOut] = this.pool;

    const uBase = wrap01(this.timeOf(this.base) / this.base.duration);
    const uTarget = wrap01(this.timeOf(this.target) / this.target.duration);

    sampleClip(this.base, this.timeOf(this.base), poseBase);
    sampleClip(this.target, this.timeOf(this.target), poseTarget);

    const perBone = resolvePerBoneWeight(this.globalWeight, this.mask);
    blendPose(poseBase, poseTarget, perBone, poseOut);

    // hips 局部位移 = 公共静息位置 + 两动作循环内起伏按 hips 权重的加权混合。
    // 重新精确计算（而非沿用 blendPose 的中间 lerp），使上半身遮罩（hipsW=0）
    // 时 hips 严格保持基础动作的起伏，不被目标动作污染。
    const hipsW = perBone.get('hips') ?? 0;
    this.offsetBase.copy(this.base.rootHipsOffset(uBase));
    this.offsetTarget.copy(this.target.rootHipsOffset(uTarget));
    this.offsetBlended.lerpVectors(this.offsetBase, this.offsetTarget, hipsW);
    poseOut.get('hips')!.position
      .copy(getBoneSpec('hips').restPosition)
      .add(this.offsetBlended);

    // 根前进速度按 hips 遮罩权重混合（上半身遮罩时根仍由基础步态驱动）
    const vBase = this.base.rootVelocity(uBase);
    const vTarget = this.target.rootVelocity(uTarget);
    const v = vBase * (1 - hipsW) + vTarget * hipsW;
    const rootDelta = dt > 0 ? v * dt : 0;

    return { pose: poseOut, rootDelta, globalWeight: this.globalWeight };
  }

  /**
   * 时间拖动（姿态预览）：把两个播放头临时设置到指定秒数并采样。
   * - 不累计根位移、不推进淡入权重；
   * - 仅改变本次采样的姿态，调用方（UI）负责在拖动结束时恢复原播放头，
   *   因此正常播放的循环进度与根位移都不会被预览过程污染。
   */
  scrub(timeA: number, timeB: number): BlendSample {
    this.timeA = Math.max(0, timeA);
    this.timeB = Math.max(0, timeB);
    return this.computeSample(0);
  }

  /** 单步：前进固定秒数（暂停状态下也可调用），权重与姿态保持同一套计算 */
  singleStep(stepSeconds: number): BlendSample {
    return this.step(stepSeconds);
  }

  /** 恢复全部默认状态（确定的初始位置与相位） */
  reset(defaults: BlenderConfig): void {
    this.timeA = 0;
    this.timeB = 0;
    this.globalWeight = 0;
    this.fading = false;
    this.base = this.clipA;
    this.target = this.clipA;
    this.rootPosition = 0;
    this.loopCount = 0;
    this.playing = true;
    this.fadeDuration = defaults.fadeDuration;
    this.mask = defaults.mask;
    this.applyRootMotion = defaults.applyRootMotion;
    this.timeScale = defaults.timeScale;
  }
}

/** 采样单个动作：旋转关键帧 + hips 循环内起伏（hips 局部位移在采样器内直接合成） */
export function sampleClip(clip: ProceduralClip, time: number, poseOut: LocalPose): void {
  const u = wrap01(time / clip.duration);
  sampleRotationKeyframes(clip.rotationKeyframes, u, poseOut);
  const offset = clip.rootHipsOffset(u);
  poseOut.get('hips')!.position.copy(getBoneSpec('hips').restPosition).add(offset);
}

/** 便于 UI 读取：当前根 hips 的世界位置（根位移 + 循环内竖直/横向起伏） */
export function computeHipsWorldPosition(blender: AnimationBlender, sample: BlendSample, target: Vector3): Vector3 {
  const hipsLocal = sample.pose.get('hips')!.position;
  target.set(hipsLocal.x, hipsLocal.y, blender.rootPosition + hipsLocal.z);
  return target;
}

export { BONE_NAMES };
