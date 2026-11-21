/**
 * 抽卡引擎: 把配置 + 随机源 + 保底进度 + 运行计划变成可复现的逐抽记录。
 *
 * 三条硬性保证:
 *  1. 纯函数式: 所有公开操作返回新 Session, 旧 Session (含 records) 永不被修改。
 *     "从中点复制一份设定改权重作对照"就是复制 Session 后换配置。
 *  2. 可快照: Session 可完整序列化成 JSON, 反序列化后继续跑, 结果与一次跑完全量
 *     逐条一致 —— 每条记录都带抽前/抽后的 RNG 状态、池版本、进度 key 与 streak。
 *  3. 可解释: 每条记录写明本次用的是哪份进度 (共享组 / 独立池)、抽前 streak, 以及
 *     版本升级/回退、切池时进度是沿用还是清空, 和本次实际触发的规则
 *     (基础权重 / 软保底加成 / 硬保底 / empty)。
 */

import {
  activeVersionOf,
  assertConfigValid,
  findPool,
  type LabConfig,
  type PoolConfig,
  type RarityConfig,
  type RarityId,
} from './config.ts';
import {
  advanceProgress,
  evaluateWeights,
  getProgress,
  initialProgress,
  progressScopeOf,
  type HitRule,
  type ProgressMap,
  type RarityRollDetail,
  type StreakProgress,
} from './progress.ts';
import { createRng, rngFromState, type RngState } from './rng.ts';

export type DrawRule = HitRule | 'empty';
export type VersionChange = 'none' | 'upgrade' | 'revert';
export type ProgressStrategy =
  /** 这份进度是第一次使用 (从 0 开始) */
  | 'fresh'
  /** 沿用已有的进度 (同池连续抽 / 切回本池 / 组内已有进度) */
  | 'continued'
  /** 切池但共用同一份进度 (共享保底组) */
  | 'shared-group'
  /** 版本变化且策略为 inherit, 沿用旧版本积累的进度 */
  | 'inherited'
  /** 版本变化且策略为 reset, 已清空 */
  | 'reset';

export type PlanMode = 'round-robin' | 'pool-blocks';

export interface RunPlan {
  readonly mode: PlanMode;
  /** 轮数 */
  readonly passes: number;
  /** pool-blocks 模式下每个池连续抽多少次 */
  readonly drawsPerBlock: number;
  /** 参与的角色 id (顺序即抽卡顺序) */
  readonly characters: readonly string[];
  /** 参与的物品池 id (顺序即抽卡顺序) */
  readonly pools: readonly string[];
}

export interface DrawRef {
  readonly index: number;
  readonly characterId: string;
  readonly poolId: string;
  readonly version: number;
  readonly progressKey: string;
}

export interface ProgressUse {
  readonly key: string;
  readonly scope: 'group' | 'pool';
  readonly ownerId: string;
  readonly strategy: ProgressStrategy;
  readonly streaksBefore: Readonly<Record<RarityId, number>>;
  readonly streaksAfter: Readonly<Record<RarityId, number>>;
  /** reset 策略丢弃的旧 streak */
  readonly discardedStreaks: Readonly<Record<RarityId, number>> | null;
  /** 这份进度上一次是在哪一抽/哪个池/哪个版本上用过的 */
  readonly carriedFrom: DrawRef | null;
}

export interface DrawRecord {
  readonly index: number;
  readonly characterId: string;
  readonly poolId: string;
  readonly poolVersion: number;
  readonly poolVersionLabel: string;
  /** 抽卡前的随机状态 (可据此复现这一抽) */
  readonly rngBefore: RngState;
  readonly rngAfter: RngState;
  /** 本次实际取到的 [0,1) 随机数; 空池 / 未触发保底的零权重时为 null */
  readonly roll: number | null;
  /** roll 投影到权重轴上的目标值; 等概率硬保底时为候选序号 */
  readonly rollTarget: number | null;
  readonly totalWeight: number;
  readonly forced: boolean;
  readonly bonusActive: boolean;
  readonly rule: DrawRule;
  readonly hit: { readonly id: RarityId; readonly label: string } | null;
  readonly details: readonly RarityRollDetail[];
  readonly progress: ProgressUse;
  readonly poolSwitched: boolean;
  readonly versionChange: VersionChange;
  readonly notes: readonly string[];
}

