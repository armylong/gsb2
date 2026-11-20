// 验证入口：不使用任何预设误差曲线，全部由真实引擎实时跑出。
// 浏览器页面通过 runAll() 调用；Node 下 `vite build --ssr` 后直接执行（见 package.json 的 test 脚本）。
import { PredictedClient } from '../core/client';
import { Harness, CONVERGE_EPS } from '../core/harness';
import { Input, NetConfig, SnapshotPayload, TICK_MS } from '../core/protocol';
import { SCENARIOS } from '../core/scenarios';
import { AuthorityServer } from '../core/server';
import { createWorld, moveStep } from '../core/world';

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const ZERO_NET: NetConfig = {
  up: { delayMs: 0, jitterMs: 0, lossPct: 0 },
  down: { delayMs: 0, jitterMs: 0, lossPct: 0 },
};

function makeInput(seq: number, tick: number, epoch: number, keys = 8): Input {
  return { seq, tick, keys, epoch };
}

/** ① 消息重复与乱序：权威端按顺序、每个序号最多应用一次 */
function testDuplicateAndReorder(): TestResult {
  const world = createWorld();
  const server = new AuthorityServer(world, 1);
  server.pushZoneEnabled = false; // 本测试只验证序号语义，排除权威外力干扰
  const i1 = makeInput(1, 0, 1);
  const i2 = makeInput(2, 1, 1);
  const i3 = makeInput(3, 2, 1);

  // 乱序送达：#2 先到（缓存等待），#1 后到补齐
  const r2first = server.receive(i2);
  const r1first = server.receive(i1);
  // 推进一个 tick，按序消费 #1、#2
  server.advance(() => {});
  // 此时再送 #1、#2 的重传包：必须判为重复，不移动
  const dup1 = server.receive({ ...i1 });
  const dup2 = server.receive({ ...i2 });
  // #3 到达并在下一 tick 消费，再送它的重传包
  server.receive(i3);
  server.advance(() => {});
  const dup3 = server.receive({ ...i3 });

  // 权威端轨迹必须等价于“按 #1 #2 #3 顺序各应用一次”
  const sequential = moveStep(world, moveStep(world, moveStep(world, { ...world.spawn }, i1.keys), i2.keys), i3.keys);
  const actual = server.pos;
  const exact = Math.abs(actual.x - sequential.x) < 1e-9 && Math.abs(actual.y - sequential.y) < 1e-9;
  const pass =
    server.appliedInputs === 3 &&
    server.lastProcessedSeq === 3 &&
    server.duplicateRejected === 3 &&
    r2first === 'buffered' &&
    r1first === 'applied-later' &&
    dup1 === 'duplicate' &&
    dup2 === 'duplicate' &&
    dup3 === 'duplicate' &&
    exact;

  return {
    name: '① 重复与乱序输入：按序应用、最多一次',
    pass,
    detail: `乱序#2=${r2first}，应用输入=${server.appliedInputs}/3，拒绝重复=${server.duplicateRejected}/3，lastSeq=${server.lastProcessedSeq}，位置与顺序应用${exact ? '完全一致' : '不一致'}`,
  };
}

/** ② 旧快照拒绝：serverTick 不倒退，不重算已确认移动 */
function testStaleSnapshot(): TestResult {
  const world = createWorld();
  const client = new PredictedClient(world, 1);
  // 制造 3 个已预测输入
  for (let t = 0; t < 3; t++) client.step(t, 8, t * TICK_MS, () => {});
  const oldPos = { ...client.pos };

  const snapA: SnapshotPayload = {
    kind: 'snapshot', epoch: 1, serverTick: 8, lastProcessedSeq: 1, pos: moveStep(world, { ...world.spawn }, 8),
  };
  const r1 = client.handleSnapshot(snapA, 8 * TICK_MS);
  const posAfterA = { ...client.pos };

  // 更旧的快照晚到：必须拒绝
  const snapOld: SnapshotPayload = {
    kind: 'snapshot', epoch: 1, serverTick: 3, lastProcessedSeq: 0, pos: { ...world.spawn },
  };
  const r2 = client.handleSnapshot(snapOld, 9 * TICK_MS);

  // 更新的快照确认到 #2，只剩 #3 被重放一次（不重算 #1/#2，无加速）
  const snapB: SnapshotPayload = {
    kind: 'snapshot',
    epoch: 1,
    serverTick: 16,
    lastProcessedSeq: 2,
    pos: moveStep(world, moveStep(world, { ...world.spawn }, 8), 8),
  };
  const r3 = client.handleSnapshot(snapB, 16 * TICK_MS);
  const expectPos = moveStep(world, snapB.pos, 8); // 仅重放未确认的 #3
  const exact = Math.abs(client.pos.x - expectPos.x) < 1e-9 && Math.abs(client.pos.y - expectPos.y) < 1e-9;

  const pass =
    r1 === 'accepted' &&
    r2 === 'stale-tick' &&
    r3 === 'accepted' &&
    client.counters.rejectedSnapshots === 1 &&
    client.lastAppliedServerTick === 16 &&
    client.ackedSeq === 2 &&
    client.unacked.length === 1 &&
    exact &&
    Math.abs(posAfterA.x - oldPos.x) < 1e-9 &&
    Math.abs(posAfterA.y - oldPos.y) < 1e-9;

  return {
    name: '② 旧/乱序快照拒绝，确认进度不倒退',
    pass,
    detail: `接受=${r1},${r3}，拒绝=${r2}，拒绝计数=${client.counters.rejectedSnapshots}，ack<=${client.ackedSeq}，未确认重放=${client.unacked.length} 个，位置精确=${exact}`,
  };
}

