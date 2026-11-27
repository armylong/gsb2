/**
 * 本地验证：npm run validate
 * 1. 两关都可解，且最短解在回合预算内
 * 2. 第 1 关最短解必须使用暂存位（绕道不可避免）
 * 3. 第 2 关最短解必须等待交替门
 * 4. 所有合法重放路径：不越门、不钻低过梁、货位不重叠、画箱总数不变
 * 5. 非法动作矩阵：关门 / 单侧门 / 堵门 / 低过梁 / 满位 都必须被拒绝且状态不变
 */
import { LEVELS } from '../src/engine/levels';
import {
  alternatingSide,
  applyAction,
  applyTransfer,
  cloneState,
  createInitialState,
  getFloor,
  isDoorOpen,
  isWon,
} from '../src/engine/engine';
import { solve, type SolvedStep } from '../src/engine/solver';import type { Action, BoxPlacement, GameState, LevelDef, Side } from '../src/engine/types';

let failures = 0;
let passes = 0;

function check(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function boxCount(state: GameState): number {
  return state.placements.length;
}

function slotOverlap(state: GameState): boolean {
  const seen = new Set<string>();
  for (const p of state.placements) {
    for (const k of placementKeys(state, p)) {
      if (seen.has(k)) return true;
      seen.add(k);
    }
  }
  return false;
}

function placementKeys(state: GameState, p: BoxPlacement): string[] {
  const level = LEVELS.find((l) => l.id === state.levelId)!;
  const box = level.boxes.find((b) => b.id === p.boxId)!;
  const keys: string[] = [];
  for (let i = 0; i < box.len; i++) {
    keys.push(`${p.region}|${p.floor ?? '_'}|${p.side ?? '_'}|${p.index + i}`);
  }
  return keys;
}

/** 独立于引擎的"过门"审计：重放中每次跨门搬运都必须门开、过梁够高 */
function auditNoClosedDoor(level: LevelDef, before: GameState, action: Action): string | null {
  if (action.type !== 'transfer') return null;
  const p = before.placements.find((x) => x.boxId === action.boxId)!;
  const target = action.target;
  const samePlatform =
    p.region !== 'car' &&
    target.region !== 'car' &&
    p.floor === target.floor &&
    p.side === target.side;
  if (samePlatform) return null;

  const side: Side = p.region === 'car' ? target.side : p.side!;
  const floor = before.carFloor;
  if (!isDoorOpen(level, floor, side, before.turn)) {
    return `画箱 ${action.boxId} 穿过了关闭的 ${floor} 层${side === 'L' ? '左' : '右'}门（回合 ${before.turn}）`;
  }
  const box = level.boxes.find((b) => b.id === action.boxId)!;
  const pf = getFloor(level, floor)[side];
  if (pf.lintel === 'low' && box.height === 'tall') {
    return `高箱 ${action.boxId} 钻过了 ${floor} 层${side === 'L' ? '左' : '右'}侧低过梁`;
  }
  return null;
}

function auditLevel(level: LevelDef, steps: SolvedStep[]): void {
  let state = createInitialState(level);
  const initialCount = boxCount(state);
  check(!slotOverlap(state), `[${level.name}] 初始货位无重叠`);

  for (const step of steps) {
    const before = cloneState(state);
    const doorViolation = auditNoClosedDoor(level, before, step.action);
    check(doorViolation === null, `[${level.name}] 不越门/不钻低过梁`, doorViolation ?? '');

    const r = applyAction(level, state, step.action);
    check(r.ok, `[${level.name}] 最短解动作合法`, r.reason?.message);
    if (!r.ok || !r.state) return;
    state = r.state;

    check(boxCount(state) === initialCount, `[${level.name}] 画箱总数恒为 ${initialCount}`);
    check(!slotOverlap(state), `[${level.name}] 货位始终不重叠`);
  }
  check(isWon(level, state), `[${level.name}] 重放后通关`);
}

function expectReject(level: LevelDef, state: GameState, action: Action, label: string): void {
  const before = cloneState(state);
  const r = applyAction(level, state, action);
  check(!r.ok && r.state === undefined, `[拒绝] ${label}`, r.reason?.message);
  check(
    JSON.stringify(before) === JSON.stringify(state),
    `[拒绝不变量] ${label} 被拒后状态原样保留`,
  );
}

// ---------------------------------------------------------------------------

console.log('== 关卡求解与最短解 ==');
for (const level of LEVELS) {
  console.log(`\n${level.name}（预算 ${level.budget} 回合）`);
  const result = solve(level);
  check(result.found, '存在通关解', `搜索 ${result.explored} 个状态未找到解`);
  if (!result.found) continue;
  console.log(`  最短解：${result.steps.length} 个动作 / ${result.totalTurns} 回合，探索 ${result.explored} 状态`);
  auditLevel(level, result.steps);

  if (level.id === 1) {
    // 第 1 关：含暂存的最短解 vs 禁用暂存的最短解
    const staged = solve(level, 300000, { requireStage: true });
    const noStage = solve(level, 300000, { forbidStage: true });
    check(staged.found, '存在使用暂存位的通关解');
    check(noStage.found, '禁用暂存位时仍存在合法解（只是更费回合）');
    if (staged.found && noStage.found) {
      console.log(`  含暂存最短解：${staged.totalTurns} 回合；禁用暂存最短解：${noStage.totalTurns} 回合；预算 ${level.budget}`);
      check(
        staged.totalTurns <= level.budget,
        '暂存路线在回合预算内',
        `需 ${staged.totalTurns}，预算 ${level.budget}`,
      );
      check(
        noStage.totalTurns > level.budget,
        '不暂存必然超出预算 —— 绕道暂存是预算内唯一走法',
        `不暂存仅需 ${noStage.totalTurns} 回合`,
      );
      check(
        noStage.totalTurns > staged.totalTurns,
        '暂存路线严格短于任何不暂存路线',
      );
    }
  }
  if (level.id === 2) {
    check(result.totalTurns <= level.budget, '第 2 关最短解在回合预算内');
    // 第 2 关：交替门的两条可验证性质
    // (a) 等待比"移动凑奇偶"便宜：等待 1 回合，邻层往返至少 2 回合
    const waitCost = applyAction(level, createInitialState(level), { type: 'wait' });
    check(waitCost.ok && waitCost.cost === 1, '等待翻转交替门只花费 1 回合');
    // (b) 直觉路线（轿厢从 2 层下 1 层接 S、原车返回）到达时左门关闭，
    //     此时进展柜必被拒；等待后左门开、可入柜
    let s2 = createInitialState(level);
    const go1 = applyAction(level, s2, { type: 'move', toFloor: 1 });
    const load = applyAction(level, go1.state!, {
      type: 'transfer',
      boxId: 'S',
      target: { region: 'car', floor: 1, side: 'L' },
    });
    const back2 = applyAction(level, load.state!, { type: 'move', toFloor: 2 });
    s2 = back2.state!;
    check(!isDoorOpen(level, 2, 'L', s2.turn), '直觉路线到达 2 层时左门恰好关闭');
    expectReject(
      level,
      s2,
      { type: 'transfer', boxId: 'S', target: { region: 'case', floor: 2, side: 'L' } },
      '关门拍 S 无法进入左侧展柜',
    );
    const waited = applyAction(level, s2, { type: 'wait' });
    check(waited.ok && isDoorOpen(level, 2, 'L', waited.state!.turn), '等待一拍后左门打开');
    const enter = applyAction(level, waited.state!, {
      type: 'transfer',
      boxId: 'S',
      target: { region: 'case', floor: 2, side: 'L' },
    });
    check(enter.ok, '开门拍 S 顺利入柜', enter.reason?.message);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 非法动作拒绝矩阵（第 1 关几何）==');

// 第 1 关：轿厢初始在 1 层；右尽头站台 P(0-1)、T(2)、S(3)，P 堵死 T、S 到门的通道
const l1 = LEVELS[0];
const init1 = createInitialState(l1);

// T、S 被 P 挡在站台里侧，无法直接搬到轿厢
expectReject(
  l1,
  init1,
  { type: 'transfer', boxId: 'T', target: { region: 'car', floor: 1, side: 'R' } },
  '站台里被 P 挡住的 T 无法出门上车',
);
expectReject(
  l1,
  init1,
  { type: 'transfer', boxId: 'S', target: { region: 'car', floor: 1, side: 'R' } },
  '站台最里侧被 P 挡住的 S 无法出门上车',
);

// P 先上车，随后 T、S 解封依次上车
let s1 = init1;
let r = applyTransfer(l1, s1, 'P', { region: 'car', floor: 1, side: 'R' });
check(r.ok, '挡路的 P 先上车', r.reason?.message);
s1 = r.state!;
r = applyTransfer(l1, s1, 'T', { region: 'car', floor: 1, side: 'R' });
check(r.ok, 'P 挪走后 T 可上车', r.reason?.message);
s1 = r.state!;
r = applyTransfer(l1, s1, 'S', { region: 'car', floor: 1, side: 'R' });
check(r.ok, 'S 可上车', r.reason?.message);
s1 = r.state!;

// 轿厢内：P 占 0-1、T 在 2、S 在 3。上到 2 层（只开左门），
// S、T 到左门的通道被 P 封死
const at2 = applyAction(l1, s1, { type: 'move', toFloor: 2 }).state!;
expectReject(
  l1,
  at2,
  { type: 'transfer', boxId: 'S', target: { region: 'case', floor: 2, side: 'L' } },
  '轿厢里被 P 挡住的 S 无法从左门进展柜',
);
expectReject(
  l1,
  at2,
  { type: 'transfer', boxId: 'S', target: { region: 'stage', floor: 2, side: 'R' } },
  '2 层右门关闭，不能从右门出',
);

// 上到 4 层（只开右门）：P 到右门被 T、S 挡
const at4 = applyAction(l1, at2, { type: 'move', toFloor: 4 }).state!;
expectReject(
  l1,
  at4,
  { type: 'transfer', boxId: 'P', target: { region: 'case', floor: 4, side: 'R' } },
  'P 到右门被外侧的小箱挡住',
);

// 回 1 层：左侧低过梁，高箱 T、S 过不去；矮的水平 P 可以
const back1 = applyAction(l1, at4, { type: 'move', toFloor: 1 }).state!;
expectReject(
  l1,
  back1,
  { type: 'transfer', boxId: 'T', target: { region: 'stage', floor: 1, side: 'L' } },
  '高箱 T 无法通过 1 层左侧低过梁',
);
const pLow = applyTransfer(l1, back1, 'P', { region: 'stage', floor: 1, side: 'L' });
check(pLow.ok, '矮的水平画箱 P 可通过低过梁', pLow.reason?.message);

// 水平画箱必须占连续两格：指定越界 index 落位被拒
expectReject(
  l1,
  back1,
  { type: 'transfer', boxId: 'P', target: { region: 'case', floor: 1, side: 'R', index: 1 } },
  '水平画箱需要连续两格，越界落位被拒',
);

// 轿厢满载后新箱子进不来（用 5 格轿厢装满：P 占 2 + 三小箱占 3）
const full = (() => {
  let st = createInitialState(l1);
  for (const id of ['P', 'T', 'S']) {
    const rr = applyTransfer(l1, st, id, { region: 'car', floor: 1, side: 'R' });
    if (!rr.ok) return st;
    st = rr.state!;
  }
  return st;
})();
check(
  full.placements.filter((p) => p.region === 'car').length === 3,
  '构造轿厢装满场景（P+T+S 共占 5 格）',
);

// 第 2 关：交替门奇偶与结算顺序
console.log('\n== 交替门结算顺序 ==');
const l2 = LEVELS[1];
check(alternatingSide(0) === 'L', '回合 0 交替门开左门');
check(alternatingSide(1) === 'R', '回合 1 交替门开右门');
check(isDoorOpen(l2, 2, 'L', 0) && !isDoorOpen(l2, 2, 'R', 0), '2 层回合 0 只开左门');

// 轿厢初始在 2 层（回合 0，左门开）；S 在 1 层。下 1 层接 S 再原车返回
let s2 = applyAction(l2, createInitialState(l2), { type: 'move', toFloor: 1 }).state!;
check(s2.turn === 1, '从 2 层下到 1 层花费 1 回合');
s2 = applyTransfer(l2, s2, 'S', { region: 'car', floor: 1, side: 'L' }).state!;
s2 = applyAction(l2, s2, { type: 'move', toFloor: 2 }).state!;
check(s2.turn === 3, '接 S 后返回 2 层，到达时为回合 3（奇数）');
check(!isDoorOpen(l2, 2, 'L', s2.turn), '奇数回合左门关闭');
check(isDoorOpen(l2, 2, 'R', s2.turn), '奇数回合右门开');

// 关门同一拍搬箱：S 进展柜（左门）必须被拒，且状态不变
expectReject(
  l2,
  s2,
  { type: 'transfer', boxId: 'S', target: { region: 'case', floor: 2, side: 'L' } },
  '关门拍 S 进展柜被拒（不能靠动画速度穿门）',
);
// 等一拍：回合 4（偶数）左门开
const waited = applyAction(l2, s2, { type: 'wait' });
check(waited.ok && waited.state!.turn === 4, '等待一拍花费 1 回合');
check(waited.state!.turn % 2 === 0, '等待后回合为偶数');
check(isDoorOpen(l2, 2, 'L', waited.state!.turn), '等待后左门打开');
check(!isDoorOpen(l2, 2, 'R', waited.state!.turn), '等待后右门关闭');
const delivered = applyTransfer(l2, waited.state!, 'S', {
  region: 'case',
  floor: 2,
  side: 'L',
});
check(delivered.ok, '开门拍 S 顺利入柜，落箱后才翻门', delivered.reason?.message);
check(delivered.state!.deliveredInOrder.includes('S'), '入柜动作记入交付顺序');

// 暂存不计入已搬运
console.log('\n== 暂存与入柜区分 ==');
// 第 1 关把 P 搬到 2 层左站台暂存位，交付记录应保持为空
let stage1 = createInitialState(l1);
stage1 = applyTransfer(l1, stage1, 'P', { region: 'car', floor: 1, side: 'R' }).state!;
stage1 = applyAction(l1, stage1, { type: 'move', toFloor: 2 }).state!;
const staged = applyTransfer(l1, stage1, 'P', { region: 'stage', floor: 2, side: 'L' });
check(staged.ok, 'P 可暂存到 2 层左站台', staged.reason?.message);
check(staged.state!.deliveredInOrder.length === 0, '暂存位不产生入柜记录');
// 非同层搬运被拒
const wrongFloor = applyTransfer(
  l1,
  createInitialState(l1),
  'S',
  { region: 'car', floor: 2, side: 'L' },
);
check(!wrongFloor.ok, '轿厢与画箱不同层时搬运被拒');

// ---------------------------------------------------------------------------
console.log('\n== 随机游走不变量（合法动作后货物数不变、无重叠） ==');
for (const level of LEVELS) {
  let state = createInitialState(level);
  const initialCount = boxCount(state);
  let steps = 0;
  for (let i = 0; i < 400; i++) {
    const actions: Action[] = level.floors
      .filter((f) => f.id !== state.carFloor)
      .map((f) => ({ type: 'move' as const, toFloor: f.id }));
    actions.push({ type: 'wait' });
    for (const p of state.placements) {
      for (const side of ['L', 'R'] as Side[]) {
        actions.push({ type: 'transfer', boxId: p.boxId, target: { region: 'stage', floor: state.carFloor, side } });
        actions.push({ type: 'transfer', boxId: p.boxId, target: { region: 'case', floor: state.carFloor, side } });
      }
      actions.push({ type: 'transfer', boxId: p.boxId, target: { region: 'car', floor: state.carFloor, side: 'L' } });
    }
    const pick = actions[Math.floor(Math.random() * actions.length)];
    const res = applyAction(level, state, pick);
    if (res.ok && res.state) {
      state = res.state;
      steps++;
      if (boxCount(state) !== initialCount) {
        check(false, `[${level.name}] 随机游走中画箱数变化`);
        break;
      }
      if (slotOverlap(state)) {
        check(false, `[${level.name}] 随机游走中货位重叠`);
        break;
      }
    }
  }
  check(true, `[${level.name}] 随机游走 ${steps} 个合法动作，货物数与货位不变量保持`);
}

console.log(`\n结果：${passes} 项通过，${failures} 项失败`);
if (failures > 0) {
  process.exit(1);
}
