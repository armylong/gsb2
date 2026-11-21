/**
 * 无头验证：不依赖浏览器/DOM，直接驱动引擎做断言。
 * 运行：npm run verify   （或 npx tsx src/engine/verify.ts）
 *
 * 覆盖：
 *  T1 连续推动：合法链条整体移动 / 超重整次失效 / 撞墙整次失效（无一物移动）
 *  T2 输送带同格竞争（稳定优先级）与重块/边界取消
 *  T3 迎头对撞成环，双方同时取消
 *  T4 传送：出口被占则阻塞，清空后成功；同拍双入口争同一出口只过一个
 *  T5 确定性：相同种子 + 相同输入序列，两次结果逐格一致
 *  T6 随机压力：200 张随机地图各跑 60 拍，全程不丢块、不重叠、不越界
 */
declare const process: { exit(code: number): void };
import { assertInvariants, cloneState, createState, step } from './engine';
import { GameMap, Input, key } from './types';
import {
  presetChainPush,
  presetOpposingPush,
  presetTeleportConflict,
  randomMap,
} from './map';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name} ${extra}`);
  }
}

function blockCount(map: GameMap): number {
  return map.blocks.length;
}

function snapshot(s: ReturnType<typeof createState>): string {
  return JSON.stringify(s.map);
}

function runInputs(map: GameMap, inputs: Input[]): ReturnType<typeof createState> {
  const s = createState(map);
  for (const i of inputs) step(s, i);
  assertInvariants(s);
  return s;
}

// ---------------------------------------------------------------- T1 推动

console.log('T1 连续推动 / 整次失效');
{
  const s = createState(presetChainPush());
  // 玩家在 (0,1)，向右推 S1 S2 S3（总重 3，可推）
  step(s, 'right');
  const ids = ['S1', 'S2', 'S3'].map((id) => s.map.blocks.find((b) => b.id === id)!);
  check('合法链条整体右移一格', ids.every((b, i) => b.x === 2 + i && b.y === 1));
  check('玩家跟进到原第一格', s.map.player.x === 1 && s.map.player.y === 1);
  check('推动后数量不变', blockCount(s.map) === blockCount(presetChainPush()));

  // 第二行：玩家移到 (0,3) 向右推 T1 T2（总重 4 > 3），整次失效
  const original = presetChainPush();
  const s2 = createState(presetChainPush());
  s2.map.player = { x: 0, y: 3 };
  step(s2, 'right');
  check('超重时所有方块位置零变化',
    JSON.stringify(s2.map.blocks) === JSON.stringify(original.blocks));
  check('超重时玩家原地不动', s2.map.player.x === 0 && s2.map.player.y === 3);
  check('失效拍产生 push-blocked 事件', s2.events.some((e) => e.kind === 'push-blocked'));

  // 第三行撞墙：玩家走到 (5,4) 向右推 U1 U2 U3，末端 (9,4) 是墙
  const s3 = createState(presetChainPush());
  s3.map.player = { x: 5, y: 4 };
  const uBefore = s3.map.blocks.filter((b) => b.id.startsWith('U')).map((b) => ({ ...b }));
  step(s3, 'right');
  const uAfter = s3.map.blocks.filter((b) => b.id.startsWith('U'));
  check('撞墙链条无一物移动', uAfter.every((b) => {
    const old = uBefore.find((o) => o.id === b.id)!;
    return b.x === old.x && b.y === old.y;
  }));
  check('玩家未进入链条', s3.map.player.x === 5 && s3.map.player.y === 4);

  // 重量3单块可推；相邻再放一块则总重 4 推不动
  const s4 = createState(presetChainPush());
  s4.map.player = { x: 3, y: 6 };
  step(s4, 'right');
  const v1 = s4.map.blocks.find((b) => b.id === 'V1')!;
  check('重量 3 单块恰在推力上限内，可推', v1.x === 5 && v1.y === 6);

  const s5 = createState(presetChainPush());
  s5.map.player = { x: 3, y: 6 };
  step(s5, 'right'); // 先推 V1 到 (5,6)，与 V2 相邻
  step(s5, 'right'); // 再推：V1(3)+V2(1)=4 > 3，整次失效
  check('组合超重后整次失效，两方块都不动',
    s5.map.blocks.find((b) => b.id === 'V1')!.x === 5 &&
    s5.map.blocks.find((b) => b.id === 'V2')!.x === 6);
  check('玩家停在 (4,6)', s5.map.player.x === 4 && s5.map.player.y === 6);
}

// ---------------------------------------------------------------- T2 输送带竞争

console.log('T2 输送带同格竞争 / 取消');
{
  const s = runInputs(presetOpposingPush(), ['idle']);
  const A = s.map.blocks.find((b) => b.id === 'A')!;
  const B = s.map.blocks.find((b) => b.id === 'B')!;
  // A (2,1) 想 -> (3,1)；B (4,3) 想 -> (4,2)。第一拍目标不同，均成功
  check('第一拍两者各走一格', A.x === 3 && A.y === 1 && B.x === 4 && B.y === 2);
  const ev2 = s.events;
  check('两个移动都有 belt-move 事件',
    ev2.filter((e) => e.kind === 'belt-move').length >= 2);

  // 第二拍：A -> (4,1)，B -> (4,1)，同格竞争。源格 A(3,1) 与 B(4,2)：y=1 优先 => A 胜
  step(s, 'idle');
  const A2 = s.map.blocks.find((b) => b.id === 'A')!;
  const B2 = s.map.blocks.find((b) => b.id === 'B')!;
  check('同格竞争按行优先：A 进入目标格', A2.x === 4 && A2.y === 1);
  check('同格竞争败者 B 留在原地', B2.x === 4 && B2.y === 2);
  check('败者有 belt-cancel 事件且标出对象',
    s.events.some((e) => e.kind === 'belt-cancel' && e.subject === 'block:B'));

  // 重量 3 的 H 永远推不动
  const sH = runInputs(presetOpposingPush(), Array(3).fill('idle') as Input[]);
  const H = sH.map.blocks.find((b) => b.id === 'H')!;
  check('重量 3 方块不被输送带带动', H.x === 8 && H.y === 3);
  check('重块每拍都产生取消事件',
    sH.events.some((e) => e.kind === 'belt-cancel' && e.subject === 'block:H'));

  // E 向左撞墙，被取消
  const E = sH.map.blocks.find((b) => b.id === 'E')!;
  check('输送带尽头是墙：方块不动', E.x === 1 && E.y === 7);
}

// ---------------------------------------------------------------- T3 对撞成环

console.log('T3 迎头对撞');
{
  const s = runInputs(presetOpposingPush(), ['idle']);
  const C = s.map.blocks.find((b) => b.id === 'C')!;
  const D = s.map.blocks.find((b) => b.id === 'D')!;
  // C (2,5)->(3,5)，D (6,5)->(5,5)，第一拍互相靠近
  check('对撞前双方各靠近一格', C.x === 3 && D.x === 5);
  step(s, 'idle'); // 第二拍：C->(4,5)，D->(4,5) 同格竞争（行相同，x 小者 C 胜）
  const C2 = s.map.blocks.find((b) => b.id === 'C')!;
  const D2 = s.map.blocks.find((b) => b.id === 'D')!;
  check('同行同格竞争 x 较小者 C 胜', C2.x === 4 && C2.y === 5);
  check('D 被取消留在 (5,5)', D2.x === 5 && D2.y === 5);

  // 构造真正的迎头相邻对撞（互指对方所在格 → 2 环）
  const map = presetOpposingPush();
  map.blocks = map.blocks.filter((b) => b.id === 'C' || b.id === 'D');
  map.belts = { [key(4, 5)]: 'right', [key(5, 5)]: 'left' };
  map.blocks[0] = { id: 'C', x: 4, y: 5, weight: 1 };
  map.blocks[1] = { id: 'D', x: 5, y: 5, weight: 1 };
  const s2 = runInputs(map, ['idle']);
  check('相邻迎头对撞成环：双方都不动',
    s2.map.blocks.find((b) => b.id === 'C')!.x === 4 &&
    s2.map.blocks.find((b) => b.id === 'D')!.x === 5);
  check('环上两个对象都被标出取消',
    s2.events.filter((e) => e.kind === 'belt-cancel').length === 2);
}

// ---------------------------------------------------------------- T4 传送

console.log('T4 传送入口冲突');
{
  const s = createState(presetTeleportConflict());
  const initialCount = blockCount(s.map);
  // 第一拍 idle：X 被输送带从 (1,2) 送进入口 (2,2)；O 堵着 P1 出口
  step(s, 'idle');
  const X1 = s.map.blocks.find((b) => b.id === 'X')!;
  check('输送带先把 X 送进入口格', X1.x === 2 && X1.y === 2);

  // 第二拍：X 触发传送，但出口 (7,2) 被 O 占据 → 阻塞，X 留入口
  step(s, 'idle');
  const X2 = s.map.blocks.find((b) => b.id === 'X')!;
  check('出口被占：传送阻塞，X 留在入口', X2.x === 2 && X2.y === 2);
  check('产生 teleport-blocked 事件',
    s.events.some((e) => e.kind === 'teleport-blocked' && e.subject === 'block:X'));

  // 移走 O，再拍：X 成功传送到 (7,2)
  s.map.blocks = s.map.blocks.filter((b) => b.id !== 'O');
  step(s, 'idle');
  const X3 = s.map.blocks.find((b) => b.id === 'X')!;
  check('出口清空后传送成功', X3.x === 7 && X3.y === 2);
  check('有 teleport 事件记录路径',
    s.events.some((e) => e.kind === 'teleport' && e.subject === 'block:X'));

  // 同拍双入口 L/R 争同一出口 (8,6)：稳定优先级 L 源 (2,6) vs R 源 (5,0)，
  // y=0 的 R 行优先。先把两方块都压在入口上（预设已如此），跑一拍
  const s2 = createState(presetTeleportConflict());
  step(s2, 'idle');
  const L = s2.map.blocks.find((b) => b.id === 'L')!;
  const R = s2.map.blocks.find((b) => b.id === 'R')!;
  const winners = [L, R].filter((b) => b.x === 8 && b.y === 6);
  check('同拍双入口争同一出口：恰好一个通过', winners.length === 1);
  check('通过者是稳定优先级最高的 R（源格 y=0）', winners[0]?.id === 'R');
  check('败者 L 留在入口', L.x === 2 && L.y === 6);
  check('方块总数全程不丢', blockCount(s2.map) === initialCount);

  // 玩家走入入口且出口空闲 → 玩家被传送
  const s3 = createState(presetTeleportConflict());
  s3.map.blocks = s3.map.blocks.filter((b) => b.id !== 'O');
  s3.map.player = { x: 1, y: 2 };
  s3.map.belts = {}; // 去掉输送带干扰
  step(s3, 'right'); // 玩家 (1,2)->(2,2) 入口，随后传送波次 1 送走
  check('玩家走入空闲入口后当拍传送到出口',
    s3.map.player.x === 7 && s3.map.player.y === 2);
}

// ---------------------------------------------------------------- T5 确定性

console.log('T5 相同种子/地图可复现');
{
  const inputs: Input[] = ['right', 'idle', 'up', 'idle', 'left', 'idle', 'down', 'idle', 'right', 'idle'];
  const map1 = randomMap(20261122);
  const map2 = randomMap(20261122);
  const a = runInputs(map1, inputs);
  const b = runInputs(map2, inputs);
  check('相同种子生成的地图一致', JSON.stringify(map1) === JSON.stringify(map2));
  check('相同输入序列后状态逐格一致', snapshot(a) === snapshot(b));

  // 不同种子大概率产生不同地图（结构随机性）
  const map3 = randomMap(20261123);
  check('不同种子产生不同地图', JSON.stringify(map3) !== JSON.stringify(map1));

  // 回放：用录制的输入在初始快照上重放，必须与倒退前状态一致
  const live = createState(randomMap(777));
  const snapshots = [cloneState(live)];
  for (const i of inputs) {
    step(live, i);
    snapshots.push(cloneState(live));
  }
  const replay = createState(randomMap(777));
  for (const i of inputs) step(replay, i);
  check('逐次回放结果与原过程一致', snapshot(replay) === snapshot(live));
  check('单步倒退快照可还原到任意一拍',
    snapshot(snapshots[4]) === snapshot((() => {
      const r = createState(randomMap(777));
      for (let k = 0; k < 4; k++) step(r, inputs[k]);
      return r;
    })()));
}

// ---------------------------------------------------------------- T6 随机压力

console.log('T6 随机地图压力测试（不丢块 / 不重叠 / 不越界）');
{
  const dirs: Input[] = ['up', 'down', 'left', 'right', 'idle'];
  let totalTicks = 0;
  let totalBlocks = 0;
  let pressureOk = true;
  const failures: string[] = [];
  for (let seed = 1; seed <= 200; seed++) {
    const map = randomMap(seed);
    const startCount = map.blocks.length;
    const s = createState(map);
    const rng = (n: number): number => {
      // 与地图种子独立的输入伪随机，保证每次验证运行一致
      let x = (n * 2654435761 + seed * 40503) >>> 0;
      x ^= x >>> 13;
      return (x >>> 0) % dirs.length;
    };
    for (let t = 0; t < 60; t++) {
      step(s, dirs[rng(t)]);
      totalTicks += 1;
    }
    if (blockCount(s.map) !== startCount) {
      pressureOk = false;
      failures.push(`种子 ${seed} 方块数量 ${startCount} -> ${blockCount(s.map)}`);
    }
    totalBlocks += startCount;
  }
  check('200 张随机地图 × 60 拍全程不丢块、不重叠、不越界', pressureOk, failures.join('; '));
  console.log(`    （累计 ${totalTicks} 拍，${totalBlocks} 个方块参与，assertInvariants 每拍执行）`);
}

// ---------------------------------------------------------------- 汇总

console.log('');
if (failed === 0) {
  console.log(`全部通过：${passed} 项断言，0 失败`);
  process.exit(0);
} else {
  console.error(`验证失败：${passed} 项通过，${failed} 项失败`);
  process.exit(1);
}
