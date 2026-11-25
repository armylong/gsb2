import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScenarios } from '../src/scenarios.ts';
import { simulate, stateAt, initialState } from '../src/engine.ts';
import type { GameState, OpCode, Pos, Scenario } from '../src/types.ts';

const [yieldScn, contScn] = getScenarios();

const pos = (state: GameState, cartId: string): Pos => {
  const c = state.carts.find((x) => x.id === cartId)!;
  return c.pos;
};
const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;
const prog = (scn: Scenario): Record<string, OpCode[]> => structuredClone(scn.defaultPrograms);

/** 普通格任何一拍都不能重叠；台面是共享工位，允许同格 */
function assertNeverStacked(scn: Scenario, programs: Record<string, OpCode[]>) {
  const sim = simulate(scn, programs);
  const tableCells = new Set(scn.tables.map((t) => `${t.pos.x},${t.pos.y}`));
  for (let t = 0; t <= sim.ticks.length; t++) {
    const s = stateAt(sim, t);
    const [a, b] = s.carts.map((c) => c.pos);
    if (samePos(a, b)) {
      assert.ok(tableCells.has(`${a.x},${a.y}`), `第 ${t} 拍两车在非台面格 (${a.x},${a.y}) 重叠`);
    }
  }
  return sim;
}

test('摆位一：默认指令双车过关，且任何时刻不重叠', () => {
  const sim = assertNeverStacked(yieldScn, prog(yieldScn));
  assert.ok(sim.winTick !== null, '默认序列应当过关');
  assert.equal(sim.winTick, 17);

  // 红车第 3 拍等待，位置停在 (3,4)；蓝车同拍经过 (4,4)
  assert.deepEqual(pos(stateAt(sim, 2), 'A'), { x: 3, y: 4 });
  assert.deepEqual(pos(stateAt(sim, 3), 'A'), { x: 3, y: 4 });
  assert.deepEqual(pos(stateAt(sim, 3), 'B'), { x: 4, y: 4 });

  // 过关来自真正的放书：两本书最终都在同色角落台面上
  const end = stateAt(sim, sim.ticks.length);
  const redBook = end.books.find((b) => b.color === 'red')!;
  const blueBook = end.books.find((b) => b.color === 'blue')!;
  assert.equal(redBook.tableId, 'red-shelf');
  assert.equal(blueBook.tableId, 'blue-shelf');
  assert.equal(redBook.cartId, null);
  assert.equal(blueBook.cartId, null);
  // 车箱都空了
  assert.ok(end.carts.every((c) => c.carrying === null));
});

test('摆位一：删掉红车的等待拍，第 3 拍同抢 (4,4) 双双阻挡，之后仍能继续', () => {
  const programs = prog(yieldScn);
  programs.A.splice(2, 1); // 删掉第 3 拍的 W
  const sim = assertNeverStacked(yieldScn, programs);

  const tick3 = sim.ticks[2];
  assert.equal(tick3.results.A.status, 'blocked');
  assert.equal(tick3.results.B.status, 'blocked');
  assert.match(tick3.results.A.reason, /同拍抢同一格/);
  assert.deepEqual(tick3.results.A.targetPos, { x: 4, y: 4 });
  // 被挡住就原地不动：A 留在 (3,4)，B 留在 (4,3)
  assert.deepEqual(pos(tick3.after, 'A'), { x: 3, y: 4 });
  assert.deepEqual(pos(tick3.after, 'B'), { x: 4, y: 3 });

  // 下一拍两辆车都能继续提动作，谁都没卡死：
  // 序列因删拍整体前移，A 第 4 拍是转向 L（成功），B 同拍 F 进入 (4,4)（成功）
  const tick4 = sim.ticks[3];
  assert.equal(tick4.results.A.op, 'L');
  assert.equal(tick4.results.A.status, 'ok');
  assert.equal(tick4.results.B.op, 'F');
  assert.equal(tick4.results.B.status, 'ok');
  assert.deepEqual(pos(tick4.after, 'B'), { x: 4, y: 4 });

  // 第 5 拍：A 朝北想进 (3,3) 但那是墙，被挡；B 转向东。被挡不影响后续拍继续提动作
  const tick5 = sim.ticks[4];
  assert.equal(tick5.results.A.status, 'blocked');
  assert.equal(tick5.results.B.op, 'L');
  assert.equal(tick5.results.B.status, 'ok');
});

