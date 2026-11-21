/**
 * 无头验证脚本: 不依赖浏览器, 只用程序内生成的四个样例场景,
 * 检查「同时结算 / 延时步数 / 门可通行 / 反馈冲突 / 编辑后重置重放」.
 *
 * 运行: npm run verify
 */

import { cloneLevel, nodeById, resetLevelState, type Level, type Signal } from './model';
import {
  describeNode,
  findGateSccs,
  nodeSources,
  staticFeedbackLoops,
  tick,
  type TickReport,
} from './sim';
import { operationFromIntent, replayOperations, type Operation } from './ops';
import { buildScenario, SCENARIOS } from './scenarios';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function expect(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

function valueOf(level: Level, id: string): Signal {
  return nodeById(level, id)?.value ?? 'off';
}

function run(
  level: Level,
  ticks: Array<{ toggles?: string[]; move?: 'up' | 'down' | 'left' | 'right' | null }>,
): { level: Level; reports: TickReport[] } {
  let current = level;
  const reports: TickReport[] = [];
  for (const input of ticks) {
    const result = tick(current, { toggleSwitchIds: input.toggles ?? [], move: input.move ?? null });
    current = result.level;
    reports.push(result.report);
  }
  return { level: current, reports };
}

function flag(pass: boolean): string {
  return pass ? '✅' : '❌';
}

// ---------- 1. 跨步反馈: 2 步延时 + 压力板 → 门 ----------
{
  const scenario = buildScenario('cross-step');
  const out = run(scenario, [
    { toggles: ['sw-a'], move: 'right' },
    {},
    {},
    {},
    {},
  ]);
  const openedAt = out.reports.map((report) => report.doors[0]?.openedAt ?? null);
  const passable = out.reports.map((report) => report.doors[0]?.passable ?? false);
  const expectedOpenStep = 3; // 第 1 步采样, 第 3 步输出 (2 步队列)
  expect(
    'cross-step · 门在第 3 步打开并保持',
    passable[0] === false && passable[expectedOpenStep - 1] === true && passable[3] === true,
    `逐步骤: passable=${passable.join('/')} openedAt=${openedAt.join('/')}`,
  );
  expect(
    'cross-step · 达到打开的步数 = 延时步数 + 1',
    openedAt[expectedOpenStep - 1] === expectedOpenStep,
    `openedAt=${openedAt[expectedOpenStep - 1]} (期望 ${expectedOpenStep})`,
  );
  const delays = out.reports.map((report) => report.delays[0]);
  expect(
    'cross-step · 延时队列每步只前进一格',
    delays.map((delay) => (delay?.value === 'on' ? 1 : 0)).join('') === '00111',
    `输出序列=${delays.map((delay) => (delay?.value === 'on' ? '1' : '0')).join('')}`,
  );
  const gateSources = describeNode(out.level, 'gt-and')?.inputs.map((input) => input.nodeName) ?? [];
  expect(
    'cross-step · 每个门输入都能追溯到来源',
    gateSources.join('') === '2 步延时压力板',
    `来源=${gateSources.join(', ')}`,
  );
  const plateContact = out.reports[0]?.contacts.find((change) => change.nodeId === 'pl-1');
  expect(
    'cross-step · 压力板接触值在移动当步生效',
    plateContact?.to === 'on',
    `第 1 步联系人=${plateContact ? `${plateContact.from}→${plateContact.to}` : '无'}`,
  );
}

// ---------- 2. 双输入门: 同时翻转 ----------
{
  const scenario = buildScenario('dual-gate');
  const first = tick(scenario, { toggleSwitchIds: ['sw-b', 'sw-a'], move: null });
  const second = tick(first.level, { toggleSwitchIds: ['sw-a'], move: null });
  expect(
    'dual-gate · 同一结算时刻翻转两开关 (顺序无关)',
    first.report.toggles.map((toggle) => toggle.nodeId).join('') === 'sw-asw-b',
    `toggles=${first.report.toggles.map((toggle) => toggle.nodeId).join(',')}`,
  );
  expect(
    'dual-gate · A=B=ON → XOR=OFF',
    valueOf(first.level, 'gt-xor') === 'off',
    `XOR=${valueOf(first.level, 'gt-xor')}`,
  );
  expect(
    'dual-gate · A=B=ON → NAND=OFF, 之后只关 A → XOR 变 ON',
    valueOf(first.level, 'gt-nand') === 'off' && valueOf(second.level, 'gt-xor') === 'on',
    `NAND=${valueOf(first.level, 'gt-nand')} XOR(次步)=${valueOf(second.level, 'gt-xor')}`,
  );
  const sources = nodeSources(scenario, nodeById(scenario, 'gt-xor')!);
  expect(
    'dual-gate · 门有两个明确来源, 各占一个输入口',
    sources.length === 2 && sources[0]?.edgeId === 'e-a-xor0' && sources[1]?.edgeId === 'e-b-xor1',
    `A=${sources[0]?.edgeId} B=${sources[1]?.edgeId}`,
  );
}

// ---------- 3. 两输入步进: 开关 + 压力板同一步 ----------
{
  const scenario = buildScenario('two-input');
  const out = run(scenario, [{ toggles: ['sw-a'], move: 'right' }, { move: 'down' }]);
  const pressed = out.reports[0];
  expect(
    'two-input · 踩板与拨开关在同一结算时刻',
    pressed?.contacts[0]?.to === 'on' && pressed?.toggles[0]?.to === 'on',
    `contact=${pressed?.contacts[0]?.to} toggle=${pressed?.toggles[0]?.to}`,
  );
  expect(
    'two-input · AND 门与门/灯同步结算',
    pressed?.deltas.some((delta) => delta.nodeId === 'gt-and' && delta.to === 'on') === true &&
      pressed?.doors[0]?.passable === true,
    `门可通行=${pressed?.doors[0]?.passable}`,
  );
}

// ---------- 4. 无延时反馈: 稳定 / 冲突 ----------
{
  const scenario = buildScenario('feedback-latch');
  const preview = staticFeedbackLoops(scenario);
  expect(
    'feedback · 暂停时静态预检只报告环, 不写运行态',
    preview.length === 2 && preview.every((loop) => loop.history.length === 0),
    `环=${preview.map((loop) => loop.id).join(', ')}`,
  );
  const cycles = findGateSccs(scenario).filter((scc) => scc.cyclic).length;
  expect('feedback · SCC 识别 2 个反馈环', cycles === 2, `cyclic SCC=${cycles}`);

  const latchStep = tick(scenario, { toggleSwitchIds: ['sw-a'], move: null });
  const latchFeedback = latchStep.report.feedbacks.find((feedback) => feedback.nodes.includes('gt-latch'));
  expect(
    'feedback · OR 自锁 1 轮收敛为 ON',
    latchFeedback?.stable === true && latchFeedback?.conflict === false && valueOf(latchStep.level, 'gt-latch') === 'on',
    `iterations=${latchFeedback?.iterations} value=${valueOf(latchStep.level, 'gt-latch')}`,
  );

  const conflictStep = run(latchStep.level, [{ toggles: ['sw-b'] }, {}]);
  const conflict = conflictStep.reports[1]?.feedbacks.find((feedback) => feedback.nodes.includes('gt-conf-a'));
  expect(
    'feedback · NAND 环报冲突并冻结环内节点',
    conflict?.conflict === true &&
      conflict?.stable === false &&
      valueOf(conflictStep.level, 'gt-conf-a') === valueOf(latchStep.level, 'gt-conf-a'),
    `conflict=${conflict?.conflict} iterations=${conflict?.iterations} 值保持=${
      valueOf(conflictStep.level, 'gt-conf-a') === valueOf(latchStep.level, 'gt-conf-a')
    }`,
  );
}

// ---------- 5. 编辑接线 → 重置 → 重放 ----------
{
  const base = buildScenario('dual-gate');
  const operations: Operation[] = [
    operationFromIntent(base, { toggles: ['sw-a'], move: null }, 'step-1'),
    operationFromIntent(base, { toggles: ['sw-b'], move: null }, 'step-2'),
    operationFromIntent(base, { toggles: [], move: null }, 'step-3'),
  ];
  const live = replayOperations(base, operations);
  expect(
    'replay · 基线运行 3 步得到可复现结果',
    live.level.step === 3 && live.reports.length === 3,
    `step=${live.level.step} reports=${live.reports.length}`,
  );

  const editedBase = cloneLevel(base);
  editedBase.edges = editedBase.edges
    .filter((edge) => edge.id !== 'e-b-xor1')
    .concat({ id: 'e-nand-to-xor-b', from: 'gt-nand', to: 'gt-xor', toPort: 1 });
  const reset = resetLevelState(editedBase);
  expect(
    'replay · 编辑接线后运行态回到第 0 步',
    reset.step === 0 && reset.character.x === base.home.x && reset.character.y === base.home.y,
    `step=${reset.step} character=(${reset.character.x},${reset.character.y})`,
  );

  const replayed = replayOperations(reset, operations);
  const replayedAgain = replayOperations(reset, operations);
  expect(
    'replay · 保存的操作可重放且确定',
    replayed.level.step === 3 && JSON.stringify(replayed.level) === JSON.stringify(replayedAgain.level),
    `step=${replayed.level.step} 两次结果一致=${JSON.stringify(replayed.level) === JSON.stringify(replayedAgain.level)}`,
  );
  const newSource = nodeSources(replayed.level, nodeById(replayed.level, 'gt-xor')!)[1];
  expect(
    'replay · 重放沿用新接线',
    newSource?.nodeId === 'gt-nand',
    `XOR IN B ← ${newSource?.nodeId}`,
  );
  const unpausedBefore = replayOperations(reset, operations, 1);
  expect(
    'replay · 游标推进可逐步回看',
    unpausedBefore.level.step === 1 && unpausedBefore.reports.length === 1,
    `cursor=${unpausedBefore.cursor} step=${unpausedBefore.level.step}`,
  );
}

// ---------- 6. 暂停无隐式变化 ----------
{
  const scenario = buildScenario('cross-step');
  const before = cloneLevel(scenario);
  const frozen = cloneLevel(scenario);
  staticFeedbackLoops(scenario);
  nodeSources(scenario, nodeById(scenario, 'gt-and')!);
  expect(
    'pause · 只读查询不改变任何运行态',
    JSON.stringify(before) === JSON.stringify(scenario) && JSON.stringify(frozen) === JSON.stringify(scenario),
    '克隆/查询前后状态一致',
  );
  const once = tick(scenario, { toggleSwitchIds: ['sw-a'], move: null });
  expect(
    'pause · 只有显式 tick 才推进延时队列',
    once.report.delays[0]?.queue.length === 1 && once.report.delays[0]?.value === 'off',
    `queue=${once.report.delays[0]?.queue.join('/')} out=${once.report.delays[0]?.value}`,
  );
}

// ---------- 输出 ----------
const failed = checks.filter((check) => !check.pass);
console.log('\n信号结算台 · 无头验证');
console.log(`样例场景: ${SCENARIOS.map((scenario) => `${scenario.title.split(':')[0]} (${scenario.id})`).join(' · ')}`);
console.log('─'.repeat(78));
for (const check of checks) {
  console.log(`${flag(check.pass)} ${check.name}`);
  console.log(`   ${check.detail}`);
}
console.log('─'.repeat(78));
console.log(`${checks.length - failed.length}/${checks.length} 项通过${failed.length ? `, ${failed.length} 项失败` : ''}`);
if (failed.length > 0) {
  process.exitCode = 1;
  for (const check of failed) console.log(`  ✗ ${check.name}`);
}
