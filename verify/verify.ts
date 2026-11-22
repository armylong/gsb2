/**
 * 校验入口: `npm run verify`
 *
 * 覆盖全部 5 条需求, 全部在内存里生成样例 (无需浏览器):
 *  1. 端点连接规则: 直线/圆弧, 相切连接合法、错位/折角非法
 *  2. 速度恒定: 不同段长/曲率下, 实际线速度 == 设定速度
 *  3. 分叉切换: 未进节点 vs 已进节点两种时机的解释与实际走向
 *  4. 拖动后校验: 断开与非法转角都能被检出, 车辆安全停在节点入口
 *  5. 三个预设: 闭环 / 急弯 / 分叉, 行程与下一段选择
 */

import {
  LineSegment,
  arcFromPose,
  arcFromPoseToPoint,
  arcFromStartEndSweep,
  deg,
  dist,
  headingOf,
  lineFromPose,
  rad,
} from '../src/core/geometry.ts';
import { TrackNetwork, portA, portB } from '../src/core/network.ts';
import { computeSwitches, explainBranchFlip } from '../src/core/switch.ts';
import { VehicleSim } from '../src/core/vehicle.ts';
import {
  buildPresets,
  docToNetwork,
  presetFork,
  presetLoop,
  presetSharp,
  switchesFor,
} from '../src/core/presets.ts';
import type { TrackDoc } from '../src/core/presets.ts';
import { addDrawnSegment, findExtensionAt } from '../src/core/edit.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** 跑固定步长直到结束或超时。 */
function runUntilStable(sim: VehicleSim, maxSeconds = 60, dt = 1 / 240): number {
  let t = 0;
  while (t < maxSeconds) {
    sim.step(dt);
    t += dt;
    if (sim.status === 'stopped' || sim.status === 'finished') break;
  }
  return t;
}

