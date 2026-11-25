// 群岛潮汐传送 —— Node 自检：不依赖浏览器，`npm run check` 直接运行
// 断言两个题面的结构性质，并打印示范路线。

import { ISLANDS, PUZZLES, findGate, findIsland } from './data.js';
import { tryTransit, otherSide } from './engine.js';
import {
  buildEdges,
  describeEdge,
  reachableFrom,
  reachableIslands,
  shortestFlipPath,
  stateKey,
  trappedStates,
} from './graph.js';
import type { Side } from './types.js';

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('== 1. 门规则引用完整性 ==');
for (const isl of ISLANDS) {
  for (const g of isl.gates) {
    for (const [sideName, rule] of [
      ['潮', g.tide],
      ['汐', g.ebb],
    ] as const) {
      if (!rule) continue;
      let targetExists = false;
      try {
        targetExists = findIsland(rule.toIsland).gates.some(
          (x) => x.id === rule.toGate
        );
      } catch {
        targetExists = false;
      }
      check(
        targetExists,
        `${isl.name}·${g.name}（${sideName}）的落点 ${rule.toIsland}/${rule.toGate} 存在`
      );
    }
  }
}

console.log('== 2. 非封死门至少有一面可通行 ==');
for (const isl of ISLANDS) {
  for (const g of isl.gates) {
    if (g.sealed) continue;
    check(g.tide !== null || g.ebb !== null, `${isl.name}·${g.name} 至少一面可通行`);
  }
}

console.log('== 3. 潮钟只在钟鸣屿，且双向换面边 cost 0 ==');
const clockIslands = ISLANDS.filter((i) => i.hasClock).map((i) => i.id);
check(JSON.stringify(clockIslands) === JSON.stringify(['I2']), '只有 I2 钟鸣屿有潮钟');
const clockEdges = buildEdges().filter((e) => e.viaClock);
check(clockEdges.length === 2, '潮钟产生两条换面边（潮→汐、汐→潮）');
check(clockEdges.every((e) => !e.flip), '潮钟换面不消耗翻卡');

console.log('== 4. 东潮门同入口两态去不同地方，且都翻卡 ==');
const a2 = findGate('I1', 'A2');
check(!!a2.tide && !!a2.ebb, '东潮门两面都有规则');
check(a2.tide!.toIsland !== a2.ebb!.toIsland, '潮面与汐面落点不同');
check(a2.tide!.flip && a2.ebb!.flip, '两面通过都翻卡');

console.log('== 5. 题面一：到章岛最短翻卡次数恰好为 2 ==');
const p1 = PUZZLES[0];
const sp = shortestFlipPath(p1.startIsland, p1.startSide, p1.goalIsland);
check(sp !== null, '章岛可达');
if (sp) {
  check(sp.flips === 2, `最短翻卡次数 = 2（实际 ${sp.flips}）`);
  console.log('    示范路线：');
  for (const e of sp.edges) {
    const { islandId, side } = (() => {
      const [id, s] = e.from.split(':');
      return { islandId: id, side: s as Side };
    })();
    const isl = findIsland(islandId);
    console.log(
      `      ${isl.name}·${side === 'tide' ? '潮' : '汐'} —${describeEdge(e)}→`
    );
  }
  const last = sp.edges[sp.edges.length - 1];
  console.log(`      到达 ${findIsland(last.to.split(':')[0]).name}`);
}

console.log('== 6. 题面一：章岛能回起点，花澜礁才是回不来的状态 ==');
const trapped = trappedStates('I1', 'tide');
const trappedIslands = new Set(trapped.map((t) => t.state.split(':')[0]));
check(!trappedIslands.has('I3'), '章岛不在“回不来”名单里');
check(trappedIslands.has('I4'), '花澜礁在“回不来”名单里');
check(trapped.every((t) => t.path.length > 0), '每个回不来状态都附到达路径');

console.log('== 7. 题面二：花澜礁可达且完全无出边 ==');
const reachI4 = reachableIslands('I1', 'tide');
check(reachI4.has('I4'), '从晨港潮面能到达花澜礁');
const i4 = findIsland('I4');
check(i4.gates.every((g) => g.sealed), '花澜礁所有门都是封死的');
for (const side of ['tide', 'ebb'] as Side[]) {
  const reach = reachableFrom('I4', side);
  const islands = new Set([...reach].map((k) => k.split(':')[0]));
  check(
    islands.size === 1 && islands.has('I4'),
    `花澜礁·${side === 'tide' ? '潮' : '汐'} 的可达集合只含自身（${[...reach].join(', ')}）`
  );
}

console.log('== 8. 北礁门是单向门，落点是封死背面 ==');
const a1 = findGate('I1', 'A1');
check(a1.oneWay, '北礁门标记为单向门');
const d1 = findGate('I4', 'D1');
check(d1.sealed, '落点 D1 是封死的门背面');
check(a1.tide!.toGate === 'D1' && a1.ebb!.toGate === 'D1', '两面都落在 D1');

console.log('== 9. 引擎：翻卡、落点、朝向、封门、空规则 ==');
const t1 = tryTransit({ islandId: 'I1', gateId: 'A2', side: 'tide' });
check(t1.ok, '东潮门·潮 可通过');
if (t1.ok) {
  check(t1.nextIslandId === 'I2' && t1.nextSide === 'ebb', '潮→钟鸣屿且翻成汐');
  check(t1.facing === 'E', '落在西门(W)背面，朝向东(E)');
}
const t2 = tryTransit({ islandId: 'I1', gateId: 'A2', side: 'ebb' });
check(t2.ok, '东潮门·汐 可通过');
if (t2.ok) {
  check(t2.nextIslandId === 'I3' && t2.nextSide === 'tide', '汐→章岛且翻成潮');
  check(t2.facing === 'S', '落在北门(N)背面，朝向南(S)');
}
const t3 = tryTransit({ islandId: 'I1', gateId: 'A1', side: 'tide' });
check(t3.ok && t3.ok && t3.info.flipped === false, '北礁门通过不翻卡');
if (t3.ok) check(t3.facing === 'S', '花澜礁落点朝向南(S)');
const t4 = tryTransit({ islandId: 'I4', gateId: 'D1', side: 'tide' });
check(!t4.ok, '封死门拒绝通行');
const t5 = tryTransit({ islandId: 'I1', gateId: 'A3', side: 'ebb' });
check(!t5.ok, '西汐门·汐 面规则为空，拒绝通行');
const t6 = tryTransit({ islandId: 'I1', gateId: 'A3', side: 'tide' });
check(t6.ok && t6.ok && t6.nextSide === 'tide', '西汐门·潮 不翻卡，保持潮面');

console.log('== 10. 题面二示范：一步走进死胡同 ==');
if (t3.ok) {
  console.log(
    `    晨港·潮 —北礁门→ 花澜礁·${t3.info.sideAfter === 'tide' ? '潮' : '汐'}（朝向南），此后无任何出边`
  );
}

console.log('== 11. otherSide 与状态键基本性质 ==');
check(otherSide('tide') === 'ebb' && otherSide('ebb') === 'tide', '翻卡互为反面');
check(stateKey('I1', 'tide') === 'I1:tide', '状态键格式稳定');

console.log('');
if (failures === 0) {
  console.log(`全部自检通过（题面：${PUZZLES.map((p) => p.title).join(' / ')}）`);
} else {
  throw new Error(`自检失败 ${failures} 项`);
}