export interface Session {
  readonly seed: string;
  readonly config: LabConfig;
  readonly plan: RunPlan;
  readonly rng: RngState;
  readonly progress: ProgressMap;
  /** 每个角色最近一抽 (用于检测切池) */
  readonly lastByCharacter: Readonly<Record<string, DrawRef>>;
  /** 每个角色在某个池上的最近一抽 (用于检测版本变化) */
  readonly lastVisitByPool: Readonly<Record<string, Readonly<Record<string, DrawRef>>>>;
  /** 每份进度最近一次被使用的记录 (用于解释"沿用了谁的进度") */
  readonly lastByProgressKey: Readonly<Record<string, DrawRef>>;
  readonly records: readonly DrawRecord[];
}

export interface CreateSessionOptions {
  readonly seed: string | number;
  readonly plan?: RunPlan;
}

export interface BatchResult {
  readonly session: Session;
  readonly records: readonly DrawRecord[];
  readonly exhausted: boolean;
}

// ---------------------------------------------------------------------------
// 运行计划
// ---------------------------------------------------------------------------

export function defaultPlan(config: LabConfig, passes = 10): RunPlan {
  return {
    mode: 'round-robin',
    passes,
    drawsPerBlock: 10,
    characters: config.characters.map((c) => c.id),
    pools: config.pools.map((p) => p.id),
  };
}

/** 总抽数 */
export function planLength(plan: RunPlan): number {
  if (plan.passes <= 0 || plan.characters.length === 0 || plan.pools.length === 0) return 0;
  const perPass =
    plan.mode === 'round-robin'
      ? plan.characters.length * plan.pools.length
      : plan.pools.length * plan.drawsPerBlock * plan.characters.length;
  return plan.passes * perPass;
}

export interface PlanStep {
  readonly characterId: string;
  readonly poolId: string;
}

/**
 * 第 index 抽对应哪个角色 / 物品池 (纯函数)。
 *  - round-robin: 每轮按角色→池的顺序各抽 1 次
 *  - pool-blocks: 每个池连续抽 drawsPerBlock 轮 (块内按角色轮转), 再换下一个池
 */
export function stepAt(plan: RunPlan, index: number): PlanStep | null {
  const total = planLength(plan);
  if (index < 0 || index >= total) return null;
  const { characters, pools } = plan;
  if (plan.mode === 'round-robin') {
    const perPass = characters.length * pools.length;
    const within = index % perPass;
    return {
      characterId: characters[Math.floor(within / pools.length)]!,
      poolId: pools[within % pools.length]!,
    };
  }
  const block = plan.drawsPerBlock * characters.length;
  const perPass = pools.length * block;
  const withinPool = Math.floor((index % perPass) / block);
  const withinBlock = (index % perPass) % block;
  return {
    poolId: pools[withinPool]!,
    characterId: characters[withinBlock % characters.length]!,
  };
}

function validatePlan(config: LabConfig, plan: RunPlan): void {
  if (!Number.isInteger(plan.passes) || plan.passes < 0) throw new Error('passes 必须是 >= 0 的整数');
  if (!Number.isInteger(plan.drawsPerBlock) || plan.drawsPerBlock < 1) {
    throw new Error('drawsPerBlock 必须是 >= 1 的整数');
  }
  if (plan.mode !== 'round-robin' && plan.mode !== 'pool-blocks') {
    throw new Error(`未知的计划模式 ${String(plan.mode)}`);
  }
  const characterIds = new Set(config.characters.map((c) => c.id));
  for (const id of plan.characters) {
    if (!characterIds.has(id)) throw new Error(`运行计划引用了不存在的角色 ${id}`);
  }
  const poolIds = new Set(config.pools.map((p) => p.id));
  for (const id of plan.pools) {
    if (!poolIds.has(id)) throw new Error(`运行计划引用了不存在的物品池 ${id}`);
  }
}

