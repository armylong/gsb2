import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainMix } from '../src/engine/colors.js';
import { computeTrace, movePanel, simulateTurn } from '../src/engine/engine.js';
import { SCENARIOS } from '../src/engine/scenarios.js';
import { Board, ColorCode, COLOR_NONE, PRIMARY, TurnReport } from '../src/engine/types.js';

/** 从初始棋盘连续执行 n 轮，返回每轮报告 */
function runRounds(board: Board, n: number): TurnReport[] {
  const reports: TurnReport[] = [];
  let current = board;
  for (let i = 1; i <= n; i += 1) {
    const report = simulateTurn(current, i);
    reports.push(report);
    current = report.board;
  }
  return reports;
}

function detailOf(report: TurnReport, flowerId: string) {
  const detail = report.details.find((d) => d.flowerId === flowerId);
  assert.ok(detail, `应存在花朵 ${flowerId} 的结算明细`);
  return detail;
}

function findFlower(board: Board, id: string) {
  const flower = board.flowers.find((f) => f.id === id);
  assert.ok(flower);
  return flower;
}

test('关卡 1：初始挡板拦截，第一轮没有任何花粉送达', () => {
  const board = structuredClone(SCENARIOS[0]!.board);
  const report = simulateTurn(board, 1);
  assert.equal(report.traces.find((t) => t.windId === 'w1')!.delivered, false);
  const mid = detailOf(report, 'fM');
  assert.equal(mid.incomingColor, COLOR_NONE);
  assert.equal(mid.afterColor, COLOR_NONE);
  assert.equal(mid.afterProgress, 0);
});

test('关卡 1：移开挡板后中间花先变红（3 轮），边缘花第 6 轮再变红', () => {
  const board = structuredClone(SCENARIOS[0]!.board);
  const opened = movePanel(board, 'p1', { x: 0, y: 4 });
  const reports = runRounds(opened, 6);

  const r1 = detailOf(reports[0]!, 'fM');
  assert.equal(r1.incomingColor, PRIMARY.R);
  assert.equal(r1.afterProgress, 1);
  assert.equal(r1.afterColor, COLOR_NONE, '第 1 轮不能直接跳到红色');

  assert.equal(detailOf(reports[1]!, 'fM').afterProgress, 2);
  const r3 = detailOf(reports[2]!, 'fM');
  assert.equal(r3.afterColor, PRIMARY.R, '第 3 轮才允许稳定为红色');
  assert.equal(r3.afterProgress, 0, '稳定后积累槽清空');
  assert.equal(r3.stabilized, true);

  // 中间花变红前，边缘花收不到任何东西
  assert.equal(detailOf(reports[0]!, 'fE').incomingColor, COLOR_NONE);
  assert.equal(detailOf(reports[1]!, 'fE').incomingColor, COLOR_NONE);
  assert.equal(detailOf(reports[2]!, 'fE').incomingColor, COLOR_NONE);

  // 第 4 轮起，已变红的中间花沿对角风把红花粉接力给边缘花
  assert.equal(detailOf(reports[3]!, 'fE').incomingColor, PRIMARY.R);
  const r6 = detailOf(reports[5]!, 'fE');
  assert.equal(r6.afterColor, PRIMARY.R);
  assert.equal(r6.stabilized, true);

  const check = SCENARIOS[0]!.check(reports);
  assert.equal(check.complete, true, check.message);
});

test('空一轮：积累进度保留并衰减 1，不会清零也不会跳到目标色', () => {
  const board = structuredClone(SCENARIOS[0]!.board);
  const opened = movePanel(board, 'p1', { x: 0, y: 4 });

  let report = simulateTurn(opened, 1); // fM 进度 1
  assert.equal(detailOf(report, 'fM').afterProgress, 1);

  const blocked = movePanel(report.board, 'p1', { x: 2, y: 1 });
  report = simulateTurn(blocked, 2); // 空一轮：1 -> 0
  const mid = detailOf(report, 'fM');
  assert.equal(mid.afterProgress, 0);
  assert.equal(mid.afterPendingColor, COLOR_NONE);
  assert.equal(mid.afterColor, COLOR_NONE, '仍然不能变成红色');

  // 再试“积累 2 轮后空一轮”：2 -> 1，进度可见地保留
  let reopened = movePanel(report.board, 'p1', { x: 0, y: 4 });
  report = simulateTurn(reopened, 3);
  assert.equal(detailOf(report, 'fM').afterProgress, 1);
  report = simulateTurn(report.board, 4);
  assert.equal(detailOf(report, 'fM').afterProgress, 2);
  const reblocked = movePanel(report.board, 'p1', { x: 2, y: 1 });
  report = simulateTurn(reblocked, 5);
  assert.equal(detailOf(report, 'fM').afterProgress, 1, '空一轮应从 2 衰减到 1');
  assert.equal(detailOf(report, 'fM').afterColor, COLOR_NONE);
});

