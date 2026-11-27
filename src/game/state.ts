import {
  SORTED_STATE_KEY,
  applyMove,
  candidateExplanations,
  chainOf,
  matchesClue,
  movesFor,
  occupantOf,
  predecessors,
  recordOf,
  reverseTree,
  type ExplainedCandidate,
  type ReverseNode,
} from '../engine/engine';
import type { EventType, MoveResult, Puzzle, State } from '../engine/types';

export type Phase = 'demo' | 'solve' | 'solved';

/** 反推时用户的一次选择：选第几回合的哪个候选。 */
export interface Chosen {
  /** 从终态往回数第几步（1 = 最后一回合）。 */
  readonly step: number;
  readonly actor: string;
  readonly move: MoveResult;
  readonly prev: State;
}

/**
 * 一次尝试：从终态出发，沿用户选的前驱一路往回。stepChosen 里的每一项
 * 都必须与上一个 prev 对得上，否则整次尝试作废。
 */
export interface Attempt {
  readonly chosen: readonly Chosen[];
  readonly state: State;
  /** 下一个要答的回合（从终态往回），= chosen.length。 */
  readonly nextStep: number;
  readonly dead: string | null;
}

export interface GameState {
  readonly puzzle: Puzzle;
  readonly phase: Phase;
  /** 当前显示的盘面。反推时是「往回走到这里」。 */
  readonly state: State;
  /** 用户已经做出的反推选择。 */
  readonly attempt: Attempt;
  /** 撤销栈：每次确认候选时压入上一份 attempt。 */
  readonly undo: readonly Attempt[];
  /** 选中的候选（预览态）。 */
  readonly preview: ExplainedCandidate | null;
  /** 候选面板是否打开。 */
  readonly browsing: boolean;
  /** 刚刚被接受/拒绝的反馈。 */
  readonly flash: { kind: 'ok' | 'bad' | 'info'; text: string } | null;
}

function eventCn(e: EventType) {
  return e === 'island' ? '岛上' : e === 'lawn' ? '草坪' : '原地';
}

export const eventAtStep = (puzzle: Puzzle, step: number): EventType =>
  puzzle.events[puzzle.events.length - 1 - step]!;

export const roundOfStep = (puzzle: Puzzle, step: number) =>
  puzzle.events.length - step;

export function initialState(puzzle: Puzzle): GameState {
  return {
    puzzle,
    phase: puzzle.mode === 'tutorial' ? 'demo' : 'solve',
    state: puzzle.finalState,
    attempt: {
      chosen: [],
      state: puzzle.finalState,
      nextStep: 0,
      dead: null,
    },
    undo: [],
    preview: null,
    browsing: false,
    flash: null,
  };
}

/** 当前这一步的全部候选。 */
export function currentCandidates(g: GameState): ExplainedCandidate[] {
  if (g.attempt.dead) return [];
  if (g.attempt.nextStep >= g.puzzle.events.length) return [];
  const event = eventAtStep(g.puzzle, g.attempt.nextStep);
  return candidateExplanations(g.puzzle.board, g.attempt.state, event);
}

/**
 * 确认一个候选：先按正向规则验证（predecessor 内部已经验过，但这里再验一次
 * 用户看到的那条），然后推进 attempt；如果已经走到起点，就结算。
 */
export function commitCandidate(g: GameState, cand: ExplainedCandidate): GameState {
  const puzzle = g.puzzle;
  if (g.attempt.dead) return g;
  const expectedStep = g.attempt.nextStep;
  const event = eventAtStep(puzzle, expectedStep);
  if (cand.record !== event) {
    return {
      ...g,
      flash: { kind: 'bad', text: `这一回合应该是「${eventCn(event)}」，与候选不符。` },
    };
  }
  // 用户看到的这条前驱得真的能正向走到当前盘
  const legal = movesFor(puzzle.board, cand.prev, cand.actor).some(
    (m) => m.to === cand.move.to && m.kind === cand.move.kind,
  );
  if (!legal || recordOf(puzzle.board, cand.prev, g.attempt.state) !== event) {
    return { ...g, flash: { kind: 'bad', text: '这条候选过不了正向规则。' } };
  }

  const chosen: Chosen = {
    step: expectedStep,
    actor: cand.actor,
    move: cand.move,
    prev: cand.prev,
  };
  const nextAttempt: Attempt = {
    chosen: [...g.attempt.chosen, chosen],
    state: cand.prev,
    nextStep: expectedStep + 1,
    dead: null,
  };

  // 走到起点：检查线索
  if (nextAttempt.nextStep === puzzle.events.length) {
    const clueOk = matchesClue(nextAttempt.state, puzzle.clue);
    if (!clueOk) {
      return {
        ...g,
        attempt: {
          ...nextAttempt,
          dead:
            `走到了一个清晨盘，但它跟早晨线索对不上（${puzzle.clue?.text ?? '—'}）。` +
            '可以撤销到刚才的分叉处换一条解释。',
        },
        state: nextAttempt.state,
        preview: null,
        browsing: false,
        flash: { kind: 'bad', text: '这个清晨盘违反早晨线索。撤销一步，换另一条解释。' },
      };
    }
    const ok = verifyForward(puzzle, nextAttempt);
    if (!ok) {
      return {
        ...g,
        attempt: { ...nextAttempt, dead: '回放核对失败：这条链走不回终态。' },
        state: nextAttempt.state,
        preview: null,
        browsing: false,
        flash: { kind: 'bad', text: '回放核对失败。' },
      };
    }
    return {
      ...g,
      attempt: nextAttempt,
      state: nextAttempt.state,
      phase: 'solved',
      preview: null,
      browsing: false,
      flash: { kind: 'ok', text: '清晨盘成立：正向回放精确命中终态和事件顺序。' },
    };
  }

  return {
    ...g,
    attempt: nextAttempt,
    state: cand.prev,
    undo: [...g.undo, g.attempt],
    preview: null,
    browsing: false,
    flash: { kind: 'ok', text: `第 ${roundOfStep(puzzle, expectedStep)} 回合定下了：${cand.move.note}` },
  };
}

