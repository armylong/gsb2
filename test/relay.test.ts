import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { canonicalReplayJson, createReplay, simulate } from '../src/game/engine.js';
import {
  convergeSample,
  level1,
  level2,
  sameBeatSample,
  sid,
} from '../src/game/levels.js';
import {
  level1BlockedOrientation,
  level1Solution,
  level2EarlyFlagTrap,
  level2Solution,
} from '../src/game/fixtures.js';
import type { EditAction, Placement } from '../src/game/types.js';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function actionsFor(placement: Placement[]): EditAction[] {
  return [
    { seq: 1, type: 'clear', atLogicalMs: 1 },
    ...placement.map((p, i) => ({
      seq: i + 2,
      type: 'place' as const,
      atLogicalMs: i + 2,
      slotId: p.slotId,
      pieceType: p.type,
      toFacing: p.facing,
    })),
    { seq: placement.length + 2, type: 'start' as const, atLogicalMs: placement.length + 2 },
  ];
}

test('两小关的人工校验摆法都能按要求通关', () => {
  const r1 = simulate(level1, level1Solution);
  assert.equal(r1.win, true, r1.checks.map((c) => c.detail).join('\n'));
  assert.deepEqual(
    r1.flags.map((f) => f.landedBeat),
    [23, 29],
  );
  assert.equal(r1.pieceCount, 7);

  const r2 = simulate(level2, level2Solution);
  assert.equal(r2.win, true, r2.checks.map((c) => c.detail).join('\n'));
  assert.deepEqual(
    r2.flags.map((f) => f.landedBeat),
    [23, 32],
  );
  assert.equal(r2.pieceCount, 8);
});

test('看起来接通的短路会让 B 旗比 A 旗早倒，因此不通关', () => {
  const trap = simulate(level2, level2EarlyFlagTrap);
  assert.equal(trap.win, false);
  assert.deepEqual(
    trap.flags.map((f) => f.landedBeat),
    [23, 20],
  );
  const order = trap.checks.find((c) => c.id === 'order');
  const interval = trap.checks.find((c) => c.id === 'interval');
  assert.equal(order?.pass, false);
  assert.equal(interval?.pass, false);
  assert.match(interval?.detail ?? '', /太早/);
});

test('样例 A：同拍两路相撞只触发一次，并保存同拍碰撞组', () => {
  const placement = sameBeatSample.samplePlacement ?? [];
  const r = simulate(sameBeatSample, placement);
  const target = sid(4, 2);

  const incoming = r.collisions.filter((c) => c.targetSlotId === target && c.beat === 18);
  assert.equal(incoming.length, 2);
  assert.equal(incoming.filter((c) => c.outcome === 'triggered').length, 1);
  assert.equal(incoming.filter((c) => c.outcome === 'merged-same-beat').length, 1);

  const group = r.groups.find((g) => g.targetSlotId === target && g.beat === 18);
  assert.ok(group);
  assert.equal(group?.simultaneous, true);
  assert.equal(group?.collisionIds.length, 2);

  const finalPiece = r.snapshots.at(-1)?.pieces.find((p) => p.slotId === target);
  assert.equal(finalPiece?.acceptedHitCount, 1);

  const replay = createReplay(sameBeatSample, placement, actionsFor(placement), r);
  assert.equal(replay.sameBeatCollisionGroups.some((g) => g.id === group?.id), true);
});

test('样例 B：两路合进同槽时，后到路线撞上已躺下的片且不重复触发', () => {
  const placement = convergeSample.samplePlacement ?? [];
  const r = simulate(convergeSample, placement);
  const target = sid(4, 2);

  const first = r.collisions.find((c) => c.targetSlotId === target && c.outcome === 'triggered');
  const duplicate = r.collisions.find((c) => c.targetSlotId === target && c.outcome === 'already-fallen');
  assert.equal(first?.beat, 12);
  assert.equal(duplicate?.beat, 24);

  const finalPiece = r.snapshots.at(-1)?.pieces.find((p) => p.slotId === target);
  assert.equal(finalPiece?.acceptedHitCount, 1);
  assert.equal(finalPiece?.status, 'fallen');
  assert.equal(finalPiece?.landBeat, 18);
});

