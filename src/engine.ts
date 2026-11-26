/**
 * engine.ts — 包裹称重谜题的纯逻辑核心
 *
 * 不依赖 DOM / Canvas，可独立在 Node 中验证。
 *
 * 关键概念：
 * - 候选重量集合 C 对所有包裹公开且有限；包裹之间允许同重。
 * - 一个「完整重量分配」是给每个包裹指定一个候选重量（允许重复）。
 * - 一条已确认称量记录包含左右盘包裹编号与观测结果（左重 / 平衡 / 右重）。
 * - 只有与「全部」记录同时相容的完整分配才是剩余可能。
 * - 某包裹的某个候选重量仍然可能，当且仅当存在至少一个完整剩余分配
 *   在该位置取这个重量（投影自联合分配，而不是各包裹独立过滤）。
 */

/** 称量结果：左盘总重 - 右盘总重 的符号。-1 左轻，0 平衡，1 左重。 */
export type Outcome = -1 | 0 | 1;

export const OUTCOME_TEXT: Record<Outcome, string> = {
  [-1]: '右盘更重',
  0: '天平平衡',
  [1]: '左盘更重',
};

export const OUTCOME_SHORT: Record<Outcome, string> = {
  [-1]: '左轻',
  0: '平衡',
  [1]: '左重',
};

export interface Weighing {
  /** 左盘包裹编号（0 基） */
  left: number[];
  /** 右盘包裹编号（0 基） */
  right: number[];
  outcome: Outcome;
}

export interface LevelDef {
  id: string;
  name: string;
  /** 关卡定位标签，如「组合推理」「限次困局」 */
  tag: string;
  /** 题面描述 */
  brief: string;
  packageCount: number;
  /** 公开的有限重量候选（升序、去重） */
  candidates: number[];
  /** 上帝视角的真实重量，仅用于生成称量结果，通关前不展示 */
  trueWeights: number[];
  /** 最多可确认称量次数 */
  maxWeighings: number;
  /** 设计好的等重分组（0 基），用于关卡性质自检与提示，不直接泄露给玩家 */
  intendedPartition: { left: number[]; right: number[] };
  /** 设计意图 / 玩法提示 */
  designNote: string;
}

/** 一次提交分组的必然性判定结果 */
export type PartitionVerdict =
  | {
      kind: 'necessary-equal';
      survivorCount: number;
      /** 每个剩余分配下两架都相等；不同分配的共同总重可能不同，全部列出 */
      possibleEqualSums: number[];
    }
  | {
      kind: 'contingent-equal';
      survivorCount: number;
      /** 一组让两边恰好相等的可能分配（用来说明「碰巧」） */
      equalExample: number[];
      equalSums: { left: number; right: number };
      /** 反例：同样满足全部记录，但两边不等 */
      counterexample: number[];
      counterSums: { left: number; right: number };
    }
  | {
      kind: 'never-equal';
      survivorCount: number;
      counterexample: number[];
      counterSums: { left: number; right: number };
    }
  | { kind: 'no-possibility' };

/* ------------------------------------------------------------------ */
/* 基础计算                                                            */
/* ------------------------------------------------------------------ */

export function sumOf(weights: readonly number[], ids: readonly number[]): number {
  let s = 0;
  for (const i of ids) s += weights[i];
  return s;
}

export function outcomeOf(weights: readonly number[], w: Pick<Weighing, 'left' | 'right'>): Outcome {
  const d = sumOf(weights, w.left) - sumOf(weights, w.right);
  return d === 0 ? 0 : d > 0 ? 1 : -1;
}

/** 生成候选重量的笛卡尔积 C^n（允许同重），顺序确定。 */
export function enumerateAssignments(count: number, candidates: readonly number[]): number[][] {
  const c = [...new Set(candidates)].sort((a, b) => a - b);
  const out: number[][] = [];
  const cur: number[] = new Array(count).fill(c[0] ?? 0);

  const walk = (pos: number): void => {
    if (pos === count) {
      out.push(cur.slice());
      return;
    }
    for (const value of c) {
      cur[pos] = value;
      walk(pos + 1);
    }
  };
  walk(0);
  return out;
}

/** 判断一个完整重量分配是否与单条称量记录一致。 */
export function matchesWeighing(assignment: readonly number[], record: Weighing): boolean {
  return outcomeOf(assignment, record) === record.outcome;
}

/**
 * 返回与全部已确认记录同时相容的所有完整重量分配。
 * 真实重量必然在其中（游戏不作弊）。
 */
