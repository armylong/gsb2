import type {
  Board,
  EventType,
  LocationDef,
  MoveKind,
  MoveResult,
  StartClue,
  State,
} from './types';

export const locationById = (board: Board, id: string): LocationDef => {
  const found = board.locations.find((l) => l.id === id);
  if (!found) throw new Error(`unknown location: ${id}`);
  return found;
};

export const animalById = (board: Board, id: string) =>
  board.animals.find((a) => a.id === id)!;

export const nameOf = (board: Board, locationId: string) =>
  locationById(board, locationId).name;

/** 事件卡上的动物称呼。 */
export const display = (board: Board, animalId: string) => {
  const a = animalById(board, animalId);
  return `#${a.number} ${a.name}`;
};

/** 某地点的当前占位者。 */
export const occupantOf = (state: State, locationId: string): string | undefined =>
  Object.keys(state).find((animalId) => state[animalId] === locationId);

/** 状态合法性：每只动物恰好一个地点，每个地点至多一只。 */
export function assertState(board: Board, state: State): void {
  const used = new Set<string>();
  for (const animal of board.animals) {
    const loc = state[animal.id];
    if (!loc) throw new Error(`state missing animal ${animal.id}`);
    if (!board.locations.some((l) => l.id === loc)) {
      throw new Error(`unknown location ${loc} for ${animal.id}`);
    }
    if (used.has(loc)) throw new Error(`two animals at ${loc}`);
    used.add(loc);
  }
  if (Object.keys(state).length !== board.animals.length) {
    throw new Error('state has unknown animals');
  }
}

export function sameState(a: State, b: State): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