/** 撤销到上一个分叉（或更早）。 */
export function undoOne(g: GameState): GameState {
  if (g.undo.length === 0 && !g.attempt.dead) return g;
  if (g.undo.length === 0) {
    // 死路也算撤销一步：回到上一个成功状态
    return {
      ...g,
      attempt: { ...g.attempt, dead: null },
      state: g.attempt.chosen.length
        ? g.attempt.chosen[g.attempt.chosen.length - 1]!.prev
        : g.puzzle.finalState,
      flash: { kind: 'info', text: '撤销了这一步，重新选。' },
    };
  }
  const prev = g.undo[g.undo.length - 1]!;
  return {
    ...g,
    attempt: prev,
    undo: g.undo.slice(0, -1),
    state: prev.state,
    phase: 'solve',
    preview: null,
    browsing: false,
    flash: { kind: 'info', text: '撤销到上一个分叉处。' },
  };
}

/**
 * 倒退到最近一个真正的分叉（候选 ≥ 2）。dead end 时用：错误选择发生在一个
 * 有多个候选的回合，所以退回那里才能换一条解释；若整条链都没有分叉，
 * 再退到最近一个仍有候选的位置。
 */
export function backtrackToBranch(g: GameState): GameState {
  let cur = g;
  let best: GameState | null = null;
  let fallback: GameState | null = null;
  let guard = 0;
  while (guard++ < 64) {
    const cands = cur.attempt.dead ? 0 : currentCandidates(cur).length;
    if (!cur.attempt.dead) {
      if (cands >= 2) {
        best = cur;
        break;
      }
      if (cands >= 1 && !fallback) fallback = cur;
    }
    if (cur.undo.length === 0) break;
    const prev = cur.undo[cur.undo.length - 1]!;
    cur = {
      ...cur,
      attempt: prev,
      undo: cur.undo.slice(0, -1),
      state: prev.state,
      preview: null,
      browsing: false,
      phase: 'solve',
    };
  }
  const target = best ?? fallback ?? cur;
  return { ...target, phase: 'solve', preview: null, browsing: false };
}

export function resetAttempt(g: GameState): GameState {
  return {
    ...initialState(g.puzzle),
    flash: { kind: 'info', text: '回到终态，重新开始。' },
  };
}

/** 把用户一路选出来的链还原成正向动作序列。 */
export function userChain(g: GameState): MoveResult[] {
  // step 越大越靠近清晨：正向回放要按 step 降序。
  return [...g.attempt.chosen]
    .sort((a, b) => b.step - a.step)
    .map((c) => c.move);
}

export function userStart(g: GameState): State | null {
  if (g.attempt.chosen.length !== g.puzzle.events.length) return null;
  return g.attempt.state;
}

/** 正向回放核对：起点 + 动作 → 终态，事件顺序也必须一致。 */
export function verifyForward(puzzle: Puzzle, attempt: Attempt): boolean {
  if (attempt.chosen.length !== puzzle.events.length) return false;
  const moves = [...attempt.chosen].sort((a, b) => b.step - a.step).map((c) => c.move);
  let s = attempt.state;
  const events: EventType[] = [];
  try {
    for (const m of moves) {
      const n = applyMove(puzzle.board, s, m);
      events.push(recordOf(puzzle.board, s, n));
      s = n;
    }
  } catch {
    return false;
  }
  return (
    SORTED_STATE_KEY(s) === SORTED_STATE_KEY(puzzle.finalState) &&
    events.join('') === puzzle.events.join('')
  );
}

/* ------------------------------------------------------------------ */
/* 教学盘：正向演示                                                   */
/* ------------------------------------------------------------------ */

export interface DemoStep {
  readonly actor: string;
  readonly kind: 'swim' | 'grass' | 'wait';
  readonly from: string;
  readonly to: string;
  readonly note: string;
  readonly event: EventType;
  readonly blockerId?: string;
  readonly stateBefore: State;
  readonly stateAfter: State;
}

/**
 * 生成教学盘的正向剧本：从清晨盘出发，找出唯一一条「每回合只动一只动物、
 * 事件顺序与 puzzle.events 一致、终点等于 finalState」的链路。
 * 训练盘规模很小，穷举即可；这样界面上演示的每一步都真的能正向走通。
 */
export function buildDemoScript(puzzle: Puzzle): DemoStep[] {
  if (!puzzle.startState) return [];
  const board = puzzle.board;
  const want = puzzle.events;
  const target = puzzle.finalState;

  const search = (state: State, steps: DemoStep[]): DemoStep[] | null => {
    if (steps.length === want.length) {
      return SORTED_STATE_KEY(state) === SORTED_STATE_KEY(target) ? steps : null;
    }
    const expected = want[steps.length]!;
    for (const animal of board.animals) {
      for (const move of movesFor(board, state, animal.id)) {
        const next = applyMove(board, state, move);
        const event = recordOf(board, state, next);
        if (event !== expected) continue;
        const step: DemoStep = {
          actor: animal.id,
          kind: move.kind,
          from: move.from,
          to: move.to,
          note: move.note,
          event,
          blockerId: move.blockerId,
          stateBefore: state,
          stateAfter: next,
        };
        const found = search(next, [...steps, step]);
        if (found) return found;
      }
    }
    return null;
  };

  return search(puzzle.startState, []) ?? [];
}

export { occupantOf, predecessors, reverseTree, chainOf };
export type { ExplainedCandidate, ReverseNode };
