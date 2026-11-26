import { recordToConstraint, type Constraint } from './board';
import { Solver, findForcedCells, explainForcedCell } from './solver';
import type { Board } from './board';
import type { Cell, Marker, ProbeRecord } from '../types';

export type HintOutcome =
  | { kind: 'hint'; cell: Cell; solid: 0 | 1; recordIds: number[] }
  | { kind: 'unknown'; reason: string };

/**
 * 提示：在“与全部公开读数相容”的所有底图里，找一个取值被唯一确定、
 * 且玩家还没正确标记过的非墙格。没有这种格子时回答“信息不够”。
 * 解数达到上限（底图可能还有更多）时不把任何格当成必然，保守回答信息不够。
 */
export function requestHint(
  board: Board,
  records: ProbeRecord[],
  markers: Map<string, Marker>,
): HintOutcome {
  if (records.length === 0) {
    return { kind: 'unknown', reason: '还没有任何读数，先放一枚探头吧' };
  }
  const solver = new Solver(board, buildConstraints(board, records));
  // 只需知道“唯一解还是多解”，但找必然格时多取一些以提高覆盖面
  const result = solver.solve({ maxSolutions: 5000 });
  if (result.solutions.length === 0) {
    return { kind: 'unknown', reason: '现有读数互相矛盾，没有任何底图能同时满足，请检查读数记录' };
  }
  if (result.capped) {
    return { kind: 'unknown', reason: `相容底图超过 ${5000} 种，现有读数还不足以确定任何一格` };
  }
  if (result.solutions.length > 1) {
    // 多解不代表没有必然格：部分格可能在所有解里取值相同
  }

  const forced = findForcedCells(result);
  const candidates = forced.filter((f) => {
    const marker = markers.get(`${f.r},${f.c}`);
    // 已正确标记的格不再提示；标记错了的格优先提示纠正
    if (f.solid === 1 && marker === 'safe') return false;
    if (f.solid === 0 && marker === 'void') return false;
    return true;
  });

  if (candidates.length === 0) {
    return {
      kind: 'unknown',
      reason: result.solutions.length > 1
        ? '还有多个相符布局，且当前能确定的格子你都已标记，信息不够——继续探测'
        : '底图已被读数完全确定，且你都标记过了',
    };
  }

  // 优先纠正错误标记，其次给安全格，再给空洞格
  const wrong = candidates.find((f) => {
    const m = markers.get(`${f.r},${f.c}`);
    return (f.solid === 1 && m === 'void') || (f.solid === 0 && m === 'safe');
  });
  const pick = wrong ?? candidates.find((f) => f.solid === 1) ?? candidates[0];
  const constraints = buildConstraints(board, records);
  const recordIds = explainForcedCell(board, constraints, { r: pick.r, c: pick.c }, pick.solid);
  return { kind: 'hint', cell: { r: pick.r, c: pick.c }, solid: pick.solid, recordIds };
}

/** 用 Board 统一的非墙格编号把读数记录转成约束 */
export function buildConstraints(board: Board, records: ProbeRecord[]): Constraint[] {
  return records.map((rec) => recordToConstraint(rec, (r, c) => board.openCellIndex(r, c)));
}
