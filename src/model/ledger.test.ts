import { describe, expect, it } from 'vitest';
import { Ledger } from './ledger';

describe('Ledger 追加式台账', () => {
  it('seq 单调递增且只追加', () => {
    const l = new Ledger<{ v: number }>();
    l.append('a', { v: 1 });
    l.append('a', { v: 2 });
    const all = l.recent(10);
    expect(all.map((e) => e.seq)).toEqual([1, 0]); // recent 新的在前
    expect(all.map((e) => e.payload.v)).toEqual([2, 1]);
  });

  it('超容量丢弃最旧条目，序号不重用', () => {
    const l = new Ledger<number>(3);
    for (let i = 0; i < 5; i++) l.append('x', i);
    const all = l.recent(10);
    expect(all.map((e) => e.payload)).toEqual([4, 3, 2]);
    expect(all[all.length - 1].seq).toBe(2);
    l.append('x', 5);
    expect(l.recent(1)[0].seq).toBe(5);
  });

  it('clear 只清视图数据，后续 seq 继续递增', () => {
    const l = new Ledger<number>();
    l.append('x', 1);
    l.clear();
    expect(l.length).toBe(0);
    l.append('x', 2);
    expect(l.recent(1)[0].seq).toBe(1);
  });
});
