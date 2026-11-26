import { describe, expect, it } from 'vitest';
import {
  createInitialFrame,
  defaultSetup,
  findHint,
  fingerprintResult,
  simulateLevel,
  stepSimulation,
  validateLevelDefinition,
} from '../src/game/engine';
import { levelOne, levelTwo, levels } from '../src/game/levels';
import { runSelfChecks } from '../src/game/selfCheck';
import type { LevelDef, SetupState } from '../src/game/types';

describe('built-in levels', () => {
  it.each(levels)('$id is structurally valid', (level) => {
    expect(validateLevelDefinition(level)).toEqual([]);
  });

  it('all in-page self-check items pass', () => {
    const failed = runSelfChecks().filter((item) => !item.ok);
    expect(failed).toEqual([]);
  });

  it('level one known parity setup wins and records dual-source switch tick', () => {
    const setup = defaultSetup(levelOne);
    setup.tilts.A = 'right';
    setup.tilts.B = 'left';
    setup.tilts.C = 'left';
    setup.tilts.D = 'left';
    const result = simulateLevel(levelOne, setup);
    expect(result.final.status, result.final.failure?.message).toBe('won');
    expect(result.final.arrivals.map((a) => [a.color, a.bin])).toEqual([
      ['red', 'L'],
      ['blue', 'R'],
    ]);

    const dual = result.frames
      .flatMap((f) => f.trace?.switchResolutions ?? [])
      .find((r) => r.sources.length === 2 && r.targetChuteId === 'D');
    expect(dual).toMatchObject({ from: 'left', to: 'left', netToggles: 2, changed: false });
    expect(dual?.sources.map((s) => s.switchId)).toEqual(['SW-A', 'SW-D']);
  });

  it('level two waiting setup wins and records priority wait', () => {
    const setup = defaultSetup(levelTwo);
    setup.tilts.R1 = 'left';
    setup.tilts.D = 'left';
    const result = simulateLevel(levelTwo, setup);
    expect(result.final.status, result.final.failure?.message).toBe('won');
    expect(result.final.arrivals.map((a) => [a.color, a.bin])).toEqual([
      ['blue', 'L'],
      ['red', 'R'],
    ]);

    const conflictStep = result.frames.find((f) => f.trace?.conflicts.length);
    expect(conflictStep?.trace?.conflicts[0]).toMatchObject({
      node: 'm',
      winnerId: 'bead:SB',
    });
    const waitBlock = result.frames
      .flatMap((f) => f.trace?.blocks ?? [])
      .find((b) => b.kind === 'lost-priority' && b.beadId === 'bead:SR');
    expect(waitBlock).toBeTruthy();
  });

  it('level two shortcut arrives too early and fails with an order reason', () => {
    const setup = defaultSetup(levelTwo);
    setup.tilts.R1 = 'right';
    const result = simulateLevel(levelTwo, setup);
    expect(result.won).toBe(false);
    expect(result.final.failure?.code).toBe('wrong-arrival');
    expect(result.final.failure?.message).toContain('顺序');
  });

  it('hint uses the same simulator and finds a winner for every level', () => {
    for (const level of levels) {
      const hint = findHint(level, defaultSetup(level));
      expect(hint, `no hint for ${level.id}`).not.toBeNull();
      expect(hint?.result.won).toBe(true);
    }
  });

  it('same setup repeated 50 times has identical fingerprints', () => {
    const setup = defaultSetup(levelTwo);
    setup.tilts.R1 = 'left';
    const first = fingerprintResult(simulateLevel(levelTwo, setup));
    for (let i = 0; i < 50; i += 1) {
      expect(fingerprintResult(simulateLevel(levelTwo, setup))).toBe(first);
    }
  });
});

const dualSwitchFixture: LevelDef = {
  id: 'dual-switch-fixture',
  name: 'dual switch fixture',
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
  priority: { kind: 'color-rank', rank: ['red', 'blue'], label: 'red priority' },
  goal: [],
  maxTicks: 2,
};

describe('switch determinism', () => {
  it('records both same-tick sources when two switches target one chute', () => {
    const setup: SetupState = {
      tilts: { A: 'left', B: 'left', D: 'left' },
      colors: { SA: 'red', SB: 'blue' },
    };
    const frame = stepSimulation(dualSwitchFixture, createInitialFrame(dualSwitchFixture, setup));
    const resolution = frame.trace?.switchResolutions.find((r) => r.targetChuteId === 'D');
    expect(resolution).toMatchObject({ from: 'left', to: 'left', netToggles: 2, changed: false });
    expect(resolution?.sources.map((s) => s.switchId)).toEqual(['SW-A', 'SW-B']);
    expect(frame.tilts.D).toBe('left');
  });
});

const waitingChainFixture: LevelDef = {
  id: 'waiting-chain-fixture',
  name: 'waiting chain fixture',
  subtitle: '',
  brief: [],
  width: 500,
  height: 300,
  nodes: {
    a: { id: 'a', x: 80, y: 80 },
    b: { id: 'b', x: 180, y: 150 },
    w: { id: 'w', x: 360, y: 80 },
    c: { id: 'c', x: 280, y: 220 },
    exit: { id: 'exit', x: 280, y: 285, kind: 'exit', bin: 'L' },
  },
  chutes: [
    { id: 'A', entry: 'a', outputs: { left: 'b', right: 'b' }, initial: 'left' },
    { id: 'B', entry: 'b', outputs: { left: 'c', right: 'c' }, initial: 'left' },
    { id: 'W', entry: 'w', outputs: { left: 'c', right: 'c' }, initial: 'left' },
    { id: 'C', entry: 'c', outputs: { left: 'exit', right: 'exit' }, initial: 'left' },
  ],
  slots: [
    { id: 'Q', node: 'a', releaseTick: 0, color: 'red' },
    { id: 'P', node: 'b', releaseTick: 0, color: 'red' },
    { id: 'W', node: 'w', releaseTick: 0, color: 'blue' },
  ],
  priority: { kind: 'color-rank', rank: ['blue', 'red'], label: '蓝珠优先' },
  goal: [{ color: 'blue', bin: 'L' }],
  maxTicks: 6,
};

describe('waiting and dead ends', () => {
  it('keeps an occupied waiter running rather than failing immediately', () => {
    const setup = defaultSetup(waitingChainFixture);
    const frame = stepSimulation(
      waitingChainFixture,
      createInitialFrame(waitingChainFixture, setup),
    );
    expect(frame.status).toBe('running');
    const occupied = frame.trace?.blocks.find((b) => b.kind === 'occupied' && b.beadId === 'bead:Q');
    expect(occupied).toBeTruthy();
    expect(frame.occupancy.a).toBe('bead:Q');
    expect(frame.failure).toBeUndefined();
  });

  it('reports a connected-side dead chute as a concrete failure', () => {
    const level: LevelDef = {
      ...waitingChainFixture,
      id: 'deadend-fixture',
      chutes: [
        { id: 'A', entry: 'a', outputs: { left: null, right: 'b' }, initial: 'left' },
      ],
      slots: [{ id: 'Q', node: 'a', releaseTick: 0, color: 'red' }],
      goal: [],
    };
    const result = simulateLevel(level, {
      tilts: { A: 'left' },
      colors: { Q: 'red' },
    });
    expect(result.final.status).toBe('failed');
    expect(result.final.failure?.code).toBe('deadend');
    expect(result.final.failure?.message).toContain('不通');
  });
});