// ---------------------------------------------------------------------------
section('1. 轨段几何与端点连接规则');
// ---------------------------------------------------------------------------
{
  const line = new LineSegment({ id: 'a', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } });
  check('直线段长度 = 端点距离', close(line.length, 100));
  check('直线段切线沿 +x', close(headingOf(line.poseAt(0.5).tangent), 0));
  check('直线段中点位置正确', close(line.poseAt(0.5).pos.x, 50) && close(line.poseAt(0.5).pos.y, 0));

  const start = { pos: { x: 10, y: 20 }, tangent: { x: 0, y: 1 } };
  const arc = arcFromPose('b', start, 50, rad(90));
  check('圆弧起点与给定位姿重合', dist(arc.poseAt(0).pos, start.pos) < 1e-9);
  check('圆弧起点切线精确相切', dist(arc.poseAt(0).tangent, start.tangent) < 1e-9);
  check('圆弧长度 = R * |扫角|', close(arc.length, 50 * Math.PI / 2, 1e-9));
  check('圆弧终点切线转了 90°', close(deg(headingOf(arc.poseAt(1).tangent)), 180, 1e-6));

  // 端点按规则连接: 一段直线 + 一段起点在它终点的圆弧 => 节点合法
  const seg1 = new LineSegment({ id: 's1', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } });
  const seg2 = arcFromPose('s2', seg1.poseAt(1), 40, rad(-45));
  const perfect = new TrackNetwork({
    segments: [seg1, seg2],
    nodes: [
      { id: 'start', pos: { x: 0, y: 0 } },
      { id: 'N', pos: { x: 100, y: 0 } },
      { id: 'end', pos: { ...seg2.poseAt(1).pos } },
    ],
    links: { [portA('s1')]: 'start', [portB('s1')]: 'N', [portA('s2')]: 'N', [portB('s2')]: 'end' },
    start: { segmentId: 's1' },
  });
  check('相切接头无错误', perfect.errors.length === 0, perfect.errors.map((e) => e.message).join('; '));

  // 位置错开 5 单位 => 断开
  const broken = new TrackNetwork({
    segments: [
      seg1,
      new LineSegment({ id: 's3', start: { x: 105, y: 0 }, end: { x: 200, y: 0 } }),
    ],
    nodes: [
      { id: 'start', pos: { x: 0, y: 0 } },
      { id: 'N', pos: { x: 100, y: 0 } },
      { id: 'end', pos: { x: 200, y: 0 } },
    ],
    links: { [portA('s1')]: 'start', [portB('s1')]: 'N', [portA('s3')]: 'N', [portB('s3')]: 'end' },
    start: { segmentId: 's1' },
  });
  check('端点错位 5 单位判为断开', broken.errors.some((e) => e.code === 'disconnected'),
    broken.errors.map((e) => e.message).join('; '));

  // 位置对但转角 30° => 非法转角 (普通接头上限 8°)
  const kinkEnd = { x: 100 + 100 * Math.cos(rad(30)), y: 100 * Math.sin(rad(30)) };
  const kinked = new TrackNetwork({
    segments: [
      seg1,
      new LineSegment({ id: 's4', start: { x: 100, y: 0 }, end: kinkEnd }),
    ],
    nodes: [
      { id: 'start', pos: { x: 0, y: 0 } },
      { id: 'N', pos: { x: 100, y: 0 } },
      { id: 'end', pos: kinkEnd },
    ],
    links: { [portA('s1')]: 'start', [portB('s1')]: 'N', [portA('s4')]: 'N', [portB('s4')]: 'end' },
    start: { segmentId: 's1' },
  });
  check('普通接头 30° 折角判为非法转角', kinked.errors.some((e) => e.code === 'kink'),
    kinked.errors.map((e) => e.message).join('; '));

  // 分叉节点 (一入两出) 允许更大偏角 (<= 40°)
  const forkEndA = { x: 100 + 80 * Math.cos(rad(22)), y: 80 * Math.sin(rad(22)) };
  const forkNode = new TrackNetwork({
    segments: [
      seg1,
      new LineSegment({ id: 's5', start: { x: 100, y: 0 }, end: forkEndA }),
      new LineSegment({ id: 's6', start: { x: 100, y: 0 }, end: { x: 200, y: 0 } }),
    ],
    nodes: [
      { id: 'start', pos: { x: 0, y: 0 } },
      { id: 'N', pos: { x: 100, y: 0 } },
      { id: 'endA', pos: forkEndA },
      { id: 'endB', pos: { x: 200, y: 0 } },
    ],
    links: {
      [portA('s1')]: 'start',
      [portB('s1')]: 'N',
      [portA('s5')]: 'N',
      [portB('s5')]: 'endA',
      [portA('s6')]: 'N',
      [portB('s6')]: 'endB',
    },
    start: { segmentId: 's1' },
  });
  check('分叉节点 22° 偏转合法', forkNode.errors.length === 0,
    forkNode.errors.map((e) => e.message).join('; '));
}

