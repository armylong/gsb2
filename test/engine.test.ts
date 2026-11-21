import { describe, expect, it } from 'vitest';
import {
  cloneLevel,
  evaluateGate,
  makeLevel,
  makeNode,
  resetLevelState,
  type Edge,
  type Level,
  type Signal,
} from '../src/model';
import {
  describeNode,
  findGateSccs,
  nodeSources,
  staticFeedbackLoops,
  tick,
  type TickReport,
} from '../src/sim';
import { operationFromIntent, replayOperations, type Operation } from '../src/ops';
import { buildScenario } from '../src/scenarios';

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

function wire(from: string, to: string, port = 0, id?: string): Edge {
  return { id: id ?? `${from}-${to}-${port}`, from, to, toPort: port };
}

function valueOf(level: Level, id: string): Signal {
  return level.nodes.find((node) => node.id === id)?.value ?? 'off';
}

const OFF: Signal = 'off';
const ON: Signal = 'on';

describe('gate truth tables', () => {
  const cases: Array<['and' | 'or' | 'xor' | 'nand' | 'nor' | 'not', Signal, Signal, Signal]> = [
    ['and', OFF, OFF, OFF],
    ['and', OFF, ON, OFF],
    ['and', ON, OFF, OFF],
    ['and', ON, ON, ON],
    ['or', OFF, OFF, OFF],
    ['or', OFF, ON, ON],
    ['or', ON, ON, ON],
    ['xor', OFF, OFF, OFF],
    ['xor', OFF, ON, ON],
    ['xor', ON, ON, OFF],
    ['nand', OFF, OFF, ON],
    ['nand', ON, ON, OFF],
    ['nor', OFF, OFF, ON],
    ['nor', ON, ON, OFF],
  ];

  it.each(cases)('%s(%s, %s) = %s', (op, a, b, expected) => {
    expect(evaluateGate(op, a, b)).toBe(expected);
  });

  it.each(cases.filter((entry) => entry[1] === 'on' || entry[2] === 'on'))(
    'wired %s gate settles to %s',
    (op, a, b, expected) => {
      const swA = makeNode('switch', 'a', { x: 0, y: 0 });
      const swB = makeNode('switch', 'b', { x: 1, y: 0 });
      const gate = makeNode('gate', 'g', { x: 3, y: 0 }, { op });
      const lamp = makeNode('lamp', 'l', { x: 5, y: 0 });
      const level = makeLevel({
        name: 't',
        cols: 6,
        rows: 3,
        home: { x: 0, y: 2 },
        nodes: [swA, swB, gate, lamp],
        edges: [wire('a', 'g', 0), wire('b', 'g', 1), wire('g', 'l', 0)],
      });
      const toggles = [a === 'on' ? 'a' : '', b === 'on' ? 'b' : ''].filter(Boolean);
      const result = tick(level, { toggleSwitchIds: toggles, move: null });
      expect(valueOf(result.level, 'g')).toBe(expected);
      expect(valueOf(result.level, 'l')).toBe(expected);
    },
  );
});

describe('single settling instant', () => {
  it('settles both toggles together and reports an atomic delta set', () => {
    const level = buildScenario('dual-gate');
    const result = tick(level, { toggleSwitchIds: ['sw-b', 'sw-a'], move: null });
    expect(result.report.toggles.map((t) => t.nodeId).sort()).toEqual(['sw-a', 'sw-b']);
    expect(result.report.step).toBe(1);
    // A 与 B 同时为 ON: XOR = OFF, NAND = OFF (两者输出保持 off, 但输入已被记录)
    expect(valueOf(result.level, 'gt-xor')).toBe('off');
    expect(valueOf(result.level, 'gt-nand')).toBe('off');
    const xorSources = nodeSources(result.level, result.level.nodes.find((n) => n.id === 'gt-xor')!);
    expect(xorSources.map((source) => source.value)).toEqual(['on', 'on']);
    expect(result.report.feedbacks).toHaveLength(0);
    const second = tick(result.level, { toggleSwitchIds: ['sw-a'], move: null });
    expect(second.report.deltas.some((d) => d.nodeId === 'gt-xor' && d.to === 'on')).toBe(true);
    expect(valueOf(second.level, 'lp-xor')).toBe('on');
  });

  it('reports every node source with its edge', () => {
    const level = buildScenario('dual-gate');
    const xor = level.nodes.find((n) => n.id === 'gt-xor')!;
    const sources = nodeSources(level, xor);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.nodeName).toBe('A');
    expect(sources[1]?.nodeName).toBe('B');
    expect(sources[0]?.edgeId).toBe('e-a-xor0');
    expect(sources[1]?.edgeId).toBe('e-b-xor1');
  });
});

