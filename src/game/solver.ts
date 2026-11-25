// ============================================================
// 提示求解器：从「当前方块姿态 + 当前纸面印记」出发做状态空间搜索。
// 不携带任何预置开局解；当前局面若已无 forward 解，再沿撤销栈找
// 最近的可解祖先，给出“退回几步”的提示。
// ============================================================

import {
  Board,
  DIR_LIST,
  Dir,
  GameState,
  cellKey,
  faceColor,
  normalSlotsAllRight,
  slotAt,
  tryMove,
} from './engine';

export type HintAction = { type: 'move'; dir: Dir } | { type: 'stamp' };

export interface SolveOptions {
  stampedBlocks: boolean;
  /** 最多展开状态数，兜底防止异常题面卡死 */
  maxStates?: number;
}

interface PoisonResult {
  poison: boolean;
}

/**
 * 理性搜索只会补盖“正确颜色的目标格”。
 * 现有印记里只要出现：错色目标印 / 素格污渍 / 地板污渍，
 * 在不允许在 forward 搜索中撤销的前提下就是死局（必须退回）。
 */
function inspectExistingStamps(board: Board, state: GameState): { mask: number } | PoisonResult {
  let mask = 0;
  for (const sc of board.slotCells) {
    const got = state.stamps[cellKey(sc.x, sc.y)];
    if (got === undefined) continue;
    if (got !== sc.def.need) return { poison: true };
    mask |= 1 << sc.index;
  }
  // 任何不在“正确目标印”集合里的印记都是污渍
  const rightKeys = new Set(
    board.slotCells
      .filter((sc) => state.stamps[cellKey(sc.x, sc.y)] === sc.def.need)
      .map((sc) => cellKey(sc.x, sc.y)),
  );
  for (const k of Object.keys(state.stamps)) {
    if (!rightKeys.has(k)) return { poison: true };
  }
  // 封口顺序异常：已有封口印，但普通目标尚未全对（正常 UI 不会产生）
  const anySeal = board.slotCells.some((sc) => sc.def.seal && rightKeys.has(cellKey(sc.x, sc.y)));
  if (anySeal && !normalSlotsAllRight(state, board)) return { poison: true };
  return { mask };
}

interface BfsNode {
  key: string;
  parent: string | null;
  action: HintAction | null;
}

/**
 * 从当前局面搜索一条通关操作序列（含 move / stamp）。
 * 无解返回 null。
 */
export function solveFrom(board: Board, state: GameState, opts: SolveOptions): HintAction[] | null {
  const inspected = inspectExistingStamps(board, state);
  if ('poison' in inspected) return null;

  const k = board.slotCells.length;
  const fullMask = (1 << k) - 1;
  const maxStates = opts.maxStates ?? 200_000;

  const startKey = state.x + ',' + state.y + '|' + state.ori + '|' + inspected.mask;
  const nodes = new Map<string, BfsNode>();
  nodes.set(startKey, { key: startKey, parent: null, action: null });
  const queue: string[] = [startKey];
  let head = 0;

  const parseKey = (key: string): { x: number; y: number; ori: string; mask: number } => {
    const [pos, ori, m] = key.split('|');
    const [x, y] = pos.split(',').map(Number);
    return { x, y, ori, mask: Number(m) };
  };

  while (head < queue.length) {
    const key = queue[head++];
    const cur = parseKey(key);
    if (cur.mask === fullMask) {
      // 回溯动作序列
      const actions: HintAction[] = [];
      let ck: string | null = key;
      while (ck) {
        const node = nodes.get(ck);
        if (!node || !node.parent) break;
        if (node.action) actions.push(node.action);
        ck = node.parent;
      }
      actions.reverse();
      return actions;
    }
    if (nodes.size > maxStates) return null;

    const curState: GameState = { x: cur.x, y: cur.y, ori: cur.ori, stamps: {} };

    // 1) 盖印：仅当脚下是“需要当前贴底色”的目标格，且封口时机合法
    const sc = slotAt(board, cur.x, cur.y);
    if (sc && !(cur.mask & (1 << sc.index))) {
      const bottom = faceColor(cur.ori, 'B');
      const sealOk = !sc.def.seal || board.slotCells.every(
        (o) => o.def.seal || (cur.mask & (1 << o.index)),
      );
      if (bottom === sc.def.need && sealOk) {
        const nm = cur.mask | (1 << sc.index);
        const nk = cur.x + ',' + cur.y + '|' + cur.ori + '|' + nm;
        if (!nodes.has(nk)) {
          nodes.set(nk, { key: nk, parent: key, action: { type: 'stamp' } });
          queue.push(nk);
        }
      }
    }

    // 2) 四个方向滚动（tryMove 负责墙 / 印阻挡判定；stamps 只用于阻挡查询）
    const blockingStamps: GameState['stamps'] = {};
    if (opts.stampedBlocks) {
      for (const slot of board.slotCells) {
        if (cur.mask & (1 << slot.index)) blockingStamps[cellKey(slot.x, slot.y)] = slot.def.need;
      }
    }
    const probeState: GameState = { ...curState, stamps: blockingStamps };
    for (const dir of DIR_LIST) {
      const res = tryMove(probeState, board, dir, opts.stampedBlocks);
      if (!res.ok) continue;
      const nk = res.state.x + ',' + res.state.y + '|' + res.state.ori + '|' + cur.mask;
      if (!nodes.has(nk)) {
        nodes.set(nk, { key: nk, parent: key, action: { type: 'move', dir } });
        queue.push(nk);
      }
    }
  }
  return null;
}

