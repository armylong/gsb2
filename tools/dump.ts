// 命令行自检 / 调参工具：
//   node dist/tools/dump.js [scenarioId]
// 输出：
//  1. 题面地图（区域 + 路线归属）
//  2. 每个足迹在初始时刻、+20 分、+40 分的可见状态
//  3. 用构造出的「正确线索链」跑验证器，确认能得出 supported
//  4. 用故意写错方向的链跑验证器，确认能得出 contradiction
//  5. 同种子重建两次，比对逐格状态，确认可复现

import { GameState } from '../src/core/game.js';
import { buildImpressions, getScenario, SCENARIOS } from '../src/core/scenarios.js';
import { remainingDepth, visibilityAt } from '../src/core/snow.js';
import {
  ChainEntry,
  DepthLevel,
  Dir,
  RouteDef,
  Visibility,
  Zone,
} from '../src/core/types.js';
import { verifyChain } from '../src/core/verify.js';

const ZONE_TAG: Record<Zone, string> = {
  [Zone.Block]: '岩',
  [Zone.Normal]: '·',
  [Zone.Wind]: '风',
  [Zone.Shelter]: '避',
};

function printMap(scId: string): void {
  const sc = getScenario(scId);
  const owner = new Map<string, string>();
  sc.routes.forEach((r) =>
    r.cells.forEach(([x, y]) => {
      const k = `${x},${y}`;
      owner.set(k, owner.has(k) ? 'X' : String(r.id));
    }),
  );
  console.log(`\n=== ${sc.title} 地图（数字=路线id，X=叠踩路口，${sc.seed}）===`);
  for (let y = 0; y < sc.height; y++) {
    let row = '';
    for (let x = 0; x < sc.width; x++) {
      const k = `${x},${y}`;
      const tag = owner.get(k);
      row += tag ? `[${tag}]` : ` ${ZONE_TAG[sc.zones[y][x]]} `;
    }
    console.log(row);
  }
}

function visTag(v: Visibility): string {
  return v === Visibility.Visible ? '脚印' : v === Visibility.Trace ? '浅痕' : '消失';
}

function printTimeline(scId: string): void {
  const sc = getScenario(scId);
  const game = new GameState(scId);
  const base = game.now;
  console.log(`\n=== ${sc.title} 足迹时间线（初始时刻 ${base} 分）===`);
  for (const route of sc.routes) {
    console.log(`-- 路线 ${route.id}（重量档 ${route.weight}，起步 ${route.startTime} 分）--`);
    for (let i = 0; i < route.cells.length; i++) {
      const [x, y] = route.cells[i];
      const stack = game.impressions.get(`${x},${y}`)!;
      const imp = stack.find((s) => s.routeId === route.id && s.step === i)!;
      const line = [base, base + 20, base + 40]
        .map((t) => {
          const v = visibilityAt(imp, t);
          const rest = remainingDepth(imp, t).toFixed(2);
          return `t=${t}:${visTag(v)}(${rest})`;
        })
        .join('  ');
      const zone = ZONE_TAG[sc.zones[y][x]];
      console.log(
        `  (${String(x).padStart(2)},${String(y).padStart(2)}) ${zone} 落脚t=${imp.time} 初始深=${imp.initialDepth.toFixed(2)}  ${line}`,
      );
    }
  }
}

/**
 * 按路线构造一条合法的观察链：
 *  - 只纳入当前时刻仍可见的足迹（消失格无法圈选，与真实玩法一致）；
 *  - 两个纳入格在路线上恰好相隔一步时插入跳格；
 *  - 若出现连续 ≥2 格消失，返回 null（说明题面违反「断点只能一格」的设计）。
 */