export function survivingAssignments(
  count: number,
  candidates: readonly number[],
  records: readonly Weighing[],
): number[][] {
  return enumerateAssignments(count, candidates).filter((a) =>
    records.every((r) => matchesWeighing(a, r)),
  );
}

export interface PackagePossibility {
  packageId: number;
  /** 仍然可能的重量（升序） */
  possible: number[];
  /** 每个候选重量对应多少个完整剩余分配（用于界面提示信息量） */
  supportCount: Map<number, number>;
}

/**
 * 从联合剩余分配投影出每个包裹仍可能的重量。
 * 一个候选只有在「某个与全部记录相容的完整分配」中出现才保留。
 */
export function possibilitiesByPackage(
  count: number,
  candidates: readonly number[],
  survivors: readonly (readonly number[])[],
): PackagePossibility[] {
  const c = [...new Set(candidates)].sort((a, b) => a - b);
  return Array.from({ length: count }, (_, p) => {
    const supportCount = new Map<number, number>();
    for (const w of c) supportCount.set(w, 0);
    for (const a of survivors) {
      const w = a[p];
      supportCount.set(w, (supportCount.get(w) ?? 0) + 1);
    }
    const possible = c.filter((w) => (supportCount.get(w) ?? 0) > 0);
    return { packageId: p, possible, supportCount };
  });
}

/* ------------------------------------------------------------------ */
/* 提交分组的必然性检验                                                */
/* ------------------------------------------------------------------ */

export function isCompletePartition(count: number, left: readonly number[], right: readonly number[]): boolean {
  if (left.length + right.length !== count) return false;
  const seen = new Set<number>();
  for (const i of left) {
    if (i < 0 || i >= count || seen.has(i)) return false;
    seen.add(i);
  }
  for (const i of right) {
    if (i < 0 || i >= count || seen.has(i)) return false;
    seen.add(i);
  }
  return seen.size === count;
}

/**
 * 按「所有剩余可能」检验分组：
 * - 若每个剩余分配下两边都等重 → necessary-equal（必然等重，提交成功）。
 * - 否则找一个不等重的剩余分配作为反例；
 *   若同时存在等重分配，说明玩家的分法只是「碰巧」在某些可能下成立。
 */
export function evaluatePartition(
  survivors: readonly (readonly number[])[],
  left: readonly number[],
  right: readonly number[],
): PartitionVerdict {
  if (survivors.length === 0) return { kind: 'no-possibility' };

  let counterexample: number[] | undefined;
  let counterSums: { left: number; right: number } | undefined;
  let equalExample: number[] | undefined;
  let equalSums: { left: number; right: number } | undefined;
  let allEqual = true;

  for (const a of survivors) {
    const ls = sumOf(a, left);
    const rs = sumOf(a, right);
    if (ls === rs) {
      if (!equalExample) {
        equalExample = a.slice();
        equalSums = { left: ls, right: rs };
      }
    } else {
      allEqual = false;
      if (!counterexample) {
        counterexample = a.slice();
        counterSums = { left: ls, right: rs };
      }
    }
  }

  if (allEqual && equalExample && equalSums) {
    const sumSet = new Set<number>();
    for (const a of survivors) sumSet.add(sumOf(a, left));
    return {
      kind: 'necessary-equal',
      survivorCount: survivors.length,
      possibleEqualSums: [...sumSet].sort((x, y) => x - y),
    };
  }
  if (equalExample && equalSums && counterexample && counterSums) {
    return {
      kind: 'contingent-equal',
      survivorCount: survivors.length,
      equalExample,
      equalSums,
      counterexample,
      counterSums,
    };
  }
  return {
    kind: 'never-equal',
    survivorCount: survivors.length,
    counterexample: counterexample!,
    counterSums: counterSums!,
  };
}

/* ------------------------------------------------------------------ */
/* 关卡性质自检（供 scripts/verify 使用）                              */
/* ------------------------------------------------------------------ */

/** 某条候选称量在给定真实重量下的记录（自动填结果）。 */
export function makeRecord(
  trueWeights: readonly number[],
  left: number[],
  right: number[],
): Weighing {
  return { left: [...left].sort((a, b) => a - b), right: [...right].sort((a, b) => a - b), outcome: outcomeOf(trueWeights, { left, right }) };
}

/** 给定记录序列后，目标分组是否已经「必然等重」。 */
export function partitionIsNecessary(
  level: Pick<LevelDef, 'packageCount' | 'candidates'>,
  records: readonly Weighing[],
  partition: { left: number[]; right: number[] },
): boolean {
  const survivors = survivingAssignments(level.packageCount, level.candidates, records);
  const verdict = evaluatePartition(survivors, partition.left, partition.right);
  return verdict.kind === 'necessary-equal';
}
