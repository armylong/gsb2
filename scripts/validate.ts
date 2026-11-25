/* 正式题面 + 核心规则的无浏览器校验：npm run validate */
import {
  Dir,
  GameState,
  cellKey,
  evaluate,
  initialState,
  parseLevel,
  rollOri,
  tryMove,
  tryStamp,
} from '../src/game/engine';
import { LEVELS } from '../src/game/levels';
import { buildHint, solveFrom } from '../src/game/solver';

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log('  ✓', msg);
  } else {
    failures++;
    console.error('  ✗ FAIL:', msg);
  }
}

/** 用引擎逐步执行 solver 给出的动作，返回最终 state（任何一步非法即抛错） */
function runPath(levelId: string, ori: string, blocks: boolean) {
  const level = LEVELS.find((l) => l.id === levelId)!;
  const board = parseLevel(level);
  let state = initialState(board, ori);
  const path = solveFrom(board, state, { stampedBlocks: blocks });
  if (!path) return { board, state, path: null, won: false };
  for (const a of path) {
    if (a.type === 'move') {
      const r = tryMove(state, board, a.dir, blocks);
      if (!r.ok) throw new Error(`solver 给出非法移动 ${a.dir} @${state.x},${state.y} reason=${r.reason}`);
      state = r.state;
    } else {
      const r = tryStamp(state, board);
      if (!r.ok) throw new Error(`solver 给出非法盖印 reason=${r.reason} @${state.x},${state.y}`);
      if (r.verdict !== 'right') throw new Error('solver 盖印颜色应当正确');
      state = r.state;
    }
  }
  return { board, state, path, won: evaluate(board, state).won };
}

console.log('\n[1] 所有关卡 / 起手朝向在「盖印格不可再进入」规则下可解，且引擎执行后通关');
for (const level of LEVELS) {
  const oris: [string, string][] = [['default', level.startOri]];
  level.variants?.forEach((v) => oris.push([v.id, v.ori]));
  for (const [name, ori] of oris) {
    const r = runPath(level.id, ori, level.stampedBlocks);
    assert(!!r.path, `${level.name} / ${name} 搜到解（${r.path?.length ?? 'null'} 步）`);
    assert(r.won, `${level.name} / ${name} 用引擎执行该解后判定通关`);
  }
}

console.log('\n[2] 分歧关：两种起手朝向的最后位置 / 路线确实不同');
{
  const level = LEVELS.find((l) => l.fork)!;
  assert(!!level, '存在标记 fork 的题面');
  const [a, b] = level.variants!;
  const ra = runPath(level.id, a.ori, true);
  const rb = runPath(level.id, b.ori, true);
  assert(ra.won && rb.won, '两种朝向都能通关');
  assert(
    ra.state.x !== rb.state.x || ra.state.y !== rb.state.y,
    `最终停留格不同：A=(${ra.state.x},${ra.state.y}) B=(${rb.state.x},${rb.state.y})`,
  );
  assert(
    JSON.stringify(ra.path) !== JSON.stringify(rb.path),
    '两条求解路径不同（起点方向改变了结果）',
  );
  console.log(
    `    A 终点(${ra.state.x},${ra.state.y}) ${ra.path?.length}步；B 终点(${rb.state.x},${rb.state.y}) ${rb.path?.length}步`,
  );
}

console.log('\n[3] 墙阻挡：位置 / 朝向 / 印记完全保留');
{
  const level = LEVELS[0];
  const board = parseLevel(level);
  const s0 = initialState(board);
  // 起点 (1,1) 西邻 x=0 的墙
  const before = JSON.stringify(s0);
  const r = tryMove(s0, board, 'W', true);
  assert(!r.ok && r.reason === 'wall', '向西撞墙，返回 wall');
  assert(JSON.stringify(s0) === before, '原状态对象未被修改');
  assert(s0.x === 1 && s0.y === 1, '位置不变');
}

console.log('\n[4] 印阻挡 vs 关闭规则');
{
  const level = LEVELS.find((l) => l.id === 'bridge-seal')!;
  const board = parseLevel(level);
  // 断桥格 (5,3) 有印，方块在其东侧 (6,3)，向西想重新进入
  const stamped: GameState = { x: 6, y: 3, ori: level.startOri, stamps: { [cellKey(5, 3)]: 'P' } };
  const blocked = tryMove(stamped, board, 'W', true);
  assert(!blocked.ok && blocked.reason === 'stamp', '规则开启：不能再次进入盖印格，原因=stamp');
  const free = tryMove(stamped, board, 'W', false);
  assert(free.ok, '规则关闭：同一格可以进入');
}

console.log('\n[5] 盖错印后提示给出退回建议（且初始局面可解，不是内置解法）');
{
  const level = LEVELS[0];
  const board = parseLevel(level);
  const s0 = initialState(board);
  const wrong = tryStamp(s0, board); // 起点地板，贴地紫 -> floor-blot
  assert(wrong.ok && wrong.verdict === 'floor-blot', '在起点盖印属于污渍');
  if (wrong.ok) {
    const h = buildHint(board, [s0], wrong.state, true, false);
    assert(h.kind === 'undo', `污渍后当前无解，提示退回（实际 kind=${h.kind}）`);
    if (h.kind === 'undo') assert(h.undoSteps === 1, '最近可解祖先就是上一步，建议撤销 1 步');
  }
  // 干净当前局面应给 next 动作
  const h2 = buildHint(board, [], s0, true, false);
  assert(h2.kind === 'next', `初始局面给出可行下一步（kind=${h2.kind}）`);
}

console.log('\n[6] 封口格时机限制');
{
  const level = LEVELS.find((l) => l.id === 'bridge-seal')!;
  const board = parseLevel(level);
  // 直接把方块放到封口格 (8,5)，普通目标全空
  const onSeal: GameState = { x: 8, y: 5, ori: level.startOri, stamps: {} };
  const r = tryStamp(onSeal, board);
  assert(!r.ok && r.reason === 'seal-locked', '普通目标未完成时封口格不能落印');
}

console.log('\n[7] 朝向滚动可逆 / 四滚归位');
{
  // 直接验证 rollOri 性质
  const o = 'RPGOYB';
  for (const d of ['N', 'E', 'S', 'W'] as Dir[]) {
    let x = o;
    for (let i = 0; i < 4; i++) x = rollOri(x, d);
    assert(x === o, `朝 ${d} 连滚 4 次朝向复原`);
  }
  assert(rollOri(rollOri(o, 'N'), 'S') === o, '北滚后南滚抵消');
  assert(rollOri(rollOri(o, 'E'), 'W') === o, '东滚后西滚抵消');
}

console.log(`\n${failures === 0 ? '✅ 全部校验通过' : `❌ ${failures} 项失败`}\n`);
if (failures > 0) process.exit(1);
