/**
 * 配置编辑。每次调用都返回新配置, 原配置 (以及基于它生成的记录) 永远不被修改 ——
 * 这是"从中点复制一份设定改权重作对照, 对照不能改掉原记录"的基础。
 */

import {
  type DeepMutable,
  type LabConfig,
  type PityGroupConfig,
  type PoolConfig,
  type ProgressPolicy,
  type RarityConfig,
  type WeightVersion,
} from './config.ts';

const defaultNow = (): string => new Date().toISOString();

export interface RarityPatch {
  readonly id: string;
  readonly label?: string;
  readonly weight?: number;
  readonly bonusPerMiss?: number;
  readonly pityThreshold?: number | null;
}

export interface AddVersionOptions {
  readonly label?: string;
  /** 测试里注入固定时间, 生产默认 new Date() */
  readonly createdAt?: string;
  /** 覆盖默认的"调权重后进度如何处理" */
  readonly progressPolicy?: ProgressPolicy;
}

function mutableCopy(config: LabConfig): DeepMutable<LabConfig> {
  return structuredClone(config) as DeepMutable<LabConfig>;
}

type MutablePool = DeepMutable<PoolConfig>;

/** 在可写配置里取池 (findPool 的返回类型是只读的, 不适用于编辑) */
function mutablePool(config: DeepMutable<LabConfig>, poolId: string): MutablePool {
  const pool = config.pools.find((p) => p.id === poolId);
  if (!pool) throw new Error(`找不到物品池 ${poolId}`);
  return pool;
}

function mutableVersionOf(pool: MutablePool): DeepMutable<WeightVersion> {
  const version = pool.versions.find((v) => v.version === pool.activeVersion);
  if (!version) throw new Error(`物品池 ${pool.id} 的当前版本 ${pool.activeVersion} 不存在`);
  return version;
}

export function cloneConfig(config: LabConfig): LabConfig {
  return structuredClone(config);
}

function applyPatches(rarities: readonly RarityConfig[], patches: readonly RarityPatch[]): RarityConfig[] {
  return rarities.map((rarity) => {
    const patch = patches.find((p) => p.id === rarity.id);
    if (!patch) return { ...rarity };
    return {
      id: rarity.id,
      label: patch.label ?? rarity.label,
      weight: patch.weight ?? rarity.weight,
      bonusPerMiss: patch.bonusPerMiss ?? rarity.bonusPerMiss,
      pityThreshold: patch.pityThreshold === undefined ? rarity.pityThreshold : patch.pityThreshold,
    };
  });
}

/** 直接改当前版本的数值, 不生成新版本 (用于构造实验起始配置) */
export function patchActiveRarities(
  config: LabConfig,
  poolId: string,
  patches: readonly RarityPatch[],
): LabConfig {
  const next = mutableCopy(config);
  const version = mutableVersionOf(mutablePool(next, poolId));
  version.rarities = applyPatches(version.rarities, patches);
  return next;
}

/**
 * 在当前版本基础上生成新权重版本并切过去 (旧版本保留, 可回退)。
 * 返回新配置与新版本号。
 */
export function addWeightVersion(
  config: LabConfig,
  poolId: string,
  patches: readonly RarityPatch[],
  options: AddVersionOptions = {},
): { config: LabConfig; version: number } {
  const next = mutableCopy(config);
  const pool = mutablePool(next, poolId);
  const current = mutableVersionOf(pool);
  const versionNumber = Math.max(...pool.versions.map((v) => v.version)) + 1;

  const newVersion: DeepMutable<WeightVersion> = {
    version: versionNumber,
    label: options.label ?? `v${versionNumber}`,
    // 旧版本保持原样; 新版本 = 旧版本数值 + 本次补丁
    rarities: applyPatches(current.rarities, patches),
    createdAt: options.createdAt ?? defaultNow(),
  };
  pool.versions.push(newVersion);
  pool.activeVersion = versionNumber;
  if (options.progressPolicy !== undefined) {
    pool.progressPolicyOnVersionChange = options.progressPolicy;
  }
  return { config: next, version: versionNumber };
}

/** 切到某个已存在的权重版本 (可用于回退) */
export function activateVersion(config: LabConfig, poolId: string, version: number): LabConfig {
  const next = mutableCopy(config);
  const pool = mutablePool(next, poolId);
  if (!pool.versions.some((v) => v.version === version)) {
    throw new Error(`物品池 ${poolId} 没有版本 ${version}`);
  }
  pool.activeVersion = version;
  return next;
}

export function setSharedGroup(config: LabConfig, poolId: string, groupId: string | null): LabConfig {
  const next = mutableCopy(config);
  mutablePool(next, poolId).sharedGroupId = groupId;
  return next;
}

export function setVersionPolicy(config: LabConfig, poolId: string, policy: ProgressPolicy): LabConfig {
  const next = mutableCopy(config);
  mutablePool(next, poolId).progressPolicyOnVersionChange = policy;
  return next;
}

export function upsertPool(config: LabConfig, pool: PoolConfig): LabConfig {
  const next = mutableCopy(config);
  const index = next.pools.findIndex((p) => p.id === pool.id);
  const copy = structuredClone(pool) as DeepMutable<PoolConfig>;
  if (index >= 0) next.pools[index] = copy;
  else next.pools.push(copy);
  return next;
}

export function upsertGroup(config: LabConfig, group: PityGroupConfig): LabConfig {
  const next = mutableCopy(config);
  const index = next.groups.findIndex((g) => g.id === group.id);
  const copy = structuredClone(group) as DeepMutable<PityGroupConfig>;
  if (index >= 0) next.groups[index] = copy;
  else next.groups.push(copy);
  return next;
}

export function removeGroup(config: LabConfig, groupId: string): LabConfig {
  const next = mutableCopy(config);
  next.groups = next.groups.filter((g) => g.id !== groupId);
  for (const pool of next.pools) {
    if (pool.sharedGroupId === groupId) pool.sharedGroupId = null;
  }
  return next;
}
