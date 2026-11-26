/**
 * 本地验证脚本：npm run validate
 * 不依赖浏览器/DOM，直接对纯引擎与求解器做断言。
 * 覆盖：唯一答案、读数相同但答案未定、越墙失败、提示解释、通路核对、
 *      单读数不足以定位（相交推断关）、次数限制、标记不耗次数、重开不换底图。
 */
import { Board, recordToConstraint } from '../src/engine/board';
import { Solver, explainForcedCell } from '../src/engine/solver';
import { requestHint, buildConstraints } from '../src/engine/hints';
import { GameState } from '../src/engine/state';
import { LEVELS } from '../src/levels';
import type { Cell, LevelDef, Marker, ProbeAction, ProbeRecord } from '../src/types';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function constraintsOf(board: Board, records: ProbeRecord[]) {
  return records.map((rec) =>
    recordToConstraint(rec, (r, c) => board.openCellIndex(r, c)),
  );
}

/** 跑关卡 walkthrough，返回每一步后的读数记录 */
function runWalkthrough(level: LevelDef): { board: Board; records: ProbeRecord[] } {
  const board = new Board(level.rows);
  const records: ProbeRecord[] = [];
  let id = 1;
  for (const action of level.walkthrough) {
    records.push(board.probe(action, id++));
  }
  return { board, records };
}

function solutionCount(board: Board, records: ProbeRecord[], max = 2) {
  const solver = new Solver(board, constraintsOf(board, records));
  return solver.solve({ maxSolutions: max });
}

/** 与真底图逐格比对，判断某个解是否就是关卡底图 */
function matchesTruth(board: Board, sol: Uint8Array, variables: { r: number; c: number }[]): boolean {
  for (let i = 0; i < variables.length; i++) {
    const { r, c } = variables[i];
    const truth = board.kind(r, c) === 'solid' ? 1 : 0;
    if (sol[i] !== truth) return false;
  }
  return true;
}

// localStorage 的最小内存桩，让 GameState 在 node 下可跑
const memStore = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i: number) => [...memStore.keys()][i] ?? null,
  get length() {
    return memStore.size;
  },
} as Storage;

console.log('\n== 关卡结构与 walkthrough 基本合法性 ==');
for (const level of LEVELS) {
  const board = new Board(level.rows);
  check(`${level.id}: 行宽一致`, level.rows.every((r: string) => r.length === level.rows[0].length));
  check(`${level.id}: 入口是开放格`, board.isOpen(level.entry.r, level.entry.c));
  check(`${level.id}: 出口是开放格`, board.isOpen(level.exit.r, level.exit.c));
  check(
    `${level.id}: 出口本身是实地（否则永远走不通）`,
    board.kind(level.exit.r, level.exit.c) === 'solid',
  );
  check(
    `${level.id}: walkthrough 探头数量不超预算`,
    level.walkthrough.filter((a: ProbeAction) => a.type === 'line').length <= level.lineBudget &&
      level.walkthrough.filter((a: ProbeAction) => a.type === 'adjacency').length <= level.adjacencyBudget,
  );
}

console.log('\n== 1) 唯一答案：walkthrough 的全套读数只相容于真底图 ==');
for (const level of LEVELS) {
  const { board, records } = runWalkthrough(level);
  const result = solutionCount(board, records, 2);
  check(
    `${level.id}: 全套读数下相容底图唯一`,
    !result.capped && result.solutions.length === 1,
    `实际解数=${result.solutions.length} capped=${result.capped}`,
  );
  check(
    `${level.id}: 唯一解与内置底图逐格一致`,
    result.solutions.length === 1 && matchesTruth(board, result.solutions[0], result.variables),
  );
  // 设计好的安全通路必须真的能通过
  const pathCheck = board.checkPath(level.safePath, level.entry, level.exit);
  check(`${level.id}: 内置 safePath 通过校验`, pathCheck.ok, pathCheck.reason ?? '');
}

console.log('\n== 2) 读数相同但答案未定：部分读数下存在多个相符布局 ==');
for (const level of LEVELS) {
  const { board, records } = runWalkthrough(level);
  // 取 walkthrough 前一半读数（至少留一条），应当信息不足
  const partial = records.slice(0, Math.max(1, Math.floor(records.length / 2)));
  const result = solutionCount(board, partial, 2);
  check(
    `${level.id}: 仅靠前 ${partial.length} 条读数时有多个相符布局`,
    result.capped,
    `解数=${result.solutions.length}`,
  );

  // 单条方向探头读数也不足以定全图
  const firstLine = records.find((r) => r.type === 'line')!;
  const oneResult = solutionCount(board, [firstLine], 2);
  check(`${level.id}: 单条读数无法确定底图`, oneResult.capped);
}

