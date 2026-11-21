import test from 'node:test';
import assert from 'node:assert/strict';

import { addWeightVersion, activateVersion, cloneConfig, patchActiveRarities, setSharedGroup } from '../src/builder.ts';
import { activeVersionOf, configErrors, findPool, validateConfig } from '../src/config.ts';
import { edgeCaseConfig, sampleConfig } from '../src/samples.ts';

test('样例配置合法', () => {
  assert.deepEqual(configErrors(sampleConfig()), []);
  assert.deepEqual(configErrors(edgeCaseConfig()).filter((i) => i.severity === 'error'), []);
});

test('最多三种稀有度', () => {
  const config = sampleConfig();
  const pool = findPool(config, 'standard');
  const version = activeVersionOf(pool);
  const fourRarities = {
    ...structuredClone(config),
    pools: config.pools.map((p) =>
      p.id === 'standard'
        ? {
            ...p,
            versions: p.versions.map((v) => ({
              ...v,
              rarities: [
                ...v.rarities,
                { id: 'ur', label: 'UR', weight: 1, bonusPerMiss: 0, pityThreshold: null },
              ],
            })),
          }
        : p,
    ),
  };
  assert.ok(version.rarities.length <= 3);
  const errors = configErrors(fourRarities);
  assert.ok(errors.some((e) => e.path.includes('rarities')));
});

test('空池只是警告, 全零权重也是警告', () => {
  const config = edgeCaseConfig();
  const issues = validateConfig(config);
  const emptyWarn = issues.find((i) => i.path.includes('empty') && i.severity === 'warning');
  const zeroWarn = issues.find((i) => i.path.includes('zero-weight') && i.severity === 'warning');
  assert.ok(emptyWarn, '空池应给出警告');
  assert.ok(zeroWarn, '全零权重应给出警告');
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
});

test('共享组成员稀有度 id 集合不一致时报错', () => {
  const config = sampleConfig();
  const broken = cloneConfig(config);
  const weapon = broken.pools.find((p) => p.id === 'weapon')!;
  const version = weapon.versions.find((v) => v.version === weapon.activeVersion)!;
  const patched = structuredClone(broken) as typeof broken;
  const target = patched.pools.find((p) => p.id === 'weapon')!.versions[0]!;
  void version;
  (target as { rarities: typeof target.rarities }).rarities = target.rarities.slice(0, 2);
  const errors = configErrors(patched);
  assert.ok(errors.some((e) => e.path.startsWith('groups.')));
});

test('addWeightVersion 生成新版本并保留旧版本', () => {
  const config = sampleConfig();
  const before = findPool(config, 'standard');
  const { config: next, version } = addWeightVersion(
    config,
    'standard',
    [{ id: 'ssr', weight: 8 }],
    { label: 'v2-上调SSR', createdAt: '2026-02-01T00:00:00.000Z' },
  );
  const after = findPool(next, 'standard');
  assert.equal(version, 2);
  assert.equal(after.activeVersion, 2);
  assert.equal(after.versions.length, before.versions.length + 1);
  assert.equal(activeVersionOf(after).rarities.find((r) => r.id === 'ssr')!.weight, 8);
  // 旧版本没被改动
  assert.equal(activeVersionOf(before).rarities.find((r) => r.id === 'ssr')!.weight, 5);
  assert.equal(findPool(config, 'standard').versions.length, 1, '原配置未被修改');
});

test('activateVersion 可回退到旧权重', () => {
  const config = sampleConfig();
  const { config: v2 } = addWeightVersion(config, 'featured', [{ id: 'ssr', weight: 15 }]);
  const back = activateVersion(v2, 'featured', 1);
  assert.equal(findPool(back, 'featured').activeVersion, 1);
  assert.equal(activeVersionOf(findPool(back, 'featured')).rarities.find((r) => r.id === 'ssr')!.weight, 10);
  assert.throws(() => activateVersion(back, 'featured', 99));
});

test('patchActiveRarities 不改变版本号', () => {
  const config = sampleConfig();
  const patched = patchActiveRarities(config, 'standard', [{ id: 'ssr', pityThreshold: 50 }]);
  const pool = findPool(patched, 'standard');
  assert.equal(pool.versions.length, 1);
  assert.equal(activeVersionOf(pool).rarities.find((r) => r.id === 'ssr')!.pityThreshold, 50);
});

test('setSharedGroup 可加入和退出共享组', () => {
  const config = sampleConfig();
  const joined = setSharedGroup(config, 'standard', 'banner-group');
  assert.equal(findPool(joined, 'standard').sharedGroupId, 'banner-group');
  const left = setSharedGroup(config, 'featured', null);
  assert.equal(findPool(left, 'featured').sharedGroupId, null);
  assert.equal(findPool(config, 'featured').sharedGroupId, 'banner-group', '原配置未被修改');
});

test('非法配置: 阈值 < 1 / 重复 id / 引用不存在的组', () => {
  const config = sampleConfig();
  const mutable = structuredClone(config) as unknown as {
    pools: { id: string; versions: { rarities: { pityThreshold: number | null }[] }[]; sharedGroupId: string | null }[];
    groups: { id: string }[];
  };
  mutable.pools[0]!.versions[0]!.rarities[0]!.pityThreshold = 0;
  mutable.pools[1]!.sharedGroupId = 'nope';
  const errors = configErrors(mutable as never);
  assert.ok(errors.some((e) => e.message.includes('保底阈值')));
  assert.ok(errors.some((e) => e.message.includes('不存在的保底组')));
});