export const SORTED_STATE_KEY = (state: State) =>
  Object.entries(state)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}@${v}`)
    .join('|');

/** 从状态变化里能看出来的「记录类型」。 */
export function recordOf(board: Board, from: State, to: State): EventType {
  const moved = board.animals.filter((a) => from[a.id] !== to[a.id]);
  if (moved.length === 0) return 'wait';
  if (moved.length !== 1) throw new Error('exactly one animal should move per round');
  const animal = moved[0]!;
  const dest = locationById(board, to[animal.id]!);
  return dest.kind === 'lawn' ? 'lawn' : 'island';
}

/**
 * 规则核心：某只动物此刻的全部可行动作。界面上所有提示都来自这里。
 *
 * 1. 每座岛有且仅有一条固定方向的下游水道；草坪没有；
 * 2. 下游空着时，必须游过去，没有别的选择；
 * 3. 下游被占时，停在原处，或退到本岛相邻的空草坪，二选一；
 * 4. 同一个地点至多一只动物，动物数始终不变；
 * 5. 草坪上的动物不再行动。
 */
export function movesFor(board: Board, state: State, actor: string): MoveResult[] {
  assertState(board, state);
  const here = state[actor]!;
  const outlet = board.outlets[here];
  if (outlet === undefined) throw new Error(`no outlet entry for ${here}`);
  if (outlet === null) return []; // 草坪：没有出口，也动不了

  const blocker = occupantOf(state, outlet);
  if (!blocker) {
    return [
      {
        actor,
        from: here,
        to: outlet,
        kind: 'swim',
        note: `${nameOf(board, here)}的水道只通向${nameOf(board, outlet)}，只能游过去。`,
      },
    ];
  }

  const options: MoveResult[] = [
    {
      actor,
      from: here,
      to: here,
      kind: 'wait',
      blockerId: blocker,
      note: `${nameOf(board, outlet)}被${display(board, blocker)}占着，只能停在${nameOf(board, here)}。`,
    },
  ];

  const lawn = board.grassFrom[here];
  if (lawn && !occupantOf(state, lawn)) {
    options.push({
      actor,
      from: here,
      to: lawn,
      kind: 'grass',
      blockerId: blocker,
      note: `${nameOf(board, outlet)}被${display(board, blocker)}占着，可以退到旁边的${nameOf(board, lawn)}。`,
    });
  }
  return options;
}

export function applyMove(board: Board, state: State, move: MoveResult): State {
  assertState(board, state);
  const legal = movesFor(board, state, move.actor).some(
    (m) => m.to === move.to && m.kind === move.kind,
  );
  if (!legal) {
    throw new Error(
      `illegal move: ${move.actor} ${move.from}->${move.to} (${move.kind})`,
    );
  }
  return { ...state, [move.actor]: move.to };
}

/** 全部合法状态（5 只动物 9 个地点 = 15120 种，穷举完全够用）。 */
export function allStates(board: Board): State[] {
  const ids = board.animals.map((a) => a.id);
  const locs = board.locations.map((l) => l.id);
  const out: State[] = [];
  const pick = (i: number, used: Set<string>, acc: Record<string, string>) => {
    if (i === ids.length) {
      out.push({ ...acc });
      return;
    }
    for (const loc of locs) {
      if (used.has(loc)) continue;
      used.add(loc);
      acc[ids[i]!] = loc;
      pick(i + 1, used, acc);
      used.delete(loc);
    }
  };
  pick(0, new Set(), {});
  return out;
}

export interface Predecessor {
  readonly prev: State;
  readonly move: MoveResult;
}

/**
 * 反推核心：当前盘 + 「这一回合的记录类型」 + 「这一回合是谁动的」→ 所有前驱。
 *
 * 每个候选都会真的被正向 movesFor / applyMove 验证一遍，所以「预览的可能
 * 前一步」全都是按同一套规则正向确实能走回当前状态的；不仅仅是形状像。
 */
export function predecessors(
  board: Board,
  state: State,
  actor: string,
  event: EventType,
): Predecessor[] {
  assertState(board, state);
  const now = state[actor]!;
  const here = locationById(board, now);
  const out: Predecessor[] = [];

  const accept = (prev: State, move: MoveResult) => {
    if (!legalForward(board, prev, move)) return;
    // 额外校验：正向走这一步记录类型确实对得上。
    const after = applyMove(board, prev, move);
    if (!sameState(after, state)) return;
    if (recordOf(board, prev, after) !== event) return;
    out.push({ prev, move });
  };

  if (event === 'island') {
    if (here.kind !== 'island') return out;
    for (const from of board.locations) {
      if (from.kind !== 'island') continue;
      if (board.outlets[from.id] !== now) continue;
      // 上一盘里 from 必须空着，否则会有两只动物挤在同一座岛。
      if (occupantOf(state, from.id)) continue;
      const prev: State = { ...state, [actor]: from.id };
      accept(prev, {
        actor,
        from: from.id,
        to: now,
        kind: 'swim',
        note: `${nameOf(board, from.id)}的水道通向${nameOf(board, now)}，游了过来。`,
      });
    }
    return out;
  }

  if (event === 'lawn') {
    if (here.kind !== 'lawn') return out;
    // 解释一：从上游岛直接游进草坪（该岛出口就是草坪）。
    for (const from of board.locations) {
      if (from.kind !== 'island') continue;
      if (board.outlets[from.id] !== now) continue;
      if (occupantOf(state, from.id)) continue;
      const prev: State = { ...state, [actor]: from.id };
      accept(prev, {
        actor,
        from: from.id,
        to: now,
        kind: 'swim',
        note: `${nameOf(board, from.id)}的水道能直接游到${nameOf(board, now)}。`,
      });
    }
    // 解释二：从岛上退过来（该岛草坪就是这片草坪，且它的下游被占）。
    for (const from of board.locations) {
      if (from.kind !== 'island') continue;
      if (board.grassFrom[from.id] !== now) continue;
      const outlet = board.outlets[from.id];
      if (!outlet) continue;
      if (occupantOf(state, from.id)) continue;
      const prev: State = { ...state, [actor]: from.id };
      const blocker = occupantOf(state, outlet);
      if (!blocker) continue;
      accept(prev, {
        actor,
        from: from.id,
        to: now,
        kind: 'grass',
        blockerId: blocker,
        note: `${nameOf(board, outlet)}被${display(board, blocker)}占着，从${nameOf(board, from.id)}退到${nameOf(board, now)}。`,
      });
    }
    return out;
  }

  // wait：这一步原地不动。上一盘里 actor 就在这儿，而且必须真有走不了的理由。
  const outlet = board.outlets[now];
  if (outlet === undefined) return out;
  if (outlet === null) return out; // 草坪上不可能等
  const blocker = occupantOf(state, outlet);
  if (!blocker || blocker === actor) return out; // 出口空着时不可能等
  accept(
    { ...state },
    {
      actor,
      from: now,
      to: now,
      kind: 'wait',
      blockerId: blocker,
      note: `${nameOf(board, outlet)}被${display(board, blocker)}占着，只能停在${nameOf(board, now)}。`,
    },
  );
  return out;
}

function legalForward(board: Board, state: State, move: MoveResult): boolean {
  return movesFor(board, state, move.actor).some(
    (m) => m.to === move.to && m.kind === move.kind,
  );
}

/** 这一步为什么算这个记录类型（用于事件卡的「凭什么」）。 */
export function explainRecord(board: Board, from: State, to: State): string {
  const moved = board.animals.filter((a) => from[a.id] !== to[a.id]);
  if (moved.length === 0) return '原地未动';
  const animal = moved[0]!;
  const dest = locationById(board, to[animal.id]!);
  return `${display(board, animal.id)} → ${dest.name}`;
}

export function replay(
  board: Board,
  start: State,
  moves: readonly MoveResult[],
): State {
  let state = start;
  for (const move of moves) state = applyMove(board, state, move);
  return state;
}

export function matchesClue(state: State, clue?: StartClue): boolean {
  if (!clue) return true;
  for (const loc of clue.emptyLocations ?? []) {
    if (occupantOf(state, loc)) return false;
  }
  for (const [animal, loc] of Object.entries(clue.fixed ?? {})) {
    if (state[animal] !== loc) return false;
  }
  return true;
}

/**
 * 从终态出发、按记录序列倒推的完整树。
 * 用于本地核对、关卡自检与分叉视图。
 */
export interface ReverseNode {
  readonly state: State;
  /** 已经往回走了几步（0 = 终态）。 */
  readonly depth: number;
  /** 本回合的记录类型。根节点没有。 */
  readonly event?: EventType;
  /** 本回合的动作者。根节点没有。 */
  readonly actor?: string;
  readonly move?: MoveResult;
  /** 本回合所有候选（动作者 × 前驱）的数量。根节点是 1。 */
  readonly branchCount: number;
  readonly parent?: ReverseNode;
}

export function reverseTree(
  board: Board,
  finalState: State,
  events: readonly EventType[],
  options: { clue?: StartClue; pruneByClue?: boolean } = {},
): ReverseNode[] {
  const leaves: ReverseNode[] = [];
  const walk = (node: ReverseNode) => {
    if (node.depth === events.length) {
      if (!options.pruneByClue || matchesClue(node.state, options.clue)) {
        leaves.push(node);
      }
      return;
    }
    const event = events[events.length - 1 - node.depth]!;
    const candidates: { actor: string; pred: Predecessor }[] = [];
    for (const animal of board.animals) {
      for (const pred of predecessors(board, node.state, animal.id, event)) {
        candidates.push({ actor: animal.id, pred });
      }
    }
    for (const { actor, pred } of candidates) {
      walk({
        state: pred.prev,
        depth: node.depth + 1,
        event,
        actor,
        move: pred.move,
        branchCount: candidates.length,
        parent: node,
      });
    }
  };
  walk({ state: finalState, depth: 0, branchCount: 1 });
  return leaves;
}

/** 叶子上溯还原正向链：start → moves → 终态。 */
export function chainOf(node: ReverseNode): {
  start: State;
  moves: MoveResult[];
  end: State;
} {
  // 叶子在 depth=n，它的 move 是第 1 回合的动作；往上走就是时间顺序。
  const moves: MoveResult[] = [];
  let cur: ReverseNode | undefined = node;
  while (cur?.move) {
    moves.push(cur.move);
    cur = cur.parent;
  }
  let end = node.state;
  let cursor: ReverseNode | undefined = node;
  while (cursor.parent) cursor = cursor.parent;
  end = cursor.state;
  return { start: node.state, moves, end };
}

/** 当前盘 + 记录类型 → 全部候选（用于「预览前一步」面板）。 */
export function candidateMoves(
  board: Board,
  state: State,
  event: EventType,
): { actor: string; move: MoveResult; prev: State }[] {
  const out: { actor: string; move: MoveResult; prev: State }[] = [];
  for (const animal of board.animals) {
    for (const pred of predecessors(board, state, animal.id, event)) {
      out.push({ actor: animal.id, move: pred.move, prev: pred.prev });
    }
  }
  return out;
}

/** 所有候选里，同一动作者同一前驱可能对应两种机制（水/草）。 */
export interface ExplainedCandidate {
  readonly actor: string;
  readonly prev: State;
  readonly move: MoveResult;
  readonly record: EventType;
}

export function candidateExplanations(
  board: Board,
  state: State,
  event: EventType,
): ExplainedCandidate[] {
  return candidateMoves(board, state, event).map((c) => ({
    actor: c.actor,
    prev: c.prev,
    move: c.move,
    record: recordOf(board, c.prev, state),
  }));
}

/** 统计一棵反推树每回合的宽度（从终态往回）。 */
export function treeWidths(root: State, board: Board, events: readonly EventType[]): number[] {
  const widths: number[] = [];
  let frontier: State[] = [root];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const next: State[] = [];
    let count = 0;
    for (const state of frontier) {
      for (const animal of board.animals) {
        for (const pred of predecessors(board, state, animal.id, event)) {
          next.push(pred.prev);
          count++;
        }
      }
    }
    widths.push(count);
    frontier = next;
  }
  return widths;
}

export type { MoveKind };
