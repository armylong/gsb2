/**
 * 无浏览器验证：用与页面完全相同的烘焙代码在 Node 下
 * 1) 打包 -> 检查采样区域互不重叠
 * 2) 烘焙 -> 再烘焙 -> 逐字节一致（确定性 / 同设置可重建）
 * 3) 导出 bundle -> 从导出的设置重建 -> 与导出 RGBA 逐字节一致
 * 4) 多分辨率（64/128/256/512）全部可打包，并比较接缝（边界）与扩张覆盖率
 * 5) 光源移动后结果确实改变、哈希确实改变
 *
 * 运行：npm run verify
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { bakeLightmap } from './baker.js';
import { assertNoOverlap, packAtlas } from './packer.js';
import { buildSurfaces, defaultSettings } from './scene.js';
import { fnvBytes, settingsHash, stableStringify } from './settings.js';
import type { BakeSettings, ExportBundle } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'tmp', 'verify-out');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function rgbaEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hashBytes(bytes: Uint8Array | Uint8ClampedArray): string {
  return fnvBytes(bytes);
}

console.log('== 1. 图集打包：互不重叠 ==');
{
  const settings = defaultSettings();
  const surfaces = buildSurfaces(settings.scene);
  // 64² 用可容纳的低密度；高分辨率用 UI 默认密度
  const densityBySize: Record<number, number> = { 64: 5, 128: 12, 256: 16, 512: 32 };
  for (const size of [64, 128, 256, 512]) {
    const atlas = packAtlas(surfaces, size, densityBySize[size], settings.paddingPx);
    check(`${size}² 全部 9 个面成功打包`, atlas.overflow.length === 0, `overflow=${atlas.overflow.join(',')}`);
    assertNoOverlap(atlas, settings.paddingPx);
    check(`${size}² 采样区域（含 padding）互不重叠`, true);
    check(
      `${size}² UV 落在 [0,1] 且方向正确`,
      atlas.rects.every(
        (r) => r.uv.u0 >= 0 && r.uv.v0 >= 0 && r.uv.u1 <= 1 && r.uv.v1 <= 1 && r.uv.u1 > r.uv.u0 && r.uv.v1 > r.uv.v0,
      ),
    );
  }

  // 压力场景：密度过高时必须显式报告 overflow，而不是产生重叠
  const stressed = packAtlas(surfaces, 64, 16, settings.paddingPx);
  check('密度过高时显式报告 overflow（不产生重叠）', stressed.overflow.length > 0);
  assertNoOverlap(stressed, settings.paddingPx);
  check('overflow 场景下已放置区域仍互不重叠', true);
}

console.log('== 2. 确定性：同设置两次烘焙逐字节一致 ==');
let exported: ExportBundle | null = null;
{
  const s = defaultSettings();
  const surfaces = buildSurfaces(s.scene);
  const atlas = packAtlas(surfaces, s.atlasSize, s.texelsPerUnit, s.paddingPx);
  const a = bakeLightmap(surfaces, atlas.rects, s);
  const b = bakeLightmap(surfaces, atlas.rects, s);
  check('RGBA 逐字节一致', rgbaEqual(a.rgba, b.rgba));
  check('边界纹素集合一致', a.boundary.every((v, i) => v === b.boundary[i]));
  check('统计一致', a.stats.texelCount === b.stats.texelCount && a.stats.boundaryCount === b.stats.boundaryCount);

  // 导出 PNG + JSON（模拟页面的导出动作）
  const png = new PNG({ width: a.size, height: a.size });
  png.data.set(a.rgba);
  const pngPath = join(outDir, 'lightmap.png');
  writeFileSync(pngPath, PNG.sync.write(png));

  exported = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: s,
    atlas: { size: atlas.size, rects: atlas.rects, overflow: atlas.overflow },
    lightmap: {
      width: a.size,
      height: a.size,
      pngFile: 'lightmap.png',
      rgbaHash: hashBytes(a.rgba),
    },
    settingsHash: settingsHash(s),
  };
  writeFileSync(join(outDir, 'bake-settings.json'), stableStringify(exported));
  check('导出文件已写入 tmp/verify-out/', true);
}

console.log('== 3. 从导出设置重建：与导出 PNG 逐字节一致 ==');
{
  if (!exported) throw new Error('上一步导出失败');
  const rebuiltSettings: BakeSettings = exported.settings;
  const surfaces = buildSurfaces(rebuiltSettings.scene);
  const atlas = packAtlas(
    surfaces,
    rebuiltSettings.atlasSize,
    rebuiltSettings.texelsPerUnit,
    rebuiltSettings.paddingPx,
  );
  check('重建的打包矩形与导出一致', stableStringify(atlas.rects) === stableStringify(exported.atlas.rects));
  const rebuilt = bakeLightmap(surfaces, atlas.rects, rebuiltSettings);

  // 回读导出的 PNG，验证文件内容与烘焙输出一致
  const png = PNG.sync.read(readFileSync(join(outDir, 'lightmap.png')));
  const fromPng = Uint8ClampedArray.from(png.data);
  check('导出 PNG 回读与烘焙 RGBA 逐字节一致', rgbaEqual(fromPng, rebuilt.rgba));
  check('PNG 回读哈希与导出记录的 rgbaHash 一致', hashBytes(fromPng) === exported.lightmap.rgbaHash);
  check('重建贴图哈希与导出哈希一致', hashBytes(rebuilt.rgba) === exported.lightmap.rgbaHash);
  check('设置哈希一致', settingsHash(rebuiltSettings) === exported.settingsHash);
}

console.log('== 4. 分辨率对比：接缝（边界密度）与边缘扩张覆盖率 ==');
{
  const base = defaultSettings();
  const densityBySize: Record<number, number> = { 64: 5, 128: 12, 256: 16, 512: 32 };
  const rows: string[] = [];
  for (const size of [64, 128, 256, 512]) {
    const s = { ...base, atlasSize: size, texelsPerUnit: densityBySize[size] };
    const surfaces = buildSurfaces(s.scene);
    const atlas = packAtlas(surfaces, s.atlasSize, s.texelsPerUnit, s.paddingPx);
    const lm = bakeLightmap(surfaces, atlas.rects, s);
    const density = lm.stats.boundaryCount / lm.stats.texelCount;
    rows.push(
      `${size}²: 边界 ${lm.stats.boundaryCount} 纹素 (密度 ${(density * 100).toFixed(2)}%), ` +
        `bias 敏感 ${lm.stats.biasSensitiveCount}, padding 空洞 ${lm.stats.paddingHoles}, ` +
        `闲置区域 ${lm.stats.remainingHoles}`,
    );
    // 真正的接缝缺陷只看 padding 环带；图集闲置区域不属于任何面，允许留空
    check(`${size}² padding 环带被扩张完全覆盖（无接缝渗色）`, lm.stats.paddingHoles === 0, `${lm.stats.paddingHoles} 个环带空洞`);
    check(`${size}² 检测到阴影边界`, lm.stats.boundaryCount > 0);
  }
  console.log(rows.map((r) => `     ${r}`).join('\n'));
}

console.log('== 5. 设置敏感性：移动光源 / 改 bias 必须产生可观察变化 ==');
{
  const s = defaultSettings();
  const surfaces = buildSurfaces(s.scene);
  const atlas = packAtlas(surfaces, s.atlasSize, s.texelsPerUnit, s.paddingPx);
  const before = bakeLightmap(surfaces, atlas.rects, s);
  const hashBefore = settingsHash(s);

  const moved = defaultSettings({
    light: { ...s.light, position: [1.2, 2.0, 1.0] },
  });
  const afterMove = bakeLightmap(surfaces, atlas.rects, moved);
  check('移动光源后 RGBA 改变', !rgbaEqual(before.rgba, afterMove.rgba));
  check('移动光源后设置哈希改变', settingsHash(moved) !== hashBefore);

  const biased = defaultSettings({ rayBias: s.rayBias * 5 });
  const afterBias = bakeLightmap(surfaces, atlas.rects, biased);
  check('调整 rayBias 后哈希改变', settingsHash(biased) !== hashBefore);
  // 偏差量化：要么当前场景的边界对 bias 敏感，要么极端 bias 直接改变了结果
  check(
    '遮挡边缘偏差被量化（bias 敏感计数或输出变化）',
    afterBias.stats.biasSensitiveCount > 0 || !rgbaEqual(before.rgba, afterBias.rgba),
    `敏感 ${afterBias.stats.biasSensitiveCount}`,
  );

  // 无扩张设置：padding 环带应保留空洞（证明扩张确实在消除接缝）
  const noDilate = defaultSettings({ dilationPasses: 0 });
  const lmNoDilate = bakeLightmap(surfaces, atlas.rects, noDilate);
  check('dilationPasses=0 时 padding 环带存在空洞', lmNoDilate.stats.paddingHoles > 0);
  check('dilationPasses=8（默认）时 padding 环带无空洞', before.stats.paddingHoles === 0);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
console.log(`样例产物：${outDir}`);
