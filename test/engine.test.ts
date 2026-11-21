import test from 'node:test';
import assert from 'node:assert/strict';

import { addWeightVersion, activateVersion, setSharedGroup, patchActiveRarities } from '../src/builder.ts';
import { edgeCaseConfig, sampleConfig } from '../src/samples.ts';
import {
  createSession,
  forkSession,
  planLength,
  remainingDraws,
  runBatch,
  sessionFromJson,
  sessionToJson,
  stepAt,
  stepOnce,
  withConfig,
  type RunPlan,
  type Session,
} from '../src/engine.ts';

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    mode: 'round-robin',
    passes: 3,
    drawsPerBlock: 5,
    characters: ['alpha', 'beta'],
    pools: ['standard', 'featured', 'weapon'],
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

test('相同种子完全相同', () => {
  const config = sampleConfig();
  const a = runAll(createSession(config, { seed: 'same', plan: plan() }));
  const b = runAll(createSession(config, { seed: 'same', plan: plan() }));
  assert.deepEqual(a.records, b.records);
  assert.deepEqual(a.rng, b.rng);
  assert.deepEqual(a.progress, b.progress);
});

test('不同种子分布不同', () => {
  const config = sampleConfig();
  const a = runAll(createSession(config, { seed: 'seed-a', plan: plan({ passes: 5 }) }));
  const b = runAll(createSession(config, { seed: 'seed-b', plan: plan({ passes: 5 }) }));
  assert.notDeepEqual(a.records, b.records);
});

test('执行计划条数与 planLength 一致, 能跑到计划结束', () => {
  const config = sampleConfig();
  const p = plan();
  const session = createSession(config, { seed: 1, plan: p });
  assert.equal(planLength(p), 3 * 2 * 3);
  const result = runBatch(session, 1000);
  assert.equal(result.records.length, planLength(p));
  assert.equal(result.exhausted, true);
  assert.equal(remainingDraws(result.session), 0);
  const extra = runBatch(result.session, 1);
  assert.equal(extra.records.length, 0);
});

test('stepAt 与两种计划模式', () => {
  const roundRobin = plan({ mode: 'round-robin', passes: 1 });
  assert.deepEqual(stepAt(roundRobin, 0), { characterId: 'alpha', poolId: 'standard' });
  assert.deepEqual(stepAt(roundRobin, 1), { characterId: 'alpha', poolId: 'featured' });
  assert.deepEqual(stepAt(roundRobin, 3), { characterId: 'beta', poolId: 'standard' });
  assert.equal(stepAt(roundRobin, planLength(roundRobin)), null);

  const blocks = plan({ mode: 'pool-blocks', passes: 1, drawsPerBlock: 2, characters: ['alpha'] });
  const steps = Array.from({ length: planLength(blocks) }, (_, i) => stepAt(blocks, i)!);
  assert.deepEqual(
    steps.map((s) => s.poolId),
    ['standard', 'standard', 'featured', 'featured', 'weapon', 'weapon'],
  );
});

test('硬保底: 阈值 1 时第一抽必中', () => {
  const config = edgeCaseConfig();
  const session = createSession(config, {
    seed: 'pity',
    plan: { mode: 'round-robin', passes: 5, drawsPerBlock: 1, characters: ['solo'], pools: ['pity-now'] },
  });
  const result = runBatch(session, 5);
  assert.ok(result.records.length === 5);
  for (const record of result.records) {
    assert.equal(record.rule, 'pity');
    assert.equal(record.hit?.id, 'ssr');
    // 每抽都是第 1 抽 (命中后 streak 归零)
    assert.equal(record.details.find((d) => d.id === 'ssr')!.pityAtDraw, 1);
  }
});