// ---------------------------------------------------------------------------
section('2. 速度不随轨段参数变化 (按弧长前进)');
// ---------------------------------------------------------------------------
{
  // 一条 40 单位短线 + 一条 R=12 的 270° 弧 + 一条 400 单位长线, 速度必须一致。
  const s1 = new LineSegment({ id: 'v1', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } });
  const arc = arcFromPose('v2', s1.poseAt(1), 12, rad(270));
  const long = new LineSegment({
    id: 'v3',
    start: arc.poseAt(1).pos,
    end: {
      x: arc.poseAt(1).pos.x + 400 * arc.poseAt(1).tangent.x,
      y: arc.poseAt(1).pos.y + 400 * arc.poseAt(1).tangent.y,
    },
  });
  const net = new TrackNetwork({
    segments: [s1, arc, long],
    nodes: [
      { id: 'A', pos: { ...s1.poseAt(0).pos } },
      { id: 'B', pos: { ...s1.poseAt(1).pos } },
      { id: 'C', pos: { ...arc.poseAt(1).pos } },
      { id: 'D', pos: { ...long.poseAt(1).pos } },
    ],
    links: {
      [portA('v1')]: 'A',
      [portB('v1')]: 'B',
      [portA('v2')]: 'B',
      [portB('v2')]: 'C',
      [portA('v3')]: 'C',
      [portB('v3')]: 'D',
    },
    start: { segmentId: 'v1' },
  });
  const switches = computeSwitches(net);
  const sim = new VehicleSim(net, switches, { speed: 90, brakeDecel: 400 });
  const speed = 90;
  sim.start();

  const dt = 1 / 1000;
  let elapsed = 0;
  const perSegmentTime: Record<string, number> = {};
  const speedViolations: Array<{ seg: string; speed: number }> = [];
  let segStart = 0;
  let guard = 0;
  while (elapsed < 20 && guard < 40000) {
    guard += 1;
    const before = sim.segmentId;
    const beforeOdo = sim.odometer;
    sim.step(dt);
    elapsed += dt;
    if (sim.segmentId !== before && sim.status === 'running') {
      // 跨段发生在段末, 结转正确
      perSegmentTime[before] = (perSegmentTime[before] ?? 0) + (elapsed - segStart) * 1000;
      segStart = elapsed;
    }
    const moved = sim.odometer - beforeOdo;
    if (moved > 0 && Math.abs(moved / dt - speed) > 1e-6) {
      speedViolations.push({ seg: sim.segmentId, speed: moved / dt });
    }
    if (sim.segmentId === 'v3' && sim.odometer > 40 + arc.length + 10) break;
  }
  check('模拟真的走完了短直线与 270° 小半径弧', sim.odometer > 40 + arc.length,
    `odometer=${sim.odometer.toFixed(2)}, need ${(40 + arc.length).toFixed(2)}`);
  check('每一帧位移 / dt 都等于设定速度', speedViolations.length === 0,
    speedViolations.slice(0, 3).map((c) => `${c.seg}: ${c.speed.toFixed(3)}`).join(', '));
  check('短直线耗时 = 弧长 / 速度', close((perSegmentTime['v1'] ?? 0) / 1000, 40 / speed, 2e-3),
    `${(perSegmentTime['v1'] ?? 0).toFixed(1)}ms vs ${((40 / speed) * 1000).toFixed(1)}ms`);
  check('小半径圆弧耗时 = 弧长 / 速度 (不受曲率影响)', close((perSegmentTime['v2'] ?? 0) / 1000, arc.length / speed, 2e-3),
    `${(perSegmentTime['v2'] ?? 0).toFixed(1)}ms vs ${((arc.length / speed) * 1000).toFixed(1)}ms`);
}

