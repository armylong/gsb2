import * as THREE from 'three';
import type { TimeKnot } from './types';

/**
 * Piecewise-linear time curve: maps elapsed time t (seconds) to arc-length
 * progress p in [0,1]. "At time t, fraction p of the whole path is done."
 *
 * Knots are kept sorted by t with non-decreasing p; flat segments are legal
 * (a pause in space), steep segments mean fast travel.
 */
export function progressAtTime(knots: TimeKnot[], duration: number, t: number): number {
  if (knots.length === 0 || duration <= 0) return 0;
  if (t <= knots[0].t) return knots[0].p;
  if (t >= knots[knots.length - 1].t) return knots[knots.length - 1].p;

  let lo = 0;
  let hi = knots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (knots[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const b = lo;
  const a = lo - 1;
  const dt = knots[b].t - knots[a].t;
  if (dt <= 0) return knots[a].p;
  const alpha = (t - knots[a].t) / dt;
  return THREE.MathUtils.clamp(
    knots[a].p + alpha * (knots[b].p - knots[a].p),
    0,
    1,
  );
}

/** Default time curve: uniform (equivalent to constant speed). */
export function defaultTimeKnots(duration: number): TimeKnot[] {
  return [
    { t: 0, p: 0 },
    { t: duration, p: 1 },
  ];
}

/**
 * Re-anchor and clamp user-edited knots:
 *  - first/last rows are pinned to t=0,p=0 and t=duration,p=1,
 *  - interior t stays strictly ordered, p stays non-decreasing.
 * Returns a new array; never mutates the input.
 */
export function sanitizeKnots(input: TimeKnot[], duration: number): TimeKnot[] {
  if (duration <= 0) return defaultTimeKnots(10);
  const interior = input
    .slice(1, -1)
    .map((k) => ({
      t: THREE.MathUtils.clamp(k.t, 0, duration),
      p: THREE.MathUtils.clamp(k.p, 0, 1),
    }))
    .sort((a, b) => a.t - b.t);

  const knots: TimeKnot[] = [{ t: 0, p: 0 }, ...interior, { t: duration, p: 1 }];

  // Enforce strictly increasing t.
  for (let i = 1; i < knots.length - 1; i++) {
    knots[i].t = Math.min(Math.max(knots[i].t, knots[i - 1].t + 1e-6), duration - 1e-6);
  }
  // Enforce non-decreasing p against the previous row.
  for (let i = 1; i < knots.length; i++) {
    if (knots[i].p < knots[i - 1].p) knots[i].p = knots[i - 1].p;
  }
  return knots;
}