test('摆位一：迎面交换位置判双双阻挡', () => {
  const programs: Record<string, OpCode[]> = {
    // A 在 (1,4) 朝东，B 挪到 (2,4) 朝西，同拍对穿
    A: ['F'],
    B: ['F'],
  };
  // 手工造一个迎面局面
  const scn: Scenario = structuredClone(yieldScn);
  scn.carts[0].pos = { x: 1, y: 4 };
  scn.carts[0].dir = 1;
  scn.carts[1].pos = { x: 2, y: 4 };
  scn.carts[1].dir = 3;
  const sim = simulate(scn, programs);
  assert.equal(sim.ticks[0].results.A.status, 'blocked');
  assert.equal(sim.ticks[0].results.B.status, 'blocked');
  assert.match(sim.ticks[0].results.A.reason, /迎面交换/);
  assert.deepEqual(pos(sim.ticks[0].after, 'A'), { x: 1, y: 4 });
  assert.deepEqual(pos(sim.ticks[0].after, 'B'), { x: 2, y: 4 });
});

test('撞墙/出界：前进被挡且不移动，转向不受影响', () => {
  const scn: Scenario = structuredClone(yieldScn);
  scn.carts[0].pos = { x: 0, y: 4 };
  scn.carts[0].dir = 3; // 朝西，面前是边界
  scn.carts[1].pos = { x: 8, y: 6 };
  scn.carts[1].dir = 1; // 朝东，面前是边界
  const sim = simulate(scn, { A: ['F', 'L'], B: ['W', 'W'] });
  assert.equal(sim.ticks[0].results.A.status, 'blocked');
  assert.match(sim.ticks[0].results.A.reason, /墙或边界/);
  assert.deepEqual(pos(sim.ticks[0].after, 'A'), { x: 0, y: 4 });
  assert.equal(sim.ticks[1].results.A.status, 'ok'); // 第二拍左转正常
  assert.equal(sim.ticks[1].after.carts[0].dir, 2);
});

test('拿放规则：空手放、满箱拿、无台面互动、错色台面拒收都判失败', () => {
  const scn = structuredClone(contScn);
  // 空手放书
  const sim0 = simulate(scn, { A: ['DROP'], B: ['W'] });
  assert.equal(sim0.ticks[0].results.A.status, 'failed');
  assert.match(sim0.ticks[0].results.A.reason, /书箱是空的/);

  // A 先走到台面拿书，再拿一次 → 书箱已满
  const sim1 = simulate(scn, { A: ['F', 'F', 'PICK', 'PICK'], B: ['W', 'W', 'W', 'W'] });
  assert.equal(sim1.ticks[2].results.A.status, 'ok');
  assert.equal(sim1.ticks[3].results.A.status, 'failed');
  assert.match(sim1.ticks[3].results.A.reason, /书箱已满/);

  // 不在台面上拿/放
  const scn2 = structuredClone(contScn);
  scn2.carts[0].pos = { x: 0, y: 0 };
  const sim2 = simulate(scn2, { A: ['PICK', 'DROP'], B: ['W', 'W'] });
  assert.match(sim2.ticks[0].results.A.reason, /没有台面/);

  // 错色台面拒收：让 B 拿着红书直接站在蓝台面上下放
  const scn3 = structuredClone(contScn);
  scn3.tables.push({ id: 'blue-shelf2', pos: { x: 0, y: 4 }, acceptColor: 'blue' });
  scn3.carts[1].pos = { x: 0, y: 4 };
  scn3.books[0].tableId = null;
  scn3.books[0].cartId = 'B';
  scn3.carts[1].carrying = scn3.books[0].id;
  const sim3 = simulate(scn3, { A: ['W'], B: ['DROP'] });
  assert.equal(sim3.ticks[0].results.B.status, 'failed');
  assert.match(sim3.ticks[0].results.B.reason, /只收/);
  // 拒收后书还在车上，没有凭空消失
  assert.equal(sim3.ticks[0].after.carts[1].carrying, scn3.books[0].id);
  assert.equal(sim3.ticks[0].after.books[0].tableId, null);
});

