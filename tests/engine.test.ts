import { describe, expect, it } from 'vitest';
import {
  allColors,
  detectCrossings,
  traceRibbon,
  validatePuzzle,
} from '../src/game/board';
import { diagnose, diagnoseCell } from '../src/game/diagnosis';
import {
  clearRibbon,
  drawEdge,
  emptyState,
  removeEdge,
  reroute,
  setTop,
} from '../src/game/operations';
import { edgeKey, vKey } from '../src/game/geometry';
import { PUZZLES, getPuzzle } from '../src/game/levels';
import type { GameState, Puzzle, Vertex } from '../src/game/types';

/** 按路径逐条画边，任何一步失败立即抛错。 */
function drawPath(
  puzzle: Puzzle,
  state: GameState,
  color: string,
  path: Vertex[],
): GameState {
  let cur = state;
  for (let i = 0; i < path.length - 1; i++) {
    const res = drawEdge(puzzle, cur, path[i], path[i + 1], color);
    if (!res.ok || !res.state) throw new Error(`画边失败: ${res.error}`);
    cur = res.state;
  }
  return cur;
}

import type { OpResult } from '../src/game/operations';

function must(res: OpResult): GameState {
  if (!res.ok || !res.state) {
    throw new Error(`操作应成功却失败: ${res.error}`);
  }
  return res.state;
}

const p1 = getPuzzle('level-1');

// 第一关红蓝两带的参考解
const redPath1: Vertex[] = [
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 3, y: 1 },
  { x: 4, y: 1 },
];
const bluePath1: Vertex[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 1, y: 2 },
  { x: 1, y: 3 },
];

// 第二关红带的之字参考走线（三处对边交叉）
const redPath2: Vertex[] = [
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 3, y: 1 },
  { x: 3, y: 2 },
  { x: 2, y: 2 },
  { x: 1, y: 2 },
  { x: 1, y: 3 },
  { x: 2, y: 3 },
  { x: 3, y: 3 },
  { x: 3, y: 4 },
];
const bluePath2: Vertex[] = [
  { x: 2, y: 0 },
  { x: 2, y: 1 },
  { x: 2, y: 2 },
  { x: 2, y: 3 },
  { x: 2, y: 4 },
];

describe('题面结构校验', () => {
  it('两套内置题面都合法', () => {
    for (const puzzle of PUZZLES) {
      expect(validatePuzzle(puzzle), puzzle.id).toEqual([]);
    }
  });

  it('第二关初始布局恰好有三处合法交叉、两处相邻冲突', () => {
    const p2 = getPuzzle('level-2');
    const state = p2.initial!;
    const crossings = detectCrossings(state);
    expect(crossings).toHaveLength(3);
    expect(crossings.every((c) => c.valid)).toBe(true);
    const d = diagnose(p2, state);
    expect(d.conflicts).toHaveLength(2);
    expect(d.conflicts.every((c) => c.color === 'red')).toBe(true);
    expect(d.conflicts[0].from).toEqual({ x: 2, y: 1 });
    expect(d.conflicts[0].to).toEqual({ x: 2, y: 2 });
    expect(d.conflicts[1].from).toEqual({ x: 2, y: 2 });
    expect(d.conflicts[1].to).toEqual({ x: 2, y: 3 });
    // 冲突段沿责任方（红带）的之字走线高亮，而不是只画两个交叉点的直线
    expect(d.conflictEdges).toContain(
      edgeKey({ x: 2, y: 1 }, { x: 3, y: 1 }),
    );
    expect(d.conflictEdges).toContain(
      edgeKey({ x: 3, y: 2 }, { x: 2, y: 2 }),
    );
    // 第二段冲突沿红带 (2,2)->(1,2)->(1,3)->(2,3) 的之字走线
    expect(d.conflictEdges).toContain(
      edgeKey({ x: 1, y: 2 }, { x: 1, y: 3 }),
    );
    // 翻转中间交叉点一次，两段冲突同时消失且目标全达成
    const flipped = must(setTop(p2, state, { x: 2, y: 2 }));
    const d2 = diagnose(p2, flipped);
    expect(d2.conflicts).toHaveLength(0);
    expect(d2.targets.every((t) => t.state === 'ok')).toBe(true);
    expect(d2.solved).toBe(true);
  });
});

