#!/usr/bin/env node
/**
 * drop-pity-lab 命令行入口。
 *
 * 用法:
 *   node src/cli.ts demo [--section 1..7] [--seed <s>] [--passes N]
 *   node src/cli.ts run [--config file.json] [--seed <s>] [--passes N] [--mode round-robin|pool-blocks]
 *                       [--draws-per-block N] [--characters a,b] [--pools x,y] [--export dir]
 *   node src/cli.ts step [--config file.json] [--seed <s>] [--count N] [--passes N] [--export dir]
 *   node src/cli.ts resume --session file.json [--count N] [--export dir]
 *   node src/cli.ts export --config file.json --seed <s> [--passes N] --out dir
 *
 * 所有样例都在程序内生成, 不需要任何外部数据文件。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { addWeightVersion, activateVersion, setVersionPolicy } from './builder.ts';
import { validateConfig, type LabConfig, type PoolConfig } from './config.ts';
import {
  createSession,
  defaultPlan,
  forkSession,
  planLength,
  remainingDraws,
  runBatch,
  sessionFromJson,
  sessionToJson,
  stepOnce,
  withConfig,
  type PlanMode,
  type RunPlan,
  type Session,
} from './engine.ts';
import { exportRun } from './export.ts';
import { displayWidth, renderComparison, renderReport, padEnd, formatDuration } from './render.ts';
import { edgeCaseConfig, sampleConfig } from './samples.ts';
import {
  buildReport,
  buildTimeline,
  diffRecords,
  segmentDraws,
  summarizeArm,
} from './stats.ts';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function heading(title: string): void {
  console.log('');
  console.log('╔' + '═'.repeat(76) + '╗');
  console.log('║ ' + padEnd(title, 75) + '║');
  console.log('╚' + '═'.repeat(76) + '╝');
}

function kv(pairs: readonly (readonly [string, string])[]): void {
  const width = Math.max(...pairs.map(([k]) => displayWidth(k)));
  for (const [key, value] of pairs) console.log(`  ${padEnd(key, width)} : ${value}`);
}

function exitWithError(message: string): never {
  console.error(`错误: ${message}`);
  process.exit(1);
}

async function loadConfig(path: string | undefined): Promise<LabConfig> {
  if (!path) return sampleConfig();
  const text = await readFile(resolve(path), 'utf8');
  const parsed = JSON.parse(text) as LabConfig;
  const errors = validateConfig(parsed).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    exitWithError(`配置 ${path} 不合法:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`);
  }
  return parsed;
}

function runAll(session: Session): Session {
  let current = session;
  for (;;) {
    const result = runBatch(current, planLength(current.plan));
    current = result.session;
    if (result.exhausted) return current;
  }
}

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  if (!value) return [...fallback];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    exitWithError(`--${name} 必须是 >= 0 的整数, 收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

function makePlan(
  config: LabConfig,
  values: { passes?: string; mode?: string; drawsPerBlock?: string; characters?: string; pools?: string },
): RunPlan {
  const base = defaultPlan(config, 10);
  const mode = (values.mode ?? base.mode) as PlanMode;
  if (mode !== 'round-robin' && mode !== 'pool-blocks') {
    exitWithError(`--mode 只能是 round-robin 或 pool-blocks, 收到 ${values.mode}`);
  }
  const plan: RunPlan = {
    ...base,
    mode,
    passes: parsePositiveInt('passes', values.passes, base.passes),
    drawsPerBlock: parsePositiveInt('draws-per-block', values.drawsPerBlock, base.drawsPerBlock),
    characters: parseList(values.characters, base.characters),
    pools: parseList(values.pools, base.pools),
  };
  if (plan.characters.length === 0) exitWithError('--characters 不能为空');
  if (plan.pools.length === 0) exitWithError('--pools 不能为空');
  const knownCharacters = new Set(config.characters.map((c) => c.id));
  const knownPools = new Set(config.pools.map((p) => p.id));
  for (const id of plan.characters) {
    if (!knownCharacters.has(id)) {
      exitWithError(`未知角色 ${id}; 可用: ${[...knownCharacters].join(', ')}`);
    }
  }
  for (const id of plan.pools) {
    if (!knownPools.has(id)) exitWithError(`未知物品池 ${id}; 可用: ${[...knownPools].join(', ')}`);
  }
  return plan;
}

function seedOf(values: { seed?: string }): string {
  return values.seed ?? 'drop-pity-demo';
}

function describePool(pool: PoolConfig): string[] {
  return pool.versions
    .filter((v) => v.version === pool.activeVersion)
    .flatMap((version) => [
      `  版本 v${version.version} (${version.label})`,
      ...version.rarities.map(
        (r) =>
          `    ${padEnd(r.label, 5)} id=${padEnd(r.id, 4)} 权重=${padEnd(String(r.weight), 5)} 加成/未中=${padEnd(String(r.bonusPerMiss), 4)} 硬保底阈值=${r.pityThreshold ?? '无'}`,
      ),
      version.rarities.length === 0 ? '    (空池: 无稀有度)' : '',
    ])
    .filter((text) => text.length > 0);
}

// ---------------------------------------------------------------------------
// demo: 逐条覆盖需求 1-7
// ---------------------------------------------------------------------------

interface DemoOptions {
  readonly seed: string;
  readonly passes: number;
  readonly section?: number;
}

async function demo(options: DemoOptions): Promise<void> {
  const config = sampleConfig();
  const { seed } = options;

  console.log('drop-pity-lab — 掉落保底模拟器');
  console.log(`种子: ${seed}   样例配置 ${config.characters.length} 角色 / ${config.pools.length} 物品池 / ${config.groups.length} 保底组`);

  const section = options.section;
  const run = (index: number): boolean => section === undefined || section === index;

  // ---------------------------------------------------------------- 1
  if (run(1)) {
    heading('1. 稀有度 / 权重 / 连续未中加成 / 保底阈值');
    for (const pool of config.pools) {
      console.log('');
      console.log(`物品池 ${pool.label} (${pool.id})` + (pool.sharedGroupId ? `  [共享组 ${pool.sharedGroupId}]` : '  [独立]'));
      for (const text of describePool(pool)) console.log(text);
    }
    console.log('');
    console.log('规则: 有效权重 = 基础权重 + 加成 × 连续未中次数;');
    console.log('      连续未中次数 + 1 >= 硬保底阈值时, 本次强制命中该稀有度。');
    console.log('      每种稀有度的连续未中数独立累计, 命中即归零。');
  }

  // ---------------------------------------------------------------- 2
  if (run(2)) {
    heading('2. 固定种子多轮 + 逐次试抽: 保底前后的抽中原因');
    const plan: RunPlan = {
      mode: 'round-robin',
      passes: options.passes,
      drawsPerBlock: 10,
      characters: ['alpha'],
      pools: ['standard'],
    };
    const session = runAll(createSession(config, { seed, plan }));
    console.log(`共 ${session.records.length} 抽, 计划: ${plan.passes} 轮 × standard 池 × 角色 alpha`);
    const segments = segmentDraws(session.records, { poolId: 'standard' }, 10);
    console.log('');
    console.log('分段命中率 (按抽前最大连续未中分段, 每 10 次一档):');
    for (const bucket of segments) {
      console.log(
        `  ${padEnd(`${bucket.from}-${bucket.to}`, 9)} 抽数 ${padEnd(String(bucket.draws), 5)} ` +
          Object.entries(bucket.hits)
            .map(([id, hits]) => `${id}:${hits}/${bucket.draws}=${(((bucket.rates[id] ?? 0) * 100).toFixed(1))}%`)
            .join('  '),
      );
    }
    const report = buildReport(session);
    const pool = report.pools[0]!;
    const ssr = pool.rarities.find((r) => r.id === 'ssr')!;
    const standardPool = config.pools.find((p) => p.id === 'standard')!;
    const standardVersion = standardPool.versions.find((v) => v.version === standardPool.activeVersion)!;
    const ssrThreshold = standardVersion.rarities.find((r) => r.id === 'ssr')?.pityThreshold ?? null;
    console.log('');
    kv([
      ['SSR 命中', `${ssr.hits}/${ssr.draws} = ${(ssr.rate * 100).toFixed(2)}% (名义 ${((ssr.nominalRate ?? 0) * 100).toFixed(2)}%)`],
      ['其中保底命中', String(ssr.pityHits)],
      ['其中加成命中', String(ssr.bonusHits)],
      ['其中基础权重命中', String(ssr.weightedHits)],
      ['SSR 最长未中', `${ssr.maxMissStreak} 抽 (阈值 ${ssrThreshold ?? '无'})`],
      ['规则分布', `权重 ${report.ruleCounts.weighted} / 保底 ${report.ruleCounts.pity} / 空 ${report.ruleCounts.empty}`],
    ]);
    console.log('');
    console.log('逐抽解释 (最后 12 抽 + 抽中保底的那几抽):');
    const timeline = buildTimeline(session.records);
    const tail = timeline.slice(-12);
    const pityIndices = session.records.filter((r) => r.rule === 'pity').map((r) => r.index);
    const extra = pityIndices
      .filter((index) => !tail.some((entry) => entry.index === index))
      .slice(0, 3)
      .map((index) => timeline[index]!)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    if (extra.length > 0) {
      console.log(`  先看保底触发的抽: #${extra.map((e) => e.index).join(', #')}`);
      for (const entry of extra) {
        const streak = Object.entries(entry.streaksBefore)
          .map(([id, v]) => `${id}=${v}`)
          .join(',');
        console.log(
          `  #${padEnd(String(entry.index), 4)} ${padEnd(entry.poolId, 9)} v${entry.version} roll=${entry.roll === null ? '-' : entry.roll.toFixed(6)} ` +
            `${padEnd(entry.rule, 8)} 命中=${padEnd(entry.hit ?? '-', 4)} 抽前[${streak}]`,
        );
        console.log(`        ${entry.notes.join(' | ')}`);
      }
      console.log('  再看最后 12 抽:');
    }
    for (const entry of tail) {
      const streak = Object.entries(entry.streaksBefore)
        .map(([id, v]) => `${id}=${v}`)
        .join(',');
      console.log(
        `  #${padEnd(String(entry.index), 4)} ${padEnd(entry.poolId, 9)} v${entry.version} roll=${entry.roll === null ? '-' : entry.roll.toFixed(6)} ` +
          `${padEnd(entry.rule, 8)} 命中=${padEnd(entry.hit ?? '-', 4)} 抽前[${streak}]`,
      );
      console.log(`        ${entry.notes.join(' | ')}`);
    }
  }

  // ---------------------------------------------------------------- 3
  if (run(3)) {
    heading('3. 多角色独立进度; 调权重后可选清空或继承');
    const plan: RunPlan = {
      mode: 'round-robin',
      passes: 12,
      drawsPerBlock: 10,
      characters: ['alpha', 'beta'],
      pools: ['standard'],
    };
    // 计划留足余量: 先只跑 12 轮 (24 抽), 后续还要在同一个 Session 上继续抽
    const longPlan: RunPlan = { ...plan, passes: plan.passes + 2 };
    const base = runBatch(createSession(config, { seed: `${seed}-ch3`, plan: longPlan }), 12 * 2).session;
    console.log('两个角色在同一池各跑 12 抽, 进度按「角色 + 池」隔离:');
    for (const characterId of ['alpha', 'beta']) {
      const records = base.records.filter((r) => r.characterId === characterId);
      const key = records[0]!.progress.key;
      const last = records.at(-1)!;
      console.log(`  ${characterId}: progress key = ${key}`);
      console.log(`    抽后 streak: ${Object.entries(last.progress.streaksAfter).map(([id, v]) => `${id}=${v}`).join(', ')}`);
    }
    console.log(`  两个角色的进度 key 不同 → 同一物品池里互不影响。`);

    // 从同一个检查点分叉两条实验, 避免相互干扰
    const { config: v2 } = addWeightVersion(base.config, 'standard', [{ id: 'ssr', weight: 12 }], {
      label: 'v2-SSR 提权',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    const inheritRecord = runBatch(withConfig(base, v2), 1).session.records.at(-1)!;
    console.log('');
    console.log('调权重生成 v2 (SSR 5 → 12) 后继续抽, 默认策略 inherit:');
    console.log(`  抽前 streak: ${JSON.stringify(inheritRecord.progress.streaksBefore)}`);
    console.log(`  使用版本: v${inheritRecord.poolVersion} (${inheritRecord.poolVersionLabel}), 策略=${inheritRecord.progress.strategy}`);
    console.log(`  说明: ${inheritRecord.notes.join(' | ')}`);

    const resetConfig = setVersionPolicy(v2, 'standard', 'reset');
    const resetRecord = runBatch(withConfig(base, resetConfig), 1).session.records.at(-1)!;
    console.log('');
    console.log('同一检查点, 把策略改成 reset 后再抽:');
    console.log(`  抽前 streak: ${JSON.stringify(resetRecord.progress.streaksBefore)} (原进度已丢弃: ${JSON.stringify(resetRecord.progress.discardedStreaks)})`);
    console.log(`  策略=${resetRecord.progress.strategy}`);
    console.log(`  说明: ${resetRecord.notes.join(' | ')}`);
  }

  // ---------------------------------------------------------------- 4
  if (run(4)) {
    heading('4. 分段命中率 / 最长未中 / 实际抽中的权重版本');
    const plan: RunPlan = {
      mode: 'round-robin',
      passes: Math.max(8, options.passes),
      drawsPerBlock: 10,
      characters: ['alpha'],
      pools: ['featured'],
    };
    const first = runBatch(createSession(config, { seed: `${seed}-ch4`, plan }), Math.floor(planLength(plan) / 2)).session;
    const { config: v2 } = addWeightVersion(first.config, 'featured', [{ id: 'ssr', weight: 16 }], {
      label: 'v2-SSR 16',
      createdAt: '2026-03-02T00:00:00.000Z',
    });
    const finished = runAll(withConfig(first, v2));
    console.log('同一轮模拟中, 中途把 featured 的 SSR 权重从 10 调到 16:');
    console.log(renderReport(buildReport(finished)));
    console.log('');
    console.log('↑ “实际抽中的权重版本”表里 v1 / v2 分别统计, 说明调表之后历史记录仍可解释。');
  }

  // ---------------------------------------------------------------- 5
  if (run(5)) {
    heading('5. 导出配置与结果; 边界用例: 必定保底 / 空池 / 零权重');
    const dir = resolve('.output');
    // 只跑一半 (20 抽里的前 10 抽) 就导出, 让 session.json 是一个可继续的检查点
    const plan5: RunPlan = {
      mode: 'round-robin',
      passes: 10,
      drawsPerBlock: 10,
      characters: ['alpha'],
      pools: ['standard', 'featured'],
    };
    const source = runBatch(createSession(config, { seed: `${seed}-ch5`, plan: plan5 }), Math.floor(planLength(plan5) / 2)).session;
    const exported = await exportRun(
      {
        config: source.config,
        session: source,
        report: buildReport(source),
        meta: { seed: source.seed, plan: source.plan, partial: true, generatedAt: new Date().toISOString() },
      },
      { dir, prefix: 'demo' },
    );
    console.log(`已导出 ${exported.files.length} 个文件到 ${exported.dir}:`);
    for (const file of exported.files) console.log(`  ${file}`);
    console.log(
      `session.json 是 ${source.records.length}/${planLength(plan5)} 抽的检查点, 可用 ` +
        `\`node src/cli.ts resume --session ${resolve('.output', 'demo-session.json')}\` 续跑。`,
    );

    const edge = edgeCaseConfig();
    const edgePlan = (poolId: string, passes: number): RunPlan => ({
      mode: 'round-robin',
      passes,
      drawsPerBlock: 1,
      characters: ['solo'],
      pools: [poolId],
    });
    console.log('');
    console.log('边界用例:');
    const cases: { pool: string; passes: number; label: string }[] = [
      { pool: 'pity-now', passes: 3, label: '必定保底 (SSR 阈值 1)' },
      { pool: 'empty', passes: 3, label: '空池' },
      { pool: 'zero-weight', passes: 3, label: '全零权重无保底' },
      { pool: 'zero-with-pity', passes: 6, label: '全零权重 + SSR 阈值 5' },
      { pool: 'bonus-only', passes: 3, label: '零权重 + 仅加成' },
    ];
    for (const testCase of cases) {
      const session = runAll(createSession(edge, { seed: `${seed}-edge`, plan: edgePlan(testCase.pool, testCase.passes) }));
      const summary = session.records
        .map((r) => `#${r.index}:${r.rule}${r.hit ? `(${r.hit.label})` : ''}`)
        .join('  ');
      console.log(`  ${padEnd(testCase.label, 22)} ${summary}`);
    }
    console.log('');
    console.log('  零权重池在无保底/无加成时不消耗随机数, 进度仍继续累加; 硬保底候选权重全为 0 时等概率命中。');
  }

  // ---------------------------------------------------------------- 6
  if (run(6)) {
    heading('6. 跨物品池共享保底组; 切池 / 回退版本时的沿用进度与触发规则');
    const plan: RunPlan = {
      mode: 'pool-blocks',
      passes: 1,
      drawsPerBlock: 6,
      characters: ['alpha'],
      pools: ['featured', 'weapon', 'standard'],
    };
    // 这一轮跑完整 18 抽; 回退演示另起一个 Session (下面 revisit), 互不干扰
    const session = runAll(createSession(config, { seed: `${seed}-ch6`, plan }));
    console.log('同一角色按 featured → weapon → standard 顺序各抽 6 次:');
    for (const poolId of ['featured', 'weapon', 'standard']) {
      const records = session.records.filter((r) => r.poolId === poolId);
      const first = records[0]!;
      const last = records.at(-1)!;
      console.log('');
      console.log(`  ${padEnd(poolId, 9)} 进度归属=${first.progress.scope}:${first.progress.ownerId}`);
      console.log(`    首抽策略=${first.progress.strategy}, 抽前=${JSON.stringify(first.progress.streaksBefore)}`);
      console.log(`    末抽后=${JSON.stringify(last.progress.streaksAfter)}`);
      console.log(`    首抽说明: ${first.notes.join(' | ')}`);
    }
    console.log('');
    console.log('结论: featured / weapon 共用 banner-group 的连续未中进度, standard 独立累计。');

    // 回到 featured: 升级权重版本 → 再回退, 展示"沿用的连续未中进度 + 本次实际触发的规则"
    const revisitPlan: RunPlan = {
      mode: 'pool-blocks',
      passes: 3,
      drawsPerBlock: 4,
      characters: ['alpha'],
      pools: ['featured'],
    };
    // 先跑 5 抽留下进度, 再升级 3 抽 / 回退 3 抽 (计划共 12 抽)
    const revisit = runBatch(createSession(config, { seed: `${seed}-ch6b`, plan: revisitPlan }), 5).session;

    const { config: upgraded } = addWeightVersion(revisit.config, 'featured', [{ id: 'ssr', weight: 20 }], {
      label: 'v2-SSR 20',
      createdAt: '2026-03-04T00:00:00.000Z',
    });
    const afterUpgrade = runBatch(withConfig(revisit, upgraded), 3).session;
    const backConfig = activateVersion(afterUpgrade.config, 'featured', 1);
    const back = runBatch(withConfig(afterUpgrade, backConfig), 3).session;

    console.log('');
    console.log('同一个 featured 池: 先升级到 v2 (SSR 10 → 20), 再回退到 v1:');
    for (const record of back.records.slice(-6)) {
      const progressed = record.versionChange !== 'none' || record.poolSwitched;
      console.log(
        `  #${padEnd(String(record.index), 3)} ${padEnd(record.poolId, 9)} v${record.poolVersion} ` +
          `版本变化=${padEnd(record.versionChange, 7)} 切池=${String(record.poolSwitched).padEnd(5)} 规则=${padEnd(record.rule, 8)} ` +
          `命中=${record.hit?.label ?? '-'}`,
      );
      console.log(`        ${record.notes.join(' | ')}`);
      if (progressed) {
        console.log(`        抽前 streak=${JSON.stringify(record.progress.streaksBefore)} → 抽后=${JSON.stringify(record.progress.streaksAfter)}`);
      }
    }
  }

  // ---------------------------------------------------------------- 7
  if (run(7)) {
    heading('7. 每抽记录随机状态 / 池版本 / 组进度; 断点续跑; 中点分叉对照');
    const plan: RunPlan = {
      mode: 'round-robin',
      passes: 12,
      drawsPerBlock: 10,
      characters: ['alpha', 'beta'],
      pools: ['standard', 'featured', 'weapon'],
    };
    const total = planLength(plan);
    const reference = runAll(createSession(config, { seed: `${seed}-ch7`, plan }));
    console.log(`参考运行: ${total} 抽 (一次跑完)`);

    const sample = reference.records[10]!;
    console.log('');
    console.log('单抽记录示例 (#10):');
    kv([
      ['抽前随机状态', `0x${sample.rngBefore.state.toString(16).padStart(8, '0')} (draws=${sample.rngBefore.draws})`],
      ['抽后随机状态', `0x${sample.rngAfter.state.toString(16).padStart(8, '0')} (draws=${sample.rngAfter.draws})`],
      ['池版本', `${sample.poolId} v${sample.poolVersion} (${sample.poolVersionLabel})`],
      ['进度 key', `${sample.progress.key} (${sample.progress.scope}:${sample.progress.ownerId})`],
      ['抽前 streak', JSON.stringify(sample.progress.streaksBefore)],
      ['命中 / 规则', `${sample.hit?.label ?? '空'} / ${sample.rule}`],
    ]);

    // 断点续跑: 跑一半 → 序列化 → 反序列化 → 跑完
    const half = Math.floor(total / 2);
    const firstHalf = runBatch(createSession(config, { seed: `${seed}-ch7`, plan }), half).session;
    const json = sessionToJson(firstHalf);
    const resumed = runAll(sessionFromJson(json));
    const diffs = diffRecords(reference.records, resumed.records);
    console.log('');
    console.log(`断点续跑: 跑 ${half} 抽 → 序列化 (${(json.length / 1024).toFixed(1)} KB) → 恢复 → 跑完 ${remainingDraws(firstHalf)} 抽`);
    console.log(`  与一次跑完比对: ${diffs.length === 0 ? '逐条完全一致 ✔' : `发现 ${diffs.length} 处差异 ✘`}`);
    if (diffs.length > 0) {
      for (const diff of diffs.slice(0, 5)) console.log(`    #${diff.index} ${diff.field}: ${JSON.stringify(diff.expected)} ≠ ${JSON.stringify(diff.actual)}`);
    }

    // 中点分叉: 复制设定改权重做对照, 原记录不可变
    const snapshotBefore = JSON.stringify(firstHalf);
    const { config: changed } = addWeightVersion(firstHalf.config, 'standard', [{ id: 'ssr', weight: 25 }], {
      label: 'v2-对照',
      createdAt: '2026-03-03T00:00:00.000Z',
    });
    const control = runAll(forkSession(firstHalf, { config: changed }));
    const original = runAll(firstHalf);
    console.log('');
    console.log('中点分叉对照 (把 standard 的 SSR 权重 5 → 25):');
    console.log(`  原记录在对照前后是否被改动: ${JSON.stringify(firstHalf) === snapshotBefore ? '否 ✔' : '是 ✘'}`);
    console.log(`  原分支与参考一致: ${diffRecords(reference.records, original.records).length === 0 ? '是 ✔' : '否 ✘'}`);
    console.log(`  分叉前半段一致: ${diffRecords(reference.records.slice(0, half), control.records.slice(0, half)).length === 0 ? '是 ✔' : '否 ✘'}`);
    const left = summarizeArm('A 原设定 (SSR 权重 5)', original);
    const right = summarizeArm('B 对照 (SSR 权重 25)', control);
    console.log('');
    console.log(renderComparison(left, right));

    const exported = await exportRun(
      {
        config: control.config,
        session: control,
        report: buildReport(control),
        comparison: { left, right },
        meta: { seed: control.seed, plan: control.plan, forkedAt: half },
      },
      { dir: resolve('.output'), prefix: 'fork' },
    );
    console.log('');
    console.log(`对照实验已导出到 ${exported.dir}:`);
    for (const file of exported.files) console.log(`  ${file}`);
  }

  heading('完成');
  console.log('提示: node src/cli.ts demo --section 6  可单独运行某一节');
  console.log('      npm run verify  运行类型检查与全部测试');
}

// ---------------------------------------------------------------------------
// run / step / resume / export
// ---------------------------------------------------------------------------

async function commandRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      seed: { type: 'string' },
      passes: { type: 'string' },
      mode: { type: 'string' },
      'draws-per-block': { type: 'string' },
      characters: { type: 'string' },
      pools: { type: 'string' },
      export: { type: 'string' },
    },
  });
  const config = await loadConfig(values.config);
  const plan = makePlan(config, values);
  const started = performance.now();
  const session = runAll(createSession(config, { seed: seedOf(values), plan }));
  const elapsed = performance.now() - started;
  console.log(renderReport(buildReport(session), { rarityOrder: ['r', 'sr', 'ssr'] }));
  console.log('');
  console.log(`耗时 ${formatDuration(elapsed)}`);
  if (values.export) {
    const exported = await exportRun(
      { config, session, report: buildReport(session), meta: { seed: session.seed, plan, generatedAt: new Date().toISOString() } },
      { dir: values.export, prefix: 'run' },
    );
    console.log(`已导出 ${exported.files.length} 个文件到 ${exported.dir}`);
    for (const file of exported.files) console.log(`  ${file}`);
  }
}

async function commandStep(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      seed: { type: 'string' },
      passes: { type: 'string' },
      mode: { type: 'string' },
      'draws-per-block': { type: 'string' },
      characters: { type: 'string' },
      pools: { type: 'string' },
      count: { type: 'string' },
      export: { type: 'string' },
    },
  });
  const config = await loadConfig(values.config);
  const plan = makePlan(config, values);
  let session = createSession(config, { seed: seedOf(values), plan });
  const count = Math.min(parsePositiveInt('count', values.count, 5), planLength(plan));
  console.log(`逐次试抽 ${count} 次 (计划总长 ${planLength(plan)}), 种子 ${session.seed}`);
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const result = stepOnce(session);
    session = result.session;
    const record = result.record;
    if (!record) {
      console.log('计划已结束');
      break;
    }
    console.log('');
    console.log(`#${record.index} [${record.characterId}/${record.poolId} v${record.poolVersion}]`);
    kv([
      ['随机状态 (前)', `0x${record.rngBefore.state.toString(16).padStart(8, '0')} (draws=${record.rngBefore.draws})`],
      ['随机数', record.roll === null ? '(未消耗)' : record.roll.toFixed(9)],
      ['权重轴', `总权重 ${record.totalWeight}${record.forced ? ' (硬保底候选)' : ''}`],
      ['规则', record.rule],
      ['命中', record.hit?.label ?? '空'],
      ['抽前 streak', JSON.stringify(record.progress.streaksBefore)],
      ['抽后 streak', JSON.stringify(record.progress.streaksAfter)],
      ['进度', `${record.progress.scope}:${record.progress.ownerId}, 策略=${record.progress.strategy}`],
      ['版本变化', record.versionChange],
    ]);
    for (const note of record.notes) console.log(`  · ${note}`);
  }
  console.log('');
  console.log(`耗时 ${formatDuration(performance.now() - started)}`);
  if (values.export) {
    const exported = await exportRun(
      { config: session.config, session, report: buildReport(session), meta: { seed: session.seed, plan: session.plan } },
      { dir: values.export, prefix: 'step' },
    );
    console.log(`已导出到 ${exported.dir}: ${exported.files.join(', ')}`);
  }
}

async function commandResume(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      count: { type: 'string' },
      export: { type: 'string' },
    },
  });
  if (!values.session) exitWithError('resume 需要 --session <file.json>');
  const text = await readFile(resolve(values.session), 'utf8');
  const session = sessionFromJson(text);
  console.log(`恢复快照: 已完成 ${session.records.length}/${planLength(session.plan)} 抽, 种子 ${session.seed}`);
  console.log(`随机状态: 0x${session.rng.state.toString(16).padStart(8, '0')} (draws=${session.rng.draws})`);
  const count =
    values.count === undefined
      ? Number.POSITIVE_INFINITY
      : parsePositiveInt('count', values.count, 0);
  const result = runBatch(session, Math.min(count, remainingDraws(session)));
  const finished = runAll(result.session);
  console.log(`本次追加 ${result.records.length} 抽, 当前 ${finished.records.length}/${planLength(finished.plan)} 抽`);
  if (finished.records.length > 0) {
    console.log('');
    const report = buildReport(finished);
    console.log(renderReport(report, { rarityOrder: ['r', 'sr', 'ssr'] }));
  }
  if (values.export) {
    const exported = await exportRun(
      { config: finished.config, session: finished, report: buildReport(finished) },
      { dir: values.export, prefix: 'resume' },
    );
    console.log(`已导出到 ${exported.dir}: ${exported.files.join(', ')}`);
  }
}

async function commandExport(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      seed: { type: 'string' },
      passes: { type: 'string' },
      mode: { type: 'string' },
      'draws-per-block': { type: 'string' },
      characters: { type: 'string' },
      pools: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.out) exitWithError('export 需要 --out <dir>');
  const config = await loadConfig(values.config);
  const plan = makePlan(config, values);
  const session = runAll(createSession(config, { seed: seedOf(values), plan }));
  const exported = await exportRun(
    {
      config,
      session,
      report: buildReport(session),
      meta: { seed: session.seed, plan, generatedAt: new Date().toISOString() },
    },
    { dir: values.out, prefix: 'export' },
  );
  console.log(`已导出 ${exported.files.length} 个文件到 ${exported.dir}`);
  for (const file of exported.files) console.log(`  ${file}`);
}

async function commandKeys(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: 'string' }, seed: { type: 'string' } },
  });
  const config = await loadConfig(values.config);
  const session = runAll(createSession(config, { seed: seedOf(values), plan: defaultPlan(config, 2) }));
  const records = new Map<string, number>();
  for (const record of session.records) records.set(record.progress.key, (records.get(record.progress.key) ?? 0) + 1);
  console.log('进度 key 概览 (角色|作用域:拥有者 -> 抽数):');
  for (const [key, count] of records) console.log(`  ${key} -> ${count}`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`drop-pity-lab

命令:
  demo    演示全部 7 项需求 (默认)
  run     按配置跑完整模拟并打印报告
  step    逐次试抽, 打印每一抽的随机状态 / 版本 / 保底原因
  resume  从 session.json 快照续跑
  export  只导出配置与结果
  keys    列出进度归属 key

示例:
  node src/cli.ts demo
  node src/cli.ts demo --section 6 --seed my-seed
  node src/cli.ts run --passes 200 --pools standard,featured --export .output
  node src/cli.ts step --count 10 --seed s1
  node src/cli.ts resume --session .output/demo-session.json
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command = 'demo', ...rest] = argv;
  switch (command) {
    case 'demo': {
      const { values } = parseArgs({
        args: rest,
        options: {
          seed: { type: 'string' },
          passes: { type: 'string' },
          section: { type: 'string' },
        },
      });
      const section = values.section === undefined ? undefined : Number(values.section);
      if (section !== undefined && (!Number.isInteger(section) || section < 1 || section > 7)) {
        exitWithError('--section 必须是 1..7');
      }
      await demo({
        seed: seedOf(values),
        passes: parsePositiveInt('passes', values.passes, 300),
        ...(section === undefined ? {} : { section }),
      });
      break;
    }
    case 'run':
      await commandRun(rest);
      break;
    case 'step':
      await commandStep(rest);
      break;
    case 'resume':
      await commandResume(rest);
      break;
    case 'export':
      await commandExport(rest);
      break;
    case 'keys':
      await commandKeys(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      usage();
      exitWithError(`未知命令 ${command}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
