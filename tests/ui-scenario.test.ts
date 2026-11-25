import { describe, expect, it } from 'vitest';
import { drawEdge, emptyState } from '../src/game/operations';
import { diagnose } from '../src/game/diagnosis';
import { getPuzzle } from '../src/game/levels';
import type { GameState, Vertex } from '../src/game/types';

/** 端到端场景：模拟 UI 上按顺序逐边画带，验证诊断结果与浏览器冒烟一致。 */
function drawPath(s: GameState, puzzleId: string, color: string, path: Vertex[]): GameState {
  const puzzle = getPuzzle(puzzleId);
  let cur = s;
  for (let i = 0; i < path.length - 1; i++) {
    const r = drawEdge(puzzle, cur, path[i], path[i + 1], color);
    if (!r.ok || !r.state) throw new Error(r.error);
    cur = r.state;
  }
  return cur;
}

describe('完整对局场景', () => {
  it('第一关：红蓝两带画完后蓝带结构完整，翻转交叉点即通关', () => {
    const puzzle = getPuzzle('level-1');
    let state = emptyState(puzzle);
    state = drawPath(
      state,
      'level-1',
      'red',
      [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 3, y: 1 },
        { x: 4, y: 1 },
      ],
    );
    state = drawPath(
      state,
      'level-1',
      'blue',
      [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
      ],
    );
    const before = diagnose(puzzle, state);
    expect(before.ribbons.every((r) => r.complete)).toBe(true);
    expect(before.crossings).toHaveLength(1);
    expect(before.targets[0].state).toBe('mismatch');
    expect(before.solved).toBe(false);
  });
});
