// 补全求解器与提示。
// - 已摆(含锁住)的片和方向全部作为硬约束, 求解器只在剩余格子上推进
// - 旋转对称的片用 optionKey 去重, 不会因 rot 写法不同被多算
// - 无解时返回有依据的解释: 现有冲突 / 数量不匹配 / 某剩余位置无可用片

import {
  Cell,
  Dir,
  DIRS,
  Placement,
  Tile,
  Board,
  optionKey,
  rotatedEdge,
} from './types.js';
import {
  Conflict,
  allCells,
  checkBoard,
  checkPlacement,
  freeCells,
  validateEdgeConditions,
} from './board.js';

export interface Explanation {
  title: string;
  detail: string;
  /** 现有盘面上的硬冲突(若有) */
  conflicts?: Conflict[];
  /** 诊断出的死位 */
  deadCell?: Cell;
  /** 死位上每个候选片被拒的原因 */
  reasons?: string[];
}

export type SolveResult =
  | { status: 'solved'; solutions: Placement[][] }
  | { status: 'unsat'; explanation: Explanation };

export interface Hint {
  kind: 'placement' | 'conflict';
  message: string;
  /** placement 类提示给出的一步; 只提示, 不自动落盘 */
  move?: { tileId: string; rot: Dir; x: number; y: number };
  conflicts?: Conflict[];
}

interface Option {
  tile: Tile;
  rot: Dir;
  key: string;
}

interface DeepestFailure {
  depth: number;
  cell: Cell;
  reasons: string[];
}

function uniqueOptions(tile: Tile): Option[] {
  const seen = new Map<string, Dir>();
  for (const rot of DIRS) {
    const key = optionKey(tile, rot);
    if (!seen.has(key)) seen.set(key, rot);
  }
  return [...seen.entries()].map(([key, rot]) => ({ tile, rot, key }));
}

function candidateAt(
  board: Board,
  current: Placement[],
  tiles: Tile[],
  cell: Cell,
  unused: Tile[],
): { options: Option[]; reasons: string[] } {
  const options: Option[] = [];
  const reasons: string[] = [];
  for (const tile of unused) {
    for (const opt of uniqueOptions(tile)) {
      const conflicts = checkPlacement(
        board,
        current,
        tiles,
        tile,
        opt.rot,
        cell.x,
        cell.y,
      );
      if (conflicts.length === 0) options.push(opt);
      else reasons.push(...conflicts.map((c) => c.message));
    }
  }
  return { options, reasons: [...new Set(reasons)] };
}

function solutionSignature(sol: Placement[], tileById: Map<string, Tile>): string {
  return sol
    .map((p) => {
      const tile = tileById.get(p.tileId)!;
      const seq = DIRS.map((d) => rotatedEdge(tile, p.rot, d)).join('');
      return `${p.x},${p.y}=${p.tileId}:${seq}`;
    })
    .sort()
    .join(';');
}

interface SearchContext {
  board: Board;
  tiles: Tile[];
  tileById: Map<string, Tile>;
  limit: number;
  solutions: Placement[][];
  sigs: Set<string>;
  deepest: DeepestFailure | null;
  /** 搜索过程中到达过的最大已放置深度(用于"能填到第几块"诊断) */
  maxDepth: number;
}

function search(ctx: SearchContext, current: Placement[], depth: number): boolean {
  if (depth > ctx.maxDepth) ctx.maxDepth = depth;
  const board = ctx.board;
  const cells = freeCells(board, current);
  if (cells.length === 0) {
    const sig = solutionSignature(current, ctx.tileById);
    if (!ctx.sigs.has(sig)) {
      ctx.sigs.add(sig);
      ctx.solutions.push(current.map((p) => ({ ...p })));
    }
    return ctx.solutions.length >= ctx.limit;
  }

  const usedIds = new Set(current.map((p) => p.tileId));
  const unused = ctx.tiles.filter((t) => !usedIds.has(t.id));

  // MRV: 候选最少的剩余格先试
  let picked: { cell: Cell; options: Option[]; reasons: string[] } | null = null;
  for (const cell of cells) {
    const { options, reasons } = candidateAt(
      board,
      current,
      ctx.tiles,
      cell,
      unused,
    );
    if (options.length === 0) {
      if (!ctx.deepest || depth > ctx.deepest.depth) {
        ctx.deepest = { depth, cell, reasons };
      }
      return false;
    }
    if (!picked || options.length < picked.options.length) {
      picked = { cell, options, reasons };
    }
  }

  const triedKeys = new Set<string>();
  for (const opt of picked!.options) {
    if (triedKeys.has(opt.key)) continue; // 对称朝向去重(同片等价旋转只试一次)
    triedKeys.add(opt.key);
    current.push({
      tileId: opt.tile.id,
      x: picked!.cell.x,
      y: picked!.cell.y,
      rot: opt.rot,
      locked: false,
    });
    const stop = search(ctx, current, depth + 1);
    current.pop();
    if (stop) return true;
  }
  return false;
}