// ---------- 带退回建议的提示 ----------
export type HintResult =
  | { kind: 'won'; text: string }
  | { kind: 'next'; action: HintAction; pathLength: number; text: string }
  | {
      kind: 'undo';
      undoSteps: number;
      actionThere: HintAction | null;
      text: string;
    }
  | { kind: 'dead-initial'; text: string };

/**
 * @param past 当前局面之前的快照栈（past[0] 是初始局）
 * @param present 当前快照
 */
export function buildHint(
  board: Board,
  past: GameState[],
  present: GameState,
  stampedBlocks: boolean,
  won: boolean,
): HintResult {
  if (won) return { kind: 'won', text: '所有色签都已归位，这一局已经完成啦。' };

  const here = solveFrom(board, present, { stampedBlocks });
  if (here && here.length > 0) {
    return { kind: 'next', action: here[0], pathLength: here.length, text: describeAction(here[0], board, present) };
  }
  if (here && here.length === 0) {
    // mask 已满但 evaluate 未判赢（理论上只会因污渍导致），走退回逻辑
  }

  // 当前无解：从最近的祖先往前找可解局面
  for (let i = past.length - 1; i >= 0; i--) {
    const ancestor = past[i];
    const path = solveFrom(board, ancestor, { stampedBlocks });
    if (path && path.length > 0) {
      const steps = past.length - i;
      const thereAction = path[0];
      const actionText = describeAction(thereAction, board, ancestor);
      return {
        kind: 'undo',
        undoSteps: steps,
        actionThere: thereAction,
        text:
          steps === 1
            ? `当前纸面已经走不通。撤销上一步，然后：${actionText}`
            : `当前局面无解，连续撤销 ${steps} 步回到分叉前，然后：${actionText}`,
      };
    }
  }

  return {
    kind: 'dead-initial',
    text: '从这道题的初始姿态起就搜不到合法盖印路线，可能是题面/规则开关配置冲突；试试重置或更换起手朝向。',
  };
}

export function describeAction(action: HintAction, board: Board, state: GameState): string {
  if (action.type === 'stamp') {
    const sc = slotAt(board, state.x, state.y);
    const need = sc?.def.need;
    return `按「盖印」（空格），把贴地的色签盖下${need ? `——本格需要「${need}」` : ''}。`;
  }
  const v = { N: '上（北）', E: '右（东）', S: '下（南）', W: '左（西）' }[action.dir];
  return `向${v}滚一格。`;
}
