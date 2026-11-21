/**
 * 关键帧路径：样例路线与录制路线的统一表示。
 * 关键帧之间做线性插值 —— 闸门扫掠判定发生在 Session 层，
 * 路径只负责"给定模拟时刻 t，角色在哪里、车头朝哪"。
 */
import { Vec2, sub, normalize, lerp } from './geometry';

export interface Keyframe {
  /** 模拟时间（秒，模拟时钟，暂停不计入） */
  t: number;
  pos: Vec2;
  /** 车头朝向（弧度） */
  angle: number;
}

export class Path {
  constructor(readonly frames: Keyframe[]) {
    if (frames.length < 2) throw new Error('Path 至少需要 2 个关键帧');
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].t < frames[i - 1].t) throw new Error('关键帧时间必须递增');
    }
  }

  get duration(): number {
    return this.frames[this.frames.length - 1].t;
  }

  /** t 超出范围时停在首/末帧 */
  sampleAt(t: number): { pos: Vec2; angle: number } {
    const frames = this.frames;
    if (t <= frames[0].t) return { pos: frames[0].pos, angle: frames[0].angle };
    if (t >= frames[frames.length - 1].t) {
      const last = frames[frames.length - 1];
      return { pos: last.pos, angle: last.angle };
    }
    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const f0 = frames[lo];
    const f1 = frames[hi];
    const u = (t - f0.t) / Math.max(1e-12, f1.t - f0.t);
    return {
      pos: lerp(f0.pos, f1.pos, u),
      angle: f0.angle + angleDelta(f0.angle, f1.angle) * u,
    };
  }
}

/** 最短角差，保证插值走小弧 */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 由相邻位置自动推导车头朝向（末帧沿用前一帧方向） */
export function withAutoAngles(frames: Omit<Keyframe, 'angle'>[]): Keyframe[] {
  return frames.map((f, i) => {
    const next = frames[Math.min(i + 1, frames.length - 1)];
    const prev = frames[Math.max(0, i - 1)];
    const dir = normalize(sub(next.pos, prev.pos));
    const angle = dir.x === 0 && dir.y === 0 ? 0 : Math.atan2(dir.y, dir.x);
    return { t: f.t, pos: f.pos, angle };
  });
}