console.log('\n== 3) 越墙失败：探测在墙处截断，读不到墙另一侧 ==');
{
  // 第三关有内部墙 (1,1)(1,2) 与 (3,3)(3,4)，用它验证截断
  const level = LEVELS[2];
  const board = new Board(level.rows);
  const rec = board.probe({ type: 'line', r: 0, c: 0, dir: 'right' }, 1);
  check(
    'lv3: 向右探测在 (0,?) 行无内墙，覆盖整行 6 格',
    rec.cells.length === 5 && rec.cells.every((p: Cell) => p.r === 0),
    `覆盖=${JSON.stringify(rec.cells)}`,
  );
  // (0,2) 向下：第 1 行是墙 (1,2)，必须立即截断，覆盖 0 格
  const blocked = board.probe({ type: 'line', r: 0, c: 2, dir: 'down' }, 2);
  check(
    'lv3: (0,2) 向下被墙 (1,2) 截断，覆盖 0 格且读数 0',
    blocked.cells.length === 0 && blocked.reading === 0,
    `覆盖=${JSON.stringify(blocked.cells)}`,
  );
  // (1,3) 向左：(1,2)(1,1) 都是墙，截断
  const blocked2 = board.probe({ type: 'line', r: 1, c: 3, dir: 'left' }, 3);
  check(
    'lv3: (1,3) 向左被双墙截断，覆盖 0 格',
    blocked2.cells.length === 0,
    `覆盖=${JSON.stringify(blocked2.cells)}`,
  );
  // 邻域探头同样不越墙：(0,2) 的邻格不含墙后的 (1,2)
  const adj = board.probe({ type: 'adjacency', r: 0, c: 2 }, 4);
  check(
    'lv3: 邻域探头不把墙格算进邻格',
    adj.cells.every((p: Cell) => !board.isWall(p.r, p.c)) &&
      adj.cells.length === 2 &&
      !adj.cells.some((p: Cell) => p.r === 1 && p.c === 2),
    `邻格=${JSON.stringify(adj.cells)}`,
  );
}

console.log('\n== 4) 提示：能给出必然格并指出读数；信息不足时明确回答 ==');
for (const level of LEVELS) {
  const { board, records } = runWalkthrough(level);
  // 完整读数下提示必须命中一个取值被所有解确定的格
  const outcome = requestHint(board, records, new Map<string, Marker>());
  check(`${level.id}: 完整读数下提示返回确定格`, outcome.kind === 'hint');
  if (outcome.kind === 'hint') {
    const solver = new Solver(board, buildConstraints(board, records));
    const result = solver.solve({ maxSolutions: 2 });
    const vi = solver.indexOf(outcome.cell.r, outcome.cell.c);
    const forced = !result.capped && result.solutions.every((s) => s[vi] === outcome.solid);
    check(`${level.id}: 提示格确实在所有相容布局里取值一致`, forced);

    // 解释里引用的读数子集本身就足以推出该格
    const allCons = buildConstraints(board, records);
    const subset = allCons.filter((c) => outcome.recordIds.includes(c.recordId));
    const subSolver = new Solver(board, subset);
    const subResult = subSolver.solve({ maxSolutions: 2 });
    const subVi = subSolver.indexOf(outcome.cell.r, outcome.cell.c);
    check(
      `${level.id}: 提示引用的读数子集足以独立推出结论`,
      !subResult.capped && subResult.solutions.every((s) => s[subVi] === outcome.solid),
      `引用 #${outcome.recordIds.join(', #')}`,
    );
    check(`${level.id}: 解释是最小子集（去掉任意一条就推不出）`, (() => {
      for (const id of outcome.recordIds) {
        const smaller = subset.filter((c) => c.recordId !== id);
        const s = new Solver(board, smaller).solve({ maxSolutions: 2 });
        const i = new Solver(board, smaller).indexOf(outcome.cell.r, outcome.cell.c);
        if (!s.capped && s.solutions.every((sol) => sol[i] === outcome.solid)) return false;
      }
      return true;
    })());
  }
  // 没有任何读数时必须回答信息不够
  const early = requestHint(board, [], new Map<string, Marker>());
  check(`${level.id}: 无读数时回答信息不够`, early.kind === 'unknown');
}

console.log('\n== 5) 第二关：任何单条读数都不能单独定位空洞，必须相交推断 ==');
{
  const level = LEVELS[1];
  const { board, records } = runWalkthrough(level);
  const truth = board.openCells().filter((p) => board.kind(p.r, p.c) === 'empty');
  check('lv2: 底图只有一个空洞', truth.length === 1, `空洞=${JSON.stringify(truth)}`);
  const hole = truth[0];
  const allCons = buildConstraints(board, records);
  let anySingleForces = false;
  for (const con of allCons) {
    const solver = new Solver(board, [con]);
    const result = solver.solve({ maxSolutions: 2 });
    if (result.capped) continue;
    const vi = solver.indexOf(hole.r, hole.c);
    if (result.solutions.every((s) => s[vi] === 0)) anySingleForces = true;
  }
  check('lv2: 没有任何一条读数能单独推出空洞位置', !anySingleForces);

  // 全套读数唯一，且解释至少引用两条读数 -> 依赖相交
  const full = new Solver(board, allCons).solve({ maxSolutions: 2 });
  check('lv2: 全套读数唯一确定底图', !full.capped && full.solutions.length === 1);
  const ids = explainForcedCell(board, allCons, hole, 0);
  check('lv2: 空洞结论的解释需要至少两条读数（相交推断）', ids.length >= 2, `引用=${ids.join(',')}`);
  // 行读数与列读数各至少一条
  const lineRecs = records.filter((r) => r.type === 'line');
  const horizontal = lineRecs.filter((r) => r.cells.every((p) => p.r === hole.r));
  const vertical = lineRecs.filter((r) => r.cells.every((p) => p.c === hole.c));
  check(
    'lv2: 解释同时依赖“空洞所在行”和“空洞所在列”两类读数',
    ids.some((id) => horizontal.some((r) => r.id === id)) &&
      ids.some((id) => vertical.some((r) => r.id === id)),
  );
}

