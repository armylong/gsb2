/**
 * 统计与报告。
 *
 *  - 分段命中率: 把每份进度按"抽前 streak 所在区间"分桶, 统计该区间内各稀有度
 *    的实际命中率 (命中数 / 区间内抽数)。软保底和硬保底的效果会直接体现在后段。
 *  - 最长未中连续长度: 按「角色 + 稀有度 + 进度作用域」统计。
 *  - 实际抽中的权重版本: 每条记录带 poolVersion, 这里汇总。
 *  - 保底前后的抽中原因: 汇总规则分布, 并区分"首次命中"与"保底接续命中"。
 */

import type { LabConfig, RarityId } from './config.ts';
import { activeVersionOf, findPool } from './config.ts';
import type { DrawRecord, DrawRule, Session } from './engine.ts';
import type { ProgressStrategy, VersionChange } from './engine.ts';

export interface SegmentBucket {
  /** 区间下界 (含) */
  readonly from: number;
  /** 区间上界 (含); 下一次硬保底发生在 maxPity+1 抽 */
  readonly to: number;
  readonly draws: number;
  /** 稀有度 id -> 命中次数 */
  readonly hits: Readonly<Record<RarityId, number>>;
  /** 稀有度 id -> 命中率 */
  readonly rates: Readonly<Record<RarityId, number>>;
}

export interface RaritySummary {
  readonly id: RarityId;
  readonly label: string;
  readonly draws: number;
  readonly hits: number;
  readonly rate: number;
  /** 理论期望: 按该稀有度基础权重 / 总基础权重 */
  readonly nominalRate: number | null;
  readonly weightedHits: number;
  readonly bonusHits: number;
  readonly pityHits: number;
  readonly maxMissStreak: number;
}

export interface VersionUsage {
  readonly poolId: string;
  readonly version: number;
  readonly label: string;
  readonly draws: number;
  readonly hits: number;
}

export interface RuleCounts {
  readonly weighted: number;
  readonly pity: number;
  readonly empty: number;
}

export interface PoolBreakdown {
  readonly poolId: string;
  readonly label: string;
  readonly draws: number;
  readonly ruleCounts: RuleCounts;
  readonly rarities: readonly RaritySummary[];
  readonly versions: readonly VersionUsage[];
  readonly segments: readonly SegmentBucket[];
  readonly maxMissStreakByRarity: Readonly<Record<RarityId, number>>;
  readonly sharedGroupId: string | null;
}

export interface CharacterBreakdown {
  readonly characterId: string;
  readonly label: string;
  readonly draws: number;
  readonly ruleCounts: RuleCounts;
  readonly rarities: readonly RaritySummary[];
  readonly segments: readonly SegmentBucket[];
  readonly maxMissStreakByRarity: Readonly<Record<RarityId, number>>;
  readonly progressScopes: readonly { key: string; scope: 'group' | 'pool'; ownerId: string; streaks: Readonly<Record<RarityId, number>> }[];
}

export interface ReportOptions {
  /** 分段粒度, 默认 10 */
  readonly segmentSize?: number;
}

export interface Report {
  readonly draws: number;
  readonly plan: Session['plan'];
  readonly ruleCounts: RuleCounts;
  readonly versions: readonly VersionUsage[];
  readonly pools: readonly PoolBreakdown[];
  readonly characters: readonly CharacterBreakdown[];
  /** 稀有度 id -> 标签 (跨池取并集) */
  readonly rarityLabels: Readonly<Record<RarityId, string>>;
}

const round = (value: number, digits = 6): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function emptyRules(): { weighted: number; pity: number; empty: number } {
  return { weighted: 0, pity: 0, empty: 0 };
}

function addRule(counts: { weighted: number; pity: number; empty: number }, rule: DrawRule): void {
  counts[rule] += 1;
}

function nominalRates(config: LabConfig, poolId: string): Map<RarityId, number | null> {
  const pool = findPool(config, poolId);
  const version = activeVersionOf(pool);
  const total = version.rarities.reduce((sum, r) => sum + r.weight, 0);
  const map = new Map<RarityId, number | null>();
  for (const rarity of version.rarities) {
    map.set(rarity.id, total > 0 ? rarity.weight / total : null);
  }
  return map;
}

function rarityLabelsOf(records: readonly DrawRecord[]): Record<RarityId, string> {
  const labels: Record<RarityId, string> = {};
  for (const record of records) {
    for (const detail of record.details) labels[detail.id] = detail.label;
  }
  return labels;
}