test('硬保底: 阈值 N 时最多 N 抽必中', () => {
  // 零权重池 + 阈值 5: 前 4 抽 empty, 第 5 抽必中
  const config = edgeCaseConfig();
  const session = createSession(config, {
    seed: 'pity-5',
    plan: { mode: 'round-robin', passes: 12, drawsPerBlock: 1, characters: ['solo'], pools: ['zero-with-pity'] },
  });
  const result = runBatch(session, 12);
  const rules = result.records.map((r) => r.rule);
  assert.deepEqual(rules.slice(0, 5), ['empty', 'empty', 'empty', 'empty', 'pity']);
  assert.deepEqual(rules.slice(5, 10), ['empty', 'empty', 'empty', 'empty', 'pity']);
  assert.equal(result.records[4]!.hit?.id, 'ssr');
});

test('空池: 永远 empty, 不消耗随机数', () => {
  const config = edgeCaseConfig();
  const session = createSession(config, {
    seed: 'empty',
    plan: { mode: 'round-robin', passes: 10, drawsPerBlock: 1, characters: ['solo'], pools: ['empty'] },
  });
  const result = runBatch(session, 10);
  assert.equal(session.rng.draws, result.session.rng.draws, '随机数计数不应变化');
  for (const record of result.records) {
    assert.equal(record.rule, 'empty');
    assert.equal(record.roll, null);
    assert.equal(record.hit, null);
  }
});

test('全零权重: 无保底时永远 empty, 进度照常推进', () => {
  const config = edgeCaseConfig();
  const session = createSession(config, {
    seed: 'zero',
    plan: { mode: 'round-robin', passes: 10, drawsPerBlock: 1, characters: ['solo'], pools: ['zero-weight'] },
  });
  const result = runBatch(session, 10);
  for (const record of result.records) {
    assert.equal(record.rule, 'empty');
    assert.equal(record.roll, null);
  }
  const last = result.records.at(-1)!;
  assert.equal(last.progress.streaksAfter.ssr, 10);
  assert.equal(session.rng.draws, 0);
});

test('仅加成: 零权重但加成从第二抽开始生效', () => {
  const config = edgeCaseConfig();
  const session = createSession(config, {
    seed: 'bonus',
    plan: { mode: 'round-robin', passes: 8, drawsPerBlock: 1, characters: ['solo'], pools: ['bonus-only'] },
  });
  const result = runBatch(session, 8);
  assert.equal(result.records[0]!.rule, 'empty', '第一抽加成 0*2=0, 应 empty');
  assert.equal(result.records[1]!.rule, 'weighted');
  assert.equal(result.records[1]!.hit?.id, 'ssr');
  assert.ok(result.records[1]!.details.find((d) => d.id === 'ssr')!.bonusWeight > 0);
});

test('软保底: 连续未中会推高有效权重', () => {
  const config = sampleConfig();
  const session = createSession(config, {
    seed: 'soft',
    plan: { mode: 'round-robin', passes: 40, drawsPerBlock: 1, characters: ['alpha'], pools: ['standard'] },
  });
  const result = runBatch(session, 40);
  const ssrDetails = result.records.map((r) => r.details.find((d) => d.id === 'ssr')!);
  // 至少有一抽的加成 > 0 (说明 streak 在起作用)
  assert.ok(ssrDetails.some((d) => d.bonusWeight > 0));
  // 加成与 streak 成正比 (标准池 SSR 的 bonusPerMiss = 1)
  for (const detail of ssrDetails) {
    assert.equal(detail.bonusWeight, 1 * detail.streakBefore);
  }
});

test('多角色进度独立', () => {
  const config = sampleConfig();
  const session = createSession(config, {
    seed: 'chars',
    plan: { mode: 'round-robin', passes: 6, drawsPerBlock: 1, characters: ['alpha', 'beta'], pools: ['standard'] },
  });
  const result = runBatch(session, 12);
  const alphaKeys = new Set(result.records.filter((r) => r.characterId === 'alpha').map((r) => r.progress.key));
  const betaKeys = new Set(result.records.filter((r) => r.characterId === 'beta').map((r) => r.progress.key));
  assert.deepEqual([...alphaKeys], ['alpha|pool:standard']);
  assert.deepEqual([...betaKeys], ['beta|pool:standard']);
  // 两个角色的 streak 互不影响: alpha 的推进不会写进 beta 的进度
  for (const record of result.records) {
    assert.equal(record.progress.key.startsWith(record.characterId), true);
  }
});

