import { IntersectionParams } from './types';

export const LIMITS = {
  minBranches: 3,
  maxBranches: 4,
  widthMin: 2,
  widthMax: 8,
  lengthMin: 10,
  lengthMax: 40,
  radiusMin: 0,
  radiusMax: 3,
  minGapDeg: 35,
};

const LABELS = 'ABCDEFGH';

export function branchLabel(index: number): string {
  return LABELS[index] ?? String(index + 1);
}

function norm360(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** 参数合法性校验，返回错误列表（为空表示合法）。错误会指明对应分支。 */
export function validateParams(p: IntersectionParams): string[] {
  const errors: string[] = [];
  if (p.branches.length < LIMITS.minBranches || p.branches.length > LIMITS.maxBranches) {
    errors.push(`分支数量须为 ${LIMITS.minBranches}–${LIMITS.maxBranches}，当前 ${p.branches.length}`);
  }
  p.branches.forEach((b, i) => {
    const lb = branchLabel(i);
    if (!Number.isFinite(b.angleDeg)) errors.push(`分支${lb} 方向角无效`);
    if (!(b.width >= LIMITS.widthMin && b.width <= LIMITS.widthMax)) {
      errors.push(`分支${lb} 宽度 ${b.width} 超出 ${LIMITS.widthMin}–${LIMITS.widthMax}`);
    }
    if (!(b.length >= LIMITS.lengthMin && b.length <= LIMITS.lengthMax)) {
      errors.push(`分支${lb} 长度 ${b.length} 超出 ${LIMITS.lengthMin}–${LIMITS.lengthMax}`);
    }
  });
  if (!(p.cornerRadius >= LIMITS.radiusMin && p.cornerRadius <= LIMITS.radiusMax)) {
    errors.push(`转角半径 ${p.cornerRadius} 超出 ${LIMITS.radiusMin}–${LIMITS.radiusMax}`);
  }
  // 相邻分支夹角（含首尾环绕）
  const sorted = p.branches
    .map((b, i) => ({ a: norm360(b.angleDeg), i }))
    .sort((x, y) => x.a - y.a);
  for (let k = 0; k < sorted.length; k++) {
    const cur = sorted[k];
    const nxt = sorted[(k + 1) % sorted.length];
    const gap = norm360(nxt.a - cur.a);
    if (gap < LIMITS.minGapDeg) {
      errors.push(
        `分支${branchLabel(cur.i)} 与分支${branchLabel(nxt.i)} 夹角 ${gap.toFixed(1)}° 小于 ${LIMITS.minGapDeg}°`
      );
    }
  }
  return errors;
}
