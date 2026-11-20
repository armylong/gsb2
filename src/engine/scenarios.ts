import { collectEvents, collectTransitions, collectWindows, describeLogEntry } from './log-format';
import { AnimationMachine } from './machine';
import type { LogEntry, MachineConfig, MachineInputs, MachineSnapshot } from './types';

export interface ScenarioAction {
  /** 当时钟到达该时刻(含)后的第一个更新周期开始前施加 */
  atMs: number;
  kind: 'hurt' | 'speed' | 'attack' | 'clear-attacks';
  value?: boolean | number;
}

export interface ScenarioCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioTick {
  tick: number;
  clockMs: number;
  stateId: string;
  elapsedMs: number;
  loopIndex: number;
  windowOpen: boolean;
  pendingAttacks: number;
  lastTransitionId: string | null;
  transitionCountThisTick: number;
}

export interface ScenarioReport {
  id: string;
  name: string;
  description: string;
  ticks: ScenarioTick[];
  log: readonly LogEntry[];
  lines: string[];
  finalSnapshot: MachineSnapshot;
  checks: ScenarioCheck[];
  passed: boolean;
}

export interface ScenarioSpec {
  id: string;
  name: string;
  description: string;
  stateId: string;
  inputs: MachineInputs;
  dtMs: number;
  steps: number;
  actions: ScenarioAction[];
  checks: (context: {
    log: readonly LogEntry[];
    final: MachineSnapshot;
    ticks: ScenarioTick[];
    config: MachineConfig;
  }) => ScenarioCheck[];
  /** 额外跑一遍验证确定性 */
  deterministic?: boolean;
}

function check(label: string, pass: boolean, detail: string): ScenarioCheck {
  return { label, pass, detail };
}

function eventsOf(log: readonly LogEntry[], eventId: string) {
  return collectEvents(log).filter((e) => e.eventId === eventId);
}

function transitionsBetween(log: readonly LogEntry[], from: string, to: string) {
  return collectTransitions(log).filter((t) => t.from === from && t.to === to);
}

/** 每个更新周期最多切换一次: 按日志中的 tick 分组统计过渡条数。 */
export function maxTransitionsPerTick(log: readonly LogEntry[]): number {
  const counts = new Map<number, number>();
  for (const entry of collectTransitions(log)) {
    counts.set(entry.tick, (counts.get(entry.tick) ?? 0) + 1);
  }
  return counts.size === 0 ? 0 : Math.max(...counts.values());
}

export function runScenario(spec: ScenarioSpec, config: MachineConfig): ScenarioReport {
  const machine = new AnimationMachine(config, {
    initialStateId: spec.stateId,
    initialInputs: spec.inputs,
  });
  const fired = new Set<number>();
  const ticks: ScenarioTick[] = [];
  const transitionsByTick = new Map<number, number>();

  const applyActions = () => {
    spec.actions.forEach((action, index) => {
      if (fired.has(index)) return;
      if (machine.getSnapshot().clockMs + 1e-9 < action.atMs) return;
      fired.add(index);
      switch (action.kind) {
        case 'hurt':
          machine.setHurt(Boolean(action.value));
          break;
        case 'speed':
          machine.setSpeed(Number(action.value));
          break;
        case 'attack':
          machine.queueAttack(Number(action.value ?? 1));
          break;
        case 'clear-attacks':
          machine.clearAttacks();
          break;
      }
    });
  };

  for (let i = 0; i < spec.steps; i += 1) {
    applyActions();
    const before = machine.log.length;
    machine.update(spec.dtMs);
    const tick = machine.getSnapshot().tick;
    let newTransitions = 0;
    for (let j = before; j < machine.log.length; j += 1) {
      if (machine.log[j].type === 'transition') newTransitions += 1;
    }
    transitionsByTick.set(tick, newTransitions);
    const snap = machine.getSnapshot();
    ticks.push({
      tick,
      clockMs: snap.clockMs,
      stateId: snap.stateId,
      elapsedMs: snap.elapsedMs,
      loopIndex: snap.loopIndex,
      windowOpen: snap.attackWindowOpen,
      pendingAttacks: snap.pendingAttacks,
      lastTransitionId: snap.lastTransitionId,
      transitionCountThisTick: newTransitions,
    });
  }

  const final = machine.getSnapshot();
  const checks = spec.checks({ log: final.log, final, ticks, config });
  const perTick = maxTransitionsPerTick(final.log);
  checks.push(
    check(
      '每个更新周期最多切换一次状态',
      perTick <= 1,
      `单周期最多过渡 ${perTick} 条`,
    ),
  );
  if (spec.deterministic !== false) {
    const again = new AnimationMachine(config, {
      initialStateId: spec.stateId,
      initialInputs: spec.inputs,
    });
    const rerunLines = runScripted(again, spec);
    checks.push(
      check(
        '从确定初态重跑得到逐条一致的记录',
        rerunLines === final.log.map((entry) => describeLogEntry(entry, config)).join('\n'),
        `${final.log.length} 条日志重跑比对`,
      ),
    );
  }

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    ticks,
    log: final.log,
    lines: final.log.map((entry) => describeLogEntry(entry, config)),
    finalSnapshot: final,
    checks,
    passed: checks.every((c) => c.pass),
  };
}