test('共享组: 同组内切池沿用进度, 未共享的池独立', () => {
  const config = sampleConfig();
  const session = createSession(config, {
    seed: 'shared',
    plan: {
      mode: 'pool-blocks',
      passes: 1,
      drawsPerBlock: 4,
      characters: ['alpha'],
      pools: ['featured', 'weapon', 'standard'],
    },
  });
  const result = runBatch(session, planLength(session.plan));
  const featured = result.records.filter((r) => r.poolId === 'featured');
  const weapon = result.records.filter((r) => r.poolId === 'weapon');
  const standard = result.records.filter((r) => r.poolId === 'standard');

  assert.equal(featured[0]!.progress.key, 'alpha|group:banner-group');
  assert.equal(featured[0]!.progress.strategy, 'fresh');
  // 切到 weapon 时沿用同组的进度
  const firstWeapon = weapon[0]!;
  assert.equal(firstWeapon.progress.scope, 'group');
  assert.equal(firstWeapon.progress.strategy, 'shared-group');
  assert.deepEqual(
    firstWeapon.progress.streaksBefore,
    featured.at(-1)!.progress.streaksAfter,
    '武器池应从限定池留下的进度继续',
  );
  assert.ok(firstWeapon.notes.some((n) => n.includes('共用同一份连续未中进度')));

  // 标准池不共享: 从 0 开始
  assert.equal(standard[0]!.progress.scope, 'pool');
  assert.equal(standard[0]!.progress.strategy, 'fresh');
  assert.deepEqual(standard[0]!.progress.streaksBefore, { r: 0, sr: 0, ssr: 0 });
});

