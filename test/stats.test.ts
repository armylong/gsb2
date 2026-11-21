import test from 'node:test';
import assert from 'node:assert/strict';

import { addWeightVersion } from '../src/builder.ts';
import { edgeCaseConfig, sampleConfig } from '../src/samples.ts';
import {
  createSession,
  planLength,
  runBatch,
  stepOnce,
  withConfig,
  type RunPlan,
  type Session,
} from '../src/engine.ts';
import {
  buildReport,
  buildTimeline,
  diffRecords,
  segmentDraws,
  summarizeArm,
} from '../src/stats.ts';

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    mode: 'round-robin',
    passes: 50,
    drawsPerBlock: 10,
    characters: ['alpha'],
    pools: ['standard'],
    ...overrides,
  };
}

function runAll(session: Session): Session {
  let current = session;
  for (;;) {
    const result = runBatch(current, planLength(current.plan));
    current = result.session;
    if (result.exhausted) return current;
  }
}

test('报告: 抽数、规则分布与版本一致', () => {
  const session = runAll(createSession(sampleConfig(), { seed: 'report', plan: plan() }));
  const report = buildReport(session);
  assert.equal(report.draws, 50);
  const sum = report.ruleCounts.weighted + report.ruleCounts.pity + report.ruleCounts.empty;
  assert.equal(sum, 50);
  assert.equal(report.versions.length, 1);
  assert.equal(report.versions[0]!.poolId, 'standard');
  assert.equal(report.versions[0]!.draws, 50);
  assert.equal(report.pools[0]!.label, '标准池');
});

test('分段: 段内抽数之和等于总抽数', () => {
  const session = runAll(createSession(sampleConfig(), { seed: 'seg', plan: plan({ passes: 200 }) }));
  const segments = segmentDraws(session.records, { poolId: 'standard' }, 10);
  const total = segments.reduce((sum, bucket) => sum + bucket.draws, 0);
  assert.equal(total, 200);
  // 每段命中数之和等于总命中数
  const hits = segments.reduce(
    (sum, bucket) => sum + Object.values(bucket.hits).reduce((a, b) => a + b, 0),
    0,
  );
  const expectedHits = session.records.filter((r) => r.hit !== null).length;
  assert.equal(hits, expectedHits);
  // 段是连续的
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i]!.from, segments[i - 1]!.to + 1);
  }
});

test('分段: 高 streak 段里 SSR 命中率高于低 streak 段 (软保底生效)', () => {
  const config = sampleConfig();
  // 让 SSR 阈值远大于抽样量, 只看软保底
  const session = runAll(
    createSession(config, {
      seed: 'soft-seg',
      plan: plan({ passes: 4000, mode: 'round-robin', drawsPerBlock: 10 }),
    }),
  );
  const segments = segmentDraws(session.records, { poolId: 'standard' }, 10);
  // 只看至少有 30 抽的段
  const solid = segments.filter((s) => s.draws >= 30);
  assert.ok(solid.length >= 2, `solid segments: ${solid.length}`);
  const early = solid[0]!;
  const late = solid.at(-1)!;
  assert.ok(late.from > early.from);
  assert.ok(
    (late.rates.ssr ?? 0) > (early.rates.ssr ?? 0),
    `早段 ${early.rates.ssr} 应低于晚段 ${late.rates.ssr}`,
  );
  assert.ok(
    (late.rates.r ?? 0) < (early.rates.r ?? 0),
    `晚段 R 命中率应低于早段: ${early.rates.r} vs ${late.rates.r}`,
  );
});

test('最长未中连续长度不超过硬保底阈值', () => {
  const config = sampleConfig();
  const session = runAll(createSession(config, { seed: 'streak', plan: plan({ passes: 2000 }) }));
  const report = buildReport(session);
  const pool = report.pools[0]!;
  const sampleThreshold = (id: string): number | null => {
    const standard = config.pools.find((p) => p.id === 'standard')!;
    const version = standard.versions.find((v) => v.version === standard.activeVersion)!;
    return version.rarities.find((r) => r.id === id)?.pityThreshold ?? null;
  };
  for (const id of ['sr', 'ssr']) {
    const summary = pool.rarities.find((r) => r.id === id)!;
    const threshold = sampleThreshold(id);
    assert.notEqual(threshold, null, `${id} 应当配置硬保底`);
    // 最长"抽前 streak" 最多到 threshold - 1, 因此最长未中 <= threshold
    assert.ok(
      summary.maxMissStreak <= threshold!,
      `${id} 最长未中 ${summary.maxMissStreak} 应 <= 阈值 ${threshold}`,
    );
    assert.ok(summary.pityHits > 0, `${id} 在 2000 抽内应至少触发一次硬保底`);
  }
});

test('最长未中: 零权重无保底时等于抽数', () => {
  const config = edgeCaseConfig();
  const session = runAll(
    createSession(config, {
      seed: 'zero-streak',
      plan: { mode: 'round-robin', passes: 25, drawsPerBlock: 1, characters: ['solo'], pools: ['zero-weight'] },
    }),
  );
  const report = buildReport(session);
  const pool = report.pools.find((p) => p.poolId === 'zero-weight')!;
  for (const rarity of pool.rarities) assert.equal(rarity.maxMissStreak, 25);
});