test('摆位二：同拍抢同一本书，A 成功 B 失败，B 后续移动不受影响，A 独立过关', () => {
  const sim = assertNeverStacked(contScn, prog(contScn));

  // 第 3 拍：两车同拍抢台面格 (3,2)，双双阻挡，原地不动
  const tick3 = sim.ticks[2];
  assert.equal(tick3.results.A.status, 'blocked');
  assert.equal(tick3.results.B.status, 'blocked');
  assert.deepEqual(pos(tick3.after, 'A'), { x: 2, y: 2 });
  assert.deepEqual(pos(tick3.after, 'B'), { x: 3, y: 1 });

  // 第 4 拍 B 等待、A 上台面
  assert.deepEqual(pos(stateAt(sim, 4), 'A'), { x: 3, y: 2 });
  assert.deepEqual(pos(stateAt(sim, 4), 'B'), { x: 3, y: 1 });

  // 第 5 拍：B 并入台面（共享工位），两车同格，书还在桌上
  assert.deepEqual(pos(stateAt(sim, 5), 'A'), { x: 3, y: 2 });
  assert.deepEqual(pos(stateAt(sim, 5), 'B'), { x: 3, y: 2 });
  assert.equal(stateAt(sim, 5).books[0].tableId, 'center-desk');

  // 第 6 拍：两车同拍 PICK 同一本书，A→B 仲裁，只有 A 成功
  const tick6 = sim.ticks[5];
  assert.equal(tick6.results.A.op, 'PICK');
  assert.equal(tick6.results.B.op, 'PICK');
  assert.equal(tick6.results.A.success, true);
  assert.equal(tick6.results.B.success, false);
  assert.match(tick6.results.B.reason, /没有可拿|同拍/);

  // 同一本书不可能同时在两个车箱里
  const holders = tick6.after.carts.filter((c) => c.carrying !== null);
  assert.equal(holders.length, 1);
  assert.equal(holders[0].id, 'A');

  // B 第 7 拍空手放书失败，第 10 拍移动正常
  assert.equal(sim.ticks[6].results.B.status, 'failed');
  assert.match(sim.ticks[6].results.B.reason, /书箱是空的/);
  assert.equal(sim.ticks[9].results.B.op, 'F');
  assert.equal(sim.ticks[9].results.B.status, 'ok');

  // A 最终把书放进红台面并过关
  assert.ok(sim.winTick !== null);
  const end = stateAt(sim, sim.ticks.length);
  assert.equal(end.books[0].tableId, 'red-shelf');
  assert.equal(end.carts[0].carrying, null);
});

test('台面共享规则：普通格静止占格仍阻挡，只有台面允许并入', () => {
  const scn: Scenario = structuredClone(contScn);
  // A 站在普通格 (2,2)，B 从 (3,2) 朝西想并入
  scn.carts[0].pos = { x: 2, y: 2 };
  scn.carts[0].dir = 1;
  scn.carts[1].pos = { x: 3, y: 2 };
  scn.carts[1].dir = 3;
  const sim = simulate(scn, { A: ['W'], B: ['F'] });
  assert.equal(sim.ticks[0].results.B.status, 'blocked');
  assert.match(sim.ticks[0].results.B.reason, /停在目标格/);

  // 同样情形但目标格是台面 → 允许并入
  const scn2: Scenario = structuredClone(contScn);
  scn2.carts[0].pos = { x: 3, y: 2 }; // A 站在台面
  scn2.carts[0].dir = 1;
  scn2.carts[1].pos = { x: 3, y: 1 };
  scn2.carts[1].dir = 2;
  const sim2 = simulate(scn2, { A: ['W'], B: ['F'] });
  assert.equal(sim2.ticks[0].results.B.status, 'ok');
  assert.deepEqual(pos(sim2.ticks[0].after, 'B'), { x: 3, y: 2 });
});

test('整条重算：修改早期指令后，旧运行拿到的书不会残留在车上', () => {
  // 先跑一遍让 A 拿书（新节拍：第 6 拍 PICK）
  const programs1 = prog(contScn);
  const sim1 = simulate(contScn, programs1);
  assert.equal(stateAt(sim1, 6).carts[0].carrying, 'book-red');

  // 改 A 的第 1 拍为等待，重新从初始局面整算
  const programs2 = prog(contScn);
  programs2.A[0] = 'W';
  const sim2 = simulate(contScn, programs2);
  // 初始局面车箱必为空；重算后的每一拍，车箱状态都由新指令推出
  assert.deepEqual(initialState(contScn).carts.map((c) => c.carrying), [null, null]);
  const at3 = stateAt(sim2, 3);
  // A 第 1 拍等了，第 3 拍才刚到 (2,2)，不可能拿着书
  assert.equal(at3.carts[0].carrying, null);
  assert.deepEqual(pos(at3, 'A'), { x: 2, y: 2 });
});

test('指令长度不齐：缺失指令按等待处理，仿真长度跟最长序列', () => {
  const sim = simulate(contScn, { A: ['F'], B: [] });
  assert.equal(sim.ticks.length, 1);
  assert.equal(sim.ticks[0].results.B.op, 'W');
  assert.equal(sim.ticks[0].results.B.status, 'ok');
});