describe('画带规则：入口/出口/禁用孔/颜色对齐', () => {
  it('不能凭空落子，必须从入口起头', () => {
    const res = drawEdge(
      p1,
      emptyState(p1),
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      'red',
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('DISCONNECTED');
  });

  it('禁用孔不能经过', () => {
    const s = drawPath(p1, emptyState(p1), 'red', [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    const intoHole = drawEdge(
      p1,
      s,
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      'red',
    );
    expect(intoHole.ok).toBe(false);
    expect(intoHole.code).toBe('HOLE');
  });

  it('端口颜色必须对上：红带不能接蓝端口', () => {
    const s = drawPath(p1, emptyState(p1), 'red', [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    const res = drawEdge(
      p1,
      s,
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      'red',
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('WRONG_COLOR');
  });

  it('一条格边不能被两种颜色重复占用', () => {
    // 先让蓝带占住 (1,2)-(1,3)，再让红带沿同色路径延伸后撞这条边
    let s = drawPath(p1, emptyState(p1), 'blue', bluePath1);
    // 红带入口 (0,1)->(1,1)->(1,2)，(1,2) 此时只与蓝带的边相邻、还没有红带邻居
    s = must(drawEdge(p1, s, { x: 0, y: 1 }, { x: 1, y: 1 }, 'red'));
    const res = drawEdge(p1, s, { x: 1, y: 1 }, { x: 1, y: 2 }, 'red');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('EDGE_TAKEN');
  });

  it('分叉与闭合环都被拒绝', () => {
    let s = drawPath(p1, emptyState(p1), 'red', [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    // 从自由端点 (2,1) 继续延伸合法
    const extend = drawEdge(p1, s, { x: 2, y: 1 }, { x: 3, y: 1 }, 'red');
    expect(extend.ok).toBe(true);
    s = extend.state!;
    // 再从 (3,1) 拐一次后，第三个方向会造成度数 3 的分叉
    const turn = drawEdge(p1, s, { x: 3, y: 1 }, { x: 3, y: 0 }, 'red');
    expect(turn.ok).toBe(true);
    s = turn.state!;
    const fork = drawEdge(p1, s, { x: 3, y: 1 }, { x: 4, y: 1 }, 'red');
    expect(fork.ok).toBe(false);
    expect(fork.code).toBe('BRANCH');
  });

  it('断头、断成多段不会被算成完整路线', () => {
    const s = drawPath(p1, emptyState(p1), 'red', [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    const d = diagnose(p1, s);
    const red = d.ribbons.find((r) => r.color === 'red')!;
    expect(red.complete).toBe(false);
    expect(red.deadEnds).toEqual([{ x: 2, y: 1 }]);
    expect(d.solved).toBe(false);
    expect(d.problems.some((m) => m.includes('断头'))).toBe(true);
  });
});

describe('交叉点上下穿压与相间规则', () => {
  it('完整解：蓝压红满足目标，红压蓝则目标不符', () => {
    let s = drawPath(p1, emptyState(p1), 'red', redPath1);
    s = drawPath(p1, s, 'blue', bluePath1);
    const crossings = detectCrossings(s);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].vertex).toEqual({ x: 1, y: 1 });

    // 端口声明序 red 在前，自动裁定 red 顶层 -> 目标 mismatch
    const dAuto = diagnose(p1, s);
    expect(dAuto.crossings[0].top).toBe('red');
    expect(dAuto.targets[0].state).toBe('mismatch');
    expect(dAuto.solved).toBe(false);

    // 翻转为 blue 顶层 -> 目标达成、整局完成
    const flipped = must(setTop(p1, s, { x: 1, y: 1 }));
    const d = diagnose(p1, flipped);
    expect(d.crossings[0].top).toBe('blue');
    expect(d.crossings[0].bottom).toBe('red');
    expect(d.targets[0].state).toBe('ok');
    expect(d.ribbons.every((r) => r.complete)).toBe(true);
    expect(d.solved).toBe(true);
  });

  it('非对边穿过被标记为结构错误，且不能设置上下', () => {
    // 构造 L 形对撞：red 走到 (1,1)，blue 从 (1,0) 下来再拐向 red 的延伸段
    let s = drawPath(p1, emptyState(p1), 'red', [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    s = must(drawEdge(p1, s, { x: 1, y: 0 }, { x: 1, y: 1 }, 'blue'));
    const res = drawEdge(p1, s, { x: 1, y: 1 }, { x: 2, y: 1 }, 'blue');
    // (1,1)->(2,1) 已被 red 占用，blue 撞边；改用另一条构造非法交叉
    expect(res.ok).toBe(false);
    expect(res.code).toBe('EDGE_TAKEN');

    // 合法构造非法交叉：red 横向过 (1,1)，blue 到 (1,1) 后只有单边（丁字结构）
    let s2 = drawPath(p1, emptyState(p1), 'red', redPath1);
    s2 = must(drawEdge(p1, s2, { x: 1, y: 0 }, { x: 1, y: 1 }, 'blue'));
    const crossings = detectCrossings(s2);
    const bad = crossings.find(
      (c) => c.vertex.x === 1 && c.vertex.y === 1,
    )!;
    expect(bad.valid).toBe(false);
    const topRes = setTop(p1, s2, { x: 1, y: 1 });
    expect(topRes.ok).toBe(false);
    expect(topRes.code).toBe('NOT_A_CROSSING');
    const d = diagnose(p1, s2);
    expect(d.invalidCrossings).toContainEqual({ x: 1, y: 1 });
    expect(d.solved).toBe(false);
  });

  it('改一个点后只标出真正冲突的那一段，相邻段正确则不标', () => {
    const p2 = getPuzzle('level-2');
    // 三处交叉，前两个同顶层（冲突），后两个交替（无冲突）
    let s = drawPath(p2, emptyState(p2), 'red', redPath2);
    s = drawPath(p2, s, 'blue', bluePath2);
    s = must(setTop(p2, s, { x: 2, y: 1 }, 'red'));
    s = must(setTop(p2, s, { x: 2, y: 2 }, 'red')); // 1->2 冲突
    s = must(setTop(p2, s, { x: 2, y: 3 }, 'blue')); // 2->3 交替
    const d = diagnose(p2, s);
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0].from).toEqual({ x: 2, y: 1 });
    expect(d.conflicts[0].to).toEqual({ x: 2, y: 2 });
    // 冲突段沿红带之字走线：(2,1)->(3,1)->(3,2)->(2,2)
    expect(d.conflictEdges).toEqual([
      edgeKey({ x: 2, y: 1 }, { x: 3, y: 1 }),
      edgeKey({ x: 3, y: 1 }, { x: 3, y: 2 }),
      edgeKey({ x: 3, y: 2 }, { x: 2, y: 2 }),
    ]);
  });

  it('收回格边后失效的上下指定被清理', () => {
    let s = drawPath(p1, emptyState(p1), 'red', redPath1);
    s = drawPath(p1, s, 'blue', bluePath1);
    s = must(setTop(p1, s, { x: 1, y: 1 }, 'blue'));
    expect(s.tops['1,1']).toBe('blue');
    s = must(removeEdge(p1, s, { x: 1, y: 2 }, { x: 1, y: 3 })); // 从蓝带末端收
    s = must(removeEdge(p1, s, { x: 1, y: 1 }, { x: 1, y: 2 }));
    s = must(removeEdge(p1, s, { x: 1, y: 0 }, { x: 1, y: 1 }));
    expect(s.tops['1,1']).toBeUndefined();
  });

  it('中间段不允许直接收，必须走改道', () => {
    const s = drawPath(p1, emptyState(p1), 'red', redPath1);
    const res = removeEdge(p1, s, { x: 1, y: 1 }, { x: 2, y: 1 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('BAD_PATH');
  });
});

describe('改道：保留两侧走法，拒绝误接', () => {
  it('替换中间一段，两侧保留且最终仍为完整路线', () => {
    // 只织红带做改道验证：红带原本直走 y=1，
    // 把 (1,1)->(2,1)->(3,1) 改为从蓝带右侧绕行（不碰蓝列 x=1 与禁用孔 (2,2)）
    const s = drawPath(p1, emptyState(p1), 'red', redPath1);
    const oldPath: Vertex[] = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ];
    const newPath: Vertex[] = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
    ];
    const res = reroute(p1, s, 'red', oldPath, newPath);
    expect(res.ok, res.error).toBe(true);
    const next = res.state!;
    // 两侧的入口段与出口段保留
    expect(next.edges[edgeKey({ x: 0, y: 1 }, { x: 1, y: 1 })]).toBe('red');
    expect(next.edges[edgeKey({ x: 3, y: 1 }, { x: 4, y: 1 })]).toBe('red');
    // 旧中间段里没有被新路线复用的边已删除
    expect(
      next.edges[edgeKey({ x: 2, y: 1 }, { x: 3, y: 1 })],
    ).toBeUndefined();
    // 新绕行段生效
    expect(next.edges[edgeKey({ x: 2, y: 0 }, { x: 3, y: 0 })]).toBe('red');
    const d = diagnose(p1, next);
    expect(d.ribbons.find((r) => r.color === 'red')!.complete).toBe(true);
  });

  it('改道接不上两侧时被拒绝，原布局不变', () => {
    const s = drawPath(p1, emptyState(p1), 'red', redPath1);
    const oldPath: Vertex[] = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ];
    const newPath: Vertex[] = [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
    ]; // 终点 (2,3) 与剩余带 (3,1) 接不上
    const before = JSON.stringify(s);
    const res = reroute(p1, s, 'red', oldPath, newPath);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('DISCONNECTED');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('改道撞禁用孔、撞别的带都被拒绝', () => {
    let s = drawPath(p1, emptyState(p1), 'red', redPath1);
    const hitHole = reroute(
      p1,
      s,
      'red',
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
      ],
    );
    expect(hitHole.ok).toBe(false);
    expect(hitHole.code).toBe('HOLE');

    s = drawPath(p1, s, 'blue', bluePath1);
    const hitBlue = reroute(
      p1,
      s,
      'red',
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      [
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ],
    );
    // (1,1)->(1,2) 是蓝带的边，先撞边；即便不撞边，(2,2) 也是孔
    expect(hitBlue.ok).toBe(false);
    expect(['EDGE_TAKEN', 'HOLE']).toContain(hitBlue.code);
  });

  it('误接出的环或断头不会被偷偷算成完整路线', () => {
    let s = drawPath(p1, emptyState(p1), 'red', redPath1);
    s = must(removeEdge(p1, s, { x: 3, y: 1 }, { x: 4, y: 1 })); // 从出口端收回一条
    const d = diagnose(p1, s);
    expect(d.ribbons.find((r) => r.color === 'red')!.complete).toBe(false);
    const still = clearRibbon(p1, s, 'blue');
    expect(traceRibbon(p1, still, 'red').complete).toBe(false);
  });
});

describe('部分完成也能检查', () => {
  it('目标点未形成交叉时给 pending，已形成但颜色不对给 mismatch', () => {
    let s = drawPath(p1, emptyState(p1), 'red', redPath1);
    const partial = diagnose(p1, s);
    expect(partial.targets[0].state).toBe('pending');
    expect(partial.solved).toBe(false);
    expect(
      partial.problems.some((m) => m.includes('还没织出有效交叉')),
    ).toBe(true);

    s = drawPath(p1, s, 'blue', bluePath1);
    const mismatch = diagnose(p1, s);
    expect(mismatch.targets[0].state).toBe('mismatch');
  });

  it('点击各类型格点返回对应判断', () => {
    let s = drawPath(p1, emptyState(p1), 'red', redPath1);
    s = drawPath(p1, s, 'blue', bluePath1);
    s = must(setTop(p1, s, { x: 1, y: 1 }, 'blue'));

    const hole = diagnoseCell(p1, s, { x: 2, y: 2 });
    expect(hole.status).toBe('hole');
    const port = diagnoseCell(p1, s, { x: 0, y: 1 });
    expect(port.status).toBe('port');
    expect(port.message).toContain('red');
    const crossing = diagnoseCell(p1, s, { x: 1, y: 1 });
    expect(crossing.status).toBe('crossing');
    expect(crossing.top).toBe('blue');
    expect(crossing.targetMet).toBe(true);
    expect(crossing.message).toContain('翻转');
    const plain = diagnoseCell(p1, s, { x: 3, y: 1 });
    expect(plain.status).toBe('ribbon');
    const empty = diagnoseCell(p1, s, { x: 3, y: 3 });
    expect(empty.status).toBe('empty');
    expect(empty.message).toContain('可以');
  });
});

describe('颜色与路径追踪', () => {
  it('每种颜色都能从入口追踪到出口，端口未接时给 openPorts', () => {
    const d0 = diagnose(p1, emptyState(p1));
    for (const color of allColors(p1)) {
      const r = d0.ribbons.find((x) => x.color === color)!;
      expect(r.complete).toBe(false);
      expect(r.openPorts).toHaveLength(2);
    }
    const s = drawPath(p1, emptyState(p1), 'red', redPath1);
    const d1 = diagnose(p1, s);
    expect(d1.ribbons.find((r) => r.color === 'red')!.complete).toBe(true);
    expect(
      d1.ribbons.find((r) => r.color === 'blue')!.openPorts,
    ).toHaveLength(2);
  });

  it('第二关完整参考解可解且 solved 为 true', () => {
    const p2 = getPuzzle('level-2');
    let s = drawPath(p2, emptyState(p2), 'red', redPath2);
    s = drawPath(p2, s, 'blue', bluePath2);
    s = drawPath(p2, s, 'green', [
      { x: 5, y: 0 },
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
      { x: 5, y: 4 },
    ]);
    // 目标要求 red, blue, red —— 与相间规则一致
    s = must(setTop(p2, s, { x: 2, y: 1 }, 'red'));
    s = must(setTop(p2, s, { x: 2, y: 2 }, 'blue'));
    s = must(setTop(p2, s, { x: 2, y: 3 }, 'red'));
    const d = diagnose(p2, s);
    expect(d.conflicts).toHaveLength(0);
    expect(d.solved).toBe(true);
    void vKey;
  });
});