/** 按当前盘面找补全; 所有已摆片(锁住或未锁)与方向都被尊重 */
export function findCompletions(
  board: Board,
  placements: Placement[],
  tiles: Tile[],
  limit = 2,
): SolveResult {
  // 1. 边条件本身是否合法(必须挂在外边/洞边)
  const badConds = validateEdgeConditions(board);
  if (badConds.length > 0) {
    return {
      status: 'unsat',
      explanation: {
        title: '固定边条件位置不合法',
        detail: `有 ${badConds.length} 条边条件挂在两个普通格之间, 边条件只能设在外边界或洞边上`,
      },
    };
  }

  // 2. 已摆位置里的硬冲突 —— 有依据, 直接报告
  const conflicts = checkBoard(board, placements, tiles);
  if (conflicts.length > 0) {
    return {
      status: 'unsat',
      explanation: {
        title: '当前盘面存在冲突, 无法补全',
        detail: '先解决以下冲突后再找补全:',
        conflicts,
      },
    };
  }

  // 3. 数量匹配: 剩余格数必须等于未用片数
  const totalCells = allCells(board).length;
  const unusedCount = tiles.length - placements.length;
  if (totalCells !== tiles.length) {
    return {
      status: 'unsat',
      explanation: {
        title: '木片数量与盘面格数不匹配',
        detail: `可放片格子 ${totalCells} 个, 木片共 ${tiles.length} 块, 无法一一填满(每块恰用一次)`,
      },
    };
  }
  if (unusedCount < 0) {
    return {
      status: 'unsat',
      explanation: {
        title: '已放木片多于木片总数',
        detail: `盘面有 ${placements.length} 个放置, 但只定义了 ${tiles.length} 块木片`,
      },
    };
  }

  // 4. 回溯
  const ctx: SearchContext = {
    board,
    tiles,
    tileById: new Map(tiles.map((t) => [t.id, t])),
    limit,
    solutions: [],
    sigs: new Set(),
    deepest: null,
    maxDepth: 0,
  };
  search(ctx, placements, 0);

  if (ctx.solutions.length > 0) {
    return { status: 'solved', solutions: ctx.solutions };
  }

  // 5. 无解诊断
  if (ctx.deepest) {
    const d = ctx.deepest;
    return {
      status: 'unsat',
      explanation: {
        title: '补不到最后: 剩余位置已无可用片',
        detail: `摆到第 ${d.depth + 1} 步时, 位置 (${d.cell.x + 1},${
          d.cell.y + 1
        }) 与所有未用木片的所有(去重后)朝向都不兼容:`,
        deadCell: d.cell,
        reasons: d.reasons.slice(0, 8),
      },
    };
  }
  return {
    status: 'unsat',
    explanation: { title: '不存在补全', detail: '搜索了全部候选组合均失败' },
  };
}

/** 只提示一步, 不改盘面; 同样的布局重复调用结果一致 */
export function getHint(
  board: Board,
  placements: Placement[],
  tiles: Tile[],
): Hint {
  const result = findCompletions(board, placements, tiles, 2);

  if (result.status === 'unsat') {
    const e = result.explanation;
    const detail = e.reasons
      ? `${e.detail} ${e.reasons.slice(0, 3).join('; ')}`
      : e.detail;
    return {
      kind: 'conflict',
      message: `${e.title}。${detail}`,
      conflicts: e.conflicts,
    };
  }

  const occupied = new Set(placements.map((p) => `${p.x},${p.y}`));
  const firstFree = (sol: Placement[]) =>
    sol.find((p) => !occupied.has(`${p.x},${p.y}`));

  const moveA = firstFree(result.solutions[0]);
  if (!moveA) {
    return { kind: 'conflict', message: '盘面已经填满, 没有需要提示的一步' };
  }

  let forced = result.solutions.length === 1;
  if (!forced && result.solutions.length >= 2) {
    const moveB = firstFree(result.solutions[1]);
    forced =
      !!moveB &&
      moveB.tileId === moveA.tileId &&
      moveB.x === moveA.x &&
      moveB.y === moveA.y &&
      optionKey(
        tiles.find((t) => t.id === moveA.tileId)!,
        moveB.rot,
      ) ===
        optionKey(
          tiles.find((t) => t.id === moveA.tileId)!,
          moveA.rot,
        );
  }

  return {
    kind: 'placement',
    message: forced
      ? `可行且被唯一补全强制的一步: 把 ${moveA.tileId} 放到 (${moveA.x + 1},${
          moveA.y + 1
        }), 旋转 ${moveA.rot * 90}°`
      : `可行的一步(该盘面存在多种补全, 这只是其中之一): 把 ${
          moveA.tileId
        } 放到 (${moveA.x + 1},${moveA.y + 1}), 旋转 ${moveA.rot * 90}°`,
    move: { tileId: moveA.tileId, rot: moveA.rot, x: moveA.x, y: moveA.y },
  };
}

/** 统计补全总数(带 cap, 用于预设校验和测试) */
export function countSolutions(
  board: Board,
  placements: Placement[],
  tiles: Tile[],
  cap = 100,
): number {
  const r = findCompletions(board, placements, tiles, cap);
  return r.status === 'solved' ? r.solutions.length : 0;
}

export interface Diagnostic {
  /** 是否存在补全 */
  solvable: boolean;
  /** 搜索中能连续填到的最大块数; 等于总格数-1 即"局部都能放, 最后缺一块" */
  maxFillable: number;
  /** 无解时最深的死位信息(若有) */
  explanation?: Explanation;
}

/** 深度诊断: 除可解性外, 报告最多能填几块、卡在哪一格 */
export function diagnose(
  board: Board,
  placements: Placement[],
  tiles: Tile[],
): Diagnostic {
  const r = findCompletions(board, placements, tiles, 1);
  if (r.status === 'solved') return { solvable: true, maxFillable: allCells(board).length };
  // findCompletions 内部的 ctx 不外露, 重跑一次轻量搜索拿 maxDepth
  const ctx: SearchContext = {
    board,
    tiles,
    tileById: new Map(tiles.map((t) => [t.id, t])),
    limit: 1,
    solutions: [],
    sigs: new Set(),
    deepest: null,
    maxDepth: 0,
  };
  search(ctx, placements, 0);
  return {
    solvable: false,
    maxFillable: ctx.maxDepth,
    explanation: r.explanation,
  };
}
