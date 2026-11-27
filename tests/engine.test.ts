import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFold,
  applyPunch,
  applyUnfold,
  cloneState,
  createInitialState,
  evaluate,
  keyOf,
  undoLast,
  runSolutionSelfCheck,
  type GameState,
  type Level,
} from '../src/engine.ts';
import { LEVELS } from '../src/levels.ts';

const baseLevel: Level = {
  id: 0,
  name: 't',
  brief: 't',
  width: 4,
  height: 3,
  maxFolds: 4,
  maxPunches: 4,
  maxThickness: 4,
  targets: [],
  preserves: [],
  solution: [],
};

function lv(over: Partial<Level> = {}): Level {
  return { ...baseLevel, ...over };
}

function idsAt(s: GameState, x: number, y: number): number[] {
  return (s.cells.get(keyOf(x, y)) ?? []).map((p) => p.id);
}

test('竖折镜像方向：fx 翻转、fy 不变，水平镜像落位', () => {
  const s = createInitialState(lv({ width: 3, height: 1 }));
  const r = applyFold(s, 'v', 1, 'gt');
  assert.ok(r.ok, r.reason);
  const stack = s.cells.get(keyOf(0, 0))!;
  assert.equal(stack.length, 2);
  // 底层是原 (0,0)，顶层是从 (2,0) 翻过来的
  assert.equal(stack[0].ox, 0);
  assert.equal(stack[1].ox, 2);
  assert.equal(stack[1].fx, 1);
  assert.equal(stack[1].fy, 0);
  // 原 (2,0) 已移走
  assert.equal(s.cells.has(keyOf(2, 0)), false);
});

test('横折镜像方向：fy 翻转、fx 不变，垂直镜像落位', () => {
  const s = createInitialState(lv({ width: 1, height: 3 }));
  assert.ok(applyFold(s, 'h', 1, 'lt').ok);
  const stack = s.cells.get(keyOf(0, 2))!;
  assert.equal(stack[0].oy, 2);
  assert.equal(stack[1].oy, 0);
  assert.equal(stack[1].fy, 1);
  assert.equal(stack[1].fx, 0);
});

test('整摞翻面后层序反转，展开恢复原层序与朝向', () => {
  // 5x1：先沿 2 折右侧（0,1 不动，2 铰链，3->1, 4->0），再沿 1 折右侧
  // 最终 (0,0) 叠三层 [0, 4, 2]
  const s = createInitialState(lv({ width: 5, height: 1 }));
  applyFold(s, 'v', 2, 'gt');
  applyFold(s, 'v', 1, 'gt');
  const stack = idsAt(s, 0, 0);
  assert.equal(stack.length, 3);
  assert.deepEqual(stack, [0, 4, 2]);
  // 逐步展开，回到初始单层布局
  applyUnfold(s);
  applyUnfold(s);
  for (let i = 0; i < 5; i++) assert.deepEqual(idsAt(s, i, 0), [i]);
  for (let i = 0; i < 5; i++) {
    const p = s.cells.get(keyOf(i, 0))![0];
    assert.equal(p.fx, 0);
    assert.equal(p.fy, 0);
  }
});

test('打穿部分纸层：只命中顶层 depth 片，底层完好', () => {
  const s = createInitialState(lv({ width: 3, height: 1, maxPunches: 2 }));
  applyFold(s, 'v', 1, 'gt');
  // 折叠后 (0,0) = [原0(底), 原2(顶)]
  const r = applyPunch(s, 0, 0, 1);
  assert.ok(r.ok, r.reason);
  const stack = s.cells.get(keyOf(0, 0))!;
  assert.equal(stack[0].holed, false);
  assert.equal(stack[1].holed, true);
  applyUnfold(s);
  const report = evaluate(s);
  assert.equal(report.broken.length, 0);
  assert.equal(report.missing.length, 0, '无目标关卡不应报缺失');
  assert.equal(s.cells.get(keyOf(2, 0))![0].holed, true);
  assert.equal(s.cells.get(keyOf(0, 0))![0].holed, false);
});

test('同一格重复打孔不新增洞，但照常消耗次数', () => {
  const s = createInitialState(lv({ width: 3, height: 1, maxPunches: 3 }));
  applyFold(s, 'v', 1, 'gt');
  assert.ok(applyPunch(s, 0, 0, 2).ok);
  assert.equal(s.punchesUsed, 1);
  assert.equal(s.holes.size, 2);
  assert.ok(applyPunch(s, 0, 0, 2).ok);
  assert.equal(s.punchesUsed, 2);
  assert.equal(s.holes.size, 2, '重复打孔不新增洞');
});