// ---------------------------------------------------------------------------
// 创建 / 改配置 / 推进
// ---------------------------------------------------------------------------

export function createSession(config: LabConfig, options: CreateSessionOptions): Session {
  assertConfigValid(config);
  const plan = options.plan ?? defaultPlan(config);
  const normalizedPlan: RunPlan = { ...plan, characters: [...plan.characters], pools: [...plan.pools] };
  validatePlan(config, normalizedPlan);
  return {
    seed: String(options.seed),
    config: structuredClone(config),
    plan: normalizedPlan,
    rng: createRng(options.seed).snapshot(),
    progress: {},
    lastByCharacter: {},
    lastVisitByPool: {},
    lastByProgressKey: {},
    records: [],
  };
}

/** 在抽卡之间替换配置 (调权重 / 切版本 / 改共享组), 保留进度与随机状态 */
export function withConfig(session: Session, config: LabConfig): Session {
  assertConfigValid(config);
  validatePlan(config, session.plan);
  return { ...session, config: structuredClone(config) };
}

function detectVersionChange(lastVersion: number | undefined, currentVersion: number): VersionChange {
  if (lastVersion === undefined || lastVersion === currentVersion) return 'none';
  return currentVersion > lastVersion ? 'upgrade' : 'revert';
}

function describeStreaks(streaks: Readonly<Record<string, number>>): string {
  const entries = Object.entries(streaks);
  if (entries.length === 0) return '(无稀有度)';
  return entries.map(([id, value]) => `${id}=${value}`).join(', ');
}

interface ProgressResolution {
  readonly progress: StreakProgress;
  readonly strategy: ProgressStrategy;
  readonly discarded: StreakProgress | null;
  readonly carriedFrom: DrawRef | null;
  readonly notes: readonly string[];
}

/**
 * 决定本次使用哪份进度、以及从哪里来。
 *
 * 优先级 (两种事件同时发生时): 版本变化 > 切池。
 * 理由: 调权重是用户显式修改配置的行为, 池配置里为此专门设了策略;
 * 而"切池"只是本次抽卡发生在另一个池上。两种事件都会写进 notes。
 */
function resolveProgress(
  session: Session,
  pool: PoolConfig,
  characterId: string,
  rarities: readonly RarityConfig[],
  poolSwitched: boolean,
  versionChange: VersionChange,
): ProgressResolution {
  const scope = progressScopeOf(pool, characterId);
  const existing = getProgress(session.progress, scope.key, rarities);
  const hasExisting = scope.key in session.progress;
  const lastVisit = session.lastVisitByPool[characterId]?.[pool.id];
  const provenance = session.lastByProgressKey[scope.key] ?? null;
  const fromLastVisit = lastVisit && lastVisit.progressKey === scope.key ? lastVisit : provenance;
  const scopeLabel = scope.scope === 'group' ? `共享组 ${scope.ownerId}` : `物品池 ${scope.ownerId}`;
  const notes: string[] = [];

  if (versionChange !== 'none') {
    const changeLabel = versionChange === 'revert' ? '回退' : '升级';
    if (pool.progressPolicyOnVersionChange === 'reset') {
      notes.push(
        `版本${changeLabel} (v${lastVisit?.version} → v${pool.activeVersion}) 且策略为 reset: 已清空${scopeLabel}的连续未中 ${describeStreaks(existing.streaks)}`,
      );
      if (scope.scope === 'group') {
        notes.push('注意: 本池处于共享组, 清空会影响组内其他池的同一份进度');
      }
      return {
        progress: initialProgress(rarities),
        strategy: 'reset',
        discarded: hasExisting ? existing : null,
        carriedFrom: provenance,
        notes,
      };
    }
    notes.push(
      `版本${changeLabel} (v${lastVisit?.version} → v${pool.activeVersion}) 且策略为 inherit: 沿用${scopeLabel}的连续未中 ${describeStreaks(existing.streaks)}`,
    );
    return {
      progress: existing,
      strategy: hasExisting ? 'inherited' : 'fresh',
      discarded: null,
      carriedFrom: fromLastVisit,
      notes,
    };
  }

  if (poolSwitched) {
    if (scope.scope === 'group') {
      notes.push(
        `切池命中${scopeLabel}: 共用同一份连续未中进度 ${describeStreaks(existing.streaks)}`,
      );
      return {
        progress: existing,
        strategy: hasExisting ? 'shared-group' : 'fresh',
        discarded: null,
        carriedFrom: provenance,
        notes,
      };
    }
    if (hasExisting) {
      notes.push(`切回${scopeLabel}: 沿用本池自己的连续未中 ${describeStreaks(existing.streaks)} (未共享, 不受其他池影响)`);
      return {
        progress: existing,
        strategy: 'continued',
        discarded: null,
        carriedFrom: provenance,
        notes,
      };
    }
    notes.push(`首次抽${scopeLabel}: 连续未中从 0 开始 (不共享, 不继承其他池)`);
    return { progress: existing, strategy: 'fresh', discarded: null, carriedFrom: null, notes };
  }

  if (!hasExisting) notes.push(`首次抽${scopeLabel}: 连续未中从 0 开始`);
  return {
    progress: existing,
    strategy: hasExisting ? 'continued' : 'fresh',
    discarded: null,
    carriedFrom: hasExisting ? fromLastVisit : null,
    notes,
  };
}