function buildChainForRoute(
  game: GameState,
  route: RouteDef,
): { chain: ChainEntry[]; gaps: number; skipped: number } | null {
  const chain: ChainEntry[] = [];
  let gaps = 0;
  let skipped = 0;
  let lastStep: number | null = null;

  for (let step = 0; step < route.cells.length; step++) {
    const [x, y] = route.cells[step];
    if (!game.isObserved(x, y)) {
      game.observations.set(`${x},${y}`, {
        x,
        y,
        atTime: game.now,
        stepped: true,
        impressions: game.peek(x, y),
      });
    }
    const obs = game.getObservation(x, y)!;
    const pick = obs.impressions.findIndex((v) => v.routeId === route.id);
    const visible = pick >= 0;

    if (!visible) {
      skipped++;
      continue;
    }
    if (lastStep !== null) {
      const delta = step - lastStep;
      if (delta === 2) {
        chain.push({ kind: 'gap' });
        gaps++;
      } else if (delta > 2) {
        return null; // 连续消失超过一格，跳格规则接不上
      }
    }
    chain.push({ kind: 'obs', x, y, pick });
    lastStep = step;
  }
  return { chain, gaps, skipped };
}

function checkVerify(scId: string): void {
  const sc = getScenario(scId);
  console.log(`\n=== ${sc.title} 验证器自检 ===`);

  for (const route of sc.routes) {
    const game = new GameState(scId);
    const built = buildChainForRoute(game, route);
    if (!built) {
      console.log(`路线 ${route.id} 完整链 -> 失败：存在连续 ≥2 格消失，题面设计不合法`);
      continue;
    }
    game.chain = built.chain;
    const r = verifyChain(game);
    const clues = r.checks.find((c) => c.routeId === route.id)?.directionalClues;
    console.log(
      `路线 ${route.id} 可见链（${built.chain.length} 条，跳格 ${built.gaps} 次，消失 ${built.skipped} 格，方向线索 ${clues}）→ verdict=${r.verdict} supported=${r.supportedRouteId}`,
    );
    if (r.verdict !== 'supported' || r.supportedRouteId !== route.id) {
      console.log('  !! 期望 supported 且指向该路线，实际：', r.message);
    }
  }

  // 矛盾链：取路线1前四个可见格，把第二格的方向翻转
  const game = new GameState(scId);
  const r1 = sc.routes[0];
  const built1 = buildChainForRoute(game, r1);
  if (built1) {
    game.chain = built1.chain.filter((e) => e.kind === 'obs').slice(0, 4);
    const second = game.chain[1];
    if (second && second.kind === 'obs') {
      const obs = game.getObservation(second.x, second.y)!;
      const v = obs.impressions[second.pick];
      if (v && v.dir !== null) {
        const flipped: Dir = (v.dir + 2) % 4;
        obs.impressions = obs.impressions.map((item) =>
          item === v ? { ...item, dir: flipped } : item,
        );
      }
    }
    const bad = verifyChain(game);
    console.log(`故意翻转方向的链 → verdict=${bad.verdict}（期望 contradiction）`);
    if (bad.verdict !== 'contradiction') console.log('  !! 未检出矛盾：', bad.message);
  }

  // 线索不够：只圈叠踩路口一格（两条路线都经过，单格无法区分）
  const game2 = new GameState(scId);
  const junction = sc.routes[0].cells.find(([x, y]) =>
    sc.routes[1].cells.some(([x2, y2]) => x2 === x && y2 === y),
  );
  if (junction) {
    const [jx, jy] = junction;
    game2.observations.set(`${jx},${jy}`, {
      x: jx,
      y: jy,
      atTime: game2.now,
      stepped: true,
      impressions: game2.peek(jx, jy),
    });
    const add = game2.addObsEntry(jx, jy, 0);
    if (add.ok) {
      const few = verifyChain(game2);
      console.log(`仅路口单格的链 → verdict=${few.verdict}（期望 insufficient）`);
      if (few.verdict !== 'insufficient') console.log('  !! 期望线索不够：', few.message);
    } else {
      console.log(`路口单格测试跳过：${add.reason}`);
    }
  }
}

function checkReproduce(scId: string): void {
  const sc = getScenario(scId);
  const a = buildImpressions(sc);
  const b = buildImpressions(sc);
  let same = true;
  for (const [k, stackA] of a) {
    const stackB = b.get(k);
    if (!stackB || stackA.length !== stackB.length) {
      same = false;
      break;
    }
    for (let i = 0; i < stackA.length; i++) {
      if (
        stackA[i].initialDepth !== stackB[i].initialDepth ||
        stackA[i].coverRate !== stackB[i].coverRate ||
        stackA[i].time !== stackB[i].time
      ) {
        same = false;
      }
    }
  }
  console.log(`\n=== ${sc.title} 可复现性：${same ? '通过（同种子逐格一致）' : '失败'} ===`);
}

