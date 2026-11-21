import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng, hashSeed, rngFromState } from '../src/rng.ts';

test('同一字符串种子产生同一序列', () => {
  const a = createRng('seed-1');
  const b = createRng('seed-1');
  const seqA = Array.from({ length: 8 }, () => a.next());
  const seqB = Array.from({ length: 8 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('不同种子产生不同序列', () => {
  const a = createRng('seed-1');
  const b = createRng('seed-2');
  assert.notDeepEqual(
    Array.from({ length: 4 }, () => a.next()),
    Array.from({ length: 4 }, () => b.next()),
  );
});

test('数字种子与字符串种子都合法且非零', () => {
  assert.equal(hashSeed(0), 0x9e3779b9);
  assert.equal(hashSeed(''), 0x811c9dc5);
  assert.ok(Number.isInteger(hashSeed(12345)));
});

test('从快照恢复后继续产生完全相同的后续序列', () => {
  const rng = createRng('resume');
  for (let i = 0; i < 5; i++) rng.next();
  const snapshot = rng.snapshot();
  const expected = Array.from({ length: 10 }, () => rng.next());

  const restored = rngFromState(snapshot);
  const actual = Array.from({ length: 10 }, () => restored.next());
  assert.deepEqual(actual, expected);
  assert.equal(restored.state.draws, snapshot.draws + 10);
});

test('随机数始终落在 [0, 1)', () => {
  const rng = createRng('range');
  for (let i = 0; i < 5000; i++) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1, `越界: ${value}`);
  }
});

test('非法快照被拒绝', () => {
  assert.throws(() => rngFromState({ state: -1, draws: 0 }));
  assert.throws(() => rngFromState({ state: 2 ** 32, draws: 0 }));
  assert.throws(() => rngFromState({ state: 1, draws: -2 }));
});