interface DrawOutcome {
  readonly hit: { id: RarityId; label: string } | null;
  readonly rule: DrawRule;
  readonly roll: number | null;
  readonly rollTarget: number | null;
  readonly totalWeight: number;
  readonly forced: boolean;
  readonly bonusActive: boolean;
  readonly notes: readonly string[];
}

function drawOnce(
  rarities: readonly RarityConfig[],
  streaks: Readonly<Record<RarityId, number>>,
  nextRandom: () => number,
): DrawOutcome {
  const evaluated = evaluateWeights(rarities, streaks);
  const notes: string[] = [];

  if (rarities.length === 0) {
    notes.push('空池: 没有任何稀有度, 本抽返回 empty, 不消耗随机数');
    return { hit: null, rule: 'empty', roll: null, rollTarget: null, totalWeight: 0, forced: false, bonusActive: false, notes };
  }

  const candidates = evaluated.forced ? evaluated.details.filter((d) => d.pityReady) : evaluated.details;
  const total = evaluated.totalWeight;
  const base = { totalWeight: total, forced: evaluated.forced, bonusActive: evaluated.bonusActive };

  if (total <= 0) {
    if (!evaluated.forced) {
      notes.push('全零权重且未触发硬保底: 本抽返回 empty, 不消耗随机数 (进度仍会推进)');
      return { hit: null, rule: 'empty', roll: null, rollTarget: null, ...base, notes };
    }
    // 硬保底候选全为 0 权重: 等概率命中, 保证保底一定生效
    const roll = nextRandom();
    const index = Math.min(candidates.length - 1, Math.floor(roll * candidates.length));
    const picked = candidates[index]!;
    notes.push(
      `硬保底 (第 ${picked.pityAtDraw} 抽): 候选权重均为 0, 在 ${candidates.length} 个候选中等概率命中 ${picked.label}`,
    );
    return {
      hit: { id: picked.id, label: picked.label },
      rule: 'pity',
      roll,
      rollTarget: index,
      ...base,
      notes,
    };
  }

  const roll = nextRandom();
  const target = roll * total;
  let accumulated = 0;
  let picked = candidates[candidates.length - 1]!;
  for (const candidate of candidates) {
    accumulated += candidate.effectiveWeight;
    if (target < accumulated) {
      picked = candidate;
      break;
    }
  }

  if (evaluated.forced) {
    notes.push(
      `硬保底 (第 ${picked.pityAtDraw} 抽, 阈值 ${rarities.find((r) => r.id === picked.id)?.pityThreshold}): 强制命中 ${picked.label}`,
    );
    return { hit: { id: picked.id, label: picked.label }, rule: 'pity', roll, rollTarget: target, ...base, notes };
  }

  if (picked.bonusWeight > 0) {
    notes.push(
      `软保底加成: ${picked.label} 有效权重 = 基础 ${picked.baseWeight} + 加成 ${picked.bonusWeight} (连续未中 ${picked.streakBefore} 次), 总权重 ${total}`,
    );
  } else {
    notes.push(`基础权重: ${picked.label} 有效权重 ${picked.effectiveWeight} / 总权重 ${total}`);
  }
  return { hit: { id: picked.id, label: picked.label }, rule: 'weighted', roll, rollTarget: target, ...base, notes };
}

