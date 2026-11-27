import type { FormantRegion, Timeline, VowelKey } from '../types';
import { clamp } from '../types';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 频率在对数尺度上插值：中心频率按音高（对数）滑动，听感更像连续的口形运动 */
const lerpFreq = (a: number, b: number, t: number): number => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return Math.exp(lerp(Math.log(a), Math.log(b), t));
};

function lerpRegion(a: FormantRegion, b: FormantRegion, t: number): FormantRegion {
  return {
    center: lerpFreq(a.center, b.center, t),
    bandwidth: lerpFreq(a.bandwidth, b.bandwidth, t),
    gain: lerp(a.gain, b.gain, t),
  };
}

/**
 * 在时间线上取 t（0..1）处的口形：三段共振区逐段线性（频率走对数）插值。
 * 拐点关闭时只在首尾之间插值。
 */
export function frameAt(timeline: Timeline, t: number): [FormantRegion, FormantRegion, FormantRegion] {
  const x = clamp(t, 0, 1);
  const keys = activeKeys(timeline);
  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (x >= keys[i].pos && x <= keys[i + 1].pos) {
      a = keys[i];
      b = keys[i + 1];
      break;
    }
  }
  const span = Math.max(1e-9, b.pos - a.pos);
  const u = clamp((x - a.pos) / span, 0, 1);
  return [
    lerpRegion(a.formants[0], b.formants[0], u),
    lerpRegion(a.formants[1], b.formants[1], u),
    lerpRegion(a.formants[2], b.formants[2], u),
  ];
}

/** 当前生效的节点（按 middleEnabled 决定返回 2 个还是 3 个） */
export function activeKeys(timeline: Timeline): VowelKey[] {
  const [start, , end] = timeline.keys;
  if (!timeline.middleEnabled) {
    return [{ ...start, pos: 0 }, { ...end, pos: 1 }];
  }
  const mid = { ...timeline.keys[1], pos: clamp(timeline.middlePos, 0.02, 0.98) };
  return [{ ...start, pos: 0 }, mid, { ...end, pos: 1 }];
}
