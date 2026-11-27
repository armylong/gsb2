/**
 * 本地核对工具：把三张盘的正向链、反推树、候选明细全部打印出来，
 * 并对每张盘做严格断言。任何一条断言失败都会以非零码退出。
 *
 * 用法：
 *   npm run verify
 *   npx tsx tools/verify.ts --verbose
 */
import { boards } from '../src/engine/boards';
import {
  SORTED_STATE_KEY,
  allStates,
  candidateMoves,
  chainOf,
  matchesClue,
  movesFor,
  occupantOf,
  predecessors,
  recordOf,
  replay,
  reverseTree,
} from '../src/engine/engine';
import type { EventType, Puzzle, State } from '../src/engine/types';
import { puzzles } from '../src/game/puzzles';

const verbose = process.argv.includes('--verbose');

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const key = (s: State) => SORTED_STATE_KEY(s);
const desc = (s: State) =>
  Object.entries(s)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([a, l]) => `${a}@${l}`)
    .join(' ');
const evName = (e: EventType) => (e === 'island' ? '岛' : e === 'lawn' ? '草' : '原');

/* ------------------------------------------------------------------ */
/* 规则单元检查                                                       */
/* ------------------------------------------------------------------ */
function ruleChecks() {
  console.log('\n## 规则检查');
  const b = boards.training;

  // 1. 出口空着只能游
  {
    const state: State = { a1: 'i1', a2: 'i4', a3: 'i3', a4: 'l2' };
    const moves = movesFor(b, state, 'a1');
    check(
      moves.length === 1 && moves[0]!.kind === 'swim' && moves[0]!.to === 'i2',
      '出口空着时唯一动作是游向下游',
      JSON.stringify(moves.map((m) => m.kind)),
    );
  }

  // 2. 出口被占：原地 + 退草
  {
    const state: State = { a1: 'i2', a2: 'i4', a3: 'i3', a4: 'l2' };
    const moves = movesFor(b, state, 'a1');
    const kinds = moves.map((m) => m.kind).sort();
    check(
      kinds.join(',') === 'grass,wait',
      '出口被占时可选原地或退草',
      kinds.join(','),
    );
  }

  // 3. 草坪动物动不了
  {
    const state: State = { a1: 'i1', a2: 'i4', a3: 'i3', a4: 'l2' };
    check(movesFor(b, state, 'a4').length === 0, '草坪上的动物没有动作');
  }

  // 4. 不能挤进同一地点
  {
    const state: State = { a1: 'i1', a2: 'i2', a3: 'i3', a4: 'l2' };
    const moves = movesFor(b, state, 'a1');
    check(
      moves.every((m) => m.to !== 'i2'),
      '下游被占时不会产生「游过去」的候选',
    );
  }

  // 5. 单向：上游不能把水倒着游
  {
    const state: State = { a1: 'i2', a2: 'i4', a3: 'i3', a4: 'l2' };
    check(
      movesFor(b, state, 'a1').every((m) => m.to !== 'i1'),
      '水道不能逆向游回上游',
    );
  }
}

