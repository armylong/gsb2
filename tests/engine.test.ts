import { describe, expect, it } from 'vitest';
import { boards } from '../src/engine/boards';
import {
  SORTED_STATE_KEY,
  allStates,
  applyMove,
  candidateExplanations,
  chainOf,
  matchesClue,
  movesFor,
  occupantOf,
  predecessors,
  recordOf,
  replay,
  reverseTree,
} from '../src/engine/engine';
import type { EventType, State } from '../src/engine/types';
import { puzzles } from '../src/game/puzzles';
import {
  backtrackToBranch,
  buildDemoScript,
  commitCandidate,
  currentCandidates,
  initialState,
  resetAttempt,
  undoOne,
  userChain,
  verifyForward,
} from '../src/game/state';

const key = (s: State) => SORTED_STATE_KEY(s);

describe('规则', () => {
  it('出口空着时唯一动作是游向下游', () => {
    const state: State = { a1: 'i1', a2: 'i4', a3: 'i3', a4: 'l2' };
    const moves = movesFor(boards.training, state, 'a1');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: 'swim', to: 'i2' });
  });

  it('出口被占时可以原地，也可以退到空草坪', () => {
    const state: State = { a1: 'i2', a2: 'i3', a3: 'i4', a4: 'l2' };
    const moves = movesFor(boards.training, state, 'a1');
    expect(moves.map((m) => m.kind).sort()).toEqual(['grass', 'wait']);
    for (const m of moves) expect(m.blockerId).toBe('a2');
  });

  it('出口被占但草坪也满时只剩原地', () => {
    // 中洲草坪被 a4 占着
    const state: State = { a1: 'i2', a2: 'i3', a3: 'i4', a4: 'l3' };
    const moves = movesFor(boards.training, state, 'a1');
    expect(moves.map((m) => m.kind)).toEqual(['wait']);
  });

  it('草坪没有出口，动物动不了', () => {
    const state: State = { a1: 'i1', a2: 'i4', a3: 'i3', a4: 'l2' };
    expect(movesFor(boards.training, state, 'a4')).toHaveLength(0);
  });

  it('水道单向：不能游回上游', () => {
    const board = boards.training;
    const state: State = { a1: 'i2', a2: 'i4', a3: 'i3', a4: 'l2' };
    const targets = movesFor(board, state, 'a1').map((m) => m.to);
    expect(targets).not.toContain('i1');
  });

  it('applyMove 拒绝非法动作', () => {
    const board = boards.training;
    const state: State = { a1: 'i1', a2: 'i4', a3: 'i3', a4: 'l2' };
    expect(() =>
      applyMove(board, state, {
        actor: 'a1',
        from: 'i1',
        to: 'i3',
        kind: 'swim',
        note: '',
      }),
    ).toThrow();
  });

  it('每个正向动作都能被 predecessors 找回', () => {
    for (const board of Object.values(boards)) {
      for (const state of allStates(board)) {
        for (const animal of board.animals) {
          for (const move of movesFor(board, state, animal.id)) {
            const next = applyMove(board, state, move);
            const back = predecessors(board, next, animal.id, recordOf(board, state, next));
            expect(
              back.some((p) => key(p.prev) === key(state) && p.move.kind === move.kind),
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('反推树（每张盘的硬性不变量）', () => {
  for (const p of puzzles) {
    describe(p.id, () => {
      const board = p.board;
      const tree = reverseTree(board, p.finalState, p.events);

      it('至少有解，且动物数始终不变', () => {
        expect(tree.length).toBeGreaterThan(0);
        for (const leaf of tree) {
          const { start, moves } = chainOf(leaf);
          expect(Object.keys(start)).toHaveLength(board.animals.length);
          let s = start;
          for (const m of moves) {
            s = applyMove(board, s, m);
            expect(new Set(Object.values(s)).size).toBe(board.animals.length);
          }
        }
      });

      it('每条链正向回放都命中终态和事件顺序', () => {
        for (const leaf of tree) {
          const { start, moves } = chainOf(leaf);
          expect(key(replay(board, start, moves))).toBe(key(p.finalState));
          const evs: EventType[] = [];
          let s = start;
          for (const m of moves) {
            const n = applyMove(board, s, m);
            evs.push(recordOf(board, s, n));
            s = n;
          }
          expect(evs.join('')).toBe(p.events.join(''));
        }
      });

      it('候选全部能通过正向规则与占位检查', () => {
        let frontier: State[] = [p.finalState];
        for (let i = p.events.length - 1; i >= 0; i--) {
          const ev = p.events[i]!;
          const next: State[] = [];
          for (const st of frontier) {
            for (const a of board.animals) {
              for (const pred of predecessors(board, st, a.id, ev)) {
                // 正向合法性
                const legal = movesFor(board, pred.prev, a.id).some(
                  (m) => m.to === pred.move.to && m.kind === pred.move.kind,
                );
                expect(legal).toBe(true);
                // 阻塞者就是当时出口上的动物
                if (pred.move.kind !== 'swim') {
                  const outlet = board.outlets[pred.move.from]!;
                  expect(occupantOf(pred.prev, outlet)).toBe(pred.move.blockerId);
                }
                next.push(pred.prev);
              }
            }
          }
          frontier = [...new Map(next.map((s) => [key(s), s])).values()];
          expect(frontier.length).toBeGreaterThan(0);
        }
      });
    });
  }
});

describe('正式盘的线索唯一性', () => {
  for (const p of puzzles.filter((x) => x.mode === 'reverse')) {
    it(`${p.id}: 早晨线索唯一钉住一个清晨盘`, () => {
      const tree = reverseTree(p.board, p.finalState, p.events);
      const starts = [...new Map(tree.map((n) => [key(n.state), n.state])).values()];
      const matched = starts.filter((s) => matchesClue(s, p.clue));
      expect(matched).toHaveLength(1);
      if (p.expectedStart) expect(key(matched[0]!)).toBe(key(p.expectedStart));
    });
  }
});

describe('两张正式图的互补性', () => {
  it('clean 图每个草坪位置只有一种来路（无直游/退草双解）', () => {
    const p = puzzles.find((x) => x.id === 'clean')!;
    let frontier: State[] = [p.finalState];
    for (let i = p.events.length - 1; i >= 0; i--) {
      const ev = p.events[i]!;
      if (ev === 'lawn') {
        for (const st of frontier) {
          const byTarget = new Map<string, Set<string>>();
          for (const a of p.board.animals)
            for (const pr of predecessors(p.board, st, a.id, ev)) {
              const k = `${a.id}|${pr.move.to}`;
              if (!byTarget.has(k)) byTarget.set(k, new Set());
              byTarget.get(k)!.add(pr.move.kind);
            }
          for (const kinds of byTarget.values()) {
            expect(kinds.has('swim') && kinds.has('grass')).toBe(false);
          }
        }
      }
      const next: State[] = [];
      for (const st of frontier)
        for (const a of p.board.animals)
          for (const pr of predecessors(p.board, st, a.id, ev)) next.push(pr.prev);
      frontier = [...new Map(next.map((s) => [key(s), s])).values()];
    }
  });

  it('branch 图终态草坪有直游/退草双解，且更早的记录排除其中一条', () => {
    const p = puzzles.find((x) => x.id === 'branch')!;
    const last = p.events[p.events.length - 1];
    expect(last).toBe('lawn');
    const cands = candidateExplanations(p.board, p.finalState, 'lawn');
    const byKey = new Map<string, { swim?: typeof cands[0]; grass?: typeof cands[0] }>();
    for (const c of cands) {
      const k = `${c.actor}|${c.move.to}`;
      if (!byKey.has(k)) byKey.set(k, {});
      const o = byKey.get(k)!;
      if (c.move.kind === 'swim') o.swim = c;
      if (c.move.kind === 'grass') o.grass = c;
    }
    const dual = [...byKey.values()].filter((o) => o.swim && o.grass);
    expect(dual.length).toBeGreaterThanOrEqual(1);
    for (const o of dual) {
      // 两条都先过正向规则
      for (const side of [o.swim!, o.grass!]) {
        expect(
          movesFor(p.board, side.prev, side.actor).some(
            (m) => m.to === side.move.to && m.kind === side.move.kind,
          ),
        ).toBe(true);
      }
      // 继续回推，只有一条活得下来
      const rest = p.events.slice(0, -1);
      const sl = reverseTree(p.board, o.swim!.prev, rest);
      const gl = reverseTree(p.board, o.grass!.prev, rest);
      expect([sl.length, gl.length].filter((n) => n > 0)).toHaveLength(1);
    }
  });
});

describe('教学盘演示', () => {
  it('演示剧本与记录、终态完全一致', () => {
    const p = puzzles.find((x) => x.id === 'tutorial')!;
    const script = buildDemoScript(p);
    expect(script).toHaveLength(p.events.length);
    expect(script.map((s) => s.event).join('')).toBe(p.events.join(''));
    expect(key(script[script.length - 1]!.stateAfter)).toBe(key(p.finalState));
    // 覆盖三类事件
    expect(new Set(script.map((s) => s.kind))).toEqual(new Set(['swim', 'wait', 'grass']));
  });
});

describe('交互流程', () => {
  const branch = puzzles.find((x) => x.id === 'branch')!;

  function solveCorrectly(g = initialState(branch)) {
    let cur = g;
    const pick = (needle: (c: ReturnType<typeof currentCandidates>[number]) => boolean) => {
      const cands = currentCandidates(cur);
      const c = cands.find(needle);
      expect(c).toBeDefined();
      cur = commitCandidate(cur, c!);
    };
    pick((c) => c.move.kind === 'swim' && c.move.to === 'l2'); // 直游东岸草坪
    pick((c) => c.move.kind === 'swim' && c.move.to === 'i2' && c.move.from === 'i3'); // 老柳岛→石阶岛
    pick((c) => c.move.to === 'i4'); // 沙嘴岛
    return cur;
  }

  it('正确路径能走到 solved，并能正向回放', () => {
    const g = solveCorrectly();
    expect(g.phase).toBe('solved');
    expect(verifyForward(branch, g.attempt)).toBe(true);
    expect(key(g.attempt.state)).toBe(key(branch.expectedStart!));
    expect(userChain(g)).toHaveLength(branch.events.length);
  });

  it('错误分支会撞死，但可以退回分叉', () => {
    let g = initialState(branch);
    // 选退草（老柳岛→东岸草坪）
    const grass = currentCandidates(g).find((c) => c.move.kind === 'grass' && c.move.to === 'l2');
    expect(grass).toBeDefined();
    g = commitCandidate(g, grass!);
    // 继续走，直到候选为空
    let guard = 0;
    while (!g.attempt.dead && currentCandidates(g).length > 0 && g.phase !== 'solved' && guard++ < 10) {
      g = commitCandidate(g, currentCandidates(g)[0]!);
    }
    // 应该走不通（这条解释被排除了）
    expect(g.phase).not.toBe('solved');
    const back = backtrackToBranch(g);
    expect(currentCandidates(back).length).toBeGreaterThanOrEqual(2);
    expect(back.attempt.chosen).toHaveLength(0);
  });

  it('撤销能逐级退回', () => {
    let g = initialState(branch);
    g = commitCandidate(g, currentCandidates(g).find((c) => c.move.to === 'l2')!);
    expect(g.attempt.chosen).toHaveLength(1);
    g = undoOne(g);
    expect(g.attempt.chosen).toHaveLength(0);
    expect(key(g.state)).toBe(key(branch.finalState));
  });

  it('回到终态会清空所有选择', () => {
    let g = initialState(branch);
    g = commitCandidate(g, currentCandidates(g)[0]!);
    g = resetAttempt(g);
    expect(g.attempt.chosen).toHaveLength(0);
    expect(key(g.state)).toBe(key(branch.finalState));
  });

  it('每一回合的候选都带正确的记录类型', () => {
    let g = initialState(branch);
    const flat = puzzles.find((x) => x.id === 'branch')!;
    for (let step = 0; step < flat.events.length; step++) {
      const ev = flat.events[flat.events.length - 1 - step]!;
      const cands = currentCandidates(g);
      expect(cands.length).toBeGreaterThan(0);
      for (const c of cands) expect(c.record).toBe(ev);
      g = commitCandidate(g, cands[0]!);
    }
    // 最后可能撞线索或成功，但至少每一步的选择都合法
    expect(['solve', 'solved']).toContain(g.phase);
  });
});

describe('状态合法性', () => {
  it('任何盘的终态与起点都是 4 只动物、4 个不同地点', () => {
    for (const p of puzzles) {
      const states = [p.finalState, p.startState, p.expectedStart].filter(Boolean) as State[];
      for (const s of states) {
        expect(new Set(Object.values(s)).size).toBe(p.board.animals.length);
      }
    }
  });
});