describe('delay semantics', () => {
  it('advances the queue one cell per step and nothing else', () => {
    const steps = run(buildScenario('cross-step'), [
      { toggles: ['sw-a'], move: 'right' },
      {},
      {},
      {},
      {},
      {},
    ]);
    const snapshots = steps.reports.map((report) => report.delays[0]);
    expect(snapshots.map((snapshot) => snapshot?.value)).toEqual(['off', 'off', 'on', 'on', 'on', 'on']);
    expect(steps.reports[2]?.doors[0]?.passable).toBe(true);
    expect(steps.reports[2]?.doors[0]?.openedAt).toBe(3);
    expect(steps.reports[0]?.doors[0]?.passable).toBe(false);
  });

  it('a paused simulation produces no implicit changes', () => {
    let level = buildScenario('cross-step');
    level = tick(level, { toggleSwitchIds: ['sw-a'], move: null }).level;
    const before = cloneLevel(level);
    expect(staticFeedbackLoops(level)).toEqual([]);
    expect(level).toEqual(before);
    const first = tick(level, { toggleSwitchIds: [], move: null });
    expect(first.report.delays[0]?.queue).toEqual(['on', 'on']);
    const frozen = cloneLevel(first.level);
    expect(first.level).toEqual(frozen);
    // 暂停 = 不调用 tick; 延时队列和角色位置都保持
    expect(level).toEqual(before);
  });
});

describe('delay length vs door openness', () => {
  for (const steps of [1, 2, 3]) {
    it(`delay ${steps}: door opens on step ${steps + 1} and stays open`, () => {
      const sw = makeNode('switch', 'sw', { x: 1, y: 1 });
      const delay = makeNode('delay', 'dl', { x: 3, y: 1 }, { steps });
      const alsoOn = makeNode('switch', 'also-on', { x: 1, y: 3 });
      const gate = makeNode('gate', 'gt', { x: 5, y: 1 }, { op: 'and' });
      const door = makeNode('door', 'dr', { x: 7, y: 1 });
      const level = makeLevel({
        name: 'delay-chain',
        cols: 9,
        rows: 4,
        home: { x: 0, y: 3 },
        nodes: [sw, delay, alsoOn, gate, door],
        edges: [
          wire('sw', 'dl', 0),
          wire('dl', 'gt', 0),
          wire('also-on', 'gt', 1),
          wire('gt', 'dr', 0),
        ],
      });
      const out = run(level, [{ toggles: ['sw', 'also-on'] }, {}, {}, {}, {}]);
      expect(out.reports[0]?.doors[0]?.passable).toBe(false);
      expect(out.reports[steps]?.doors[0]?.passable).toBe(true);
      expect(out.reports[steps]?.doors[0]?.openedAt).toBe(steps + 1);
      expect(out.reports[steps + 1]?.doors[0]?.passable).toBe(true);
    });
  }

  it('clamps a zero-step delay to one step at construction', () => {
    const delay = makeNode('delay', 'dl', { x: 3, y: 1 }, { steps: 0 });
    expect(delay.kind === 'delay' ? delay.steps : -1).toBe(1);
    expect(delay.kind === 'delay' ? delay.queue : []).toEqual([]);
  });
});

