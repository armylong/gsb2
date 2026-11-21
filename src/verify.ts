/**
 * 可运行的验证脚本：npm run verify
 * 覆盖：同种子复现、存档保存/加载一致、局部重算保留固定点且区域外不变、
 *       拥挤预设产生缺口报告、河岸预设芦苇只长在湿区。
 */
import { genTerrain, cellAt } from './terrain';
import { generate, inRegion, Placement } from './generator';
import { PRESETS } from './vegetation';
import { serialize, deserialize, placementsHash } from './state';

const W = 48;
const H = 32;
let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
  if (!cond) failures++;
}

// ---- 1. 同种子复现 ----
const seed = 'demo-42';
const preset = PRESETS.riverbank;
const terrain = genTerrain(seed, preset.terrainStyle, W, H);
const run1 = generate(terrain, preset.types, seed);
const run2 = generate(terrain, preset.types, seed);
check('同种子两次生成结果一致', placementsHash(run1.placements) === placementsHash(run2.placements));

const runOther = generate(terrain, preset.types, 'another-seed');
check('不同种子结果不同', placementsHash(run1.placements) !== placementsHash(runOther.placements));

// ---- 2. 保存 / 加载 ----
const json = serialize(seed, preset.terrainStyle, preset.types, run1.placements);
const loaded = deserialize(json);
check('存档往返后放置结果一致', placementsHash(loaded.placements) === placementsHash(run1.placements));
const terrainReload = genTerrain(loaded.seed, loaded.terrainStyle, W, H);
const regen = generate(terrainReload, loaded.types, loaded.seed, {
  keep: loaded.placements.filter((p) => p.pinned),
});
check(
  '加载参数重新生成与存档一致',
  placementsHash(regen.placements) === placementsHash(loaded.placements),
);

// ---- 3. 局部重算：固定点保留、区域外不变 ----
const pins: Placement[] = [
  { x: 15, y: 12, type: 'tree', pinned: true },
  { x: 18, y: 14, type: 'reed', pinned: true },
];
const withPins = generate(terrain, preset.types, seed, { keep: pins });
const region = { x0: 10, y0: 8, x1: 25, y1: 20 };
const keep = withPins.placements.filter((p) => p.pinned || !inRegion(p.x, p.y, region));
const local = generate(terrain, preset.types, seed, { region, keep });

const outsideBefore = withPins.placements.filter((p) => !inRegion(p.x, p.y, region));
const outsideAfter = local.placements.filter((p) => !inRegion(p.x, p.y, region));
check('局部重算后区域外布局不变', placementsHash(outsideBefore) === placementsHash(outsideAfter));
check(
  '局部重算保留手工固定位置',
  pins.every((pin) => local.placements.some((p) => p.x === pin.x && p.y === pin.y && p.pinned)),
);
const local2 = generate(terrain, preset.types, seed, { region, keep });
check('局部重算本身可复现', placementsHash(local.placements) === placementsHash(local2.placements));

// ---- 4. 拥挤预设：放不满时报告缺口与最常见限制 ----
const crowded = PRESETS.crowded;
const cTerrain = genTerrain('crowd-1', crowded.terrainStyle, W, H);
const cRun = generate(cTerrain, crowded.types, 'crowd-1');
check(
  '拥挤植被放不满并报告缺口',
  cRun.report.gaps > 0 && cRun.report.topConstraints.length > 0,
  `需求 ${cRun.report.demand}，放下 ${cRun.report.placed}，缺口 ${cRun.report.gaps}`,
);
console.log(
  '  最常见限制: ' +
    cRun.report.topConstraints.map((c) => `${c.reason}×${c.count}`).join(', '),
);

// ---- 5. 狭窄河岸：芦苇只长在湿区 ----
const reeds = run1.placements.filter((p) => p.type === 'reed');
check('河岸预设生成了芦苇', reeds.length > 0, `${reeds.length} 株`);
check(
  '芦苇全部位于湿区',
  reeds.every((p) => cellAt(terrain, p.x, p.y).zone === 'wet'),
);

console.log(failures === 0 ? '\n全部验证通过 ✔' : `\n${failures} 项验证失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