// ---------------------------------------------------------------------------
// 分段命中率
// ---------------------------------------------------------------------------

/**
 * 分段规则: 对每抽取"本次抽卡前、该池里所有稀有度 streak 的最大值"作为区分段。
 *  - 段内统计每个稀有度的命中率, 用来观察"离上次命中越远, 越容易中"。
 *  - 段上界 = max(该池/组配置的 pityThreshold, 样本最大值)。
 */
export function segmentDraws(
  records: readonly DrawRecord[],
  options: { readonly poolId?: string; readonly characterId?: string } = {},
  segmentSize = 10,
): SegmentBucket[] {
  const selected = records.filter(
    (record) =>
      (options.poolId === undefined || record.poolId === options.poolId) &&
      (options.characterId === undefined || record.characterId === options.characterId),
  );

  const rarityIds = new Set<RarityId>();
  for (const record of selected) for (const detail of record.details) rarityIds.add(detail.id);

  const buckets = new Map<number, { draws: number; hits: Record<RarityId, number> }>();
  for (const record of selected) {
    const streak = maxStreak(record.progress.streaksBefore);
    const bucketIndex = Math.floor(streak / segmentSize);
    const bucket = buckets.get(bucketIndex) ?? { draws: 0, hits: {} };
    bucket.draws += 1;
    if (record.hit) bucket.hits[record.hit.id] = (bucket.hits[record.hit.id] ?? 0) + 1;
    buckets.set(bucketIndex, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, bucket]) => {
      const rates: Record<RarityId, number> = {};
      for (const id of rarityIds) rates[id] = round((bucket.hits[id] ?? 0) / bucket.draws);
      const hits: Record<RarityId, number> = {};
      for (const id of rarityIds) hits[id] = bucket.hits[id] ?? 0;
      return {
        from: index * segmentSize,
        to: index * segmentSize + segmentSize - 1,
        draws: bucket.draws,
        hits,
        rates,
      };
    });
}

function maxStreak(streaks: Readonly<Record<RarityId, number>>): number {
  let max = 0;
  for (const value of Object.values(streaks)) max = Math.max(max, value);
  return max;
}

/**
 * 某个稀有度在「每份进度」上的最长连续未中。
 *
 * 必须按 progress key 分组: 共享组内的池共用一份 streak, 跨池连续未中要合并计数;
 * 不同角色 / 不同独立池之间则互不相干。只统计当前版本里仍包含该稀有度的抽卡,
 * 与引擎里"版本中暂时没有该稀有度时进度冻结"的语义一致。
 */
function maxMissStreakByKey(records: readonly DrawRecord[], rarityId: RarityId): Map<string, number> {
  const byKey = new Map<string, { current: number; best: number }>();
  for (const record of records) {
    if (!record.details.some((d) => d.id === rarityId)) continue;
    const entry = byKey.get(record.progress.key) ?? { current: 0, best: 0 };
    entry.current = record.hit?.id === rarityId ? 0 : entry.current + 1;
    entry.best = Math.max(entry.best, entry.current);
    byKey.set(record.progress.key, entry);
  }
  const result = new Map<string, number>();
  for (const [key, entry] of byKey) result.set(key, entry.best);
  return result;
}

/** 取一组进度 key 上的最长连续未中 */
function maxMissStreakForKeys(
  records: readonly DrawRecord[],
  rarityId: RarityId,
  keys: ReadonlySet<string>,
): number {
  const byKey = maxMissStreakByKey(records, rarityId);
  let best = 0;
  for (const key of keys) best = Math.max(best, byKey.get(key) ?? 0);
  return best;
}