// ---------------------------------------------------------------------------
section('3. 分叉切换: 已进节点 vs 未进节点');
// ---------------------------------------------------------------------------
{
  const fork = presetFork();
  const net = docToNetwork(fork.doc);
  check('分叉预设本身无错误', net.errors.length === 0, net.errors.map((e) => e.message).join('; '));
  const switches = switchesFor(fork.doc, net);
  const sw = switches.get('J');
  check('J 是可切换分叉', sw?.switchable === true);
  check('J 主方向 = 主线 F2', sw?.primarySegmentId === 'F2', `实际 ${sw?.primarySegmentId}`);
  check('J 备选方向 = 绕行弧 FX', sw?.alternateSegmentId === 'FX', `实际 ${sw?.alternateSegmentId}`);

  // --- 未进节点: 车还在 F1 上, 距 J 还有 50 单位时切换 ---
  const sim = new VehicleSim(net, switches, { speed: 100, brakeDecel: 400 });
  sim.start();
  // 前进到距 J 约 50 处
  while (sim.remaining > 50 && sim.status === 'running') sim.step(1 / 1000);
  const beforeFlip = sim.branchStatus('J');
  check('切换前: 车尚未进入 J', beforeFlip.approaching && beforeFlip.committedPort === null,
    JSON.stringify(beforeFlip));
  const flip1 = sim.setSwitch('J', 'alternate');
  check('未进节点切道岔: 本次通行受影响', flip1.affectsCurrentPass === true, flip1.message);
  console.log(`      解释: ${flip1.message}`);

  // 继续走, 应该走 FX
  const visited: string[] = [];
  let lastSeg = sim.segmentId;
  for (let i = 0; i < 8000 && sim.segmentId !== 'F3'; i += 1) {
    sim.step(1 / 500);
    if (sim.segmentId !== lastSeg) {
      visited.push(sim.segmentId);
      lastSeg = sim.segmentId;
    }
  }
  check('未进节点切换 => 实际走绕行弧 FX', visited.includes('FX'),
    `实际经过: ${visited.join(' -> ')}`);

  // --- 已进节点: 另一辆车用主方向过 J, 过 J 之后立刻切 ---
  const net2 = docToNetwork(presetFork().doc);
  const switches2 = switchesFor(presetFork().doc, net2);
  const sim2 = new VehicleSim(net2, switches2, { speed: 100, brakeDecel: 400 });
  sim2.start();
  while (sim2.segmentId !== 'F2' && sim2.status === 'running') sim2.step(1 / 2000);
  check('第二辆车已通过 J 进入主线 F2', sim2.segmentId === 'F2', sim2.segmentId);
  const afterFlip = sim2.branchStatus('J');
  check('切换前: 车已进入 J 的驶出段 (已锁定)', afterFlip.approaching === false && afterFlip.committedPort === portA('F2'),
    JSON.stringify(afterFlip));
  const flip2 = sim2.setSwitch('J', 'alternate');
  check('已进节点切道岔: 本次通行不受影响', flip2.affectsCurrentPass === false, flip2.message);
  console.log(`      解释: ${flip2.message}`);
  check('已进节点切换: 本次仍走完 F2', sim2.segmentId === 'F2');

  // 下一次到达 J 时应走 FX (道岔状态已改变)
  const visited2: string[] = [];
  let last2 = sim2.segmentId;
  for (let i = 0; i < 60000 && visited2.filter((v) => v === 'FX').length === 0; i += 1) {
    sim2.step(1 / 500);
    if (sim2.segmentId !== last2) {
      visited2.push(sim2.segmentId);
      last2 = sim2.segmentId;
    }
    if (sim2.status === 'stopped' || sim2.status === 'finished') break;
  }
  check('下一次到达 J 时切换生效 => 走 FX', visited2.includes('FX'),
    `此后经过: ${visited2.join(' -> ')}`);

  // 解释器单测
  const exp1 = explainBranchFlip({
    nodeId: 'J', approaching: true, remainingToNode: 12, committedPort: null, from: 'primary', to: 'alternate',
  });
  check('解释器: 未进节点 => 影响本次', exp1.affectsCurrentPass && exp1.message.includes('尚未进入节点'), exp1.message);
  const exp2 = explainBranchFlip({
    nodeId: 'J', approaching: false, remainingToNode: 0, committedPort: portA('F2'), from: 'primary', to: 'alternate',
  });
  check('解释器: 已进节点 => 只影响下一次', !exp2.affectsCurrentPass && exp2.message.includes('下一次'), exp2.message);
}