describe('feedback', () => {
  it('finds the cyclic SCC statically without touching runtime state', () => {
    const level = buildScenario('feedback-latch');
    const cyclic = findGateSccs(level).filter((scc) => scc.cyclic);
    expect(cyclic).toHaveLength(2);
    expect(cyclic.map((scc) => [...scc.nodes].sort()).sort()).toEqual(
      [['gt-conf-a', 'gt-conf-b'], ['gt-latch']].sort(),
    );
    const preview = staticFeedbackLoops(level);
    expect(preview).toHaveLength(2);
    expect(preview.every((entry) => entry.history.length === 0 && Object.keys(entry.result).length === 0)).toBe(true);
  });

  it('OR self-latch converges to ON and stays latched', () => {
    let level = buildScenario('feedback-latch');
    const result = tick(level, { toggleSwitchIds: ['sw-a'], move: null });
    level = result.level;
    expect(result.report.deltas.find((delta) => delta.nodeId === 'gt-latch')?.to).toBe('on');
    const latchFeedback = result.report.feedbacks.find((feedback) => feedback.nodes[0] === 'gt-latch');
    expect(latchFeedback?.stable).toBe(true);
    expect(latchFeedback?.iterations).toBeLessThanOrEqual(2);
    // 自锁保持: 松开开关后 AND? 这里是 OR 自锁, 输入 B 为自身输出, 保持 ON
    const release = tick(level, { toggleSwitchIds: ['sw-a'], move: 'up' });
    expect(valueOf(release.level, 'gt-latch')).toBe('on');
    expect(release.report.feedbacks.find((feedback) => feedback.nodes[0] === 'gt-latch')?.conflict).toBe(false);
  });

  it('NAND loop reports a conflict, freezes its nodes, and names them', () => {
    let level = buildScenario('feedback-latch');
    level = tick(level, { toggleSwitchIds: ['sw-b'], move: null }).level;
    const conflicted = tick(level, { toggleSwitchIds: [], move: null });
    const conflict = conflicted.report.feedbacks.find((feedback) => feedback.nodes.includes('gt-conf-a'));
    expect(conflict?.stable).toBe(false);
    expect(conflict?.conflict).toBe(true);
    expect(conflict?.iterations).toBeGreaterThan(0);
    expect(conflict?.message).toContain('冲突');
    // 冻结: 冲突节点维持结算前的值, 且下游灯不会被写成一个"猜测值"
    expect(valueOf(conflicted.level, 'gt-conf-a')).toBe(valueOf(level, 'gt-conf-a'));
    expect(valueOf(conflicted.level, 'gt-conf-b')).toBe(valueOf(level, 'gt-conf-b'));
  });

  it('cross-step feedback uses the delay, not the zero-delay loop path', () => {
    const result = tick(buildScenario('cross-step'), { toggleSwitchIds: ['sw-a'], move: null });
    expect(result.report.feedbacks).toHaveLength(0);
    expect(result.report.delays[0]?.advanced).toBe(false);
  });
});

describe('character and doors', () => {
  it('a closed door blocks passage; opening it in the same instant still costs a step', () => {
    const sw = makeNode('switch', 'sw', { x: 1, y: 2 });
    const gate = makeNode('gate', 'gt', { x: 3, y: 2 }, { op: 'or' });
    const door = makeNode('door', 'door', { x: 6, y: 4 });
    const level = makeLevel({
      name: 'door-blocks',
      cols: 8,
      rows: 6,
      home: { x: 5, y: 4 },
      nodes: [sw, gate, door],
      edges: [wire('sw', 'gt', 0), wire('gt', 'door', 0)],
    });
    const blocked = tick(level, { toggleSwitchIds: ['sw'], move: 'right' });
    expect(blocked.report.move?.moved).toBe(false);
    expect(blocked.report.move?.blockedBy?.name).toBe('门');
    // 本步结算后门已打开, 但移动判定基于结算前的门状态
    expect(blocked.report.doors[0]?.passable).toBe(true);
    expect(blocked.level.character).toEqual({ x: 5, y: 4 });
    const through = tick(blocked.level, { toggleSwitchIds: [], move: 'right' });
    expect(through.report.move?.moved).toBe(true);
    expect(through.level.character).toEqual({ x: 6, y: 4 });
  });

  it('movement collision uses the pre-step door state (documented rule)', () => {
    const sw = makeNode('switch', 'sw', { x: 1, y: 2 });
    const gate = makeNode('gate', 'gt', { x: 3, y: 2 }, { op: 'or' });
    const door = makeNode('door', 'door', { x: 6, y: 2 });
    const level = makeLevel({
      name: 'door-instant',
      cols: 8,
      rows: 4,
      home: { x: 5, y: 2 },
      nodes: [sw, gate, door],
      edges: [wire('sw', 'gt', 0), wire('gt', 'door', 0)],
    });
    const result = tick(level, { toggleSwitchIds: ['sw'], move: 'right' });
    expect(result.report.doors[0]?.passable).toBe(true);
    expect(result.report.move?.moved).toBe(false);
    expect(result.level.character).toEqual({ x: 5, y: 2 });
    const next = tick(result.level, { toggleSwitchIds: [], move: 'right' });
    expect(next.report.move?.moved).toBe(true);
    expect(next.level.character).toEqual({ x: 6, y: 2 });
  });
});

