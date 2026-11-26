import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialState,
  isWin,
  nextHint,
  parseScript,
  physicalCol,
  runScript,
  solve,
  stateKey,
  step,
  type Dir,
  type GameState,
} from '../src/engine.js';
import { History } from '../src/history.js';
import { LEVELS } from '../src/levels.js';

const byId = (id: string) => {
  const level = LEVELS.find((item) => item.id === id);
  if (!level) throw new Error(`missing level ${id}`);
  return level;
};

test('mirror conversion places both marker views on one physical column', () => {
  assert.equal(physicalCol('inside', 2, 7), 2);
  assert.equal(physicalCol('outside', 4, 7), 2);
  assert.equal(physicalCol('inside', 5, 7), 5);
  assert.equal(physicalCol('outside', 1, 7), 5);

  const level = byId('mirror-first-steps');
  const before = createInitialState(level);
  const after = step(level, before, 'right').state;
  assert.equal(
    physicalCol('inside', after.pos.inside.c, level.cols),
    physicalCol('inside', before.pos.inside.c, level.cols) + 1,
  );
  assert.equal(
    physicalCol('outside', after.pos.outside.c, level.cols),
    physicalCol('outside', before.pos.outside.c, level.cols) - 1,
    'same screen-right key is physically opposite on the mirrored side',
  );
});

for (const level of LEVELS) {
  test(`level ${level.id} has mirrored markers, one target per side, and a solver win`, () => {
    assert.equal(level.targets.length, 2);
    for (const marker of level.markers) {
      assert.equal(
        physicalCol('inside', marker.at.inside.c, level.cols),
        physicalCol('outside', marker.at.outside.c, level.cols),
        `${marker.id} must reference the same physical column`,
      );
    }

    const result = solve(level);
    assert.equal(result.status, 'won', `level should be solvable: ${JSON.stringify(result)}`);
  });

  test(`recorded win replay succeeds for ${level.id}`, () => {
    const run = runScript(level, level.replay.win);
    assert.equal(run.won, true, `win script failed at states: ${JSON.stringify(run.states.at(-1))}`);
  });
}

test('one blocked beetle stays while the other keeps moving', () => {
  const level = byId('one-side-held');
  let state = createInitialState(level);

  state = step(level, state, 'down').state;
  state = step(level, state, 'down').state;

  const firstRight = step(level, state, 'right');
  assert.equal(firstRight.info.moved.inside, true);
  assert.equal(firstRight.info.moved.outside, false);
  assert.equal(firstRight.info.blockedReason.outside, 'wall');
  assert.deepEqual(firstRight.state.pos.outside, { r: 3, c: 1 });
  assert.deepEqual(firstRight.state.pos.inside, { r: 3, c: 2 });

  let current = firstRight.state;
  for (let i = 0; i < 3; i += 1) current = step(level, current, 'right').state;

  assert.equal(current.doors['side-door'], true, 'meeting marker toggles the shared door');
  const throughDoor = step(level, current, 'down');
  assert.equal(throughDoor.info.moved.inside, true);
  assert.equal(throughDoor.info.moved.outside, true);
  assert.equal(throughDoor.info.blockedReason.inside, null);
  assert.equal(throughDoor.info.blockedReason.outside, null);
});

test('one-shot marker fires once, tolerates standing still, leaving, and returning', () => {
  const level = byId('spent-key-deadend');
  let state = createInitialState(level);

  state = step(level, state, 'down').state;
  const trigger = step(level, state, 'down');
  state = trigger.state;

  assert.equal(state.used['only-key'], true);
  assert.equal(state.doors['key-door'], false);
  assert.ok(trigger.info.events.some((e) => e.type === 'marker-toggle' && e.kind === 'once'));

  // Standing on K and pressing into the closed door must not retrigger it.
  for (let i = 0; i < 3; i += 1) {
    const held = step(level, state, 'down');
    assert.equal(held.info.moved.inside, false);
    assert.equal(held.info.moved.outside, false);
    assert.equal(held.info.blockedReason.inside, 'closed-door');
    assert.equal(held.info.blockedReason.outside, 'closed-door');
    assert.equal(held.info.events.some((e) => e.type === 'marker-toggle'), false);
    assert.equal(held.state.used['only-key'], true);
    assert.equal(held.state.doors['key-door'], false);
    assert.equal(stateKey(held.state) === stateKey(state), true, 'blocked press changes no logical key');
    state = held.state;
  }

  const leave = step(level, state, 'up');
  assert.equal(leave.info.moved.inside, true);
  assert.equal(leave.info.moved.outside, true);

  const returning = step(level, leave.state, 'down');
  assert.equal(returning.info.events.some((e) => e.type === 'marker-toggle'), false);
  assert.equal(returning.state.used['only-key'], true);
  assert.equal(returning.state.doors['key-door'], false);
});