/** ③ 丢包后最终确认：80% 上行丢包窗口结束后，所有输入经重传送达并收敛 */
function testLossRecovery(): TestResult {
  const harness = new Harness({ seed: 424242, net: structuredClone(ZERO_NET), smoothing: false, tauMs: 0, showTrail: false, pushZone: false });
  const N = 120;
  // 0~40 tick 高丢包
  for (let i = 0; i < N; i++) {
    if (i === 0) harness.updateNetConfig({ up: { delayMs: 0, jitterMs: 0, lossPct: 80 }, down: { ...ZERO_NET.down } });
    if (i === 40) harness.updateNetConfig(structuredClone(ZERO_NET));
    harness.manualKeys = 8;
    harness.advanceTick();
  }
  // 停输入，继续跑到链路收齐
  for (let i = 0; i < 600 && !harness.isQuiet(); i++) {
    harness.manualKeys = 0;
    harness.advanceTick();
  }
  const c = harness.client;
  const pass =
    harness.isQuiet() &&
    harness.isConverged() &&
    c.counters.retransmits > 0 &&
    c.ackedSeq === N &&
    c.unacked.length === 0 &&
    harness.server.appliedInputs === N;

  return {
    name: '③ 短暂丢包后重传补齐、最终全部确认并收敛',
    pass,
    detail: `首发=${c.counters.sent}，重传=${c.counters.retransmits}，确认到 #${c.ackedSeq}/${N}，未确认=${c.unacked.length}，权威应用=${harness.server.appliedInputs}，误差=${harness.lastError.logical.toExponential(2)}`,
  };
}

/** ④ 重置隔离：旧 epoch 的输入/快照在新一轮全部被拒绝，且不改变新状态 */
function testResetIsolation(): TestResult {
  const harness = new Harness({ seed: 7, net: structuredClone(ZERO_NET), smoothing: false, tauMs: 0, showTrail: false, pushZone: false });
  for (let i = 0; i < 10; i++) {
    harness.manualKeys = 8;
    harness.advanceTick();
  }
  const oldEpoch = harness.epoch;
  harness.reset();
  const newEpoch = harness.epoch;
  const serverBefore = { ...harness.server.pos };
  const clientBefore = { ...harness.client.pos };

  const staleInput: Input = { seq: 1, tick: 0, keys: 8, epoch: oldEpoch };
  const inResult = harness.server.receive(staleInput);
  const staleSnap: SnapshotPayload = {
    kind: 'snapshot', epoch: oldEpoch, serverTick: 999, lastProcessedSeq: 999, pos: { x: 1, y: 1 },
  };
  const snapResult = harness.client.handleSnapshot(staleSnap, harness.nowMs + TICK_MS);

  const unchanged =
    harness.server.pos.x === serverBefore.x &&
    harness.server.pos.y === serverBefore.y &&
    harness.client.pos.x === clientBefore.x &&
    harness.client.pos.y === clientBefore.y &&
    harness.client.lastAppliedServerTick === -1;

  const pass = inResult === 'stale-epoch' && snapResult === 'stale-epoch' && newEpoch === oldEpoch + 1 && unchanged;
  return {
    name: '④ 重置隔离：旧轮次消息不能影响新一轮',
    pass,
    detail: `epoch ${oldEpoch}→${newEpoch}，旧输入=${inResult}，旧快照=${snapResult}，新轮次状态保持出生点=${unchanged}`,
  };
}

