import { describe, expect, it } from 'vitest';
import {
  Board,
  Dir,
  Placement,
  Tile,
  canonicalRot,
  optionKey,
  rotatedEdge,
} from '../src/core/types.js';
import {
  checkBoard,
  checkPlacement,
  freeCells,
  pruneEdgeConditions,
  validateEdgeConditions,
} from '../src/core/board.js';
import {
  countSolutions,
  diagnose,
  findCompletions,
  getHint,
} from '../src/core/solver.js';
import { PRESETS } from '../src/data/presets.js';

const tile = (id: string, edges: [string, string, string, string]): Tile => ({ id, edges });
const board = (
  width: number,
  holes: { x: number; y: number }[] = [],
  edgeConditions: Board['edgeConditions'] = {},
): Board => ({ width, height: width, holes, edgeConditions });

describe('旋转', () => {
  const t = tile('A', ['a', 'b', 'c', 'd']);
  it('rot=1 时上边取原左边, 右边取原上边', () => {
    expect(rotatedEdge(t, 1, 0)).toBe('d');
    expect(rotatedEdge(t, 1, 1)).toBe('a');
    expect(rotatedEdge(t, 1, 2)).toBe('b');
    expect(rotatedEdge(t, 1, 3)).toBe('c');
  });

  it('四边全同的片四个朝向去重键相同', () => {
    const sym = tile('S', ['x', 'x', 'x', 'x']);
    const keys = [0, 1, 2, 3].map((r) => optionKey(sym, r as Dir));
    expect(new Set(keys).size).toBe(1);
  });

  it('半对称片(对边相同)只有 2 个不同朝向, 非对称片有 4 个', () => {
    const half = tile('H', ['a', 'b', 'a', 'b']);
    expect(new Set([0, 1, 2, 3].map((r) => optionKey(half, r as Dir))).size).toBe(2);
    const asym = tile('Q', ['a', 'b', 'c', 'd']);
    expect(new Set([0, 1, 2, 3].map((r) => optionKey(asym, r as Dir))).size).toBe(4);
  });

  it('canonicalRot 对旋转后的序列给出同一规范朝向(按旋转后边纹比较)', () => {
    const seq = ['a', 'b', 'c', 'd'] as [string, string, string, string];
    const rotatedSeq: [string, string, string, string] = ['d', 'a', 'b', 'c'];
    // 把 rotatedSeq 转回规范朝向, 应与原序列规范朝向的边纹排列相同
    const cr0 = canonicalRot(seq);
    const cr1 = canonicalRot(rotatedSeq);
    const norm = (edges: readonly string[], cr: Dir) =>
      [0, 1, 2, 3].map((d) => edges[(d - cr + 4) % 4]);
    expect(norm(rotatedSeq, cr1)).toEqual(norm(seq, cr0));
  });
});

describe('冲突检测', () => {
  const t1 = tile('T1', ['a', 'b', 'c', 'd']);
  const b = board(2);

  it('相邻片纹路不一致时报 edge-mismatch, 一致时不报', () => {
    const placed: Placement[] = [{ tileId: 'T1', x: 0, y: 0, rot: 0, locked: false }];
    // t2 左边是 x, 与 t1 右边 b 不一致
    const badT2 = tile('T2', ['a', 'x', 'c', 'x']);
    const bad = checkPlacement(b, placed, [t1, badT2], badT2, 0, 1, 0);
    expect(bad.some((c) => c.kind === 'edge-mismatch')).toBe(true);

    // t2 左边是 b, 与 t1 右边 b 一致
    const goodT2 = tile('T2', ['a', 'x', 'c', 'b']);
    const good = checkPlacement(b, placed, [t1, goodT2], goodT2, 0, 1, 0);
    expect(good.some((c) => c.kind === 'edge-mismatch')).toBe(false);
  });

  it('同一块片不能同时在两处', () => {
    const placed: Placement[] = [{ tileId: 'T1', x: 0, y: 0, rot: 0, locked: false }];
    const c = checkPlacement(b, placed, [t1], t1, 0, 1, 0);
    expect(c.some((x) => x.kind === 'tile-duplicate')).toBe(true);
  });

  it('洞里不能放片', () => {
    const bHole = board(2, [{ x: 1, y: 1 }]);
    const c = checkPlacement(bHole, [], [t1], t1, 0, 1, 1);
    expect(c.some((x) => x.kind === 'cell-invalid')).toBe(true);
  });

  it('外边固定条件不一致时报错, 无条件(null)不约束', () => {
    const bCond = board(1, [], { '0,0,0': 'z' });
    const c = checkPlacement(bCond, [], [t1], t1, 0, 0, 0);
    expect(c.some((x) => x.kind === 'edge-condition-mismatch')).toBe(true);
    const ok = checkPlacement(board(1), [], [t1], t1, 0, 0, 0);
    expect(ok).toHaveLength(0);
  });

  it('挂在两个普通格之间的边条件被判为非法', () => {
    const bCond = board(2, [], { '0,0,1': 'z' });
    expect(validateEdgeConditions(bCond)).toHaveLength(1);
  });

  it('挖洞后 pruneEdgeConditions 清掉悬挂的边条件', () => {
    // (0,0) 右边原本对着普通格 (1,0), 条件非法; 把 (1,0) 挖洞后变合法
    const bHole = board(2, [{ x: 1, y: 0 }], { '0,0,1': 'z' });
    expect(validateEdgeConditions(bHole)).toHaveLength(0);
    // 填回洞 -> 条件重新非法, prune 删掉
    const bFilled = board(2, [], { '0,0,1': 'z' });
    expect(pruneEdgeConditions(bFilled)).toBe(1);
    expect(Object.keys(bFilled.edgeConditions)).toHaveLength(0);
    // 合法的外边条件不受影响
    const bOuter = board(2, [], { '0,0,0': 'z' });
    expect(pruneEdgeConditions(bOuter)).toBe(0);
    expect(bOuter.edgeConditions['0,0,0']).toBe('z');
  });

  it('全盘检查对同一条冲突只报一次', () => {
    const p1: Placement = { tileId: 'T1', x: 0, y: 0, rot: 0, locked: false };
    const p2: Placement = { tileId: 'T2', x: 1, y: 0, rot: 0, locked: false };
    // t2 左边是 x, 与 t1 右边 b 冲突
    const t2bad = tile('T2', ['a', 'x', 'c', 'x']);
    const conflicts = checkBoard(board(2), [p1, p2], [t1, t2bad]);
    const edgeConflicts = conflicts.filter((c) => c.kind === 'edge-mismatch');
    expect(edgeConflicts).toHaveLength(1);
  });
});