function summarizeRarities(
  records: readonly DrawRecord[],
  config: LabConfig,
  poolId: string | null,
  filter: (record: DrawRecord) => boolean,
): RaritySummary[] {
  const ids = new Set<RarityId>();
  for (const record of records) for (const detail of record.details) ids.add(detail.id);
  if (poolId !== null) {
    const pool = findPool(config, poolId);
    for (const rarity of activeVersionOf(pool).rarities) ids.add(rarity.id);
  }
  const nominal = poolId !== null ? nominalRates(config, poolId) : new Map<RarityId, number | null>();
  const selected = records.filter(filter);
  // 这份统计涉及的进度 key (共享组 / 独立池 / 角色)
  const keys = new Set(selected.map((record) => record.progress.key));

  return [...ids].map((id) => {
    let label = id;
    let draws = 0;
    let hits = 0;
    let weightedHits = 0;
    let bonusHits = 0;
    let pityHits = 0;
    for (const record of selected) {
      const detail = record.details.find((d) => d.id === id);
      if (detail) {
        label = detail.label;
        draws += 1;
      }
      if (record.hit?.id !== id) continue;
      hits += 1;
      if (record.rule === 'pity') pityHits += 1;
      else if (detail && detail.bonusWeight > 0) bonusHits += 1;
      else weightedHits += 1;
    }
    const best = maxMissStreakForKeys(records, id, keys);
    return {
      id,
      label,
      draws,
      hits,
      rate: draws > 0 ? round(hits / draws) : 0,
      nominalRate: nominal.get(id) ?? null,
      weightedHits,
      bonusHits,
      pityHits,
      maxMissStreak: best,
    };
  });
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export function buildReport(session: Session, options: ReportOptions = {}): Report {
  const segmentSize = options.segmentSize ?? 10;
  const records = session.records;
  const { config } = session;
  const ruleCounts = emptyRules();
  for (const record of records) addRule(ruleCounts, record.rule);

  const versionMap = new Map<string, { poolId: string; version: number; label: string; draws: number; hits: number }>();
  for (const record of records) {
    const key = `${record.poolId}#${record.poolVersion}`;
    const entry = versionMap.get(key) ?? {
      poolId: record.poolId,
      version: record.poolVersion,
      label: record.poolVersionLabel,
      draws: 0,
      hits: 0,
    };
    entry.draws += 1;
    if (record.hit) entry.hits += 1;
    versionMap.set(key, entry);
  }
  const versions = [...versionMap.values()].sort((a, b) =>
    a.poolId === b.poolId ? a.version - b.version : a.poolId.localeCompare(b.poolId),
  );

  const pools: PoolBreakdown[] = config.pools.map((pool) => {
    const poolRecords = records.filter((record) => record.poolId === pool.id);
    const poolRules = emptyRules();
    for (const record of poolRecords) addRule(poolRules, record.rule);
    return {
      poolId: pool.id,
      label: pool.label,
      draws: poolRecords.length,
      ruleCounts: poolRules,
      rarities: summarizeRarities(records, config, pool.id, (record) => record.poolId === pool.id),
      versions: versions.filter((v) => v.poolId === pool.id),
      segments: segmentDraws(records, { poolId: pool.id }, segmentSize),
      maxMissStreakByRarity: Object.fromEntries(
        summarizeRarities(records, config, pool.id, (record) => record.poolId === pool.id).map((s) => [s.id, s.maxMissStreak]),
      ),
      sharedGroupId: pool.sharedGroupId,
    };
  });

  const characters: CharacterBreakdown[] = config.characters.map((character) => {
    const characterRecords = records.filter((record) => record.characterId === character.id);
    const characterRules = emptyRules();
    for (const record of characterRecords) addRule(characterRules, record.rule);

    const scopes = new Map<string, { key: string; scope: 'group' | 'pool'; ownerId: string; streaks: Readonly<Record<RarityId, number>> }>();
    for (const record of characterRecords) {
      scopes.set(record.progress.key, {
        key: record.progress.key,
        scope: record.progress.scope,
        ownerId: record.progress.ownerId,
        streaks: record.progress.streaksAfter,
      });
    }

    return {
      characterId: character.id,
      label: character.label,
      draws: characterRecords.length,
      ruleCounts: characterRules,
      rarities: summarizeRarities(records, config, null, (record) => record.characterId === character.id),
      segments: segmentDraws(records, { characterId: character.id }, segmentSize),
      maxMissStreakByRarity: Object.fromEntries(
        summarizeRarities(records, config, null, (record) => record.characterId === character.id).map((s) => [s.id, s.maxMissStreak]),
      ),
      progressScopes: [...scopes.values()],
    };
  });

  return {
    draws: records.length,
    plan: session.plan,
    ruleCounts,
    versions,
    pools,
    characters,
    rarityLabels: rarityLabelsOf(records),
  };
}

// ---------------------------------------------------------------------------
// 时间线 (逐次试抽的解释视图)
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  readonly index: number;
  readonly characterId: string;
  readonly poolId: string;
  readonly version: number;
  readonly versionLabel: string;
  readonly roll: number | null;
  readonly totalWeight: number;
  readonly rule: DrawRule;
  readonly hit: string | null;
  readonly streaksBefore: Readonly<Record<RarityId, number>>;
  readonly streaksAfter: Readonly<Record<RarityId, number>>;
  readonly strategy: ProgressStrategy;
  readonly scope: 'group' | 'pool';
  readonly ownerId: string;
  readonly poolSwitched: boolean;
  readonly versionChange: VersionChange;
  readonly rngBefore: string;
  readonly notes: readonly string[];
}