test('厚度超限拒绝且原地保持', () => {
  // 5x1 限厚 2：两折后 (0,0) 会叠三层，第二次折叠必须被拒绝
  const s = createInitialState(lv({ width: 5, height: 1, maxThickness: 2 }));
  applyFold(s, 'v', 2, 'gt'); // (0,0) 变两层，未超限
  const before = cloneState(s);
  const r = applyFold(s, 'v', 1, 'gt'); // 会在 (0,0) 叠三层
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /厚度/);
  assert.deepEqual([...s.cells.keys()].sort(), [...before.cells.keys()].sort());
  assert.equal(s.foldsUsed, 1);
});

test('在没有纸的位置打孔被拒绝且原地保持', () => {
  const s = createInitialState(lv({ width: 2, height: 1 }));
  const r = applyPunch(s, 5, 0, 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /没有纸/);
  assert.equal(s.punchesUsed, 0);
  assert.equal(s.undoStack.length, 0);
});

test('depth 超过该摞厚度被拒绝', () => {
  const s = createInitialState(lv({ width: 2, height: 1 }));
  const r = applyPunch(s, 0, 0, 2);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /只有 1 层/);
});

test('折痕越界与次数耗尽都被拒绝', () => {
  const s = createInitialState(lv({ width: 3, height: 1, maxFolds: 1 }));
  assert.equal(applyFold(s, 'v', 0, 'gt').ok, false);
  assert.equal(applyFold(s, 'v', 3, 'gt').ok, false);
  assert.ok(applyFold(s, 'v', 1, 'gt').ok);
  assert.equal(applyFold(s, 'v', 1, 'lt').ok, false);
});

test('撤销区分折/展开/打孔，层序、朝向、计数全部还原', () => {
  const s = createInitialState(lv({ width: 3, height: 1, maxPunches: 2 }));
  applyFold(s, 'v', 1, 'gt');
  applyPunch(s, 0, 0, 2);
  applyUnfold(s);
  assert.equal(s.folds.length, 0);
  assert.equal(s.punchesUsed, 1);
  // 撤销展开
  undoLast(s);
  assert.equal(s.folds.length, 1);
  assert.equal(s.cells.get(keyOf(2, 0)), undefined);
  // 撤销打孔
  undoLast(s);
  assert.equal(s.punchesUsed, 0);
  assert.equal(s.holes.size, 0);
  assert.equal(s.cells.get(keyOf(0, 0))!.every((p) => !p.holed), true);
  // 撤销折叠
  undoLast(s);
  assert.equal(s.foldsUsed, 0);
  assert.deepEqual(idsAt(s, 2, 0), [2]);
  assert.equal(s.undoStack.length, 0);
  // 再撤销无事可做
  assert.equal(undoLast(s).ok, false);
});

test('保留格被打穿则判定失败，目标齐全且保留完好才通关', () => {
  const s = createInitialState(
    lv({
      width: 3,
      height: 1,
      targets: [{ x: 2, y: 0 }],
      preserves: [{ x: 0, y: 0 }],
    }),
  );
  applyFold(s, 'v', 1, 'gt');
  applyPunch(s, 0, 0, 2); // 连底层原 (0,0) 一起打穿
  applyUnfold(s);
  const report = evaluate(s);
  assert.equal(report.won, false);
  assert.deepEqual(report.broken, [{ x: 0, y: 0 }]);
});

test('全部关卡示例可执行并通关（含横折后竖折关）', () => {
  for (const level of LEVELS) {
    const r = runSolutionSelfCheck(level);
    assert.ok(r.ok, `关卡 ${level.id}：${r.reason}`);
  }
  const l4 = LEVELS.find((l) => l.id === 4)!;
  assert.deepEqual(
    l4.solution.filter((st) => st.kind === 'fold').map((st) => st.kind === 'fold' && st.axis),
    ['h', 'v'],
  );
});

test('第 5 关示例验证部分层打孔与负坐标落点', () => {
  const level = LEVELS.find((l) => l.id === 5)!;
  const s = createInitialState(level);
  applyFold(s, 'v', 1, 'gt');
  // x=-1 在原纸面之外但有纸（原 (3,0) 镜像而来）
  const outside = s.cells.get(keyOf(-1, 0))!;
  assert.equal(outside[0].ox, 3);
  applyPunch(s, 0, 0, 1);
  applyPunch(s, -1, 0, 1);
  applyUnfold(s);
  const report = evaluate(s);
  assert.equal(report.won, true);
  assert.equal(s.cells.get(keyOf(0, 0))![0].holed, false);
  assert.equal(s.cells.get(keyOf(1, 0))![0].holed, false);
});
