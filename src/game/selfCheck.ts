import {
  createInitialFrame,
  defaultSetup,
  fingerprintResult,
  simulateLevel,
  stepSimulation,
  validateLevelDefinition,
} from './engine';
import { levelOne, levelTwo, levels } from './levels';
import type { LevelDef, SetupState } from './types';

export interface SelfCheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export const dualSwitchFixture: LevelDef = {
  id: 'dual-switch-fixture',
  name: '同拍双开关校验夹具',
  subtitle: '',
  brief: [],
  width: 400,
  height: 300,
  nodes: {
    a: { id: 'a', x: 80, y: 80 },
    b: { id: 'b', x: 320, y: 80 },
    na: { id: 'na', x: 80, y: 180 },
    nb: { id: 'nb', x: 320, y: 180 },
    d: { id: 'd', x: 200, y: 220 },
    outL: { id: 'outL', x: 120, y: 280, kind: 'exit', bin: 'L' },
    outR: { id: 'outR', x: 280, y: 280, kind: 'exit', bin: 'R' },
  },
  chutes: [
    {
      id: 'A',
      entry: 'a',
      outputs: { left: 'na', right: 'na' },
      initial: 'left',
      trigger: { id: 'SW-A', toggles: ['D'] },
    },
    {
      id: 'B',
      entry: 'b',
      outputs: { left: 'nb', right: 'nb' },
      initial: 'left',
      trigger: { id: 'SW-B', toggles: ['D'] },
    },
    { id: 'D', entry: 'd', outputs: { left: 'outL', right: 'outR' }, initial: 'left' },
  ],
  slots: [
    { id: 'SA', node: 'a', releaseTick: 0, color: 'red' },
    { id: 'SB', node: 'b', releaseTick: 0, color: 'blue' },
  ],
  priority: { kind: 'color-rank', rank: ['red', 'blue'], label: '红珠优先' },
  goal: [],
  maxTicks: 2,
};

function solutionFor(levelId: string): SetupState {
  if (levelId === levelOne.id) {
    const setup = defaultSetup(levelOne);
    setup.tilts = { A: 'right', B: 'left', C: 'left', D: 'left' };
    return setup;
  }
  const setup = defaultSetup(levelTwo);
  setup.tilts.R1 = 'left';
  setup.tilts.D = 'left';
  return setup;
}

export function runSelfChecks(): SelfCheckItem[] {
  const items: SelfCheckItem[] = [];

  for (const level of levels) {
    const problems = validateLevelDefinition(level);
    items.push({
      name: `关卡结构：${level.name}`,
      ok: problems.length === 0,
      detail: problems.length ? problems.join('；') : '所有节点、槽口和开关引用均存在。',
    });
  }

  for (const level of levels) {
    const setup = solutionFor(level.id);
    const result = simulateLevel(level, setup);
    items.push({
      name: `手算解可通关：${level.name}`,
      ok: result.won,
      detail: result.won
        ? `到达顺序 ${result.final.arrivals.map((a) => `${a.color}→${a.bin}`).join('，')}`
        : result.final.failure?.message ?? '未知失败',
    });
  }

  const waitingSetup = solutionFor(levelTwo.id);
  const fingerprints = Array.from({ length: 100 }, () =>
    fingerprintResult(simulateLevel(levelTwo, waitingSetup)),
  );
  const allSame = fingerprints.every((f) => f === fingerprints[0]);
  items.push({
    name: '同一摆放重复放珠 100 次',
    ok: allSame,
    detail: allSame ? '100 次完整帧、竞争、开关和到达记录指纹完全一致。' : '检测到非确定性结果。',
  });

  const waitingResult = simulateLevel(levelTwo, waitingSetup);
  const conflict = waitingResult.frames.find((f) => f.trace?.conflicts.some((c) => c.node === 'm'));
  const conflictTrace = conflict?.trace?.conflicts[0];
  items.push({
    name: '等待确实来自同格竞争',
    ok: conflictTrace?.winnerId === 'bead:SB',
    detail: conflict
      ? `M 格竞争胜方为 ${conflictTrace?.winnerId ?? '未找到'}；输家 block=lost-priority，随后 occupied 链允许前珠离开、后珠补入。`
      : '没有找到 M 格竞争记录。',
  });

  const shortcut = defaultSetup(levelTwo);
  shortcut.tilts.R1 = 'right';
  const shortcutResult = simulateLevel(levelTwo, shortcut);
  items.push({
    name: '不等待的近路会被判定为顺序错误',
    ok: !shortcutResult.won && shortcutResult.final.failure?.code === 'wrong-arrival',
    detail: shortcutResult.final.failure?.message ?? '近路竟然通关。',
  });

  const paritySetup = solutionFor(levelOne.id);
  const parityResult = simulateLevel(levelOne, paritySetup);
  const builtInDual = parityResult.frames
    .flatMap((f) => f.trace?.switchResolutions ?? [])
    .find((r) => r.sources.length === 2 && r.targetChuteId === 'D');
  items.push({
    name: '第一关内置同拍双开关来源',
    ok:
      builtInDual?.netToggles === 2 &&
      !builtInDual.changed &&
      builtInDual.sources.map((s) => s.switchId).join(',') === 'SW-A,SW-D',
    detail: builtInDual
      ? `D 槽保持 ${builtInDual.to}；来源为 SW-A 与 SW-D，记录可定位到珠和源槽。`
      : '第一关没有找到双来源开关结算。',
  });

  const dualSetup: SetupState = {
    tilts: { A: 'left', B: 'left', D: 'left' },
    colors: { SA: 'red', SB: 'blue' },
  };
  const dualFrame = stepSimulation(
    dualSwitchFixture,
    createInitialFrame(dualSwitchFixture, dualSetup),
  );
  const resolution = dualFrame.trace?.switchResolutions.find((r) => r.targetChuteId === 'D');
  const dualOk =
    resolution?.netToggles === 2 &&
    !resolution.changed &&
    resolution.sources.map((s) => s.switchId).join(',') === 'SW-A,SW-B';
  items.push({
    name: '同拍两个开关影响同一槽',
    ok: Boolean(dualOk),
    detail: dualOk
      ? 'SW-A、SW-B 均由真正经过的珠触发；来源按 ID 记录，两次 toggle 偶数抵消，D 保持左。'
      : `记录异常：${JSON.stringify(resolution)}`,
  });

  return items;
}
