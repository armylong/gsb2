import type { LevelDef, Phase } from './types';

const EPS = 1e-7;

export function norm360(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

export function norm180(angle: number): number {
  const a = norm360(angle);
  return a > 180 ? a - 360 : a;
}

/** Shortest unsigned angular distance in degrees. */
export function angleDistance(a: number, b: number): number {
  return Math.abs(norm180(a - b));
}

export function angleAt(initial: number, speed: number, dir: 1 | -1, elapsed: number): number {
  return norm360(initial + dir * speed * elapsed);
}

export function phaseAt(level: Pick<LevelDef, 'cycleBeats' | 'dayBeats'>, beat: number): Phase {
  if (level.dayBeats <= 0) return 'night';
  return beat % level.cycleBeats < level.dayBeats ? 'day' : 'night';
}

export function roundAt(level: Pick<LevelDef, 'cycleBeats'>, beat: number): number {
  return Math.floor(beat / level.cycleBeats) + 1;
}

export function isInsideArc(angle: number, centre: number, halfWidth: number): boolean {
  return Math.abs(norm180(angle - centre)) <= halfWidth + EPS;
}

export function eaveAt(angle: number, centre: number, eave: { from: number; to: number }): boolean {
  const rel = norm180(angle - centre);
  return rel >= eave.from - EPS && rel <= eave.to + EPS;
}

export function polar(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy - radius * Math.sin(rad) };
}

export function formatBeat(beat: number): string {
  return `第 ${beat + 1} 拍`;
}
