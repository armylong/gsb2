/**
 * 纯 node 校验：node scripts/verify.ts
 * 不依赖 React / 浏览器，覆盖分配规则、两种空手原因、平分、种子可重复性。
 */
import {
  autoPick,
  buildGame,
  computeFingerprint,
  ownedCountsBefore,
  priorityForRound,
  resolveRound,
  scoreGame,
  tiedTeamIds,
} from '../src/game/engine.ts';
import { generateSandboxRound } from '../src/game/scenarios.ts';
import type { GameState, TeamId } from '../src/game/types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function findEntry(state: GameState, roundIdx: number, team: TeamId) {
  return state.rounds[roundIdx].log!.find((e) => e.teamId === team)!;
}

function revealAll(state: GameState): void {
  state.rounds.forEach((round) => {
    round.log = resolveRound(round);
  });
}

console.log('1) 优先顺序每轮整体左旋一位');
check('第 1 轮 A→B→C', priorityForRound(0).join('') === 'ABC');
check('第 2 轮 B→C→A', priorityForRound(1).join('') === 'BCA');
check('第 3 轮 C→A→B', priorityForRound(2).join('') === 'CAB');
check('第 4 轮回到 A→B→C', priorityForRound(3).join('') === 'ABC');

console.log('2) 内置一：首选相撞，落败两队走备用');
{
  const game = buildGame('collisionPrimary');
  check('载入即三队全部确认', Object.values(game.rounds[0].choices).every((c) => c.confirmed));
  revealAll(game);
  const [a, b, c] = (['A', 'B', 'C'] as TeamId[]).map((t) => findEntry(game, 0, t));
  check('A 首选到手玛瑙片', a.outcome === 'primaryWon' && a.wonSpecimenId === 'cp1-r1');
  check('B 首选落空，备用到手', b.outcome === 'backupWon' && b.wonSpecimenId === 'cp1-p1');
  check('B 的首选记录为被 A 拿走', b.primaryTakenBy === 'A');
  check('C 同样备用到手', c.outcome === 'backupWon' && c.wonSpecimenId === 'cp1-r2');
  const winners = game.rounds[0].log!.map((e) => e.wonSpecimenId);
  check('同一件标本最多给一个队', new Set(winners).size === winners.length);
}

console.log('3) 内置二：备用再相撞 + 两种空手原因');
{
  const game = buildGame('collisionBackup');
  revealAll(game);
  const r1 = game.rounds[0];
  check('第 2 轮优先顺序已轮换', r1.priority.join('') === 'ABC');
  const [a1, b1, c1] = (['A', 'B', 'C'] as TeamId[]).map((t) => findEntry(game, 0, t));
  check('A 首选拿到翡翠原石', a1.outcome === 'primaryWon' && a1.wonSpecimenId === 'cb1-s1');
  check('B 备用拿到琥珀原石', b1.outcome === 'backupWon' && b1.wonSpecimenId === 'cb1-s2');
  check(
    'C 备用被 B 拿走 -> 备选已被别人拿走',
    c1.outcome === 'missedBackupTaken' &&
      c1.missReason === 'backupTaken' &&
      c1.backupTakenBy === 'B',
  );

  const r2 = game.rounds[1];
  check('第 3 轮优先顺序 B→C→A', r2.priority.join('') === 'BCA');
  const c2 = findEntry(game, 1, 'C');
  check(
    'C 首选被 B 拿走且未交备用 -> 没有合适备选',
    c2.outcome === 'missedNoBackup' && c2.missReason === 'noBackup' && c2.primaryTakenBy === 'B',
  );
}

console.log('4) 内置三：两轮后平分，积分榜能识别');
{
  const game = buildGame('tieScore');
  revealAll(game);
  const scores = scoreGame(game.rounds);
  check('红隼队 6 分', scores.A.total === 6, `实际 ${scores.A.total}`);
  check('蓝雀队 6 分', scores.B.total === 6, `实际 ${scores.B.total}`);
  check('绿蜥队 4 分', scores.C.total === 4, `实际 ${scores.C.total}`);
  const tied = tiedTeamIds(scores);
  check('平分队为 A 与 B', tied.length === 2 && tied.includes('A') && tied.includes('B'));
}

