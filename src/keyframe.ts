import { cloneWeights, lerpWeights, zeroWeights, type Weights } from './types';

export type PlayMode = 'manual' | 'playing';

/**
 * 关键帧与时间轴状态。
 * 形状永远由当前权重决定: 播放只是在两帧权重间插值,
 * 中途反向/切换目标时插值连续, 不会回到默认形状。
 */
export class KeyframeStore {
  private slots: (Weights | null)[] = [zeroWeights(), zeroWeights()];
  activeSlot = 0;
  /** 时间轴 t: 0=A帧, 1=B帧 */
  t = 0;
  mode: PlayMode = 'manual';
  direction: 1 | -1 = 1;
  speed = 0.25; // t/秒
  /** 当前生效权重(播放时为插值结果) */
  current: Weights = zeroWeights();

  get frameA(): Weights {
    return this.slots[0] ?? zeroWeights();
  }
  get frameB(): Weights {
    return this.slots[1] ?? zeroWeights();
  }

  /** 把当前编辑中的权重录到指定槽位 */
  capture(slot: 0 | 1, w: Weights) {
    this.slots[slot] = cloneWeights(w);
  }

  isCaptured(slot: 0 | 1): boolean {
    return this.slots[slot] !== null;
  }

  /** 手动调节权重时调用: 立即成为当前形状, 不触碰已录关键帧 */
  setManual(w: Weights) {
    this.mode = 'manual';
    this.current = cloneWeights(w);
  }

  /** 播放推进; dt 秒; 返回是否仍在播放 */
  advance(dt: number): boolean {
    if (this.mode !== 'playing') return false;
    this.t += this.direction * this.speed * dt;
    if (this.t >= 1) {
      this.t = 1;
      this.direction = -1;
    } else if (this.t <= 0) {
      this.t = 0;
      this.direction = 1;
    }
    this.current = lerpWeights(this.frameA, this.frameB, this.t);
    return true;
  }

  play() {
    if (!this.slots[0] || !this.slots[1]) return;
    this.mode = 'playing';
  }

  pause() {
    this.mode = 'manual';
  }

  /** 拖动时间轴: 从任意位置插值, 反向也连续 */
  scrub(t: number) {
    this.mode = 'manual';
    this.t = clamp01(t);
    this.current = lerpWeights(this.frameA, this.frameB, this.t);
  }

  /** 当前权重写回(供 UI 滑杆回显) */
  snapshot(): Weights {
    return cloneWeights(this.current);
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