console.log('\n== 6) 通路核对：踩空 / 撞墙 / 不相邻 / 起终点错误都要判失败 ==');
{
  const level = LEVELS[0];
  const board = new Board(level.rows);
  const E = level.entry;
  const X = level.exit;
  const failCases: { name: string; path: { r: number; c: number }[] }[] = [
    { name: '起点错误', path: [{ r: 0, c: 0 }, E, { r: E.r, c: E.c + 1 }] },
    { name: '终点错误', path: [E, { r: E.r, c: E.c + 1 }] },
    { name: '踩空洞 (3,0)', path: [E, { r: 3, c: 0 }] },
    { name: '撞墙 (0,2)', path: [E, { r: 1, c: 0 }, { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }] },
    { name: '非相邻跳格', path: [E, { r: 0, c: 0 }] },
  ];
  for (const fc of failCases) {
    const r = board.checkPath(fc.path, E, X);
    check(`lv1: ${fc.name} 被判失败`, !r.ok, r.reason);
  }
  const ok = board.checkPath(level.safePath, E, X);
  check('lv1: 合法通路通过', ok.ok, ok.reason ?? '');
}

console.log('\n== 7) GameState：次数限制、标记不耗次数、重开保留底图 ==');
{
  const level = LEVELS[0];
  memStore.clear();
  const state = new GameState(level);
  const lineBudget = level.lineBudget;
  for (let i = 0; i < lineBudget; i++) {
    state.place({ type: 'line', r: 0, c: 0, dir: 'right' });
  }
  check('lv1: 方向探头达到预算后拒绝继续', !state.canPlace({ type: 'line', r: 0, c: 0, dir: 'right' }).ok);
  check('lv1: 邻域探头预算独立，仍可使用', state.canPlace({ type: 'adjacency', r: 0, c: 0 }).ok);

  const before = state.records.length;
  state.setMarker(1, 1, 'safe');
  state.setMarker(1, 2, 'void');
  state.setMarker(1, 3, 'unknown');
  check('lv1: 改标记不消耗探头', state.records.length === before);
  check('lv1: 三种标记都能写入', state.markerAt(1, 1) === 'safe' && state.markerAt(1, 2) === 'void' && state.markerAt(1, 3) === 'unknown');
  state.setMarker(1, 1, 'safe'); // 再点同一种 = 取消
  check('lv1: 同格再点同类标记取消', state.markerAt(1, 1) === undefined);

  // 交卷失败 -> 重开：读数清空，但底图不变（同一 LevelDef，且新 state 算出的读数一致）
  state.clearPath();
  state.togglePathCell(level.entry.r, level.entry.c);
  state.togglePathCell(3, 0); // 空洞
  const submit = state.submit();
  check('lv1: 踩空洞的通路交卷失败', !submit.ok, submit.reason);
  check('lv1: 失败后底图已揭开用于回顾', state.revealed);
  state.restart();
  check('lv1: 重开后读数与标记清空', state.records.length === 0 && state.markers.size === 0);
  check('lv1: 重开后未揭开', !state.revealed);
  const reProbe = state.board.probe({ type: 'line', r: 0, c: 0, dir: 'right' }, 1);
  const firstWalkthrough = new Board(level.rows).probe(level.walkthrough[4], 1);
  check('lv1: 重开不换底图（同位置同方向读数一致）', reProbe.reading === firstWalkthrough.reading);

  // 墙格不能放探头
  check('lv1: 墙格拒绝探头', !state.canPlace({ type: 'line', r: 0, c: 2, dir: 'down' }).ok);
}

console.log('\n== 8) 邻域探头读数语义 ==');
{
  // 构造一个小棋盘独立验证“至少一个空洞”语义与不越墙
  const board = new Board(['.#.', '...', '..o']);
  // (1,1) 邻格：上 (0,1) 是墙被排除；下 (2,1) 实；左 (1,0) 实；右 (1,2) 实 -> 全实 = 0
  const safe = board.probe({ type: 'adjacency', r: 1, c: 1 }, 1);
  check('邻域: 四邻全实且上方是墙 -> 读数 0', safe.reading === 0 && safe.cells.length === 3);
  // (1,2) 邻格：下 (2,2) 是空洞 -> 读数 1
  const danger = board.probe({ type: 'adjacency', r: 1, c: 2 }, 2);
  check('邻域: 邻格含空洞 -> 读数 1', danger.reading === 1);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
if (fail > 0) process.exit(1);