/* ------------------------------------------------------------------ */
/* 每张盘的反推属性                                                   */
/* ------------------------------------------------------------------ */
function puzzleChecks(p: Puzzle) {
  console.log(`\n## ${p.id} · ${p.title}`);
  const { board, finalState, events, clue } = p;

  const tree = reverseTree(board, finalState, events);
  const starts = [...new Map(tree.map((n) => [key(n.state), n.state])).values()];
  console.log(`  终态 ${desc(finalState)}；记录 ${events.map(evName).join('')}；反推叶子 ${tree.length}，不同起点 ${starts.length}`);
  for (const s of starts) console.log(`    ${clue && matchesClue(s, clue) ? '★' : ' '} ${desc(s)}`);

  check(tree.length > 0, '至少存在一条能正向走通的清晨链');

  // 1. 每条叶子都能正向回放，并精确复现终态与事件顺序
  let replayOk = true;
  let countOk = true;
  for (const leaf of tree) {
    const { start, moves } = chainOf(leaf);
    if (Object.keys(start).length !== board.animals.length) countOk = false;
    const end = replay(board, start, moves);
    const evs: EventType[] = [];
    let s = start;
    for (const m of moves) {
      const n = { ...s, [m.actor]: m.to };
      evs.push(recordOf(board, s, n));
      s = n;
    }
    if (key(end) !== key(finalState)) replayOk = false;
    if (evs.join('') !== events.join('')) replayOk = false;
  }
  check(replayOk, '每条反推链正向回放都命中终态与事件顺序');
  check(countOk, '每条链的动物数始终不变（不多不少）');

  // 2. 反推候选全部「正向合法」：对每个候选用 movesFor 再验一次
  let candidatesLegal = true;
  let candidateCount = 0;
  let frontier: State[] = [finalState];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const next: State[] = [];
    for (const st of frontier) {
      for (const a of board.animals) {
        for (const p of predecessors(board, st, a.id, ev)) {
          candidateCount++;
          const legal = movesFor(board, p.prev, a.id).some(
            (m) => m.to === p.move.to && m.kind === p.move.kind,
          );
          if (!legal) candidatesLegal = false;
          next.push(p.prev);
        }
      }
    }
    frontier = [...new Map(next.map((s) => [key(s), s])).values()];
  }
  check(candidatesLegal, `反推候选全部能通过正向规则（共 ${candidateCount} 条候选）`);

  // 3. 占位逐条重算：候选里的 blocker 必须真的在出口上
  let blockerOk = true;
  frontier = [finalState];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const next: State[] = [];
    for (const st of frontier) {
      for (const a of board.animals) {
        for (const p of predecessors(board, st, a.id, ev)) {
          if (p.move.kind !== 'swim') {
            const outlet = board.outlets[p.move.from];
            if (!outlet) blockerOk = false;
            else if (occupantOf(p.prev, outlet) !== p.move.blockerId) blockerOk = false;
          }
          next.push(p.prev);
        }
      }
    }
    frontier = [...new Map(next.map((s) => [key(s), s])).values()];
  }
  check(blockerOk, '退草 / 原地候选的阻塞者与当时的出口占位一致');

  if (p.mode === 'reverse') {
    check(!!clue, '正式盘带早晨线索');
    const matched = starts.filter((s) => matchesClue(s, clue));
    check(matched.length === 1, '早晨线索唯一钉住一个清晨盘', `命中 ${matched.length} 个`);
    if (p.expectedStart) {
      check(
        matched.length === 1 && key(matched[0]!) === key(p.expectedStart),
        '唯一清晨盘与设计答案一致',
      );
      const leaf = tree.find((n) => key(n.state) === key(p.expectedStart!));
      check(!!leaf, '设计答案确实在反推树里');
    }
  }

  // 4. 计数：任何时刻动物数 = 4，地点不重复
  let countsOk = true;
  for (const leaf of tree) {
    const { start, moves } = chainOf(leaf);
    let s = start;
    const states = [start];
    for (const m of moves) {
      s = { ...s, [m.actor]: m.to };
      states.push(s);
    }
    for (const st of states) {
      const locs = Object.values(st);
      if (locs.length !== board.animals.length) countsOk = false;
      if (new Set(locs).size !== locs.length) countsOk = false;
    }
  }
  check(countsOk, '整条链上每个盘面都是「四只、四个不同地点」');

  if (verbose) {
    console.log('  -- 逐回合候选 --');
    let f: State[] = [finalState];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      console.log(`   回推第 ${i + 1} 回合 [${evName(ev)}]`);
      const next: State[] = [];
      for (const st of f) {
        for (const a of board.animals) {
          for (const p of predecessors(board, st, a.id, ev)) {
            console.log(
              `     ${desc(st)} ← ${a.id} ${p.move.kind} ${p.move.from}->${p.move.to}${p.move.blockerId ? ` (堵 ${p.move.blockerId})` : ''}`,
            );
            next.push(p.prev);
          }
        }
      }
      f = [...new Map(next.map((s) => [key(s), s])).values()];
    }
  }
}

/* ------------------------------------------------------------------ */
/* 两张正式盘的特殊属性                                               */
/* ------------------------------------------------------------------ */
function cleanChecks() {
  console.log('\n## 纯回推盘的特殊属性');
  const p = puzzles.find((x) => x.id === 'clean')!;
  const tree = reverseTree(p.board, p.finalState, p.events);

  // 每个「草」回合都不应出现同目标 swim/grass 双解
  let dual = false;
  let frontier: State[] = [p.finalState];
  for (let i = p.events.length - 1; i >= 0; i--) {
    const ev = p.events[i]!;
    if (ev === 'lawn') {
      for (const st of frontier) {
        const m = new Map<string, Set<string>>();
        for (const a of p.board.animals)
          for (const pr of predecessors(p.board, st, a.id, ev)) {
            const k = `${a.id}|${pr.move.to}`;
            if (!m.has(k)) m.set(k, new Set());
            m.get(k)!.add(pr.move.kind);
          }
        for (const s of m.values()) if (s.has('swim') && s.has('grass')) dual = true;
      }
    }
    const next: State[] = [];
    for (const st of frontier)
      for (const a of p.board.animals)
        for (const pr of predecessors(p.board, st, a.id, ev)) next.push(pr.prev);
    frontier = [...new Map(next.map((s) => [key(s), s])).values()];
  }
  check(!dual, '纯回推盘里没有「直游 / 退草」双解（每个位置只有一种来路）');
  check(tree.length >= 2, '纯回推盘仍保留「谁动了」的分叉', `叶子 ${tree.length}`);
}