test('换了颜色：旧进度作废，从新颜色第 1 轮重新积累', () => {
  const board: Board = {
    width: 5,
    height: 3,
    flowers: [
      { id: 'src', x: 0, y: 0, color: PRIMARY.R, pendingColor: 0, progress: 0 },
      { id: 'dst', x: 1, y: 0, color: 0, pendingColor: 0, progress: 0 },
    ],
    winds: [{ id: 'w', from: { x: 0, y: 0 }, dir: 'E', kind: 'breeze' }],
    panels: [],
  };
  let report = simulateTurn(board, 1);
  assert.equal(detailOf(report, 'dst').afterPendingColor, PRIMARY.R);
  assert.equal(detailOf(report, 'dst').afterProgress, 1);

  // 来源改为黄色
  const yellowBoard = structuredClone(report.board);
  findFlower(yellowBoard, 'src').color = PRIMARY.Y;
  report = simulateTurn(yellowBoard, 2);
  const dst = detailOf(report, 'dst');
  assert.equal(dst.afterPendingColor, PRIMARY.Y);
  assert.equal(dst.afterProgress, 1, '颜色改变后进度必须重置为 1');
  assert.equal(dst.afterColor, COLOR_NONE);
});

test('关卡 2：两路花粉同轮到达，按位混色为橙且与风的遍历顺序无关', () => {
  const board = structuredClone(SCENARIOS[1]!.board);
  const report = simulateTurn(board, 1);
  const target = detailOf(report, 'fT');
  const orange: ColorCode = PRIMARY.R | PRIMARY.Y;

  assert.equal(target.arrivals.length, 2);
  assert.equal(target.incomingColor, orange);
  assert.deepEqual(
    target.arrivals.map((a) => a.sourceFlowerId),
    ['fR', 'fY'],
    '来源按来源花 id 排序',
  );
  assert.equal(explainMix(target.arrivals.map((a) => a.sourceColor), target.incomingColor), '红 + 黄 → 橙');

  // 打乱 winds 顺序后重算，结果必须完全一致
  const shuffled = structuredClone(board);
  shuffled.winds.reverse();
  const shuffledReport = simulateTurn(shuffled, 1);
  const shuffledTarget = detailOf(shuffledReport, 'fT');
  assert.equal(shuffledTarget.incomingColor, target.incomingColor);
  assert.deepEqual(
    shuffledTarget.arrivals.map((a) => a.sourceFlowerId),
    target.arrivals.map((a) => a.sourceFlowerId),
  );
  assert.deepEqual(shuffledTarget, target);

  // 连续 3 轮后稳定为橙
  const reports = runRounds(board, 3);
  const r3 = detailOf(reports[2]!, 'fT');
  assert.equal(r3.afterColor, orange);
  assert.equal(r3.stabilized, true);
  assert.equal(SCENARIOS[1]!.check(reports).complete, true);
});

test('关卡 2：挡板移到任意一路中间格，只保留另一路来源', () => {
  const board = structuredClone(SCENARIOS[1]!.board);

  const blockRed = movePanel(board, 'p1', { x: 3, y: 1 });
  const redReport = simulateTurn(blockRed, 1);
  const redDetail = detailOf(redReport, 'fT');
  assert.equal(redDetail.arrivals.length, 1);
  assert.equal(redDetail.arrivals[0]!.sourceFlowerId, 'fY');
  assert.equal(redDetail.incomingColor, PRIMARY.Y);
  const redTrace = redReport.traces.find((t) => t.windId === 'wR')!;
  assert.equal(redTrace.delivered, false);
  assert.equal(redTrace.steps.at(-1)!.blocked, true);

  const blockYellow = movePanel(board, 'p1', { x: 3, y: 3 });
  const yellowReport = simulateTurn(blockYellow, 1);
  assert.equal(detailOf(yellowReport, 'fT').incomingColor, PRIMARY.R);
});

test('重跑确定性：同一关卡从同一状态跑两次，逐轮 JSON 完全相同', () => {
  for (const scenario of SCENARIOS) {
    const first = runRounds(structuredClone(scenario.board), scenario.expectedRounds);
    const second = runRounds(structuredClone(scenario.board), scenario.expectedRounds);
    assert.deepEqual(
      first.map((r) => ({ ...r, board: undefined })),
      second.map((r) => ({ ...r, board: undefined })),
      `${scenario.id} 的报告应可复现`,
    );
  }
});

test('computeTrace：边界截断与挡板拦截都逐格生效', () => {
  const board = structuredClone(SCENARIOS[1]!.board);
  const wind = board.winds.find((w) => w.id === 'wR')!;
  const trace = computeTrace(board, wind);
  assert.deepEqual(
    trace.map((s) => [s.x, s.y]),
    [
      [3, 1],
      [4, 2],
    ],
  );

  const blocked = movePanel(board, 'p1', { x: 3, y: 1 });
  const blockedTrace = computeTrace(blocked, wind);
  assert.equal(blockedTrace.length, 1);
  assert.equal(blockedTrace[0]!.blocked, true);
});

test('不能把挡风板放到花上或另一块挡板上', () => {
  const board = structuredClone(SCENARIOS[0]!.board);
  assert.throws(() => movePanel(board, 'p1', { x: 1, y: 1 }), /不能放置/);
  assert.throws(() => movePanel(board, 'p1', { x: 2, y: 1 }), /不能放置/);
});