function checkOverlap(scId: string): void {
  const sc = getScenario(scId);
  const game = new GameState(scId);
  console.log(`\n=== ${sc.title} 叠踩格检查 ===`);
  for (const [k, stack] of game.impressions) {
    if (stack.length < 2) continue;
    const vis = game.peek(...(k.split(',').map(Number) as [number, number]));
    const desc = vis
      .map(
        (v) =>
          `路线${v.routeId}/${v.visibility === Visibility.Visible ? `朝${v.dir === null ? '?' : ['北', '东', '南', '西'][v.dir]}/${depthTag(v.depth)}` : '浅痕'}`,
      )
      .join(' | ');
    console.log(`  格 ${k} 叠 ${stack.length} 条，当前可见 ${vis.length} 条：${desc || '均已消失'}`);
  }
}

function depthTag(d: DepthLevel): string {
  return d === DepthLevel.Deep ? '深' : d === DepthLevel.Medium ? '中' : d === DepthLevel.Light ? '浅' : '痕';
}

const id = process.argv[2];
const ids = id ? [id] : SCENARIOS.map((s) => s.id);
for (const scId of ids) {
  printMap(scId);
  printTimeline(scId);
  checkOverlap(scId);
  checkVerify(scId);
  checkReproduce(scId);
  checkTimeEvolution(scId);
  checkSnapshotFrozen(scId);
}

/** 时间演化：每个区域都应至少出现一次 可读→浅痕→消失 的单调退化 */
function checkTimeEvolution(scId: string): void {
  const game = new GameState(scId);
  const stages: Visibility[] = [];
  // 找一个风带里的足迹（退化最快），逐 5 分钟采样
  const windEntry = [...game.impressions.values()]
    .flat()
    .find((imp) => {
      const [x, y] = findCellOf(game, imp);
      return game.zoneAt(x, y) === Zone.Wind;
    });
  if (!windEntry) {
    console.log(`\n=== ${scId} 时间演化：题面无迎风口足迹，跳过 ===`);
    return;
  }
  for (let t = windEntry.time; t <= windEntry.time + 120; t += 5) {
    stages.push(visibilityAt(windEntry, t));
  }
  const monotone = stages.every((v, i) => i === 0 || v <= stages[i - 1]);
  const sawAll =
    stages.includes(Visibility.Visible) &&
    stages.includes(Visibility.Trace) &&
    stages.includes(Visibility.Gone);
  console.log(
    `\n=== ${scId} 时间演化：${monotone && sawAll ? '通过（可读→浅痕→消失，单调不回退）' : '失败'} ===`,
  );
  if (!monotone || !sawAll) console.log('  采样序列：', stages.map(visTag).join(' → '));
}

function findCellOf(game: GameState, target: { routeId: number; step: number }): [number, number] {
  for (const [k, stack] of game.impressions) {
    if (stack.some((i) => i.routeId === target.routeId && i.step === target.step)) {
      const [x, y] = k.split(',').map(Number);
      return [x, y];
    }
  }
  return [-1, -1];
}

/** 观察快照冻结：早时刻记录的方向/深浅，不会因之后快进而被改写 */
function checkSnapshotFrozen(scId: string): void {
  const game = new GameState(scId);
  const first = game.scenario.routes[0].cells[0];
  const [fx, fy] = first;
  game.observations.set(`${fx},${fy}`, {
    x: fx,
    y: fy,
    atTime: game.now,
    stepped: true,
    impressions: game.peek(fx, fy),
  });
  const before = JSON.stringify(game.getObservation(fx, fy)!.impressions);
  game.advance(200);
  const after = JSON.stringify(game.getObservation(fx, fy)!.impressions);
  const ok = before === after;
  console.log(`=== ${scId} 观察快照冻结：${ok ? '通过（历史记录不被时间改写）' : '失败'} ===`);
}