function branchChecks() {
  console.log('\n## 分叉盘的特殊属性');
  const p = puzzles.find((x) => x.id === 'branch')!;
  const { board, finalState, events } = p;
  const last = events[events.length - 1]!;
  check(last === 'lawn', '终态最后一步是草坪记录');

  // 终态一步应同时存在「直游」与「退草」两条合法候选（对同一目标）
  let found: { actor: string; dest: string; swim: any; grass: any } | null = null;
  for (const a of board.animals) {
    const byDest = new Map<string, { swim?: any; grass?: any }>();
    for (const pr of predecessors(board, finalState, a.id, 'lawn')) {
      if (!byDest.has(pr.move.to)) byDest.set(pr.move.to, {});
      byDest.get(pr.move.to)![pr.move.kind as 'swim' | 'grass'] = pr;
    }
    for (const [dest, o] of byDest)
      if (o.swim && o.grass) found = { actor: a.id, dest, swim: o.swim, grass: o.grass };
  }
  check(!!found, '终态草坪同时有「直接游进」与「被堵后退草」两条候选');

  if (found) {
    // 两条候选都能过正向规则
    const swimLegal = movesFor(board, found.swim.prev, found.actor).some(
      (m) => m.to === found.dest && m.kind === 'swim',
    );
    const grassLegal = movesFor(board, found.grass.prev, found.actor).some(
      (m) => m.to === found.dest && m.kind === 'grass',
    );
    check(swimLegal && grassLegal, '两条解释都先通过正向规则验证');
    console.log(`   直游：${desc(found.swim.prev)} → ${found.actor} 游到 ${found.dest}`);
    console.log(`   退草：${desc(found.grass.prev)} → ${found.actor} 退到 ${found.dest}（${found.grass.move.blockerId} 占着出口）`);

    // 更早的记录应把其中一条排除
    const rest = events.slice(0, -1);
    const sl = reverseTree(board, found.swim.prev, rest);
    const gl = reverseTree(board, found.grass.prev, rest);
    check(
      (sl.length > 0 && gl.length === 0) || (gl.length > 0 && sl.length === 0),
      '更早的回合记录恰好排除其中一条解释',
      `直游续推 ${sl.length} 条，退草续推 ${gl.length} 条`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 训练盘：三个规则例子                                               */
/* ------------------------------------------------------------------ */
function trainingChecks() {
  console.log('\n## 训练盘覆盖的规则例子');
  const b = boards.training;
  const state: State = { a1: 'i1', a2: 'i4', a3: 'i3', a4: 'l2' };

  // 单向：i1 -> i2
  const a1 = movesFor(b, state, 'a1');
  check(
    a1.length === 1 && a1[0]!.kind === 'swim' && a1[0]!.to === 'i2',
    '例子1 单向水道：芦苇岛只能游到石阶岛',
  );

  // 被占 + 退草：芦苇岛的下游（石阶岛）被占，可退到西岸草坪
  const s2: State = { a1: 'i1', a2: 'i2', a3: 'i4', a4: 'l3' };
  const a1b = movesFor(b, s2, 'a1');
  check(
    a1b.some((m) => m.kind === 'wait') && a1b.some((m) => m.kind === 'grass'),
    '例子2 目标被占：可原地，也可退到西岸草坪',
  );
  // 草坪也满时只剩原地
  const s2b: State = { a1: 'i1', a2: 'i2', a3: 'i4', a4: 'l2' };
  check(
    movesFor(b, s2b, 'a1').map((m) => m.kind).join(',') === 'wait',
    '例子2b 目标被占且草坪也满：只剩原地',
  );

  // 多个解释：沙嘴岛直游东岸草坪 vs 老柳岛被堵后退东岸草坪
  const s3: State = { a1: 'i1', a2: 'l2', a3: 'i2', a4: 'l1' };
  const dual = predecessors(boards.fork, s3, 'a2', 'lawn');
  const kinds = new Set(dual.map((p) => p.move.kind));
  check(
    kinds.has('swim') && kinds.has('grass'),
    '例子3 多个解释：草坪上的动物在反推时同时有「直游」与「退草」两条来路',
    `候选 ${dual.length} 条`,
  );
}

/* ------------------------------------------------------------------ */
function exhaustiveness() {
  console.log('\n## 规则穷举自查');
  for (const [name, board] of Object.entries(boards)) {
    const states = allStates(board);
    let legal = true;
    for (const st of states) {
      for (const a of board.animals) {
        for (const m of movesFor(board, st, a.id)) {
          // 正向结果必须是合法状态
          const next = { ...st, [m.actor]: m.to };
          const locs = Object.values(next);
          if (new Set(locs).size !== locs.length) legal = false;
          // 再反推回来，应能找到同一个动作
          const back = predecessors(board, next, a.id, recordOf(board, st, next));
          if (!back.some((p) => key(p.prev) === key(st) && p.move.kind === m.kind)) {
            legal = false;
          }
        }
      }
    }
    check(legal, `${name}: 每个正向动作都能被反推找回（状态数 ${states.length}）`);
  }
}

console.log('池边巡护 · 本地核对');
attempt(() => {
  ruleChecks();
  for (const p of puzzles) puzzleChecks(p);
  cleanChecks();
  branchChecks();
  trainingChecks();
  exhaustiveness();
});

function attempt(fn: () => void) {
  try {
    fn();
  } catch (err) {
    failures++;
    console.log(`  [FAIL] 核对过程异常：${(err as Error).message}`);
    if (verbose) console.log((err as Error).stack);
  }
  console.log(failures === 0 ? '\n全部通过 ✓' : `\n失败 ${failures} 项 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

void candidateMoves;