test('挡柱和错误侧单向片都会给出阻挡记录', () => {
  const blockedPost = simulate(level1, level1BlockedOrientation);
  assert.ok(blockedPost.collisions.some((c) => c.outcome === 'blocked-post' && c.targetSlotId?.endsWith('2-2')));

  const wrongSidePlacement: Placement[] = [
    { slotId: sid(2, 3), type: 'thin', facing: 'E' },
    { slotId: sid(3, 3), type: 'wide', facing: 'E' },
    { slotId: sid(3, 4), type: 'thin', facing: 'S' },
    { slotId: sid(3, 5), type: 'thin', facing: 'E' },
    { slotId: sid(4, 5), type: 'thin', facing: 'E' },
    { slotId: sid(5, 5), type: 'thin', facing: 'N' },
    { slotId: sid(5, 4), type: 'thin', facing: 'N' },
  ];
  const wrongGate = simulate(level1, wrongSidePlacement);
  const blocked = wrongGate.collisions.find((c) => c.outcome === 'blocked-wrong-side');
  assert.ok(blocked, '应存在错误侧碰撞');
  assert.match(blocked?.note ?? '', /只允许/);
  const gate = wrongGate.snapshots.at(-1)?.pieces.find((p) => p.kind === 'gate');
  assert.equal(gate?.status, 'idle');
});

test('禁碰槽和用片上限会让通关检查失败', () => {
  const forbiddenPlacement: Placement[] = [
    { slotId: sid(2, 3), type: 'thin', facing: 'E' },
    { slotId: sid(3, 3), type: 'wide', facing: 'E' },
    { slotId: sid(3, 4), type: 'thin', facing: 'S' },
    { slotId: sid(3, 5), type: 'thin', facing: 'E' },
    { slotId: sid(4, 5), type: 'thin', facing: 'E' },
    { slotId: sid(5, 5), type: 'thin', facing: 'N' },
    { slotId: sid(5, 4), type: 'thin', facing: 'E' },
  ];
  const forbidden = simulate(level1, forbiddenPlacement);
  assert.equal(forbidden.forbiddenTouchedSlotIds.includes(sid(6, 4)), true);
  assert.equal(forbidden.checks.find((c) => c.id === 'forbidden')?.pass, false);

  const placedOnForbidden = simulate(level1, [{ slotId: sid(6, 4), type: 'thin', facing: 'E' }]);
  assert.equal(placedOnForbidden.checks.find((c) => c.id === 'forbidden')?.pass, false);

  const tooMany = simulate(level1, [
    ...level1Solution,
    { slotId: sid(5, 4), type: 'thin', facing: 'W' },
  ]);
  assert.equal(tooMany.pieceCount, 8);
  assert.equal(tooMany.checks.find((c) => c.id === 'pieces')?.pass, false);
  assert.equal(tooMany.win, false);
});

test('单步回看所依赖的逐拍快照稳定：退回上一拍时目标尚未触发', () => {
  const r = simulate(sameBeatSample, sameBeatSample.samplePlacement ?? []);
  const target = sid(4, 2);
  const before = r.snapshots[17]?.pieces.find((p) => p.slotId === target);
  const atBeat = r.snapshots[18]?.pieces.find((p) => p.slotId === target);
  assert.equal(before?.status, 'idle');
  assert.equal(atBeat?.status, 'falling');
  assert.equal(atBeat?.acceptedHitCount, 1);
});

test('同一输入本地运行两次，回看 JSON 与 SHA-256 完全一致', () => {
  const cases: Array<[string, Parameters<typeof simulate>[1]]> = [
    ['level1', level1Solution],
    ['level2', level2Solution],
    ['same-beat', sameBeatSample.samplePlacement ?? []],
    ['converge', convergeSample.samplePlacement ?? []],
  ];

  for (const [name, placement] of cases) {
    const level = levelFor(name);
    const replayA = createReplay(level, placement, actionsFor(placement));
    const replayB = createReplay(level, placement, actionsFor(placement));
    const jsonA = canonicalReplayJson(replayA);
    const jsonB = canonicalReplayJson(replayB);
    assert.equal(jsonA, jsonB, `${name} replay JSON mismatch`);
    assert.equal(hash(jsonA), hash(jsonB));
    assert.equal(hash(jsonA).length, 64);
    assert.equal(replayA.schema, 'wood-relay-replay/v1');
  }
});

function levelFor(name: string): typeof level1 {
  if (name === 'level1') return level1;
  if (name === 'level2') return level2;
  if (name === 'same-beat') return sameBeatSample;
  return convergeSample;
}
