import { describe, it, expect } from 'vitest';
import { expandArrangement } from '../src/core/sequencer';
import { stripFromStrings, beatsFromStrings, type Arrangement } from '../src/core/model';
import { PUZZLES } from '../src/core/puzzles';

const mapOf = (strips: ReturnType<typeof stripFromStrings>[]) =>
  new Map(strips.map((s) => [s.id, s]));

describe('展开：已知纸带顺序核对拍点', () => {
  it('第一关正解展开后与目标逐拍一致', () => {
    const p = PUZZLES[0];
    const solution: Arrangement = [
      { kind: 'strip', stripId: 'A', reversed: false },
      { kind: 'strip', stripId: 'B', reversed: true },
      { kind: 'strip', stripId: 'C', reversed: false },
    ];
    const exp = expandArrangement(solution, mapOf(p.strips), 3);
    expect(exp.ok).toBe(true);
    if (exp.ok) expect(exp.beats).toEqual(p.target);
  });

  it('倒向插入：列序反转、路不变', () => {
    const s = stripFromStrings('S', 'S', ['X..X', '.X..', '..X.']);
    const fwd = expandArrangement([{ kind: 'strip', stripId: 'S', reversed: false }], mapOf([s]), 3);
    const rev = expandArrangement([{ kind: 'strip', stripId: 'S', reversed: true }], mapOf([s]), 3);
    expect(fwd.ok && rev.ok).toBe(true);
    if (fwd.ok && rev.ok) {
      expect(rev.beats).toEqual([...fwd.beats].reverse());
      // 手算：倒向后第 1 拍是原第 4 列 → 高鼓
      expect(rev.beats[0].hits).toEqual([true, false, false]);
      // 倒向后第 2 拍是原第 3 列 → 低鼓
      expect(rev.beats[1].hits).toEqual([false, false, true]);
    }
  });

  it('空位也占一拍：全空纸带展开出等长的静音拍', () => {
    const s = stripFromStrings('Z', 'Z', ['....', '....', '....']);
    const exp = expandArrangement([{ kind: 'strip', stripId: 'Z', reversed: false }], mapOf([s]), 3);
    expect(exp.ok && exp.beats.length === 4).toBe(true);
    if (exp.ok) expect(exp.beats.every((b) => b.hits.every((h) => !h))).toBe(true);
  });
});

describe('展开：返回标记', () => {
  const p = PUZZLES[1];
  const m = mapOf(p.strips);

  it('只重复指定的小段一次，第二遍读到继续前进', () => {
    const solution: Arrangement = [
      { kind: 'strip', stripId: 'D', reversed: false },
      { kind: 'strip', stripId: 'E', reversed: false },
      { kind: 'strip', stripId: 'F', reversed: false },
      { kind: 'return', backTo: 1 },
    ];
    const exp = expandArrangement(solution, m, 3);
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;
    // D E F E F = 20 拍，不多不少（不会多转）
    expect(exp.beats.length).toBe(20);
    expect(exp.beats).toEqual(p.target);
    // 重复段（拍 12..19）与第一次（拍 4..11）逐拍相同
    expect(exp.beats.slice(12, 20)).toEqual(exp.beats.slice(4, 12));
  });

  it('标记指向开头时整段重读一次后停下，不会死循环', () => {
    const arr: Arrangement = [
      { kind: 'strip', stripId: 'E', reversed: false },
      { kind: 'strip', stripId: 'F', reversed: false },
      { kind: 'return', backTo: 0 },
    ];
    const exp = expandArrangement(arr, m, 3);
    expect(exp.ok).toBe(true);
    if (exp.ok) expect(exp.beats.length).toBe(16); // E F E F
  });

  it('标记指向自身或之后：停在对应孔位并说明原因', () => {
    const arr: Arrangement = [
      { kind: 'strip', stripId: 'D', reversed: false },
      { kind: 'return', backTo: 1 }, // 指向自己
    ];
    const exp = expandArrangement(arr, m, 3);
    expect(exp.ok).toBe(false);
    if (!exp.ok) {
      expect(exp.slotIndex).toBe(1);
      expect(exp.beatIndex).toBe(4); // 停在读完 D 之后的孔位
      expect(exp.reason).toContain('顺序不成立');
    }
  });

  it('标记指向不存在的槽位：报错', () => {
    const arr: Arrangement = [
      { kind: 'strip', stripId: 'D', reversed: false },
      { kind: 'return', backTo: 5 },
    ];
    const exp = expandArrangement(arr, m, 3);
    expect(exp.ok).toBe(false);
    if (!exp.ok) expect(exp.reason).toContain('不存在');
  });
});

describe('展开：与手写期望逐拍对照', () => {
  it('第二关 D E F E F 的鼓点位置', () => {
    const p = PUZZLES[1];
    const expected = beatsFromStrings([
      'X...X..X....X..X....',
      '.X...X.XX..X.X.XX..X',
      '..X......XX......XX.',
    ]);
    expect(p.target).toEqual(expected);
  });
});