describe('求解器', () => {
  it('唯一解预设: 解数为 1, 且锁定片被尊重', () => {
    const p = PRESETS[0].puzzle;
    expect(countSolutions(p.board, p.placements, p.tiles, 10)).toBe(1);
    // 锁住的片在解里位置和朝向不变
    const r = findCompletions(p.board, p.placements, p.tiles, 1);
    expect(r.status).toBe('solved');
    if (r.status === 'solved') {
      const lock = p.placements[0];
      const got = r.solutions[0].find((s) => s.tileId === lock.tileId)!;
      expect({ x: got.x, y: got.y, rot: got.rot }).toEqual({
        x: lock.x,
        y: lock.y,
        rot: lock.rot,
      });
    }
  });

  it('多解预设: 至少 2 个不同补全', () => {
    const p = PRESETS[1].puzzle;
    expect(countSolutions(p.board, p.placements, p.tiles, 10)).toBeGreaterThanOrEqual(2);
  });

  it('陷阱预设: 无解但能填到只剩一块, 并给出死位解释', () => {
    const p = PRESETS[2].puzzle;
    const diag = diagnose(p.board, [], p.tiles);
    expect(diag.solvable).toBe(false);
    expect(diag.maxFillable).toBe(freeCells(p.board, []).length - 1);
    const r = findCompletions(p.board, [], p.tiles, 1);
    expect(r.status).toBe('unsat');
    if (r.status === 'unsat') {
      expect(r.explanation.deadCell).toBeDefined();
      expect(r.explanation.reasons?.length).toBeGreaterThan(0);
    }
  });

  it('当前盘面已有硬冲突时, 直接返回该冲突而不是静默搜失败', () => {
    const p = PRESETS[0].puzzle;
    // 把另一块未锁定的片塞进锁片所在格, 必然产生 cell-occupied 硬冲突
    const lock = p.placements[0];
    const other = p.tiles.find((t) => t.id !== lock.tileId)!;
    const bad: Placement[] = [
      ...p.placements,
      { tileId: other.id, x: lock.x, y: lock.y, rot: 0, locked: false },
    ];
    expect(checkBoard(p.board, bad, p.tiles).length).toBeGreaterThan(0);
    const r = findCompletions(p.board, bad, p.tiles, 1);
    expect(r.status).toBe('unsat');
    if (r.status === 'unsat') expect(r.explanation.conflicts?.length).toBeGreaterThan(0);
  });

  it('旋转对称的片不会因 rot 写法不同被多算: 解数对旋转表示免疫', () => {
    // 1 行 2 列, 两片四边全同 a: 片不同(id 不同)所以有 2! = 2 个布局,
    // 但每个片自身 4 个 rot 完全等价, 若没做对称去重会膨胀到 2*4*4=32
    const b: Board = { width: 2, height: 1, holes: [], edgeConditions: {} };
    const tiles = [1, 2].map((i) => tile(`T${i}`, ['a', 'a', 'a', 'a']));
    expect(countSolutions(b, [], tiles, 50)).toBe(2);

    // 单片四向全同: 1x1 只有 1 个解, 而不是 4 个
    const one = board(1);
    expect(countSolutions(one, [], [tile('S', ['a', 'a', 'a', 'a'])], 10)).toBe(1);
  });

  it('提示只给一步且不改盘面; 重复调用结果一致', () => {
    const p = PRESETS[0].puzzle;
    const before = JSON.stringify(p.placements);
    const h1 = getHint(p.board, p.placements, p.tiles);
    const h2 = getHint(p.board, p.placements, p.tiles);
    expect(h1.kind).toBe('placement');
    expect(h1.move).toBeDefined();
    expect(JSON.stringify(p.placements)).toBe(before); // 盘面未被修改
    expect(h1.move).toEqual(h2.move);
  });

  it('无解布局的提示返回 conflict 类, 并带依据', () => {
    const p = PRESETS[2].puzzle;
    const h = getHint(p.board, [], p.tiles);
    expect(h.kind).toBe('conflict');
    expect(h.message.length).toBeGreaterThan(0);
  });

  it('格数与片数不匹配时给出明确解释', () => {
    const b = board(2);
    const tiles = [tile('T1', ['a', 'a', 'a', 'a'])];
    const r = findCompletions(b, [], tiles, 1);
    expect(r.status).toBe('unsat');
    if (r.status === 'unsat') expect(r.explanation.title).toContain('不匹配');
  });
});