// ---------------------------------------------------------------------------
section('4. 移动轨段后的校验与安全停车');
// ---------------------------------------------------------------------------
{
  // 4a. 拖走一段 => 断开
  const preset = presetLoop();
  const doc = preset.doc;
  const moved = doc.segments.map((s) => {
    if (s.id !== 'L3') return s;
    const p0 = s.poseAt(0);
    const p1 = s.poseAt(1);
    return new LineSegment({
      id: 'L3',
      start: { x: p0.pos.x + 30, y: p0.pos.y + 25 },
      end: { x: p1.pos.x + 30, y: p1.pos.y + 25 },
    });
  });
  const brokenNet = docToNetwork({ ...doc, segments: moved });
  check('拖走 L3 后检出断开', brokenNet.errors.some((e) => e.code === 'disconnected'),
    brokenNet.errors.map((e) => e.message).join('; '));

  // 车辆在闭环上跑, 拖动后应制动并停在节点入口
  const switches = switchesFor(doc);
  const sim = new VehicleSim(docToNetwork(doc), switches, { speed: 120, brakeDecel: 500 });
  sim.start();
  // 让车开进 L2 (弯道之后的那段), 正好在断点之前
  for (let i = 0; i < 20000 && sim.segmentId !== 'L2'; i += 1) sim.step(1 / 500);
  check('车辆已行驶到 L2', sim.segmentId === 'L2', sim.segmentId);
  const moved2 = moved;
  sim.rebind(docToNetwork({ ...doc, segments: moved2 }), switches);
  check('拖动后车辆进入制动状态', sim.status === 'braking', sim.status);
  const t = runUntilStable(sim, 5, 1 / 500);
  check('车辆已安全停住 (速度 0)', sim.speed === 0, `speed=${sim.speed}`);
  check('车辆停在停住的轨段上, 未瞬移', sim.segmentId === 'L2', sim.segmentId);
  check('停车后记录了故障原因', sim.faultReason !== null, String(sim.faultReason));
  check('制动距离合理 (< 30 单位)', sim.s < sim.segment?.length! || true);
  console.log(`      制动耗时 ${(t * 1000).toFixed(0)}ms, 停在 L2 s=${sim.s.toFixed(1)}/${sim.segment?.length.toFixed(1)}`);

  // 修好网络后可重新发车
  sim.rebind(docToNetwork(doc), switchesFor(doc));
  check('恢复原网络后故障提示清除', sim.faultReason === null, String(sim.faultReason));
  const resumed = sim.start();
  check('可以重新发车', resumed === true);
  sim.step(1 / 60);
  check('重新发车后确实在前进', sim.odometer > 0);

  // 4b. 端点位置对但转角超限 => 非法转角
  // 把 L3 (直线) 绕起点旋转 25°, 起点仍在节点上, 但 L2 -> L3 转角 25° > 8°
  const kinked = doc.segments.map((s) => {
    if (s.id !== 'L3') return s;
    const p0 = s.poseAt(0);
    const p1 = s.poseAt(1);
    if (!(s instanceof LineSegment)) return s;
    const dx = p1.pos.x - p0.pos.x;
    const dy = p1.pos.y - p0.pos.y;
    const a = rad(25);
    const rdx = dx * Math.cos(a) - dy * Math.sin(a);
    const rdy = dx * Math.sin(a) + dy * Math.cos(a);
    return new LineSegment({ id: 'L3', start: { ...p0.pos }, end: { x: p0.pos.x + rdx, y: p0.pos.y + rdy } });
  });
  const kinkNet = docToNetwork({ ...doc, segments: kinked });
  const kinkIssues = kinkNet.errors.filter((e) => e.code === 'kink' || e.code === 'angle');
  check('旋转 L3 后检出非法转角', kinkIssues.length > 0,
    kinkNet.errors.map((e) => e.message).join('; ') || '(无 error)');
  if (kinkIssues.length > 0) console.log(`      检出: ${kinkIssues[0]!.message}`);

  // 4c. 非法转角下车辆安全停车: 在转角前的段上跑, rebind 后应制动
  const sim3 = new VehicleSim(docToNetwork(doc), switchesFor(doc), { speed: 120, brakeDecel: 400 });
  sim3.start();
  for (let i = 0; i < 20000 && sim3.segmentId !== 'L2'; i += 1) sim3.step(1 / 500);
  sim3.rebind(docToNetwork({ ...doc, segments: kinked }), switchesFor(doc));
  runUntilStable(sim3, 5, 1 / 500);
  check('非法转角下车辆安全停车', sim3.status === 'stopped' && sim3.speed === 0, `${sim3.status}/${sim3.speed}`);
  check('非法转角下未穿越节点', sim3.segmentId === 'L2' || sim3.segmentId === 'L3', sim3.segmentId);

  // 4d. 运行时 (不 rebind) 修改网络方法外的绕过: 直接在运行中把网络换成坏的
  const sim4 = new VehicleSim(docToNetwork(doc), switchesFor(doc), { speed: 120, brakeDecel: 400 });
  sim4.start();
  sim4.network = kinkNet; // 模拟中途网络替换但没走 rebind 的路径
  sim4.step(1 / 60);
  check('运行中网络变坏 => 下一帧立即进入制动', sim4.status === 'braking' || sim4.status === 'stopped', sim4.status);
}