describe('replay', () => {
  it('edits a connection, resets, and replays saved operations deterministically', () => {
    const base = buildScenario('dual-gate');
    const operations: Operation[] = [
      operationFromIntent(base, { toggles: ['sw-a'], move: null }, 'op-1'),
      operationFromIntent(base, { toggles: ['sw-b'], move: null }, 'op-2'),
      operationFromIntent(base, { toggles: [], move: null }, 'op-3'),
    ];
    const live = replayOperations(base, operations);
    expect(live.reports).toHaveLength(3);
    expect(live.level.step).toBe(3);
    expect(live.reports[2]?.lamps.find((lamp) => lamp.id === 'lp-xor')?.on).toBe(false);

    const editedBase = resetLevelState(cloneLevel(base));
    editedBase.edges = editedBase.edges
      .filter((edge) => edge.id !== 'e-b-nand1')
      .concat({ id: 'e-xor-nand1', from: 'gt-xor', to: 'gt-nand', toPort: 1 });
    const replayed = replayOperations(editedBase, operations);
    expect(replayed.level.step).toBe(3);
    expect(replayed.level.character).toEqual(base.home);
    const nandSources = nodeSources(
      replayed.level,
      replayed.level.nodes.find((node) => node.id === 'gt-nand')!,
    );
    expect(nandSources[1]?.nodeId).toBe('gt-xor');
    // A/B 同时 ON 时 XOR=OFF, 因此接到 NAND B 后 NAND=ON
    expect(valueOf(replayed.level, 'gt-nand')).toBe('on');
  });

  it('rewinding to a cursor reproduces the same state', () => {
    const base = buildScenario('cross-step');
    const operations: Operation[] = [
      operationFromIntent(base, { toggles: ['sw-a'], move: null }, 'a'),
      operationFromIntent(base, { toggles: [], move: null }, 'b'),
      operationFromIntent(base, { toggles: [], move: null }, 'c'),
      operationFromIntent(base, { toggles: [], move: null }, 'd'),
    ];
    const partial = replayOperations(base, operations, 2);
    expect(partial.cursor).toBe(2);
    expect(partial.level.step).toBe(2);
    const full = replayOperations(base, operations, 4);
    expect(full.reports[2]?.doors[0]?.passable).toBe(false);
    expect(full.reports[3]?.doors[0]?.passable).toBe(false);
    expect(full.level).toEqual(replayOperations(base, operations, 4).level);
    // 从判定为"走到底"的结果再回卷, 状态与从基线重放一致
    const rewind = replayOperations(base, operations, 2);
    expect(rewind.level).toEqual(partial.level);
  });

  it('describes sources and provenance for the inspector panel', () => {
    const level = buildScenario('cross-step');
    const gate = describeNode(level, 'gt-and');
    expect(gate?.inputs.map((input) => input.nodeName)).toEqual(['2 步延时', '压力板']);
    expect(gate?.note).toContain('与门');
    expect(describeNode(level, 'missing')).toBeNull();
    const unconnected = describeNode(buildScenario('two-input'), 'dr-1');
    expect(unconnected?.value).toBe('off');
    expect(unconnected?.inputs[0]?.nodeName).toBe('AND 门');
  });

  it('records labels from the state at capture time', () => {
    const base = buildScenario('cross-step');
    const op = operationFromIntent(base, { toggles: ['sw-a'], move: 'right' }, 'x');
    expect(op.label).toContain('A 开关 → ON');
    expect(op.label).toContain('角色移动 →');
    const reset = resetLevelState(base);
    const replayed = replayOperations(reset, [op]);
    expect(replayed.reports[0]?.toggles[0]?.to).toBe('on');
  });
});