export function buildTimeline(records: readonly DrawRecord[]): TimelineEntry[] {
  return records.map((record) => ({
    index: record.index,
    characterId: record.characterId,
    poolId: record.poolId,
    version: record.poolVersion,
    versionLabel: record.poolVersionLabel,
    roll: record.roll,
    totalWeight: record.totalWeight,
    rule: record.rule,
    hit: record.hit?.label ?? null,
    streaksBefore: record.progress.streaksBefore,
    streaksAfter: record.progress.streaksAfter,
    strategy: record.progress.strategy,
    scope: record.progress.scope,
    ownerId: record.progress.ownerId,
    poolSwitched: record.poolSwitched,
    versionChange: record.versionChange,
    rngBefore: `0x${record.rngBefore.state.toString(16).padStart(8, '0')}#${record.rngBefore.draws}`,
    notes: record.notes,
  }));
}

// ---------------------------------------------------------------------------
// 结果比对
// ---------------------------------------------------------------------------

export interface RecordDiff {
  readonly index: number;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * 比对两组抽卡记录。用于验证第 7 条的两个场景:
 *  - 断点续跑 vs 一次跑完: 应当无差异;
 *  - 同配置的两个独立 Session: 应当无差异。
 */
export function diffRecords(
  expected: readonly DrawRecord[],
  actual: readonly DrawRecord[],
  fields: readonly (keyof DrawRecord)[] = ['poolId', 'characterId', 'poolVersion', 'rule', 'hit', 'roll', 'rngBefore', 'rngAfter', 'progress'],
): RecordDiff[] {
  const diffs: RecordDiff[] = [];
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    const a = expected[i];
    const b = actual[i];
    if (!a || !b) {
      diffs.push({ index: i, field: 'record', expected: a ? 'present' : 'missing', actual: b ? 'present' : 'missing' });
      continue;
    }
    for (const field of fields) {
      if (!deepEqual(a[field], b[field])) {
        diffs.push({ index: i, field, expected: a[field], actual: b[field] });
        break;
      }
    }
  }
  return diffs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// 对照实验: 两个 Session 的汇总对比
// ---------------------------------------------------------------------------

export interface ArmSummary {
  readonly label: string;
  readonly draws: number;
  readonly ruleCounts: RuleCounts;
  readonly versions: readonly VersionUsage[];
  readonly perRarity: readonly {
    readonly rarityId: RarityId;
    readonly label: string;
    readonly hits: number;
    readonly rate: number;
    readonly pityHits: number;
    readonly bonusHits: number;
    readonly maxMissStreak: number;
  }[];
}

export function summarizeArm(label: string, session: Session): ArmSummary {
  const report = buildReport(session);
  const ruleCounts = report.ruleCounts;
  const byRarity = new Map<RarityId, { label: string; hits: number; draws: number; pityHits: number; bonusHits: number; maxMissStreak: number }>();
  for (const record of session.records) {
    for (const detail of record.details) {
      const entry = byRarity.get(detail.id) ?? {
        label: detail.label,
        hits: 0,
        draws: 0,
        pityHits: 0,
        bonusHits: 0,
        maxMissStreak: 0,
      };
      entry.draws += 1;
      if (record.hit?.id === detail.id) {
        entry.hits += 1;
        if (record.rule === 'pity') entry.pityHits += 1;
        else if (detail.bonusWeight > 0) entry.bonusHits += 1;
      }
      byRarity.set(detail.id, entry);
    }
  }
  // 最长连续未中按进度 key 分别计算后取最大值 (共享组跨池合并)
  const allKeys = new Set(session.records.map((record) => record.progress.key));
  for (const [id, entry] of byRarity) {
    entry.maxMissStreak = maxMissStreakForKeys(session.records, id, allKeys);
  }
  return {
    label,
    draws: session.records.length,
    ruleCounts,
    versions: report.versions,
    perRarity: [...byRarity.entries()].map(([id, entry]) => ({
      rarityId: id,
      label: entry.label,
      hits: entry.hits,
      rate: entry.draws > 0 ? round(entry.hits / entry.draws) : 0,
      pityHits: entry.pityHits,
      bonusHits: entry.bonusHits,
      maxMissStreak: entry.maxMissStreak,
    })),
  };
}