test('实际抽中的权重版本: 调权重后按版本分别统计', () => {
  const config = sampleConfig();
  const p = plan({ passes: 30 });
  const first = runBatch(createSession(config, { seed: 'versions', plan: p }), 15).session;
  const { config: changed } = addWeightVersion(first.config, 'standard', [{ id: 'ssr', weight: 20 }], {
    label: 'v2-提权',
  });
  const second = runBatch(withConfig(first, changed), 15).session;
  const report = buildReport(second);
  assert.equal(report.versions.length, 2);
  const v1 = report.versions.find((v) => v.version === 1)!;
  const v2 = report.versions.find((v) => v.version === 2)!;
  assert.equal(v1.label, 'v1-标准');
  assert.equal(v2.label, 'v2-提权');
  assert.equal(v1.draws + v2.draws, 30);
  assert.equal(v2.draws, 15);
});

test('时间线包含每次抽卡的随机状态与规则说明', () => {
  const session = runAll(createSession(sampleConfig(), { seed: 'timeline', plan: plan({ passes: 3 }) }));
  const timeline = buildTimeline(session.records);
  assert.equal(timeline.length, 3);
  for (const entry of timeline) {
    assert.match(entry.rngBefore, /^0x[0-9a-f]{8}#\d+$/);
    assert.ok(entry.notes.length > 0);
    assert.equal(entry.streaksAfter.ssr !== undefined, true);
  }
});

test('diffRecords: 相同记录无差异, 不同记录报出字段', () => {
  const config = sampleConfig();
  const a = runAll(createSession(config, { seed: 'diff', plan: plan({ passes: 5 }) }));
  const b = runAll(createSession(config, { seed: 'diff', plan: plan({ passes: 5 }) }));
  assert.deepEqual(diffRecords(a.records, b.records), []);
  const c = runAll(createSession(config, { seed: 'other', plan: plan({ passes: 5 }) }));
  assert.ok(diffRecords(a.records, c.records).length > 0);
  assert.ok(diffRecords(a.records, c.records)[0]!.field.length > 0);
});

test('summarizeArm 汇总 pity / bonus 命中数', () => {
  const config = edgeCaseConfig();
  const session = runAll(
    createSession(config, {
      seed: 'arm',
      plan: { mode: 'round-robin', passes: 10, drawsPerBlock: 1, characters: ['solo'], pools: ['zero-with-pity'] },
    }),
  );
  const summary = summarizeArm('零权重+保底', session);
  assert.equal(summary.draws, 10);
  assert.equal(summary.ruleCounts.pity, 2);
  assert.equal(summary.ruleCounts.empty, 8);
  const ssr = summary.perRarity.find((r) => r.rarityId === 'ssr')!;
  assert.equal(ssr.hits, 2);
  assert.equal(ssr.pityHits, 2);
});

// 逐次试抽也能产出可统计的记录
test('stepOnce 10 次后报告统计正确', () => {
  let session = createSession(sampleConfig(), { seed: 'step-report', plan: plan({ passes: 10 }) });
  for (let i = 0; i < 4; i++) session = stepOnce(session).session;
  const report = buildReport(session);
  assert.equal(report.draws, 4);
  assert.equal(report.pools[0]!.draws, 4);
});

test('最长未中按进度 key 合并: 共享组内跨池连续计数', () => {
  const config = sampleConfig();
  // 每个块只抽 1 次, 在两个共享池之间来回切换; SSR 一定连续未中时进度应跨池累加
  const plan = {
    mode: 'pool-blocks' as const,
    passes: 20,
    drawsPerBlock: 1,
    characters: ['alpha'],
    pools: ['featured', 'weapon'],
  };
  const session = runAll(createSession(config, { seed: 'cross-pool-streak', plan }));
  const report = buildReport(session);
  const featured = report.pools.find((p) => p.poolId === 'featured')!;
  const weapon = report.pools.find((p) => p.poolId === 'weapon')!;
  const sharedKey = session.records[0]!.progress.key;
  assert.ok(sharedKey.startsWith('alpha|group:'));
  // 两个池统计的是同一份进度, 所以同一稀有度的最长未中应当一致
  for (const id of ['r', 'sr', 'ssr']) {
    assert.equal(
      featured.maxMissStreakByRarity[id],
      weapon.maxMissStreakByRarity[id],
      `${id} 在共享组两个池里应报告相同的连续未中长度`,
    );
  }
});

test('最长未中不跨角色合并', () => {
  const config = sampleConfig();
  const plan = {
    mode: 'pool-blocks' as const,
    passes: 20,
    drawsPerBlock: 1,
    characters: ['alpha', 'beta'],
    pools: ['standard'],
  };
  const session = runAll(createSession(config, { seed: 'char-streak', plan }));
  // 两个角色各自独立; 总最长未中应等于两个角色各自最长未中的较大者
  const alpha = session.records.filter((r) => r.characterId === 'alpha');
  const beta = session.records.filter((r) => r.characterId === 'beta');
  const alphaReport = buildReport({ ...session, records: alpha });
  const betaReport = buildReport({ ...session, records: beta });
  const full = buildReport(session);
  for (const id of ['r', 'sr', 'ssr']) {
    const a = alphaReport.characters.find((c) => c.characterId === 'alpha')!.maxMissStreakByRarity[id] ?? 0;
    const b = betaReport.characters.find((c) => c.characterId === 'beta')!.maxMissStreakByRarity[id] ?? 0;
    const all = Math.max(
      full.characters.find((c) => c.characterId === 'alpha')!.maxMissStreakByRarity[id] ?? 0,
      full.characters.find((c) => c.characterId === 'beta')!.maxMissStreakByRarity[id] ?? 0,
    );
    assert.equal(all, Math.max(a, b));
  }
});