/** ⑤ 三组内置场景：停止输入并等消息收齐后两端收敛 */
function testScenarioConvergence(): TestResult {
  const details: string[] = [];
  let allPass = true;
  for (const scenario of SCENARIOS) {
    const harness = new Harness({
      seed: 20261120,
      net: structuredClone(scenario.initialNet),
      smoothing: false,
      tauMs: 0,
      showTrail: false,
      pushZone: true,
    });
    harness.loadScenario(scenario);
    const traceTicks = scenario.keysPerTick.length;
    const expectedInputs = scenario.keysPerTick.filter((k) => k !== 0).length;
    // 录像播完后继续推进，直到输入通道真正收齐（带充裕上限），而不是按固定 tick 数截断
    let extra = 0;
    for (let i = 0; i < traceTicks; i++) harness.advanceTick();
    while (!harness.isQuiet() && extra < 12000) {
      harness.advanceTick();
      extra++;
    }

    const sent = harness.client.counters.sent;
    const ok =
      harness.traceFinished &&
      harness.isQuiet() &&
      harness.isConverged() &&
      sent === expectedInputs &&
      harness.client.ackedSeq === sent &&
      harness.server.appliedInputs === sent &&
      harness.lastError.logical <= CONVERGE_EPS;
    allPass = allPass && ok;
    details.push(
      `${scenario.id}: ${ok ? 'PASS' : 'FAIL'}（输入 ${harness.server.appliedInputs}/${sent} 全确认，误差=${harness.lastError.logical.toExponential(2)}，收齐=${harness.isQuiet()}）`,
    );
  }
  return { name: '⑤ 三个场景停输入、消息收齐后最终收敛', pass: allPass, detail: details.join('；') };
}

/** ⑥ 权威推挤区产生真实预测分歧：纠正次数>0、峰值误差>0，离开并收齐后逻辑位置重新收敛 */
function testPushZoneCorrection(): TestResult {
  const net: NetConfig = {
    up: { delayMs: 120, jitterMs: 40, lossPct: 0 },
    down: { delayMs: 120, jitterMs: 40, lossPct: 0 },
  };
  const harness = new Harness({ seed: 20261120, net, smoothing: false, tauMs: 0, showTrail: false, pushZone: true });
  // 出生点与推挤区同在底部无墙走廊：按住右行 240 tick 直接穿过推挤区，
  // 区内输入/确认持续流动，权威端独有的右向推力逐快照产生真实纠正；随后停输入等收齐
  const plan: Array<[number, number]> = [
    [8, 240],
    [0, 0],
  ];
  for (const [keys, ticks] of plan) {
    for (let i = 0; i < ticks; i++) {
      harness.manualKeys = keys;
      harness.advanceTick();
    }
  }
  const peakDuringMotion = harness.client.counters.maxLogicalError;
  const correctionsDuringMotion = harness.client.counters.corrections;
  // 停输入，等输入通道收齐
  harness.manualKeys = 0;
  let extra = 0;
  while (!harness.isQuiet() && extra < 4000) {
    harness.advanceTick();
    extra++;
  }
  const c = harness.client;
  const pass =
    correctionsDuringMotion > 0 &&
    peakDuringMotion > 1 &&
    harness.isQuiet() &&
    harness.isConverged() &&
    harness.lastError.logical <= CONVERGE_EPS;

  return {
    name: '⑥ 权威推挤区：真实纠正发生，且停输入收齐后重新收敛',
    pass,
    detail: `纠正次数=${correctionsDuringMotion}，峰值逻辑误差=${peakDuringMotion.toFixed(2)}px，收齐后误差=${harness.lastError.logical.toExponential(2)}，重传=${c.counters.retransmits}`,
  };
}

export function runAll(): TestResult[] {
  return [
    testDuplicateAndReorder(),
    testStaleSnapshot(),
    testLossRecovery(),
    testResetIsolation(),
    testScenarioConvergence(),
    testPushZoneCorrection(),
  ];
}

// Node 直跑（npm test）
declare const process: { argv: string[]; exit: (code: number) => void } | undefined;
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url.endsWith('run.js')) {
  const results = runAll();
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}