function executeStep(session: Session, index: number): DrawRecord {
  const step = stepAt(session.plan, index);
  if (!step) throw new Error(`计划已结束, 无法执行第 ${index} 抽`);
  const pool = findPool(session.config, step.poolId);
  const version = activeVersionOf(pool);
  const rarities = version.rarities;
  const scope = progressScopeOf(pool, step.characterId);
  const lastOverall = session.lastByCharacter[step.characterId];
  const lastVisit = session.lastVisitByPool[step.characterId]?.[pool.id];
  const poolSwitched = lastOverall !== undefined && lastOverall.poolId !== pool.id;
  const versionChange = detectVersionChange(lastVisit?.version, version.version);

  const resolution = resolveProgress(session, pool, step.characterId, rarities, poolSwitched, versionChange);

  const rng = rngFromState(session.rng);
  const rngBefore = rng.snapshot();
  const outcome = drawOnce(rarities, resolution.progress.streaks, () => rng.next());
  const rngAfter = rng.snapshot();

  const evaluated = evaluateWeights(rarities, resolution.progress.streaks);
  const hitId = outcome.hit?.id ?? null;
  const streaksAfter = advanceProgress(resolution.progress, hitId, rarities).streaks;

  const notes = [...resolution.notes, ...outcome.notes];
  if (outcome.rule === 'pity') {
    const detail = outcome.hit ? evaluated.details.find((d) => d.id === outcome.hit!.id) : undefined;
    notes.push(
      `实际触发规则: 硬保底 (该稀有度连续未中 ${detail?.streakBefore ?? '?'} 次, 本次第 ${detail?.pityAtDraw ?? '?'} 抽)`,
    );
  } else if (outcome.rule === 'weighted') {
    const detail = outcome.hit ? evaluated.details.find((d) => d.id === outcome.hit!.id) : undefined;
    notes.push(
      detail && detail.bonusWeight > 0
        ? `实际触发规则: 权重 + 软保底加成 (基础 ${detail.baseWeight} + 加成 ${detail.bonusWeight})`
        : `实际触发规则: 基础权重`,
    );
  } else {
    notes.push('实际触发规则: 无 (empty)');
  }

  const progressUse: ProgressUse = {
    key: scope.key,
    scope: scope.scope,
    ownerId: scope.ownerId,
    strategy: resolution.strategy,
    streaksBefore: { ...resolution.progress.streaks },
    streaksAfter,
    discardedStreaks: resolution.discarded ? { ...resolution.discarded.streaks } : null,
    carriedFrom: resolution.carriedFrom,
  };

  return {
    index,
    characterId: step.characterId,
    poolId: pool.id,
    poolVersion: version.version,
    poolVersionLabel: version.label,
    rngBefore,
    rngAfter,
    roll: outcome.roll,
    rollTarget: outcome.rollTarget,
    totalWeight: outcome.totalWeight,
    forced: outcome.forced,
    bonusActive: outcome.bonusActive,
    rule: outcome.rule,
    hit: outcome.hit,
    details: evaluated.details,
    progress: progressUse,
    poolSwitched,
    versionChange,
    notes,
  };
}