test('回退权重版本: 记录实际版本, 默认沿用进度', () => {
  const config = sampleConfig();
  const base = createSession(config, {
    seed: 'revert',
    plan: { mode: 'round-robin', passes: 20, drawsPerBlock: 1, characters: ['alpha'], pools: ['featured'] },
  });
  const first = runBatch(base, 5).session;
  const { config: v2 } = addWeightVersion(first.config, 'featured', [{ id: 'ssr', weight: 40 }], {
    label: 'v2-上调',
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const upgraded = runBatch(withConfig(first, v2), 5).session;
  assert.ok(upgraded.records.slice(5).every((r) => r.poolVersion === 2));
  assert.equal(upgraded.records[5]!.versionChange, 'upgrade');

  const backConfig = activateVersion(upgraded.config, 'featured', 1);
  const back = runBatch(withConfig(upgraded, backConfig), 5).session;
  const firstBack = back.records[10]!;
  assert.equal(firstBack.poolVersion, 1);
  assert.equal(firstBack.versionChange, 'revert');
  assert.equal(firstBack.progress.strategy, 'inherited');
  assert.deepEqual(firstBack.progress.streaksBefore, upgraded.records[9]!.progress.streaksAfter);
  assert.ok(firstBack.notes.some((n) => n.includes('回退')));
  assert.ok(firstBack.notes.some((n) => n.includes('沿用')));
});

test('版本变化 + reset 策略: 清空进度并记录丢弃的 streak', () => {
  const config = sampleConfig();
  const resetConfig = patchActiveRarities(config, 'standard', [{ id: 'ssr', pityThreshold: 10 }]);
  const withPolicy = structuredClone(resetConfig) as unknown as {
    pools: { id: string; progressPolicyOnVersionChange: string }[];
  };
  withPolicy.pools.find((p) => p.id === 'standard')!.progressPolicyOnVersionChange = 'reset';

  const base = createSession(withPolicy as never, {
    seed: 'reset',
    plan: { mode: 'round-robin', passes: 20, drawsPerBlock: 1, characters: ['alpha'], pools: ['standard'] },
  });
  const first = runBatch(base, 5).session;
  const before = first.records.at(-1)!.progress.streaksAfter;
  assert.ok(before.ssr !== undefined);
  const { config: v2 } = addWeightVersion(first.config, 'standard', [{ id: 'ssr', weight: 6 }]);
  const second = runBatch(withConfig(first, v2), 1).session;
  const record = second.records[5]!;
  assert.equal(record.versionChange, 'upgrade');
  assert.equal(record.progress.strategy, 'reset');
  assert.deepEqual(record.progress.discardedStreaks, before);
  assert.deepEqual(record.progress.streaksBefore, { r: 0, sr: 0, ssr: 0 });
  assert.ok(record.notes.some((n) => n.includes('reset')));
});

test('快照往返: 序列化 → 反序列化 → 继续跑, 与一次跑完一致', () => {
  const config = sampleConfig();
  const p = plan({ passes: 4 });
  const reference = runAll(createSession(config, { seed: 'resume', plan: p }));

  let session = createSession(config, { seed: 'resume', plan: p });
  const half = Math.floor(planLength(p) / 2);
  session = runBatch(session, half).session;
  const json = sessionToJson(session);
  const restored = sessionFromJson(json);
  const finished = runAll(restored);

  assert.equal(finished.records.length, reference.records.length);
  assert.deepEqual(finished.records, reference.records);
  assert.deepEqual(finished.rng, reference.rng);
  assert.deepEqual(finished.progress, reference.progress);
});

test('多次分段续跑与一次跑完一致', () => {
  const config = sampleConfig();
  const p = plan({ passes: 4 });
  const reference = runAll(createSession(config, { seed: 'chunks', plan: p }));
  let session = createSession(config, { seed: 'chunks', plan: p });
  for (let i = 0; i < 7; i++) {
    session = sessionFromJson(sessionToJson(runBatch(session, 3).session));
  }
  session = runAll(session);
  assert.deepEqual(session.records, reference.records);
});

test('逐次试抽与批量跑完全等价', () => {
  const config = sampleConfig();
  const p = plan({ passes: 2 });
  const batch = runAll(createSession(config, { seed: 'step', plan: p }));
  let stepped = createSession(config, { seed: 'step', plan: p });
  for (;;) {
    const result = stepOnce(stepped);
    stepped = result.session;
    if (result.exhausted) break;
  }
  assert.deepEqual(stepped.records, batch.records);
});

test('从中点分叉: 改权重做对照, 原记录不受影响', () => {
  const config = sampleConfig();
  const p = plan({ passes: 4 });
  const reference = runAll(createSession(config, { seed: 'fork', plan: p }));
  const midpoint = Math.floor(planLength(p) / 2);

  const original = runBatch(createSession(config, { seed: 'fork', plan: p }), midpoint).session;
  const snapshotBefore = JSON.stringify(original);

  const { config: changed } = addWeightVersion(original.config, 'standard', [{ id: 'ssr', weight: 30 }]);
  const control = forkSession(original, { config: changed });
  const controlDone = runAll(control);
  const originalDone = runAll(original);

  // 原记录完全没被对照实验改动
  assert.equal(JSON.stringify(original), snapshotBefore);
  assert.deepEqual(originalDone.records, reference.records, '原分支应与基准一致');
  // 对照分支前半段完全相同, 后半段因权重不同而分叉
  assert.deepEqual(controlDone.records.slice(0, midpoint), reference.records.slice(0, midpoint));
  assert.notDeepEqual(
    controlDone.records.slice(midpoint).map((r) => `${r.poolId}#${r.poolVersion}`),
    reference.records.slice(midpoint).map((r) => `${r.poolId}#${r.poolVersion}`),
  );
  assert.ok(controlDone.records.slice(midpoint).some((r) => r.poolId === 'standard' && r.poolVersion === 2));
});

test('分叉得到的配置与原配置是两棵独立的树', () => {
  const config = sampleConfig();
  const session = createSession(config, { seed: 'deep', plan: plan({ passes: 1 }) });
  const fork = forkSession(session);
  const { config: changed } = addWeightVersion(fork.config, 'standard', [{ id: 'ssr', weight: 99 }]);
  assert.notEqual(changed, fork.config);
  assert.deepEqual(session.config, config);
  assert.equal(fork.config.pools.find((p) => p.id === 'standard')!.versions.length, 1);
});

test('每抽记录随机状态、池版本与组进度', () => {
  const config = sampleConfig();
  const p = plan({ passes: 2 });
  const session = runAll(createSession(config, { seed: 'fields', plan: p }));
  let previous = createSession(config, { seed: 'fields', plan: p }).rng;
  for (const record of session.records) {
    assert.deepEqual(record.rngBefore, previous, '本抽的抽前状态应等于上一抽的抽后状态');
    assert.equal(record.poolVersion, 1);
    assert.equal(record.poolVersionLabel, 'v1-' + (record.poolId === 'standard' ? '标准' : record.poolId === 'featured' ? '限定' : '武器'));
    assert.equal(typeof record.progress.key, 'string');
    previous = record.rngAfter;
  }
});

test('withConfig 不合法配置被拒绝', () => {
  const config = sampleConfig();
  const session = createSession(config, { seed: 'bad', plan: plan({ passes: 1 }) });
  const broken = structuredClone(config) as unknown as { groups: { id: string }[] };
  broken.groups[0]!.id = 'renamed';
  assert.throws(() => withConfig(session, broken as never));
});

test('共享组内池的稀有度 id 集合必须一致', () => {
  const config = sampleConfig();
  const bad = structuredClone(config) as unknown as {
    pools: { id: string; versions: { rarities: { id: string }[] }[] }[];
  };
  bad.pools.find((p) => p.id === 'weapon')!.versions[0]!.rarities.pop();
  assert.throws(() => createSession(bad as never, { seed: 'x' }));
});

test('setSharedGroup 后切池开始共用进度', () => {
  const config = sampleConfig();
  const joined = setSharedGroup(config, 'standard', 'banner-group');
  const session = createSession(joined, {
    seed: 'join',
    plan: {
      mode: 'pool-blocks',
      passes: 1,
      drawsPerBlock: 3,
      characters: ['alpha'],
      pools: ['featured', 'standard'],
    },
  });
  const result = runBatch(session, planLength(session.plan));
  const standardFirst = result.records.find((r) => r.poolId === 'standard')!;
  assert.equal(standardFirst.progress.scope, 'group');
  assert.equal(standardFirst.progress.strategy, 'shared-group');
});

test('版本中暂时移除的稀有度: 进度冻结, 回退后原样沿用', () => {
  const config = sampleConfig();
  const plan: RunPlan = {
    mode: 'round-robin',
    passes: 10,
    drawsPerBlock: 1,
    characters: ['alpha'],
    pools: ['standard'],
  };
  const base = runBatch(createSession(config, { seed: 'freeze', plan }), 4).session;
  const before = base.records.at(-1)!.progress.streaksAfter;

  // v2: 删掉 sr 稀有度
  const twoRarity = structuredClone(config) as unknown as {
    pools: { id: string; versions: { rarities: { id: string }[] }[] }[];
  };
  twoRarity.pools[0]!.versions[0]!.rarities = twoRarity.pools[0]!.versions[0]!.rarities.filter((r) => r.id !== 'sr');
  const { config: v2 } = addWeightVersion(twoRarity as never, 'standard', []);
  const upgraded = runBatch(withConfig(base, v2), 3).session;
  const afterUpgrade = upgraded.records.at(-1)!.progress.streaksAfter;
  assert.equal(afterUpgrade.sr, before.sr, '被移除的 sr 进度应冻结, 而不是继续累加');
  assert.equal(afterUpgrade.ssr, (before.ssr ?? 0) + 3, '仍在版本里的 ssr 应正常推进');

  // 回退到 v1 (含 sr), 进度应原样接上
  const backConfig = activateVersion(upgraded.config, 'standard', 1);
  const back = runBatch(withConfig(upgraded, backConfig), 1).session;
  const record = back.records.at(-1)!;
  assert.equal(record.versionChange, 'revert');
  assert.equal(record.progress.streaksBefore.sr, before.sr);
});