test('a beetle on a newly closed door can leave, but cannot re-enter afterward', () => {
  const level = byId('spent-key-deadend');
  const initial = createInitialState(level);
  const door = level.doors[0]!;
  const marker = level.markers[0]!;

  const onClosedDoor: GameState = {
    ...initial,
    pos: {
      inside: { ...door.at.inside },
      outside: { ...door.at.outside },
    },
    doors: { ...initial.doors, [door.id]: false },
    used: { ...initial.used, [marker.id]: true },
  };

  const leave = step(level, onClosedDoor, 'left');
  assert.equal(leave.info.moved.inside, true);
  assert.equal(leave.info.moved.outside, true);

  const reenter = step(level, leave.state, 'right');
  assert.equal(reenter.info.moved.inside, false);
  assert.equal(reenter.info.moved.outside, false);
  assert.equal(reenter.info.blockedReason.inside, 'closed-door');
  assert.equal(reenter.info.blockedReason.outside, 'closed-door');
});

test('hint always gives a usable first step from every reachable hinted state', () => {
  for (const level of LEVELS) {
    let state = createInitialState(level);
    for (let stepCount = 0; stepCount < 60 && !isWin(level, state); stepCount += 1) {
      const hint = nextHint(level, state);
      assert.equal(hint.dir === null, false, `expected hint for ${level.id} at ${stateKey(state)}`);
      const dir = hint.dir as Dir;
      state = step(level, state, dir).state;
    }
    assert.equal(isWin(level, state), true, `following hints should win ${level.id}`);
  }
});

test('history undo restores real door, marker and position snapshots', () => {
  const level = byId('spent-key-deadend');
  const initial = createInitialState(level);
  const history = new History(initial);

  let state = initial;
  for (const dir of parseScript('DD')) {
    const result = step(level, state, dir);
    state = result.state;
    history.push(state);
  }

  assert.equal(history.depth, 3);
  assert.equal(history.current.used['only-key'], true);

  const undoneOnce = history.undo();
  assert.ok(undoneOnce);
  assert.equal(undoneOnce!.used['only-key'], false);
  assert.equal(undoneOnce!.doors['key-door'], true);
  assert.equal(history.depth, 2);

  const undoneTwice = history.undo();
  assert.ok(undoneTwice);
  assert.deepEqual(undoneTwice!.pos, initial.pos);
  assert.equal(history.canUndo, false);
  assert.equal(history.undo(), null);
});

test('recorded bad trigger replay is an exhaustive unsolvable dead state with diagnosis', () => {
  const level = byId('spent-key-deadend');
  assert.ok(level.replay.dead, 'third level must define a dead replay');

  const run = runScript(level, level.replay.dead!);
  assert.equal(run.won, false);
  assert.equal(run.states.at(-1)!.used['only-key'], true);
  assert.equal(run.states.at(-1)!.doors['key-door'], false);

  const result = solve(level, run.states.at(-1)!);
  assert.equal(result.status, 'unsolvable');
  if (result.status === 'unsolvable') {
    assert.equal(result.diagnosis.kind, 'consumed-one-shot-door');
    assert.match(result.diagnosis.title, /一次性/);
    assert.ok(result.diagnosis.lines.some((line) => line.includes('已消耗')));
  }
});
