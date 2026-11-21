#!/usr/bin/env node
/**
 * 一键验证: 类型检查 + 全部测试 + 关键行为的端到端断言。
 *
 *   node scripts/verify.ts            # 类型检查 + 测试 + 场景校验
 *   node scripts/verify.ts --no-tests # 只跑场景校验
 *
 * 场景校验不依赖测试文件, 直接驱动公开 API 检查需求 1-7 的关键性质,
 * 任何一条不满足都会以非 0 退出码结束 (适合放进 CI)。
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addWeightVersion, activateVersion, setSharedGroup, setVersionPolicy } from '../src/builder.ts';
import { configErrors, findPool, progressKeyOf } from '../src/config.ts';
import {
  createSession,
  forkSession,
  planLength,
  remainingDraws,
  runBatch,
  sessionFromJson,
  stepAt,
  sessionToJson,
  stepOnce,
  withConfig,
  type RunPlan,
  type Session,
} from '../src/engine.ts';
import { exportRun } from '../src/export.ts';
import { edgeCaseConfig, sampleConfig } from '../src/samples.ts';
import { buildReport, diffRecords, segmentDraws, summarizeArm } from '../src/stats.ts';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

let checks = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function runAll(session: Session): Session {
  let current = session;
  for (;;) {
    const result = runBatch(current, planLength(current.plan));
    current = result.session;
    if (result.exhausted) return current;
  }
}

const basePlan = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  mode: 'round-robin',
  passes: 60,
  drawsPerBlock: 10,
  characters: ['alpha', 'beta'],
  pools: ['standard', 'featured', 'weapon'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function verifyBasics(): Promise<void> {
  section('1. 配置: 最多三种稀有度 / 权重 / 加成 / 保底阈值');
  const config = sampleConfig();
  check('样例配置无错误', configErrors(config).length === 0, JSON.stringify(configErrors(config)));
  check(
    '每个池最多 3 种稀有度',
    config.pools.every((pool) =>
      pool.versions.every((version) => version.rarities.length <= 3),
    ),
  );
  check(
    '每个池都配置了权重 / 加成 / 阈值字段',
    config.pools.every((pool) =>
      pool.versions.every((version) =>
        version.rarities.every(
          (r) =>
            Number.isFinite(r.weight) &&
            Number.isFinite(r.bonusPerMiss) &&
            (r.pityThreshold === null || Number.isInteger(r.pityThreshold)),
        ),
      ),
    ),
  );

  // 超限配置必须被拒绝
  const four = structuredClone(config) as unknown as {
    pools: { id: string; versions: { rarities: unknown[] }[] }[];
  };
  four.pools[0]!.versions[0]!.rarities.push({
    id: 'ur',
    label: 'UR',
    weight: 1,
    bonusPerMiss: 0,
    pityThreshold: null,
  });
  check('四种稀有度被拒绝', configErrors(four as never).some((e) => e.path.includes('rarities')));
}

async function verifyDeterminism(): Promise<void> {
  section('2. 固定种子 / 逐次试抽 / 保底前后原因');
  const config = sampleConfig();
  const plan = basePlan({ passes: 40 });
  const a = runAll(createSession(config, { seed: 'verify-seed', plan }));
  const b = runAll(createSession(config, { seed: 'verify-seed', plan }));
  check('同种子逐条一致', diffRecords(a.records, b.records).length === 0);

  const c = runAll(createSession(config, { seed: 'other-seed', plan }));
  check('不同种子结果不同', diffRecords(a.records, c.records).length > 0);

  let stepped = createSession(config, { seed: 'verify-seed', plan });
  for (;;) {
    const result = stepOnce(stepped);
    stepped = result.session;
    if (result.exhausted) break;
  }
  check('逐次试抽与批量跑一致', diffRecords(a.records, stepped.records).length === 0);

  const report = buildReport(a);
  check('报告统计了命中规则分布', report.ruleCounts.weighted + report.ruleCounts.pity + report.ruleCounts.empty === planLength(plan));
  const standard = report.pools.find((p) => p.poolId === 'standard')!;
  check('标准池出现了硬保底命中', standard.ruleCounts.pity > 0, `pity=${standard.ruleCounts.pity}`);
  const ssr = standard.rarities.find((r) => r.id === 'ssr')!;
  check('SSR 同时有加成命中和保底命中', ssr.bonusHits > 0 && ssr.pityHits > 0);
  check('每抽都记录了保底原因说明', a.records.every((r) => r.notes.some((n) => n.startsWith('实际触发规则'))));
}

async function verifyMultiCharacter(): Promise<void> {
  section('3. 多角色独立进度; 调权重后清空 / 继承');
  const config = sampleConfig();
  const plan = basePlan({ passes: 20, pools: ['standard'] });
  const session = runAll(createSession(config, { seed: 'chars', plan }));
  const alphaKeys = new Set(session.records.filter((r) => r.characterId === 'alpha').map((r) => r.progress.key));
  const betaKeys = new Set(session.records.filter((r) => r.characterId === 'beta').map((r) => r.progress.key));
  check('两个角色的进度 key 不重叠', [...alphaKeys].every((k) => !betaKeys.has(k)), `${[...alphaKeys]} vs ${[...betaKeys]}`);

  // 从同一检查点分叉: inherit vs reset
  const partialSession = createSession(config, { seed: 'chars-fork', plan });
  const partial = runBatch(partialSession, 15).session;
  // 下一抽属于哪个角色, 就用哪份进度做对照 (计划按角色轮转)
  const nextStep = stepAt(plan, partial.records.length)!;
  const nextKey = progressKeyOf(
    findPool(partial.config, nextStep.poolId),
    nextStep.characterId,
  );
  const before = partial.progress[nextKey]!.streaks;
  const { config: v2 } = addWeightVersion(partial.config, 'standard', [{ id: 'ssr', weight: 12 }]);
  const inheritRecord = runBatch(withConfig(partial, v2), 1).session.records.at(-1)!;
  check('新版本被记录为 v2', inheritRecord.poolVersion === 2);
  check('inherit 策略沿用进度', inheritRecord.progress.strategy === 'inherited');
  check(
    '沿用后的抽前 streak 与检查点记录的进度一致',
    JSON.stringify(inheritRecord.progress.streaksBefore) === JSON.stringify(before),
    `${JSON.stringify(inheritRecord.progress.streaksBefore)} vs ${JSON.stringify(before)}`,
  );

  const reset = setVersionPolicy(v2, 'standard', 'reset');
  const resetRecord = runBatch(withConfig(partial, reset), 1).session.records.at(-1)!;
  check('reset 策略清空进度', resetRecord.progress.strategy === 'reset');
  check('reset 时记录被丢弃的进度', JSON.stringify(resetRecord.progress.discardedStreaks) === JSON.stringify(before));
  check('reset 后抽前 streak 全 0', Object.values(resetRecord.progress.streaksBefore).every((v) => v === 0));
}

async function verifyStats(): Promise<void> {
  section('4. 分段命中率 / 最长未中 / 实际命中的权重版本');
  const config = sampleConfig();
  const plan = basePlan({ passes: 500, characters: ['alpha'], pools: ['standard'] });
  const first = runBatch(createSession(config, { seed: 'stats', plan }), 250).session;
  const { config: v2 } = addWeightVersion(first.config, 'standard', [{ id: 'ssr', weight: 12 }], {
    label: 'v2-提权',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const finished = runAll(withConfig(first, v2));
  const report = buildReport(finished);

  check('两个版本都被统计', report.versions.length === 2);
  check('v1 / v2 抽数之和等于总抽数', report.versions.reduce((s, v) => s + v.draws, 0) === 500);
  check('v2 记录了自己的标签', report.versions.some((v) => v.version === 2 && v.label === 'v2-提权'));

  const segments = segmentDraws(finished.records, { poolId: 'standard' }, 10);
  check('分段抽数之和等于总抽数', segments.reduce((s, b) => s + b.draws, 0) === 500);
  const solid = segments.filter((s) => s.draws >= 20);
  check('存在至少两个有样本的分段', solid.length >= 2, `solid=${solid.length}`);
  if (solid.length >= 2) {
    const early = solid[0]!;
    const late = solid.at(-1)!;
    check(
      '高 streak 段的 SSR 命中率更高',
      (late.rates.ssr ?? 0) > (early.rates.ssr ?? 0),
      `${early.rates.ssr} -> ${late.rates.ssr}`,
    );
  }

  const pool = report.pools.find((p) => p.poolId === 'standard')!;
  const ssr = pool.rarities.find((r) => r.id === 'ssr')!;
  check('SSR 最长未中不超过阈值', ssr.maxMissStreak <= 15, `maxMiss=${ssr.maxMissStreak}`);
  check('最长未中 > 0 (说明记录的是真实观测)', ssr.maxMissStreak > 0);
}

async function verifyEdgeCases(dir: string): Promise<void> {
  section('5. 导出; 边界用例: 必定保底 / 空池 / 零权重');
  const config = sampleConfig();
  const session = runAll(createSession(config, { seed: 'export', plan: basePlan({ passes: 5 }) }));
  const exported = await exportRun(
    { config, session, report: buildReport(session), meta: { seed: session.seed } },
    { dir, prefix: 'verify' },
  );
  check('导出了配置 / 快照 / 时间线 / 报告 / meta', exported.files.length === 5, exported.files.join(', '));

  const edge = edgeCaseConfig();
  const edgePlan = (pool: string, passes: number): RunPlan => ({
    mode: 'round-robin',
    passes,
    drawsPerBlock: 1,
    characters: ['solo'],
    pools: [pool],
  });

  const pityNow = runAll(createSession(edge, { seed: 'edge', plan: edgePlan('pity-now', 5) }));
  check(
    '必定保底: 每抽都是 pity 且命中 SSR',
    pityNow.records.every((r) => r.rule === 'pity' && r.hit?.id === 'ssr'),
    pityNow.records.map((r) => r.rule).join(','),
  );

  const empty = createSession(edge, { seed: 'edge', plan: edgePlan('empty', 5) });
  const emptyRun = runAll(empty);
  check('空池: 每抽 empty 且不消耗随机数', emptyRun.records.every((r) => r.rule === 'empty' && r.roll === null));
  check('空池: 随机数计数不变', empty.rng.draws === emptyRun.rng.draws);

  const zero = runAll(createSession(edge, { seed: 'edge', plan: edgePlan('zero-weight', 7) }));
  check('零权重无保底: 每抽 empty', zero.records.every((r) => r.rule === 'empty'));
  check('零权重: 进度仍然推进', zero.records.at(-1)!.progress.streaksAfter.ssr === 7);

  const zeroPity = runAll(createSession(edge, { seed: 'edge', plan: edgePlan('zero-with-pity', 10) }));
  const rules = zeroPity.records.map((r) => r.rule);
  check(
    '零权重 + 阈值 5: 第 5 / 10 抽靠硬保底命中',
    rules[4] === 'pity' && rules[9] === 'pity' && rules[0] === 'empty',
    rules.join(','),
  );
  check('零权重保底仍命中 SSR', zeroPity.records[4]!.hit?.id === 'ssr');
}

async function verifySharedGroup(): Promise<void> {
  section('6. 共享保底组; 切池 / 回退版本的沿用进度与实际规则');
  const config = sampleConfig();
  const plan: RunPlan = {
    mode: 'pool-blocks',
    passes: 1,
    drawsPerBlock: 8,
    characters: ['alpha'],
    pools: ['featured', 'weapon', 'standard'],
  };
  const session = runAll(createSession(config, { seed: 'group', plan }));
  const featured = session.records.filter((r) => r.poolId === 'featured');
  const weapon = session.records.filter((r) => r.poolId === 'weapon');
  const standard = session.records.filter((r) => r.poolId === 'standard');

  check('featured 使用组进度', featured.every((r) => r.progress.scope === 'group' && r.progress.ownerId === 'banner-group'));
  check('weapon 使用同一组进度', weapon.every((r) => r.progress.key === featured[0]!.progress.key));
  check(
    'weapon 首抽沿用 featured 末抽后的 streak',
    JSON.stringify(weapon[0]!.progress.streaksBefore) === JSON.stringify(featured.at(-1)!.progress.streaksAfter),
  );
  check('weapon 首抽被标记为 shared-group', weapon[0]!.progress.strategy === 'shared-group');
  check('weapon 首抽说明包含"共用同一份连续未中进度"', weapon[0]!.notes.some((n) => n.includes('共用同一份连续未中进度')));
  check('standard 使用独立池进度', standard.every((r) => r.progress.scope === 'pool'));
  check('standard 首抽从 0 开始', Object.values(standard[0]!.progress.streaksBefore).every((v) => v === 0));

  // 共享组确实会"跨池"地触发保底:
  //   1) 在 featured 里把 SSR 设成永远不中 (零权重、无保底) → streak 一直累积;
  //   2) 在 weapon 里把 SSR 阈值压到 2 → 切池后立刻触发硬保底。
  const { config: hotFeatured } = addWeightVersion(
    config,
    'featured',
    [{ id: 'ssr', weight: 0, bonusPerMiss: 0, pityThreshold: null }],
    { label: 'v2-禁用SSR' },
  );
  const { config: hot } = addWeightVersion(
    hotFeatured,
    'weapon',
    [{ id: 'ssr', weight: 0, bonusPerMiss: 0, pityThreshold: 2 }],
    { label: 'v2-快速保底' },
  );
  const hotPlan: RunPlan = {
    mode: 'pool-blocks',
    passes: 1,
    drawsPerBlock: 4,
    characters: ['alpha'],
    pools: ['featured', 'weapon'],
  };
  const hotRun = runAll(createSession(hot, { seed: 'group-hot', plan: hotPlan }));
  const weaponPity = hotRun.records.filter((r) => r.poolId === 'weapon' && r.rule === 'pity');
  check('在武器池触发了由组进度带来的保底', weaponPity.length > 0, `pity=${weaponPity.length}`);
  if (weaponPity.length > 0) {
    check(
      '该保底的抽前 streak 来自组内其他池',
      weaponPity[0]!.progress.scope === 'group' && weaponPity[0]!.details.find((d) => d.id === 'ssr')!.streakBefore >= 1,
      `streakBefore=${weaponPity[0]!.details.find((d) => d.id === 'ssr')!.streakBefore}`,
    );
    check('保底说明包含"硬保底"', weaponPity[0]!.notes.some((n) => n.includes('硬保底')));
  }

  // 回退版本: 沿用进度 + 本次实际触发的规则
  const backPlan: RunPlan = {
    mode: 'pool-blocks',
    passes: 3,
    drawsPerBlock: 4,
    characters: ['alpha'],
    pools: ['featured'],
  };
  const partial = runBatch(createSession(config, { seed: 'revert', plan: backPlan }), 5).session;
  const { config: v2 } = addWeightVersion(partial.config, 'featured', [{ id: 'ssr', weight: 20 }], {
    label: 'v2-20',
    createdAt: '2026-01-03T00:00:00.000Z',
  });
  const upgraded = runBatch(withConfig(partial, v2), 3).session;
  const backConfig = activateVersion(upgraded.config, 'featured', 1);
  const back = runBatch(withConfig(upgraded, backConfig), 1).session;
  const record = back.records.at(-1)!;
  check('回退被标记为 revert', record.versionChange === 'revert');
  check('回退记录实际版本 v1', record.poolVersion === 1);
  check('回退时沿用进度', record.progress.strategy === 'inherited');
  check('回退时抽前 streak 等于升级段末的 streak', JSON.stringify(record.progress.streaksBefore) === JSON.stringify(upgraded.records.at(-1)!.progress.streaksAfter));
  check('回退说明写明沿用了连续未中进度', record.notes.some((n) => n.includes('回退') && n.includes('沿用')));

  // 未加入共享组的池仍独立: 临时把 standard 拉进组再验证
  const joined = setSharedGroup(config, 'standard', 'banner-group');
  const joinedPlan: RunPlan = { ...plan, pools: ['weapon', 'standard'] };
  const joinedRun = runAll(createSession(joined, { seed: 'joined', plan: joinedPlan }));
  const stdFirst = joinedRun.records.find((r) => r.poolId === 'standard')!;
  check('加入组后 standard 改用组进度', stdFirst.progress.scope === 'group');
  check('加入组后 standard 首抽即为 shared-group', stdFirst.progress.strategy === 'shared-group');
}

async function verifyResumeAndFork(dir: string): Promise<void> {
  section('7. 每抽记录随机状态 / 池版本 / 组进度; 断点续跑; 中点分叉');
  const config = sampleConfig();
  const plan = basePlan({ passes: 30 });
  const total = planLength(plan);
  const reference = runAll(createSession(config, { seed: 'resume', plan }));

  check(
    '每抽都记录随机状态 / 版本 / 进度 key',
    reference.records.every(
      (r) =>
        Number.isInteger(r.rngBefore.state) &&
        Number.isInteger(r.rngAfter.state) &&
        Number.isInteger(r.poolVersion) &&
        typeof r.progress.key === 'string' &&
        r.progress.streaksBefore !== undefined,
    ),
  );
  check(
    '相邻两抽的随机状态前后衔接',
    reference.records.every((r, i) => i === 0 || JSON.stringify(reference.records[i - 1]!.rngAfter) === JSON.stringify(r.rngBefore)),
  );

  const half = Math.floor(total / 2);
  const firstHalf = runBatch(createSession(config, { seed: 'resume', plan }), half).session;
  const snapshotPath = join(dir, 'half-session.json');
  await import('node:fs/promises').then((fs) => fs.writeFile(snapshotPath, sessionToJson(firstHalf), 'utf8'));
  const { readFile } = await import('node:fs/promises');
  const restored = sessionFromJson(await readFile(snapshotPath, 'utf8'));
  check('恢复后剩余抽数正确', remainingDraws(restored) === total - half);
  const resumed = runAll(restored);
  check('恢复续跑与一次跑完逐条一致', diffRecords(reference.records, resumed.records).length === 0);

  // 多次分块续跑 (每次都过一遍 JSON)
  let chunked = createSession(config, { seed: 'resume', plan });
  while (!chunked.records.length || chunked.records.length < total) {
    const step = runBatch(chunked, 7);
    chunked = sessionFromJson(sessionToJson(step.session));
    if (step.exhausted) break;
  }
  check('分块续跑与一次跑完逐条一致', diffRecords(reference.records, chunked.records).length === 0);

  // 中点复制设定改权重
  const snapshotBefore = JSON.stringify(firstHalf);
  const { config: changed } = addWeightVersion(firstHalf.config, 'standard', [{ id: 'ssr', weight: 25 }], {
    label: 'v2-对照',
    createdAt: '2026-01-04T00:00:00.000Z',
  });
  const control = runAll(forkSession(firstHalf, { config: changed }));
  const original = runAll(firstHalf);
  check('对照实验未修改原记录', JSON.stringify(firstHalf) === snapshotBefore);
  check('原分支与参考运行一致', diffRecords(reference.records, original.records).length === 0);
  check(
    '对照分支前半段与原分支一致',
    diffRecords(reference.records.slice(0, half), control.records.slice(0, half)).length === 0,
  );
  check(
    '对照分支后半段使用了新版本',
    control.records.slice(half).some((r) => r.poolId === 'standard' && r.poolVersion === 2),
  );
  check(
    '对照分支后半段与原分支不同',
    diffRecords(reference.records.slice(half), control.records.slice(half)).length > 0,
  );

  const left = summarizeArm('原设定', original);
  const right = summarizeArm('对照', control);
  const exported = await exportRun(
    { config: control.config, session: control, report: buildReport(control), comparison: { left, right } },
    { dir, prefix: 'fork' },
  );
  check('对照实验导出包含 comparison.json', exported.files.some((f) => f.endsWith('fork-comparison.json')));
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function runTypecheck(): boolean {
  section('类型检查 (tsc --noEmit)');
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], {
    stdio: 'inherit',
  });
  const ok = result.status === 0;
  console.log(ok ? '  ✔ 类型检查通过' : '  ✘ 类型检查失败');
  return ok;
}

function runTests(): boolean {
  section('单元测试 (node --test)');
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'test/rng.test.ts', 'test/config.test.ts', 'test/engine.test.ts', 'test/stats.test.ts'], {
    stdio: 'inherit',
  });
  const ok = result.status === 0;
  console.log(ok ? '  ✔ 全部测试通过' : '  ✘ 测试失败');
  return ok;
}

async function main(): Promise<void> {
  const skipTests = process.argv.includes('--no-tests');
  const started = performance.now();
  console.log('drop-pity-lab 验证');
  console.log('='.repeat(60));

  let typecheckOk = true;
  let testsOk = true;
  if (!skipTests) {
    typecheckOk = runTypecheck();
    testsOk = runTests();
  }

  const dir = await mkdtemp(join(tmpdir(), 'drop-pity-verify-'));
  try {
    await verifyBasics();
    await verifyDeterminism();
    await verifyMultiCharacter();
    await verifyStats();
    await verifyEdgeCases(dir);
    await verifySharedGroup();
    await verifyResumeAndFork(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  section('结果');
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  console.log(`  场景断言: ${checks - failures.length}/${checks} 通过, 耗时 ${elapsed}s`);
  if (!skipTests) {
    console.log(`  类型检查: ${typecheckOk ? '通过' : '失败'}`);
    console.log(`  单元测试: ${testsOk ? '通过' : '失败'}`);
  }
  if (failures.length > 0) {
    console.log('');
    console.log('失败项:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  const ok = failures.length === 0 && typecheckOk && testsOk;
  console.log('');
  console.log(ok ? '✔ 验证通过' : '✘ 验证失败');
  process.exit(ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
