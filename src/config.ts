/**
 * 配置模型: 角色 / 稀有度 / 物品池 / 权重版本 / 共享保底组。
 *
 * 核心概念:
 *  - 角色 (character): 每个角色有完全独立的保底进度。
 *  - 物品池 (pool): 最多 3 种稀有度, 每种带基础权重、未中加成、硬保底阈值。
 *  - 权重版本 (version): 调权重会生成新版本而不是覆盖旧版本; 抽卡记录里带实际
 *    命中的版本号, 调表之后仍能解释历史结果, 也能回退到旧版本。
 *  - 共享保底组 (group): 同一组内的多个物品池, 对同一角色共用一份连续未中
 *    进度; 未加入组的池各自独立计算。
 */

export type RarityId = string;
export type ProgressPolicy = 'inherit' | 'reset';
export type Severity = 'error' | 'warning';

export const MAX_RARITIES = 3;
export const SCHEMA_VERSION = 2 as const;

export interface CharacterConfig {
  readonly id: string;
  readonly label: string;
}

export interface RarityConfig {
  readonly id: RarityId;
  /** 展示名, 例如 "SSR" */
  readonly label: string;
  /** 基础权重, 必须 >= 0; 0 表示没有自然命中可能 */
  readonly weight: number;
  /** 每次连续未中后追加的权重 (线性加成) */
  readonly bonusPerMiss: number;
  /**
   * 硬保底阈值: 距上次命中最多 N 抽, 第 N 抽必定命中。
   * 实现上判断 `streakBefore + 1 >= pityThreshold`; null 表示无硬保底。
   */
  readonly pityThreshold: number | null;
}

export interface WeightVersion {
  /** 版本号, 从 1 递增; 越大越新 */
  readonly version: number;
  /** 人类可读标签, 例如 "v2-上调SSR" */
  readonly label: string;
  readonly rarities: readonly RarityConfig[];
  /** 该版本创建时间 (ISO), 仅用于导出说明 */
  readonly createdAt: string;
}

export interface PoolConfig {
  readonly id: string;
  readonly label: string;
  /** 当前使用的权重版本号 */
  readonly activeVersion: number;
  readonly versions: readonly WeightVersion[];
  /**
   * 共享保底组 id。null = 不共享, 进度保存在本池。
   * 同一组内的池对同一角色共用一份"连续未中"进度。
   */
  readonly sharedGroupId: string | null;
  /** 调整权重 (生成/切换到新版本) 后, 本池 (或所在组) 的保底进度如何处理 */
  readonly progressPolicyOnVersionChange: ProgressPolicy;
}

export interface PityGroupConfig {
  readonly id: string;
  readonly label: string;
}

export interface LabConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly characters: readonly CharacterConfig[];
  readonly pools: readonly PoolConfig[];
  readonly groups: readonly PityGroupConfig[];
}

export interface ConfigIssue {
  readonly path: string;
  readonly severity: Severity;
  readonly message: string;
}

/** 深只读的配置在编辑时需要可写视图; 只在 builder 内部使用 */
export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function validateConfig(config: LabConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (path: string, message: string): void => {
    issues.push({ path, severity: 'error', message });
  };

  if (config.schemaVersion !== SCHEMA_VERSION) {
    err('schemaVersion', `期望 ${SCHEMA_VERSION}, 收到 ${String(config.schemaVersion)}`);
  }

  if (config.characters.length === 0) {
    err('characters', '至少需要一个角色');
  }
  const characterIds = new Set<string>();
  for (const character of config.characters) {
    if (!character.id) err('characters', '角色 id 不能为空');
    if (characterIds.has(character.id)) err(`characters.${character.id}`, '角色 id 重复');
    characterIds.add(character.id);
  }

  const groupIds = new Set<string>();
  for (const group of config.groups) {
    if (!group.id) err('groups', '保底组 id 不能为空');
    if (groupIds.has(group.id)) err(`groups.${group.id}`, '保底组 id 重复');
    groupIds.add(group.id);
  }

  if (config.pools.length === 0) {
    err('pools', '至少需要一个物品池');
  }
  const poolIds = new Set<string>();
  for (const pool of config.pools) {
    const base = `pools.${pool.id}`;
    if (!pool.id) err(base, '物品池 id 不能为空');
    if (poolIds.has(pool.id)) err(base, '物品池 id 重复');
    poolIds.add(pool.id);

    if (pool.versions.length === 0) {
      err(`${base}.versions`, '至少需要一个权重版本');
      continue;
    }
    const seenVersions = new Set<number>();
    for (const version of pool.versions) {
      if (seenVersions.has(version.version)) err(`${base}.versions.${version.version}`, '版本号重复');
      seenVersions.add(version.version);
      issues.push(...validateVersion(version, `${base}.versions.${version.version}`));
    }
    if (!pool.versions.some((v) => v.version === pool.activeVersion)) {
      err(`${base}.activeVersion`, `当前版本 ${pool.activeVersion} 不存在`);
    }
    if (pool.sharedGroupId !== null && !groupIds.has(pool.sharedGroupId)) {
      err(`${base}.sharedGroupId`, `引用了不存在的保底组 ${String(pool.sharedGroupId)}`);
    }
    if (pool.progressPolicyOnVersionChange !== 'inherit' && pool.progressPolicyOnVersionChange !== 'reset') {
      err(`${base}.progressPolicyOnVersionChange`, '只能是 inherit / reset');
    }
  }

  // 共享组按稀有度 id 共享连续未中数, 因此同组内各池当前版本的稀有度 id 集合必须一致。
  for (const group of config.groups) {
    const members = config.pools.filter((p) => p.sharedGroupId === group.id);
    const signatureOf = (pool: PoolConfig): string => {
      const version = pool.versions.find((v) => v.version === pool.activeVersion);
      return version ? version.rarities.map((r) => r.id).join(',') : '';
    };
    const first = members[0];
    if (!first) continue;
    const signature = signatureOf(first);
    for (const member of members.slice(1)) {
      if (signatureOf(member) !== signature) {
        err(
          `groups.${group.id}`,
          `成员 ${first.id} 与 ${member.id} 的稀有度 id 集合不一致, 无法共享连续未中进度`,
        );
      }
    }
  }

  return issues;
}