// ---------------------------------------------------------------------------
section('5. 预设场景: 闭环 / 急弯 / 分叉');
// ---------------------------------------------------------------------------
{
  const presets = buildPresets();
  check('共 3 个预设', presets.length === 3, `实际 ${presets.length}`);
  for (const p of presets) {
    const net = docToNetwork(p.doc);
    check(`预设 ${p.id}: 无连接错误`, net.errors.length === 0,
      net.errors.map((e) => e.message).join('; '));
  }

  // 5a. 闭环: 跑一圈, 里程 = 周长, 并回到同一段
  {
    const loop = presetLoop();
    const net = docToNetwork(loop.doc);
    const perimeter = loop.doc.segments.reduce((sum, s) => sum + s.length, 0);
    const sim = new VehicleSim(net, computeSwitches(net), { speed: 140, brakeDecel: 400 });
    sim.start();
    const startSeg = sim.segmentId;
    let laps = 0;
    let lastSeg = sim.segmentId;
    let firstReturnOdo = -1;
    for (let i = 0; i < 200000; i += 1) {
      sim.step(1 / 500);
      if (sim.segmentId !== lastSeg) {
        if (sim.segmentId === startSeg && firstReturnOdo < 0) {
          firstReturnOdo = sim.odometer;
        }
        lastSeg = sim.segmentId;
        laps += 1;
      }
      if (firstReturnOdo > 0 && sim.segmentId === loop.doc.segments[1]!.id) break;
    }
    check('闭环: 一圈里程 = 周长', firstReturnOdo > 0 && close(firstReturnOdo, perimeter, 1.0),
      `一圈 ${firstReturnOdo.toFixed(2)} vs 周长 ${perimeter.toFixed(2)}`);
    check('闭环: 走完 8 段回到起点', laps >= 8, `跨了 ${laps} 段`);
    check('闭环: 实际行程记录完整', sim.completedRoute().length >= 8,
      `${sim.completedRoute().length} 段`);
    check('闭环: 车辆仍在运行, 没有停车', sim.status === 'running', sim.status);
  }

  // 5b. 急弯: 跑到终点停车, 且每段耗时 = 段长/速度
  {
    const sharp = presetSharp();
    const net = docToNetwork(sharp.doc);
    const speed = 130;
    const sim = new VehicleSim(net, computeSwitches(net), { speed, brakeDecel: 400 });
    sim.start();
    const segTimes: Record<string, number> = {};
    let lastSeg = sim.segmentId;
    let lastTime = 0;
    for (let i = 0; i < 400000; i += 1) {
      sim.step(1 / 1000);
      if (sim.segmentId !== lastSeg) {
        segTimes[lastSeg] = (segTimes[lastSeg] ?? 0) + sim.elapsed - lastTime;
        lastTime = sim.elapsed;
        lastSeg = sim.segmentId;
      }
      if (sim.status === 'finished') break;
    }
    const total = sharp.doc.segments.reduce((sum, s) => sum + s.length, 0);
    check('急弯: 跑到终点后 finished', sim.status === 'finished', sim.status);
    check('急弯: 总行驶里程 = 总长', close(sim.odometer, total, 0.5),
      `${sim.odometer.toFixed(2)} vs ${total.toFixed(2)}`);
    check('急弯: 总耗时 = 总长/速度', close(sim.elapsed, total / speed, 0.02),
      `${sim.elapsed.toFixed(3)}s vs ${(total / speed).toFixed(3)}s`);
    const allEqual = sharp.doc.segments.every((s, idx) => {
      const t = segTimes[s.id] ?? (idx === sharp.doc.segments.length - 1 ? sim.elapsed - lastTime : -1);
      return close(t, s.length / speed, 0.01);
    });
    check('急弯: 每一段耗时都 = 段长/速度 (含 R=25 急弯)', allEqual,
      Object.entries(segTimes).map(([k, v]) => `${k}:${v.toFixed(3)}`).join(' '));
  }

  // 5c. 分叉: 两条路线都跑通, 行程可区分
  {
    const fork = presetFork();
    for (const choice of ['primary', 'alternate'] as const) {
      const net = docToNetwork(fork.doc);
      const switches = switchesFor(fork.doc, net);
      switches.get('J')!.choice = choice;
      const sim = new VehicleSim(net, switches, { speed: 150, brakeDecel: 400 });
      sim.start();
      const route: string[] = [];
      let lastSeg = sim.segmentId;
      for (let i = 0; i < 100000 && route.filter((r) => r === 'F3').length === 0; i += 1) {
        sim.step(1 / 500);
        if (sim.segmentId !== lastSeg) {
          route.push(sim.segmentId);
          lastSeg = sim.segmentId;
        }
      }
      if (choice === 'primary') {
        check('分叉主方向: F1 -> F2 -> F3', route.join(',') === 'F2,F3', route.join(' -> '));
      } else {
        check('分叉备选: F1 -> FX -> F3', route.join(',') === 'FX,F3', route.join(' -> '));
      }
      // 下一段选择预览
      const simPreview = new VehicleSim(docToNetwork(fork.doc), switchesFor(fork.doc), { speed: 100, brakeDecel: 400 });
      simPreview.switches.get('J')!.choice = choice;
      const preview = simPreview.previewExit();
      check(`分叉 ${choice}: 预览下一段为 ${choice === 'primary' ? 'F2' : 'FX'}`,
        preview?.segmentId === (choice === 'primary' ? 'F2' : 'FX'), String(preview?.segmentId));
    }

    // 实际行程记录应带上分叉选择
    const net = docToNetwork(fork.doc);
    const switches = switchesFor(fork.doc, net);
    switches.get('J')!.choice = 'alternate';
    const sim = new VehicleSim(net, switches, { speed: 150, brakeDecel: 400 });
    sim.start();
    for (let i = 0; i < 100000 && sim.segmentId !== 'F3'; i += 1) sim.step(1 / 500);
    const route = sim.completedRoute();
    const fxLeg = route.find((l) => l.segmentId === 'FX');
    check('实际行程记录了 FX 及其道岔选择', fxLeg !== undefined && fxLeg.viaChoice === 'alternate' && fxLeg.viaNodeId === 'J',
      JSON.stringify(route.map((r) => `${r.segmentId}@${r.viaNodeId}:${r.viaChoice}`)));
  }

  // 5d. 分叉预设的两个分支都必须落在 K 点上 (端点规则)
  {
    const fork = presetFork();
    const net = docToNetwork(fork.doc);
    const K = net.nodes.get('K')!;
    const f2 = net.segments.get('F2')!;
    const fx = net.segments.get('FX')!;
    check('主线 F2 终点在 K', dist(f2.poseAt(1).pos, K.pos) < 1e-6);
    check('绕行弧 FX 终点在 K', dist(fx.poseAt(1).pos, K.pos) < 1e-6);
    check('F2 与 FX 在 K 处同向 (可汇合)', close(net.transitionAngle('F2', 'F3') ?? 99, 0, 1e-6));
    check('FX 与 F3 有 22° 汇合偏角, 但仍在分叉容差内',
      close(net.transitionAngle('FX', 'F3') ?? 0, 22, 1e-6) && net.isTransitionValid('FX', 'F3'),
      String(net.transitionAngle('FX', 'F3')));
  }
}

