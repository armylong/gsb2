import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/game/diagnosis';
import {
  drawEdge,
  emptyState,
  setTop,
} from '../src/game/operations';
import { getPuzzle, defaultState } from '../src/game/levels';
import {
  SAVE_VERSION,
  clearSave,
  hasSave,
  loadLayout,
  restart,
  saveLayout,
  validateAllPuzzles,
  validateStateAgainstPuzzle,
  type StorageLike,
} from '../src/game/persistence';
import { PUZZLES } from '../src/game/levels';
import type { GameState, Vertex } from '../src/game/types';

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function drawPath(
  puzzle: ReturnType<typeof getPuzzle>,
  state: GameState,
  color: string,
  path: Vertex[],
): GameState {
  let cur = state;
  for (let i = 0; i < path.length - 1; i++) {
    const res = drawEdge(puzzle, cur, path[i], path[i + 1], color);
    if (!res.ok || !res.state) throw new Error(res.error);
    cur = res.state;
  }
  return cur;
}

describe('题库启动校验', () => {
  it('两套题面及其初始布局全部通过静态校验', () => {
    expect(() => validateAllPuzzles(PUZZLES)).not.toThrow();
  });
});

describe('保存 / 重开 / 验证一致性', () => {
  it('保存后读回的布局与原布局逐字段一致，诊断结果也一致', () => {
    const p1 = getPuzzle('level-1');
    const storage = new MemoryStorage();
    let s = drawPath(p1, emptyState(p1), 'red', [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ]);
    s = drawPath(p1, s, 'blue', [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ]);
    s = setTop(p1, s, { x: 1, y: 1 }, 'blue').state!;

    expect(hasSave(p1.id, storage)).toBe(false);
    saveLayout(p1, s, storage);
    expect(hasSave(p1.id, storage)).toBe(true);

    const loaded = loadLayout(p1, storage)!;
    expect(loaded.edges).toEqual(s.edges);
    expect(loaded.tops).toEqual(s.tops);
    expect(loaded.puzzleId).toBe(s.puzzleId);

    const d1 = diagnose(p1, s);
    const d2 = diagnose(p1, loaded);
    expect(d2.solved).toBe(d1.solved);
    expect(d2.targets).toEqual(d1.targets);
    expect(d2.conflicts).toEqual(d1.conflicts);
    expect(d2.ribbons.map((r) => [r.color, r.complete])).toEqual(
      d1.ribbons.map((r) => [r.color, r.complete]),
    );
  });

  it('第二关：保存含两个相邻冲突的初始局面，重开后读回仍是两个冲突', () => {
    const p2 = getPuzzle('level-2');
    const storage = new MemoryStorage();
    const initial = defaultState(p2);
    expect(diagnose(p2, initial).conflicts).toHaveLength(2);

    saveLayout(p2, initial, storage);

    // 玩家翻转中间点后局面变成已解
    const solved = setTop(p2, initial, { x: 2, y: 2 }).state!;
    expect(diagnose(p2, solved).solved).toBe(true);

    // 重开回到题面初始布局
    const reopened = restart(p2);
    expect(reopened.edges).toEqual(initial.edges);
    expect(reopened.tops).toEqual(initial.tops);
    expect(diagnose(p2, reopened).conflicts).toHaveLength(2);

    // 读档还原的也是带两个冲突的存档，验证结果保持一致
    const loaded = loadLayout(p2, storage)!;
    expect(diagnose(p2, loaded).conflicts).toHaveLength(2);

    clearSave(p2.id, storage);
    expect(hasSave(p2.id, storage)).toBe(false);
    expect(loadLayout(p2, storage)).toBeNull();
  });

  it('损坏存档与跨题面存档都会被拒绝', () => {
    const p1 = getPuzzle('level-1');
    const storage = new MemoryStorage();
    const s = emptyState(p1);
    saveLayout(p1, s, storage);

    const p2 = getPuzzle('level-2');
    // 在 level-2 的存储键下放一个 id 不匹配的存档，模拟跨题面污染
    storage.setItem(
      'ribbon-loom:save:level-2',
      JSON.stringify({
        version: SAVE_VERSION,
        puzzleId: 'level-1',
        savedAt: new Date().toISOString(),
        state: { puzzleId: 'level-1', edges: {}, tops: {} },
      }),
    );
    expect(() => loadLayout(p2, storage)).toThrow(/不匹配/);

    // 手动写入坏 JSON
    storage.setItem('ribbon-loom:save:level-1', '{not-json');
    expect(() => loadLayout(p1, storage)).toThrow(/解析失败/);

    storage.setItem(
      'ribbon-loom:save:level-1',
      JSON.stringify({
        version: SAVE_VERSION,
        puzzleId: 'level-1',
        savedAt: new Date().toISOString(),
        state: { puzzleId: 'level-1', edges: { '9,9|9,10': 'red' }, tops: {} },
      }),
    );
    expect(() => loadLayout(p1, storage)).toThrow(/校验失败/);
  });

  it('保存前校验能拦住撞禁用孔和未知颜色的布局', () => {
    const p1 = getPuzzle('level-1');
    const bad: GameState = {
      puzzleId: 'level-1',
      edges: { '2,1|2,2': 'red' }, // (2,2) 是禁用孔
      tops: {},
    };
    expect(validateStateAgainstPuzzle(p1, bad).length).toBeGreaterThan(0);
    expect(() => saveLayout(p1, bad, new MemoryStorage())).toThrow();
  });
});
