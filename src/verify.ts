// 可运行的验证脚本:node src/verify.ts
// 跑两个场景并断言关键时间点;另验证撤回/归档对照机制。
import type { Game, TurnRecord } from './engine.ts';
import { scenarioCutoff, scenarioSimultaneous } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

let failures = 0;

function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✔ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${msg}`);
  }
}

function printRecord(g: Game, rec: TurnRecord): void {
  console.log(`  第${rec.turn}回合 | A补给前哨: ${rec.suppliedOutposts.A.join(',') || '无'} | B补给前哨: ${rec.suppliedOutposts.B.join(',') || '无'}`);
  for (const z of rec.zones) {
    console.log(
      `    [${z.zone}] 控制值=${z.controlValue} 领先=${z.leader ?? '平局'} 连续=${z.streak} 归属:${z.ownerBefore ?? '无'}→${z.ownerAfter ?? '无'}`,
    );
    const top = (list: { source: string; amount: number }[]) =>
      list.slice(0, 3).map((c) => `${c.source}=${c.amount}`).join(' ');
    console.log(`      A贡献: ${top(z.contributionsA)}`);
    console.log(`      B贡献: ${top(z.contributionsB)}`);
  }
  for (const e of rec.events) console.log(`    事件: ${e}`);
}

function runScripted(s: Scenario): TurnRecord[] {
  const recs: TurnRecord[] = [];
  for (const moves of s.script) {
    for (const [id, x, y] of moves) s.game.moveUnit(id, x, y);
    recs.push(s.game.endTurn());
  }
  return recs;
}

// ---------- 场景一:前哨被切断 ----------
console.log('\n=== 场景一:前哨被切断 ===');
{
  const s = scenarioCutoff();
  const recs = runScripted(s);
  for (const r of recs) printRecord(s.game, r);

  const ownerAt = (t: number) => recs[t - 1].zones[0].ownerAfter;
  const leaderAt = (t: number) => recs[t - 1].zones[0].leader;
  const suppliedAt = (t: number) => recs[t - 1].suppliedOutposts.A.length > 0;

  check(suppliedAt(4), '第4回合前哨仍在补给网内(b2 尚未到位)');
  check(!suppliedAt(5), '第5回合 b2 站上 (4,5),前哨断供');
  check(ownerAt(1) === null && ownerAt(2) === 'A', 'A 连续两回合领先,第2回合占领 Z1');
  check(leaderAt(5) === 'B' && ownerAt(5) === 'A', '第5回合断供后 B 首次领先,但 A 仍保有控制权(需连续两回合)');
  check(ownerAt(6) === 'B', '第6回合 B 连续两回合领先,Z1 易主为 B');

  // ---------- 撤回一轮,微调路线再算,旧结果进归档 ----------
  console.log('\n--- 撤回验证:撤回第7回合,改走 b1 再算 ---');
  const undone = s.game.undo();
  check(undone !== null && undone.turn === 7, '成功撤回第7回合');
  check(s.game.archive.length === 1 && s.game.history.length === 6, '旧结果进入归档,历史回退到6回合');
  s.game.moveUnit('b1', 10, 5); // 微调:B 的 b1 向争夺区再压一格
  const recalc = s.game.endTurn();
  printRecord(s.game, recalc);
  const archived = s.game.archive[0];
  check(recalc.turn === 7, '重新计算得到新的第7回合');
  check(
    archived.zones[0].controlValue !== recalc.zones[0].controlValue,
    `新旧第7回合控制值不同(旧=${archived.zones[0].controlValue}, 新=${recalc.zones[0].controlValue}),归档可用于对照`,
  );
}

// ---------- 场景二:同时进入争夺区 ----------
console.log('\n=== 场景二:同时进入争夺区 ===');
{
  const s = scenarioSimultaneous();
  const recs = runScripted(s);
  for (const r of recs) printRecord(s.game, r);

  const z = (t: number) => recs[t - 1].zones[0];
  check(z(1).controlValue === 0 && z(1).leader === null, '第1回合双方同时进入,控制值持平');
  check(z(1).ownerAfter === null && z(1).streak === 0, '平局保留:无人占领,占领进度清零');
  check(z(2).leader === 'A' && z(2).streak === 1 && z(2).ownerAfter === null, '第2回合 A 首次领先,仅一回合不足以占领');
  check(z(3).ownerAfter === 'A', '第3回合 A 连续两回合领先,占领 Z2');
}

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 条断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
