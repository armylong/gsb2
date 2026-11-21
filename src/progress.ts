/**
 * 保底进度。
 *
 * 进度按「角色 + 稀有度 id」累计"连续未中数"(miss streak):
 *  - 每种稀有度独立累计: 本次没抽中它, 它的 streak +1; 抽中了则归零。
 *  - 有效权重 = weight + bonusPerMiss * streak。
 *  - 硬保底: streak + 1 >= pityThreshold 时本次强制命中 (即"最多 N 抽必中")。
 *
 * 进度挂在 progress key 上 (见 config.progressKeyOf):
 *  - 未共享: 每个角色在每个物品池各一份;
 *  - 共享组: 每个角色在整个组一份, 组内池共用。
 * 每次抽卡记录都会带上所用的进度 key、抽前各稀有度的 streak、以及触发的规则,
 * 用于解释"切池/回退版本后沿用了谁的连续未中进度"。
 */

import type { PoolConfig, RarityConfig, RarityId } from './config.ts';
import { progressKeyOf } from './config.ts';

export interface StreakProgress {
  /** 稀有度 id -> 连续未中次数 */
  readonly streaks: Readonly<Record<RarityId, number>>;
  /** 当前这份进度里出现过哪些稀有度 (progress 应按稀有度独立, 不随池切换减少) */
  readonly knownRarities: readonly RarityId[];
}

export type ProgressMap = Readonly<Record<string, StreakProgress>>;

/** 一次实际命中时生效的规则 */
export type HitRule =
  /** 按 (基础 + 加成) 权重抽中 */
  | 'weighted'
  /** 达到阈值, 被硬保底强制命中 */
  | 'pity';

export interface RarityRollDetail {
  readonly id: RarityId;
  readonly label: string;
  /** 本次计算时使用的 streak (抽之前) */
  readonly streakBefore: number;
  readonly baseWeight: number;
  readonly bonusWeight: number;
  readonly effectiveWeight: number;
  /** 本次是否达到硬保底 */
  readonly pityReady: boolean;
  /** 硬保底触发时, 这是第几抽 (streakBefore + 1) */
  readonly pityAtDraw: number | null;
}

export interface PitySnapshot {
  /** 进度归属 key */
  readonly progressKey: string;
  /** 进度挂在组上还是池上 */
  readonly scope: 'group' | 'pool';
  /** 组 id 或池 id */
  readonly ownerId: string;
  /** 抽前各稀有度 streak */
  readonly streaksBefore: Readonly<Record<RarityId, number>>;
  /** 本次是否有任一稀有度达到硬保底 */
  readonly forced: boolean;
  /** 参与本次分配的稀有度有效权重快照 */
  readonly details: readonly RarityRollDetail[];
}

export function initialProgress(rarities: readonly RarityConfig[]): StreakProgress {
  const streaks: Record<RarityId, number> = {};
  for (const rarity of rarities) streaks[rarity.id] = 0;
  return { streaks, knownRarities: rarities.map((r) => r.id) };
}

/**
 * 取某个 progress key 的进度; 不存在时初始化。
 * 版本更替可能增删稀有度: 缺失的补 0, 已有的保留 —— 这也是"回退旧版本时沿用
 * 进度"得以成立的机制。
 */
export function getProgress(map: ProgressMap, key: string, rarities: readonly RarityConfig[]): StreakProgress {
  const ids = rarities.map((r) => r.id);
  const existing = map[key];
  if (!existing) return initialProgress(rarities);
  const streaks: Record<RarityId, number> = { ...existing.streaks };
  for (const id of ids) streaks[id] ??= 0;
  const known = new Set<RarityId>(existing.knownRarities);
  for (const id of ids) known.add(id);
  return { streaks, knownRarities: [...known] };
}

/** 把某个 key 的进度清零 (命中原因仍是 weighted, 只是 streak 归零) */
export function resetProgress(map: ProgressMap, key: string, rarities: readonly RarityConfig[]): ProgressMap {
  return { ...map, [key]: initialProgress(rarities) };
}

export function withoutProgressKey(map: ProgressMap, key: string): ProgressMap {
  const next = { ...map };
  delete next[key];
  return next;
}

export interface EvaluatedWeights {
  readonly details: readonly RarityRollDetail[];
  /** 是否有稀有度达到硬保底 */
  readonly forced: boolean;
  /** 软保底 (加成) 是否改变了权重分布 (任一 bonus > 0) */
  readonly bonusActive: boolean;
  /** 参与本次分配的总有效权重 */
  readonly totalWeight: number;
}

/**
 * 计算本次抽卡每个稀有度的有效权重。
 *
 * 硬保底: 若有 pityReady 的稀有度, 只在它们之间按权重分配。若它们的有效权重
 * 全为 0 (零权重 + 零加成), 则等概率命中 —— 硬保底不能因为权重为零而失效。
 */
export function evaluateWeights(rarities: readonly RarityConfig[], streaks: Readonly<Record<RarityId, number>>): EvaluatedWeights {
  const details: RarityRollDetail[] = rarities.map((rarity) => {
    const streakBefore = streaks[rarity.id] ?? 0;
    const pityReady = rarity.pityThreshold !== null && streakBefore + 1 >= rarity.pityThreshold;
    const bonusWeight = rarity.bonusPerMiss * streakBefore;
    return {
      id: rarity.id,
      label: rarity.label,
      streakBefore,
      baseWeight: rarity.weight,
      bonusWeight,
      effectiveWeight: rarity.weight + bonusWeight,
      pityReady,
      pityAtDraw: pityReady ? streakBefore + 1 : null,
    };
  });

  const forced = details.some((d) => d.pityReady);
  const candidates = forced ? details.filter((d) => d.pityReady) : details;
  let totalWeight = 0;
  for (const detail of candidates) totalWeight += detail.effectiveWeight;
  const bonusActive = details.some((d) => d.bonusWeight > 0);
  return { details, forced, bonusActive, totalWeight };
}

/**
 * 抽卡完成后推进进度:
 *  - 当前版本里存在的稀有度: 命中则归零, 未命中则 +1;
 *  - 只存在于旧版本、当前版本已删除的稀有度: 冻结在删除前的 streak,
 *    这样回退到旧版本时能"沿用"它当时的连续未中进度, 而不会因为当前版本
 *    根本不可能出它而被虚增。
 */
export function advanceProgress(
  progress: StreakProgress,
  hitId: RarityId | null,
  rarities: readonly RarityConfig[],
): StreakProgress {
  const active = new Set(rarities.map((r) => r.id));
  const streaks: Record<RarityId, number> = { ...progress.streaks };
  for (const id of progress.knownRarities) {
    if (!active.has(id)) continue;
    streaks[id] = id === hitId ? 0 : (progress.streaks[id] ?? 0) + 1;
  }
  return { streaks, knownRarities: progress.knownRarities };
}

export interface ProgressScope {
  readonly key: string;
  readonly scope: 'group' | 'pool';
  readonly ownerId: string;
}

export function progressScopeOf(pool: PoolConfig, characterId: string): ProgressScope {
  return {
    key: progressKeyOf(pool, characterId),
    scope: pool.sharedGroupId !== null ? 'group' : 'pool',
    ownerId: pool.sharedGroupId ?? pool.id,
  };
}