export function validateVersion(version: WeightVersion, path: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (p: string, message: string): void => {
    issues.push({ path: p, severity: 'error', message });
  };
  const warn = (p: string, message: string): void => {
    issues.push({ path: p, severity: 'warning', message });
  };

  const { rarities } = version;
  if (rarities.length === 0) {
    // 空池是合法配置: 抽卡返回 empty, 方便测试边界情况。
    warn(`${path}.rarities`, '空池: 抽卡会返回 empty, 不消耗随机数');
    return issues;
  }
  if (rarities.length > MAX_RARITIES) {
    err(`${path}.rarities`, `最多 ${MAX_RARITIES} 种稀有度, 收到 ${rarities.length}`);
  }

  const ids = new Set<RarityId>();
  let totalWeight = 0;
  for (const rarity of rarities) {
    const rp = `${path}.rarities.${rarity.id}`;
    if (!rarity.id) err(rp, '稀有度 id 不能为空');
    if (ids.has(rarity.id)) err(rp, '稀有度 id 重复');
    ids.add(rarity.id);
    if (!Number.isFinite(rarity.weight) || rarity.weight < 0) {
      err(`${rp}.weight`, '权重必须 >= 0 的有限数');
    }
    if (!Number.isFinite(rarity.bonusPerMiss) || rarity.bonusPerMiss < 0) {
      err(`${rp}.bonusPerMiss`, '加成必须 >= 0 的有限数');
    }
    if (rarity.pityThreshold !== null && (!Number.isInteger(rarity.pityThreshold) || rarity.pityThreshold < 1)) {
      err(`${rp}.pityThreshold`, '保底阈值必须 >= 1 的整数, 或 null');
    }
    totalWeight += rarity.weight;
  }
  if (totalWeight === 0) {
    warn(`${path}.rarities`, '全零权重: 没有加成或硬保底时抽卡会返回 empty');
  }
  return issues;
}

export function configErrors(config: LabConfig): ConfigIssue[] {
  return validateConfig(config).filter((issue) => issue.severity === 'error');
}

export function assertConfigValid(config: LabConfig): void {
  const errors = configErrors(config);
  if (errors.length > 0) {
    const detail = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
    throw new Error(`配置不合法:\n${detail}`);
  }
}

/** 取出物品池当前生效的版本 */
export function activeVersionOf(pool: PoolConfig): WeightVersion {
  const version = pool.versions.find((v) => v.version === pool.activeVersion);
  if (!version) throw new Error(`物品池 ${pool.id} 的当前版本 ${pool.activeVersion} 不存在`);
  return version;
}

export function findPool(config: LabConfig, poolId: string): PoolConfig {
  const pool = config.pools.find((p) => p.id === poolId);
  if (!pool) throw new Error(`找不到物品池 ${poolId}`);
  return pool;
}

export function findCharacter(config: LabConfig, characterId: string): CharacterConfig {
  const character = config.characters.find((c) => c.id === characterId);
  if (!character) throw new Error(`找不到角色 ${characterId}`);
  return character;
}

/**
 * 进度归属的 key:
 *  - 加入共享组 → 该角色在整个组上一份进度
 *  - 否则 → 该角色在本池上一份进度
 */
export function progressKeyOf(pool: PoolConfig, characterId: string): string {
  const scope = pool.sharedGroupId !== null ? `group:${pool.sharedGroupId}` : `pool:${pool.id}`;
  return `${characterId}|${scope}`;
}