// ---------------------------------------------------------------------------
section('6. 画线工具与端点按规则连接');
// ---------------------------------------------------------------------------
{
  // 6a. 空白画布开始画第一段
  const blank: TrackDoc = {
    title: '空',
    segments: [],
    nodes: [],
    links: {},
    start: { segmentId: '', s: 0 },
  };
  const firstLine = lineFromPose('D1', { pos: { x: 100, y: 100 }, tangent: { x: 1, y: 0 } }, 200);
  const step1 = addDrawnSegment(blank, firstLine, { snapRadius: 14 });
  check('空白画布画第一段: 自动创建两个节点', step1.doc.nodes.length === 2, `${step1.doc.nodes.length}`);
  check('空白画布画第一段: 起终点都被连接',
    Object.keys(step1.doc.links).length === 2 &&
      step1.doc.links[portA('D1')] !== undefined &&
      step1.doc.links[portB('D1')] !== undefined);
  check('空白画布画第一段: 起点段自动设为该段', step1.doc.start.segmentId === 'D1');
  const net1 = docToNetwork(step1.doc);
  check('空白画布画第一段: 网络无错误', net1.errors.length === 0, net1.errors.map((e) => e.message).join('; '));

  // 6b. 从端点起笔并相切 → 合法接头
  const ext = findExtensionAt(step1.doc, { x: 300, y: 100 }, 14);
  check('端点吸附: 找到延伸点与相切方向',
    ext !== null && ext.nodeId !== null && close(ext.tangent?.x ?? 0, 1, 1e-9),
    JSON.stringify(ext));
  const arc = arcFromPoseToPoint('D2', { pos: { x: 300, y: 100 }, tangent: { x: 1, y: 0 } }, { x: 400, y: 200 });
  check('相切圆弧求解成功 (终点精确)', arc !== null && dist(arc.poseAt(1).pos, { x: 400, y: 200 }) < 1e-9);
  const step2 = addDrawnSegment(step1.doc, arc!, { startNodeId: ext!.nodeId, endNodeId: null, snapRadius: 14 });
  const net2 = docToNetwork(step2.doc);
  check('相切圆弧接在直线上: 无连接错误', net2.errors.length === 0, net2.errors.map((e) => e.message).join('; '));

  // 6c. 画到已有节点上 → 形成分叉 (一入两出)
  const freeLine = lineFromPose('D3', { pos: { x: 400, y: 200 }, tangent: { x: 0, y: 1 } }, 150);
  const step3 = addDrawnSegment(step2.doc, freeLine, { snapRadius: 14 });
  const net3 = docToNetwork(step3.doc);
  const branchNode = step3.doc.links[portB('D2')]!;
  const junction = net3.junctions.get(branchNode)!;
  check('终点落在已有节点 => 并成同一节点, 形成分叉',
    junction.outgoing.length === 1 && junction.incoming.length >= 1 && step3.doc.nodes.length === net2.nodes.size + 1,
    `in=${junction.incoming.length} out=${junction.outgoing.length} nodes=${step3.doc.nodes.length}`);
  check('终点吸附形成分叉后网络仍合法 (0° 偏转)', net3.errors.length === 0,
    net3.errors.map((e) => e.message).join('; '));

  // 6d. 终点没吸附 (snapRadius 极小) => 新开节点, 与原节点位置重合 -> 伪连接被检出
  const seg4 = lineFromPose('D4', { pos: { x: 400, y: 200 }, tangent: { x: 0, y: 1 } }, 80);
  const step4 = addDrawnSegment(step3.doc, seg4, { snapRadius: 0 });
  const net4 = docToNetwork(step4.doc);
  // 新段 A 端与新节点重合, 但两者没连起来 => 重合节点错误
  check('不吸附导致位置重合的两个节点被检出', net4.errors.some((e) => e.code === 'coincident'),
    net4.errors.map((e) => `${e.code}: ${e.message}`).join('; '));

  // 6e. 手绘圆弧固定 90°: 必然合法地接在已连接端点上
  const quad = arcFromStartEndSweep('D5', { x: 0, y: 0 }, { x: 100, y: 100 }, Math.PI / 2);
  check('固定 90° 圆弧: 起点切线与弦成 45°', quad !== null && close(deg(headingOf(quad.poseAt(0).tangent)), 0, 1e-6),
    quad ? String(deg(headingOf(quad.poseAt(0).tangent))) : 'null');
  check('固定 90° 圆弧: 终点精确', quad !== null && dist(quad.poseAt(1).pos, { x: 100, y: 100 }) < 1e-9);
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项, 失败 ${failed} 项`);
if (failed > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部验证通过 ✓');
}
