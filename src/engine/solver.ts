import type { Board } from './board';
import type { Constraint } from './board';
import type { Cell } from '../types';

/**
 * 求解器：把每个非墙格当成 0/1 变量（1=实地，0=空洞），
 * 在“所有公开读数约束”下回溯枚举相容底图。
 * 关卡规模小（几十格），带前向剪枝的穷举足够快，且结论是严格的。
 */

export interface SolveOptions {
  /** 找到这么多解就停（只需要区分 1 个 / 多个时传 2） */
  maxSolutions?: number;
}

export interface SolveResult {
  /** 每个解是按 variables 顺序的 0/1 数组 */
  solutions: Uint8Array[];
  /** 是否因达到上限而提前停止（意味着可能还有更多解） */
  capped: boolean;
  variables: Cell[];
}

export class Solver {
  readonly variables: Cell[] = [];
  private indexMap = new Map<string, number>();
  private constraints: Constraint[];
  /** 每个变量出现在哪些约束里，用于增量剪枝 */
  private varConstraints: number[][] = [];
  /** 变量排序启发式：参与约束最多的优先 */
  private order: number[] = [];

  constructor(board: Board, constraints: Constraint[]) {
    this.constraints = constraints;
    this.variables = board.openCells();
    this.variables.forEach((cell, i) => this.indexMap.set(`${cell.r},${cell.c}`, i));
    this.varConstraints = this.variables.map(() => []);
    constraints.forEach((con, ci) => {
      for (const v of con.vars) this.varConstraints[v].push(ci);
    });
    this.order = this.variables
      .map((_, i) => i)
      .sort((a, b) => this.varConstraints[b].length - this.varConstraints[a].length);
  }

  indexOf(r: number, c: number): number {
    const idx = this.indexMap.get(`${r},${c}`);
    if (idx === undefined) throw new Error(`墙格或越界格不能作为变量：(${r},${c})`);
    return idx;
  }

  solve(options: SolveOptions = {}): SolveResult {
    const max = options.maxSolutions ?? Number.POSITIVE_INFINITY;
    const n = this.variables.length;
    const assignment = new Uint8Array(n);
    // 每个约束当前已赋值变量数与实地数
    const conAssigned = this.constraints.map(() => 0);
    const conSum = this.constraints.map(() => 0);
    const solutions: Uint8Array[] = [];

    const feasible = (ci: number): boolean => {
      const con = this.constraints[ci];
      const remaining = con.vars.length - conAssigned[ci];
      const sum = conSum[ci];
      // 剩余全为 0 时的最小和、全为 1 时的最大和，必须与 [lo, hi] 有交集
      return sum <= con.hi && sum + remaining >= con.lo;
    };

    const dfs = (depth: number): void => {
      if (solutions.length >= max) return;
      if (depth === n) {
        solutions.push(assignment.slice());
        return;
      }
      const v = this.order[depth];
      // 先试实地(1)再试空洞(0)，顺序不影响完备性
      for (const value of [1, 0] as const) {
        assignment[v] = value;
        const touched: number[] = [];
        let ok = true;
        for (const ci of this.varConstraints[v]) {
          conAssigned[ci]++;
          conSum[ci] += value;
          touched.push(ci);
          if (!feasible(ci)) {
            ok = false;
            break;
          }
        }
        if (ok) dfs(depth + 1);
        if (solutions.length >= max) return;
        for (const ci of touched) {
          conAssigned[ci]--;
          conSum[ci] -= value;
        }
      }
    };

    // 无约束时也要确认所有约束本身可行（空 cells 的边界情况）
    const initiallyFeasible = this.constraints.every((con) => con.lo <= con.hi);
    if (initiallyFeasible) dfs(0);
    return { solutions, capped: solutions.length >= max, variables: this.variables };
  }
}

export interface ForcedCell {
  r: number;
  c: number;
  /** 1 = 必然实地（安全），0 = 必然空洞 */
  solid: 0 | 1;
}

/** 在一组解里找出取值完全一致的变量（封顶时不保证严格必然，由调用方处理 capped） */
export function findForcedCells(result: SolveResult): ForcedCell[] {
  if (result.solutions.length === 0) return [];
  const forced: ForcedCell[] = [];
  const first = result.solutions[0];
  for (let v = 0; v < first.length; v++) {
    const value = first[v];
    let same = true;
    for (let i = 1; i < result.solutions.length; i++) {
      if (result.solutions[i][v] !== value) {
        same = false;
        break;
      }
    }
    if (same) {
      const cell = result.variables[v];
      forced.push({ r: cell.r, c: cell.c, solid: value as 0 | 1 });
    }
  }
  return forced;
}

/**
 * 贪心求“足以推出该格取值”的最小读数子集（不可约子集）：
 * 从全部约束开始，对每条原始约束尝试删除，删后该格仍然必然取相同值就永久删掉。
 * 遍历用快照避免数组缩短时跳过元素。
 * 返回的 recordId 列表就是提示要引用的读数。
 */
export function explainForcedCell(
  board: Board,
  allConstraints: Constraint[],
  target: Cell,
  solid: 0 | 1,
): number[] {
  let active = allConstraints.map((_, i) => i);
  const stillForced = (indices: number[]): boolean => {
    const subset = indices.map((i) => allConstraints[i]);
    const solver = new Solver(board, subset);
    const result = solver.solve({ maxSolutions: 2 });
    if (result.capped || result.solutions.length === 0) return false;
    const vi = solver.indexOf(target.r, target.c);
    return result.solutions.every((s) => s[vi] === solid);
  };

  for (const idx of allConstraints.map((_, i) => i)) {
    if (!active.includes(idx)) continue;
    const trial = active.filter((x) => x !== idx);
    if (stillForced(trial)) active = trial;
  }
  return active.map((i) => allConstraints[i].recordId);
}