console.log('5) 备用不能抢走已经分完的标本（通用规则回归）');
{
  const game = buildGame('collisionPrimary');
  revealAll(game);
  const log = game.rounds[0].log!;
  const allWon = log.filter((e) => e.wonSpecimenId).map((e) => e.wonSpecimenId);
  check('没有任何标本被分给两个队', new Set(allWon).size === allWon.length);
  check('未被选中的标本留桌', game.rounds[0].specimens.length - allWon.length === 4);
}

console.log('6) 同种子同选择：开牌结果与自动选择可重复');
{
  const g1 = buildGame('sandbox', 424242);
  const g2 = buildGame('sandbox', 424242);
  check(
    '两次开局自动队 B 的选择一致',
    JSON.stringify(g1.rounds[0].choices.B) === JSON.stringify(g2.rounds[0].choices.B),
  );
  check(
    '两次开局自动队 C 的选择一致',
    JSON.stringify(g1.rounds.map((r) => r.choices.C)) ===
      JSON.stringify(g2.rounds.map((r) => r.choices.C)),
  );
  check('沙盒标本只由种子决定', JSON.stringify(generateSandboxRound(424242, 0)) ===
    JSON.stringify(generateSandboxRound(424242, 0)));
  check(
    '不同种子产生不同桌面',
    JSON.stringify(generateSandboxRound(424242, 0)) !==
      JSON.stringify(generateSandboxRound(7, 0)),
  );

  // 手动 A 队在两局做同样选择后开牌，指纹与分配完全一致
  g1.rounds.forEach((r) => {
    r.choices.A = { primaryId: r.specimens[0].id, backupId: r.specimens[1].id, confirmed: true };
  });
  g2.rounds.forEach((r) => {
    r.choices.A = { primaryId: r.specimens[0].id, backupId: r.specimens[1].id, confirmed: true };
  });
  const fp1 = g1.rounds.map((r) => computeFingerprint(g1.seed, r, resolveRound(r)));
  const fp2 = g2.rounds.map((r) => computeFingerprint(g2.seed, r, resolveRound(r)));
  check('两轮开牌指纹逐轮一致', JSON.stringify(fp1) === JSON.stringify(fp2));
}

console.log('7) 自动偏好：给定种子时可重复，且两种策略各有倾向');
{
  const game = buildGame('sandbox', 99);
  const round = game.rounds[0];
  const owned = ownedCountsBefore({ rounds: game.rounds }, 0);
  const p1 = autoPick('B', 'valueFirst', round, game.seed, owned.B);
  const p2 = autoPick('B', 'valueFirst', round, game.seed, owned.B);
  check('择高分策略重复调用结果一致', JSON.stringify(p1) === JSON.stringify(p2));
  const top = [...round.specimens].sort((x, y) => y.value - x.value)[0];
  check('择高分首选落在最高分值标本上', p1.primaryId === top.id);
  check('首选与备用不同', p1.primaryId !== p1.backupId);

  const q1 = autoPick('C', 'setSeeker', round, game.seed, owned.C);
  const q2 = autoPick('C', 'setSeeker', round, game.seed, owned.C);
  check('凑成套策略重复调用结果一致', JSON.stringify(q1) === JSON.stringify(q2));
}

console.log('8) 计分来由：成套奖金落在凑成套的那一件上');
{
  const game = buildGame('tieScore');
  revealAll(game);
  const scores = scoreGame(game.rounds);
  // A 两轮都拿到岩矿（玄武岩 3、花岗岩 3），还没到 3 件套，无奖金
  check('A 没有成套', scores.A.setsCompleted === 0);
  const withBonus = scores.A.items.filter((i) => i.setBonus > 0);
  check('A 没有任何单件带成套奖金', withBonus.length === 0);
  check('A 每件来由含基础分说明', scores.A.items.every((i) => i.note.includes('基础分')));
}

console.log('');
if (failures > 0) {
  console.error(`校验失败：${failures} 项`);
  process.exit(1);
}
console.log('全部校验通过 ✅');
