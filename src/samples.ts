/**
 * 样例配置。所有样例都通过代码生成, 不依赖外部文件。
 *
 * 场景 "twin-pools": 两个角色、三个池:
 *  - standard: 独立池, 只有 2 种稀有度
 *  - featured / weapon: 共享保底组 "banner-group", 共用连续未中进度
 * 每个池都带软保底加成和硬保底, 用来展示保底前后的差异。
 */

import type { LabConfig, PoolConfig, RarityConfig, WeightVersion } from './config.ts';
import { SCHEMA_VERSION } from './config.ts';

const STAMP = '2026-01-01T00:00:00.000Z';

function rarity(
  id: string,
  label: string,
  weight: number,
  bonusPerMiss: number,
  pityThreshold: number | null,
): RarityConfig {
  return { id, label, weight, bonusPerMiss, pityThreshold };
}

function version(
  number: number,
  label: string,
  rarities: readonly RarityConfig[],
): WeightVersion {
  return { version: number, label, rarities, createdAt: STAMP };
}

function pool(input: Omit<PoolConfig, 'progressPolicyOnVersionChange'> & Partial<Pick<PoolConfig, 'progressPolicyOnVersionChange'>>): PoolConfig {
  return { progressPolicyOnVersionChange: 'inherit', ...input };
}

export function sampleConfig(): LabConfig {
  // 阈值是为演示而压缩过的 (阈值 15 意味着最多 15 抽必出 SSR), 让几百抽内就能
  // 观察到硬保底。真实项目可以直接把阈值改成 90 之类。
  const standardV1 = version(1, 'v1-标准', [
    rarity('r', 'R', 70, 0, null),
    rarity('sr', 'SR', 25, 2, 10),
    rarity('ssr', 'SSR', 5, 1, 15),
  ]);
  const featuredV1 = version(1, 'v1-限定', [
    rarity('r', 'R', 60, 0, null),
    rarity('sr', 'SR', 30, 3, 8),
    rarity('ssr', 'SSR', 10, 2, 12),
  ]);
  const weaponV1 = version(1, 'v1-武器', [
    rarity('r', 'R', 75, 0, null),
    rarity('sr', 'SR', 20, 2, 10),
    rarity('ssr', 'SSR', 5, 1, 20),
  ]);

  return {
    schemaVersion: SCHEMA_VERSION,
    characters: [
      { id: 'alpha', label: '角色A' },
      { id: 'beta', label: '角色B' },
    ],
    groups: [{ id: 'banner-group', label: '限定共享组' }],
    pools: [
      pool({
        id: 'standard',
        label: '标准池',
        activeVersion: 1,
        versions: [standardV1],
        sharedGroupId: null,
      }),
      pool({
        id: 'featured',
        label: '限定角色池',
        activeVersion: 1,
        versions: [featuredV1],
        sharedGroupId: 'banner-group',
      }),
      pool({
        id: 'weapon',
        label: '武器池',
        activeVersion: 1,
        versions: [weaponV1],
        sharedGroupId: 'banner-group',
      }),
    ],
  };
}

/**
 * 边界用例配置, 供 demo 第 5 条使用:
 *  - pity-now:         权重极低 + 阈值 1, 第 1 抽必定保底
 *  - empty:            空池 (0 种稀有度)
 *  - zero-weight:      3 种稀有度全 0 权重, 且无加成/无保底 => 永远 empty
 *  - zero-with-pity:   3 种稀有度全 0 权重, 但 SSR 阈值 5, 靠硬保底命中
 *  - bonus-only:       权重全 0, 但有加成, 加成从 0 开始所以第一抽仍 empty
 */export function edgeCaseConfig(): LabConfig {
  const pityNow = version(1, 'v1-必保底', [
    rarity('r', 'R', 99, 0, null),
    rarity('ssr', 'SSR', 1, 0, 1),
  ]);
  const empty = version(1, 'v1-空池', []);
  const zeroWeight = version(1, 'v1-零权重', [
    rarity('r', 'R', 0, 0, null),
    rarity('sr', 'SR', 0, 0, null),
    rarity('ssr', 'SSR', 0, 0, null),
  ]);
  const zeroWithPity = version(1, 'v1-零权重保底', [
    rarity('r', 'R', 0, 0, null),
    rarity('sr', 'SR', 0, 0, null),
    rarity('ssr', 'SSR', 0, 0, 5),
  ]);
  const bonusOnly = version(1, 'v1-仅加成', [
    rarity('r', 'R', 0, 0, null),
    rarity('ssr', 'SSR', 0, 2, null),
  ]);

  return {
    schemaVersion: SCHEMA_VERSION,
    characters: [{ id: 'solo', label: '测试角色' }],
    groups: [],
    pools: [
      pool({ id: 'pity-now', label: '必定保底池', activeVersion: 1, versions: [pityNow], sharedGroupId: null }),
      pool({ id: 'empty', label: '空池', activeVersion: 1, versions: [empty], sharedGroupId: null }),
      pool({ id: 'zero-weight', label: '全零权重池', activeVersion: 1, versions: [zeroWeight], sharedGroupId: null }),
      pool({ id: 'zero-with-pity', label: '零权重+保底池', activeVersion: 1, versions: [zeroWithPity], sharedGroupId: null }),
      pool({ id: 'bonus-only', label: '仅加成池', activeVersion: 1, versions: [bonusOnly], sharedGroupId: null }),
    ],
  };
}