function runScripted(machine: AnimationMachine, spec: ScenarioSpec): string {
  const fired = new Set<number>();
  for (let i = 0; i < spec.steps; i += 1) {
    spec.actions.forEach((action, index) => {
      if (fired.has(index)) return;
      if (machine.getSnapshot().clockMs + 1e-9 < action.atMs) return;
      fired.add(index);
      switch (action.kind) {
        case 'hurt':
          machine.setHurt(Boolean(action.value));
          break;
        case 'speed':
          machine.setSpeed(Number(action.value));
          break;
        case 'attack':
          machine.queueAttack(Number(action.value ?? 1));
          break;
        case 'clear-attacks':
          machine.clearAttacks();
          break;
      }
    });
    machine.update(spec.dtMs);
  }
  const config = machine.configRef;
  return machine.log.map((entry) => describeLogEntry(entry, config)).join('\n');
}

const DEMO_SCENARIOS: ScenarioSpec[] = [
  {
    id: 'attack-interrupted',
    name: '攻击被受击打断',
    description:
      '攻击在 240ms 开启窗口, 300ms 时进入受击。受击过渡优先级(100)高于自然退出(20), 应中断攻击、强制关闭窗口, 且窗口关/收势事件不再发生。800ms 再次攻击以验证从零计时。',
    stateId: 'attack',
    inputs: { speed: 0, hurt: false, pendingAttacks: 0 },
    dtMs: 50,
    steps: 32,
    actions: [
      { atMs: 300, kind: 'hurt', value: true },
      { atMs: 700, kind: 'hurt', value: false },
      { atMs: 800, kind: 'attack', value: 1 },
      { atMs: 1100, kind: 'hurt', value: true },
      { atMs: 1500, kind: 'hurt', value: false },
    ],
    checks: ({ log }) => {
      const interrupts = transitionsBetween(log, 'attack', 'hurt');
      const windows = collectWindows(log);
      const forcedCloses = windows.filter(
        (w) => w.action === 'close' && w.reason === 'state-exit',
      );
      const opens = windows.filter((w) => w.action === 'open');
      const attackClose = eventsOf(log, 'attack-window-close');
      const attackRecover = eventsOf(log, 'attack-recover');
      const firstInterrupt = interrupts[0];
      const reentry = collectTransitions(log).find(
        (t) => t.transitionId === 'idle-to-attack',
      );
      const attackEnters = log.filter(
        (e) => e.type === 'state-enter' && e.stateId === 'attack',
      );
      return [
        check(
          '两次攻击都被受击过渡打断',
          interrupts.length === 2,
          `attack → hurt 过渡 ${interrupts.length} 次: [${interrupts
            .map((t) => `${t.atMs}ms`)
            .join(', ')}]`,
        ),
        check(
          '第一次中断发生在 300ms',
          firstInterrupt?.atMs === 300,
          `实际 ${firstInterrupt?.atMs}ms`,
        ),
        check(
          '受击过渡优先级 100 高于攻击自然退出 20',
          firstInterrupt?.priority === 100,
          `实际优先级 ${firstInterrupt?.priority}`,
        ),
        check(
          '开窗 2 次, 切出攻击时各强制关闭 1 次',
          forcedCloses.length === 2 && opens.length === 2,
          `开窗 ${opens.length} 次, 切出关闭 ${forcedCloses.length} 次`,
        ),
        check(
          '被打断的攻击后续窗口关事件不再发生',
          attackClose.length === 0,
          `attack-window-close 触发 ${attackClose.length} 次`,
        ),
        check(
          '被打断的攻击收势事件不再发生',
          attackRecover.length === 0,
          `attack-recover 触发 ${attackRecover.length} 次`,
        ),
        check(
          '中断记录列出被跳过的事件',
          (() => {
            const interrupt = log.find((e) => e.type === 'interrupt');
            return (
              interrupt?.type === 'interrupt' &&
              interrupt.skippedEventIds.includes('attack-window-close') &&
              interrupt.skippedEventIds.includes('attack-recover') &&
              interrupt.forcedWindowClose
            );
          })(),
          JSON.stringify(
            log.filter((e) => e.type === 'interrupt').map((e) => e.skippedEventIds),
          ),
        ),
        check(
          '重新进入攻击从 0 计时 (弓步 800+140=940ms)',
          attackEnters.length === 2 &&
            reentry?.atMs === 800 &&
            eventsOf(log, 'attack-lunge').map((e) => e.atMs).join(',') === '140,940',
          `攻击进入 ${attackEnters.length} 次, 弓步事件 ${eventsOf(log, 'attack-lunge')
            .map((e) => e.atMs)
            .join(', ')}ms`,
        ),
        check(
          '排队攻击只在被采用的过渡中消耗',
          reentry !== undefined && reentry.consumedAttack === true,
          `idle → attack 消耗=${reentry?.consumedAttack}`,
        ),
      ];
    },
  },
  {
    id: 'wait-progress',
    name: '等待退出时间',
    description:
      '攻击的自然退出要求到达 80% 进度(576ms)。一次 1000ms 的大步推进应恰在 576ms 切换, 576ms 之后的收势事件不再发生, 剩余 424ms 交给待机。',
    stateId: 'attack',
    inputs: { speed: 0, hurt: false, pendingAttacks: 0 },
    dtMs: 1000,
    steps: 1,
    actions: [],
    checks: ({ log, final }) => {
      const transition = collectTransitions(log).find(
        (t) => t.transitionId === 'attack-to-idle',
      );
      const closeEvent = eventsOf(log, 'attack-window-close');
      const recoverEvent = eventsOf(log, 'attack-recover');
      const idleEntry = log.find((e) => e.type === 'state-enter' && e.stateId === 'idle');
      return [
        check(
          '等待 80% 进度后才切换 (576ms)',
          transition?.atMs === 576,
          `实际切换于 ${transition?.atMs}ms`,
        ),
        check(
          '切换时源动作局部时间为 576ms',
          transition?.fromElapsedMs === 576,
          `fromElapsedMs=${transition?.fromElapsedMs}, 要求阈值进度=${transition?.progress}`,
        ),
        check(
          '等待前已经过的事件照常触发',
          closeEvent.length === 1 && closeEvent[0].atMs === 420,
          `窗口关事件 ${closeEvent.map((e) => e.atMs).join(', ')}ms`,
        ),
        check(
          '等待阈值之后的事件被跳过',
          recoverEvent.length === 0,
          `收势事件 ${recoverEvent.length} 次`,
        ),
        check(
          '剩余时间交给新状态 (424ms)',
          final.stateId === 'idle' && final.elapsedMs === 424,
          `目标状态=${final.stateId}, 局部时间=${final.elapsedMs}ms`,
        ),
        check(
          '待机事件按新计时触发 (576+300=876ms)',
          idleEntry?.type === 'state-enter' &&
            eventsOf(log, 'idle-breathe-a').some((e) => e.atMs === 876),
          `idle 进入 ${idleEntry?.type === 'state-enter' ? idleEntry.atMs : '?'}ms, 呼吸起 ${eventsOf(
            log,
            'idle-breathe-a',
          )
            .map((e) => e.atMs)
            .join(', ')}ms`,
        ),
      ];
    },
  },
  {
    id: 'loop-boundary',
    name: '一次跨过循环边界',
    description:
      '跑步是 900ms 循环动作, 每圈 120ms / 570ms 两次脚步。单次推进 3000ms 应跨过 3 个边界, 触发 7 次脚步、3 条循环记录, 不遗漏也不重复。',
    stateId: 'run',
    inputs: { speed: 0.6, hurt: false, pendingAttacks: 0 },
    dtMs: 3000,
    steps: 1,
    actions: [],
    checks: ({ log, final }) => {
      const steps = ['run-step-l', 'run-step-r'];
      const footsteps = collectEvents(log).filter((e) => steps.includes(e.eventId));
      const loops = log.filter((e) => e.type === 'loop');
      const keys = footsteps.map((e) => `${e.eventId}@${e.atMs}`);
      return [
        check(
          '单次推进跨过 3 个循环边界',
          loops.length === 3 &&
            loops.map((e) => (e.type === 'loop' ? e.atMs : 0)).join(',') === '900,1800,2700',
          `循环记录 ${loops.map((e) => (e.type === 'loop' ? e.atMs : 0)).join(',')}ms`,
        ),
        check(
          '7 次脚步事件按时刻逐一触发',
          footsteps.map((e) => e.atMs).join(',') === '120,570,1020,1470,1920,2370,2820',
          `事件: ${footsteps.map((e) => e.atMs).join(', ')}ms`,
        ),
        check(
          '没有重复事件',
          new Set(keys).size === keys.length,
          `${keys.length} 条记录, ${new Set(keys).size} 个唯一键`,
        ),
        check(
          '循环圈号随事件正确递增',
          footsteps
            .filter((e) => e.eventId === 'run-step-l')
            .map((e) => e.loopIndex)
            .join(',') === '0,1,2,3',
          `左脚事件圈号 ${footsteps
            .filter((e) => e.eventId === 'run-step-l')
            .map((e) => e.loopIndex)
            .join(',')}`,
        ),
        check(
          '推进结束停在当前圈 300ms',
          final.stateId === 'run' && final.elapsedMs === 300 && final.loopIndex === 3,
          `状态=${final.stateId}, 局部=${final.elapsedMs}, 圈=${final.loopIndex}`,
        ),
      ];
    },
  },
];

export function getScenarioSpecs(): ScenarioSpec[] {
  return DEMO_SCENARIOS;
}

export function runDemoScenarios(config: MachineConfig): ScenarioReport[] {
  return DEMO_SCENARIOS.map((spec) => runScenario(spec, config));
}