/** 执行 count 次抽卡 (或直到计划结束), 返回新 Session 与本次新增记录 */
export function runBatch(session: Session, count: number): BatchResult {
  if (!Number.isInteger(count) || count < 0) throw new Error('count 必须是 >= 0 的整数');
  const total = planLength(session.plan);
  if (session.records.length > total) {
    throw new Error(`记录数 ${session.records.length} 超过计划长度 ${total}`);
  }

  let current = session;
  const produced: DrawRecord[] = [];
  while (produced.length < count && current.records.length < total) {
    const index = current.records.length;
    const record = executeStep(current, index);

    const key = record.progress.key;
    const existing = current.progress[key];
    const knownRarities = existing?.knownRarities ?? Object.keys(record.progress.streaksAfter);
    const nextProgress: Record<string, StreakProgress> = {
      ...current.progress,
      [key]: { streaks: record.progress.streaksAfter, knownRarities },
    };

    const ref: DrawRef = {
      index,
      characterId: record.characterId,
      poolId: record.poolId,
      version: record.poolVersion,
      progressKey: key,
    };
    const characterVisits = {
      ...(current.lastVisitByPool[record.characterId] ?? {}),
      [record.poolId]: ref,
    };

    current = {
      ...current,
      rng: record.rngAfter,
      progress: nextProgress,
      lastByCharacter: { ...current.lastByCharacter, [record.characterId]: ref },
      lastVisitByPool: { ...current.lastVisitByPool, [record.characterId]: characterVisits },
      lastByProgressKey: { ...current.lastByProgressKey, [key]: ref },
      records: [...current.records, record],
    };
    produced.push(record);
  }

  return { session: current, records: produced, exhausted: current.records.length >= total };
}

/** 逐次试抽: 与 runBatch(session, 1) 等价 */
export function stepOnce(session: Session): {
  session: Session;
  record: DrawRecord | null;
  exhausted: boolean;
} {
  const result = runBatch(session, 1);
  return { session: result.session, record: result.records[0] ?? null, exhausted: result.exhausted };
}

// ---------------------------------------------------------------------------
// 从检查点分叉 (对照实验)
// ---------------------------------------------------------------------------

export interface ForkOptions {
  readonly config?: LabConfig;
  readonly plan?: RunPlan;
}

/**
 * 从当前检查点复制一份 Session 用于对照。records / progress / rng / 版本全部
 * 深拷贝, 修改副本不会影响原记录。
 */
export function forkSession(session: Session, options: ForkOptions = {}): Session {
  const config = options.config ?? session.config;
  const plan = options.plan ?? session.plan;
  assertConfigValid(config);
  validatePlan(config, plan);
  return {
    seed: session.seed,
    config: structuredClone(config),
    plan: structuredClone({ ...plan, characters: [...plan.characters], pools: [...plan.pools] }),
    rng: { ...session.rng },
    progress: structuredClone(session.progress),
    lastByCharacter: structuredClone(session.lastByCharacter),
    lastVisitByPool: structuredClone(session.lastVisitByPool),
    lastByProgressKey: structuredClone(session.lastByProgressKey),
    records: structuredClone(session.records),
  };
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

export const SESSION_SCHEMA_VERSION = 1 as const;

export interface SerializedSession {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly session: Session;
}

export function serializeSession(session: Session): SerializedSession {
  return { schemaVersion: SESSION_SCHEMA_VERSION, session: structuredClone(session) };
}

export function sessionToJson(session: Session, pretty = true): string {
  return JSON.stringify(serializeSession(session), null, pretty ? 2 : 0);
}

export function deserializeSession(input: unknown): Session {
  const data = input as Partial<SerializedSession> | null;
  if (!data || typeof data !== 'object' || data.schemaVersion !== SESSION_SCHEMA_VERSION || !data.session) {
    throw new Error('不是可识别的 Session 快照 (schemaVersion 不匹配)');
  }
  const session = data.session;
  assertConfigValid(session.config);
  validatePlan(session.config, session.plan);
  if (!Number.isInteger(session.rng.state) || !Number.isInteger(session.rng.draws)) {
    throw new Error('快照的随机状态非法');
  }
  if (!Array.isArray(session.records)) throw new Error('快照的 records 非法');
  if (session.records.length > planLength(session.plan)) {
    throw new Error('快照的记录数超过计划长度');
  }
  return structuredClone(session);
}

export function sessionFromJson(json: string): Session {
  return deserializeSession(JSON.parse(json));
}

export function isExhausted(session: Session): boolean {
  return session.records.length >= planLength(session.plan);
}

export function remainingDraws(session: Session): number {
  return Math.max(0, planLength(session.plan) - session.records.length);
}
