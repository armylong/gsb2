import { describe, expect, it } from 'vitest';
import type { Placement, WorldState } from './types';
import { canRedo, canUndo, commit, createHistory, redo, undo } from './history';
import { ITEMS } from './items';

const pl = (itemId: string, col: number, row: number): Placement => ({
  itemId,
  bagId: 'bag-a',
  anchor: { col, row },
  rotation: 0,
});

const world = (placements: Placement[]): WorldState => ({
  bags: [
    { id: 'bag-a', name: 'A', cols: 8, rows: 6 },
    { id: 'bag-b', name: 'B', cols: 6, rows: 5 },
  ],
  placements,
});

describe('撤销/重做历史', () => {
  it('一次移动一个条目; 撤销恢复编号/位置/旋转/背包, 重做再次应用', () => {
    const w0 = world([pl('I01', 0, 0), pl('I02', 0, 2)]);
    let h = createHistory(w0);
    const w1 = world([pl('I01', 3, 3), pl('I02', 0, 2)]);
    const w2 = world([
      { ...pl('I01', 3, 3), bagId: 'bag-b', rotation: 1 },
      pl('I02', 0, 2),
    ]);
    h = commit(h, w1);
    h = commit(h, w2);
    expect(h.past).toHaveLength(2);
    expect(h.future).toHaveLength(0);

    h = undo(h);
    expect(h.present.placements.find((p) => p.itemId === 'I01')).toEqual(pl('I01', 3, 3));
    expect(canRedo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toEqual(w0);
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present.placements.find((p) => p.itemId === 'I01')).toEqual(pl('I01', 3, 3));
    h = redo(h);
    const restored = h.present.placements.find((p) => p.itemId === 'I01')!;
    expect(restored.bagId).toBe('bag-b');
    expect(restored.rotation).toBe(1);
    expect(canRedo(h)).toBe(false);
  });

  it('撤销后产生新操作会清空旧重做分支', () => {
    const w0 = world([pl('I01', 0, 0)]);
    let h = createHistory(w0);
    h = commit(h, world([pl('I01', 1, 0)]));
    h = commit(h, world([pl('I01', 2, 0)]));
    h = undo(h);
    expect(h.future).toHaveLength(1);
    h = commit(h, world([pl('I01', 5, 5)]));
    expect(h.future).toHaveLength(0);
    expect(canRedo(h)).toBe(false);
    expect(h.past).toHaveLength(2);
  });

  it('提交相同状态(no-op/取消拖动)不生成历史', () => {
    const w0 = world([pl('I01', 0, 0)]);
    const h0 = createHistory(w0);
    const h1 = commit(h0, structuredClone(w0));
    expect(h1).toBe(h0);
    expect(h1.past).toHaveLength(0);
  });

  it('快照相互独立: 修改提交后的对象不污染历史', () => {
    const w0 = world([pl('I01', 0, 0)]);
    let h = createHistory(w0);
    const mutable = world([pl('I01', 1, 0)]);
    h = commit(h, mutable);
    mutable.placements[0].anchor.col = 99;
    expect(h.present.placements[0].anchor.col).toBe(1);
    expect(h.past[0].placements[0].anchor.col).toBe(0);
  });

  it('物品目录形状数量与样例规模一致(防止样例漏放物品)', () => {
    expect(ITEMS.length).toBe(12);
  });
});
