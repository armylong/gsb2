import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { canonicalReplayJson, createReplay, simulate } from '../src/game/engine.js';
import { convergeSample, level1, level2, sameBeatSample, sid } from '../src/game/levels.js';
import {
  level1Solution,
  level2EarlyFlagTrap,
  level2Solution,
} from '../src/game/fixtures.js';
import type { EditAction, LevelDef, Placement, ReplayRecord } from '../src/game/types.js';

interface VerifyCase {
  name: string;
  level: LevelDef;
  placement: Placement[];
  expectWin: boolean;
  expectations?: (result: ReturnType<typeof simulate>) => void;
}

function deterministicActions(placement: Placement[]): EditAction[] {
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
}

const cases: VerifyCase[] = [
  {
    name: 'level-1-solution',
    level: level1,
    placement: level1Solution,
    expectWin: true,
    expectations: (r) => {
      assert(r.flags.map((f) => f.landedBeat).join(',') === '23,29', '第 1 关旗拍应为 23,29');
    },
  },
  {
    name: 'level-2-solution',
    level: level2,
    placement: level2Solution,
    expectWin: true,
    expectations: (r) => {
      assert(r.flags.map((f) => f.landedBeat).join(',') === '23,32', '第 2 关旗拍应为 23,32');
    },
  },
  {
    name: 'level-2-early-flag-trap',
    level: level2,
    placement: level2EarlyFlagTrap,
    expectWin: false,
    expectations: (r) => {
      assert(r.flags[0]?.landedBeat === 23, 'A 旗应在 23 拍落地');
      assert(r.flags[1]?.landedBeat === 20, '短路 B 旗应在 20 拍提前落地');
    },
  },
  {
    name: 'sample-same-beat-collision',
    level: sameBeatSample,
    placement: sameBeatSample.samplePlacement ?? [],
    expectWin: true,
    expectations: (r) => {
      const target = sid(4, 2);
      const incoming = r.collisions.filter((c) => c.targetSlotId === target && c.beat === 18);
      assert(incoming.length === 2, '同拍样例应有两条碰撞');
      assert(incoming.filter((c) => c.outcome === 'triggered').length === 1, '只能有一次触发');
      assert(incoming.filter((c) => c.outcome === 'merged-same-beat').length === 1, '应有一次同拍合并');
      const piece = r.snapshots.at(-1)?.pieces.find((p) => p.slotId === target);
      assert(piece?.acceptedHitCount === 1, '目标片接受次数应为 1');
    },
  },
  {
    name: 'sample-two-routes-merge-slot',
    level: convergeSample,
    placement: convergeSample.samplePlacement ?? [],
    expectWin: true,
    expectations: (r) => {
      const target = sid(4, 2);
      assert(
        r.collisions.some((c) => c.targetSlotId === target && c.beat === 12 && c.outcome === 'triggered'),
        '短路应在 12 拍触发',
      );
      assert(
        r.collisions.some((c) => c.targetSlotId === target && c.beat === 24 && c.outcome === 'already-fallen'),
        '长路应在 24 拍记录 already-fallen',
      );
      const piece = r.snapshots.at(-1)?.pieces.find((p) => p.slotId === target);
      assert(piece?.acceptedHitCount === 1, '合槽后仍只能接受一次');
    },
  },
];

const report: Array<{
  name: string;
  win: boolean;
  beats: [number | null, number | null];
  replaySha256: string;
  repeatedSha256: string;
  consistent: boolean;
  sameBeatGroups: number;
}> = [];

const records: Record<string, ReplayRecord> = {};

for (const item of cases) {
  const actions = deterministicActions(item.placement);
  const replayA = createReplay(item.level, item.placement, actions);
  const replayB = createReplay(item.level, item.placement, actions);
  const jsonA = canonicalReplayJson(replayA);
  const jsonB = canonicalReplayJson(replayB);
  const hashA = sha256(jsonA);
  const hashB = sha256(jsonB);

  assert(jsonA === jsonB, `${item.name}: 两次 JSON 不一致`);
  assert(hashA === hashB, `${item.name}: 两次哈希不一致`);
  assert(replayA.result.win === item.expectWin, `${item.name}: win 应为 ${item.expectWin}`);
  item.expectations?.(replayA.result);

  records[item.name] = replayA;
  report.push({
    name: item.name,
    win: replayA.result.win,
    beats: [replayA.result.flags[0]?.landedBeat ?? null, replayA.result.flags[1]?.landedBeat ?? null],
    replaySha256: hashA,
    repeatedSha256: hashB,
    consistent: hashA === hashB,
    sameBeatGroups: replayA.sameBeatCollisionGroups.length,
  });

  console.log(
    `${replayA.result.win ? 'PASS' : 'EXPECTED-FAIL'}  ${item.name.padEnd(34)} beats=${JSON.stringify(
      report.at(-1)?.beats,
    )} sha256=${hashA.slice(0, 16)}… sameBeatGroups=${replayA.sameBeatCollisionGroups.length}`,
  );
}

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/verification-report.json', JSON.stringify(report, null, 2));
writeFileSync('artifacts/replay-records.json', JSON.stringify(records, null, 2));

if (process.exitCode) {
  console.error('\n本地验证存在失败项。');
} else {
  console.log(`\n全部 ${cases.length} 个样例在同机重复计算后哈希一致。`);
  console.log('完整记录已写入 artifacts/replay-records.json，摘要见 artifacts/verification-report.json。');
}
