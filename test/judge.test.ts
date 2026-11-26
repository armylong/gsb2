import { describe, it, expect } from 'vitest';
import { judge } from '../src/core/judge';
import { beatsFromStrings, stripFromStrings, type Puzzle } from '../src/core/model';
import { PUZZLES } from '../src/core/puzzles';

const [p1, p2] = PUZZLES;

describe('判定：正解能通关', () => {
  it('第一关：A→ B← C→', () => {
    const r = judge(p1, [
      { kind: 'strip', stripId: 'A', reversed: false },
      { kind: 'strip', stripId: 'B', reversed: true },
      { kind: 'strip', stripId: 'C', reversed: false },
    ]);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('第二关：D E F + 返回标记指向第 2 槽', () => {
    const r = judge(p2, [
      { kind: 'strip', stripId: 'D', reversed: false },
      { kind: 'strip', stripId: 'E', reversed: false },
      { kind: 'strip', stripId: 'F', reversed: false },
      { kind: 'return', backTo: 1 },
    ]);
    expect(r.pass).toBe(true);
  });
});

describe('判定：标出第一处有问题的拍子', () => {
  it('忘了倒向：第一处偏差落在 B 段开头（第 5 拍）', () => {
    const r = judge(p1, [
      { kind: 'strip', stripId: 'A', reversed: false },
      { kind: 'strip', stripId: 'B', reversed: false },
      { kind: 'strip', stripId: 'C', reversed: false },
    ]);
    expect(r.pass).toBe(false);
    expect(r.firstBadBeat).toBe(4);
    expect(r.beatDetail).toContain('中鼓');
  });

  it('漏掉的静音拍也算偏差：目标末尾的空拍不能省', () => {
    // 自定义题：目标 8 拍，只有第 1 拍有声，其余都是空拍
    const quiet: Puzzle = {
      id: 't-quiet',
      title: 't',
      description: '',
      trackNames: ['高鼓', '中鼓', '低鼓'],
      strips: [
        stripFromStrings('S1', 'S1', ['X...', '....', '....']),
        stripFromStrings('S2', 'S2', ['....', '....', '....']),
      ],
      returnTokens: 0,
      maxBeats: 8,
      maxSimultaneous: 2,
      target: beatsFromStrings(['X.......', '........', '........']),
      initial: [],
      hint: '',
    };
    const r = judge(quiet, [{ kind: 'strip', stripId: 'S1', reversed: false }]);
    expect(r.pass).toBe(false);
    // S1 的空拍与目标前段空拍重合，第一处对不上的是第 5 拍——该留的静音拍被漏掉了
    expect(r.firstBadBeat).toBe(4);
    expect(r.beatDetail).toContain('空拍');
    expect(r.violations.some((v) => v.includes('S2'))).toBe(true);
  });

  it('多转一遍：整圈重读的拍子被逐个算出', () => {
    // 目标只有 G H 八拍；玩家让读卡器回到开头，G H 被多转了一遍
    const loopy: Puzzle = {
      id: 't-loop',
      title: 't',
      description: '',
      trackNames: ['高鼓', '中鼓', '低鼓'],
      strips: [
        stripFromStrings('G', 'G', ['X...', '....', '....']),
        stripFromStrings('H', 'H', ['....', '.X..', '....']),
      ],
      returnTokens: 1,
      maxBeats: 8,
      maxSimultaneous: 2,
      target: beatsFromStrings(['X.......', '.....X..', '........']),
      initial: [],
      hint: '',
    };
    const r = judge(loopy, [
      { kind: 'strip', stripId: 'G', reversed: false },
      { kind: 'strip', stripId: 'H', reversed: false },
      { kind: 'return', backTo: 0 },
    ]);
    expect(r.pass).toBe(false);
    expect(r.firstBadBeat).toBe(8); // 目标在第 8 拍后已经结束
    expect(r.beatDetail).toContain('多余');
    expect(r.violations.some((v) => v.includes('走纸长度'))).toBe(true);
  });

  it('第二关里标记指错位置：多出来的拍和走纸超限都被报出', () => {
    const r = judge(p2, [
      { kind: 'strip', stripId: 'D', reversed: false },
      { kind: 'strip', stripId: 'E', reversed: false },
      { kind: 'strip', stripId: 'F', reversed: false },
      { kind: 'return', backTo: 0 }, // 回到开头 → D E F D E F
    ]);
    expect(r.pass).toBe(false);
    expect(r.firstBadBeat).toBeDefined();
    expect(r.violations.some((v) => v.includes('走纸长度'))).toBe(true);
  });

  it('返回标记顺序不成立：展开失败并给出停下的位置', () => {
    const r = judge(p2, [
      { kind: 'strip', stripId: 'D', reversed: false },
      { kind: 'return', backTo: 1 },
      { kind: 'strip', stripId: 'E', reversed: false },
      { kind: 'strip', stripId: 'F', reversed: false },
    ]);
    expect(r.pass).toBe(false);
    expect(r.expandError).toContain('的顺序不成立'.slice(1)); // “顺序不成立”
    expect(r.firstBadBeat).toBe(4);
  });
});

describe('判定：用纸限制', () => {
  it('同一条纸带放两次会被记下', () => {
    const r = judge(p1, [
      { kind: 'strip', stripId: 'A', reversed: false },
      { kind: 'strip', stripId: 'A', reversed: false },
      { kind: 'strip', stripId: 'B', reversed: true },
      { kind: 'strip', stripId: 'C', reversed: false },
    ]);
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.includes('只能用一次'))).toBe(true);
  });

  it('同一拍打孔数超过打孔器上限', () => {
    const dense: Puzzle = {
      id: 't-dense',
      title: 't',
      description: '',
      trackNames: ['高鼓', '中鼓', '低鼓'],
      strips: [stripFromStrings('S', 'S', ['X...', 'X...', '....'])],
      returnTokens: 0,
      maxBeats: 4,
      maxSimultaneous: 1,
      target: beatsFromStrings(['X...', 'X...', '....']),
      initial: [],
      hint: '',
    };
    const r = judge(dense, [{ kind: 'strip', stripId: 'S', reversed: false }]);
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.includes('打孔器'))).toBe(true);
  });
});
