/**
 * 规则引擎 + 高度场 + 预设点的可运行验证。
 * 运行: npm run verify
 */
import { makeHeightfield } from '../src/heightfield';
import {
  evaluateRules, bandFactor, cloneDefaults, FALLBACK, GRASS, ROCK, SNOW, LayerRule,
} from '../src/rules';
import { PRESETS, makeGapRules } from '../src/presets';

let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? `  (${detail})` : ''}`);
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

console.log('== 1. 高度场可重复性 ==');
{
  const a = makeHeightfield(1337);
  const b = makeHeightfield(1337);
  const c = makeHeightfield(999);
  let same = true;
  let diff = false;
  for (const [x, z] of [[0, 0], [123.4, -56.7], [-180, 190], [37.25, 88.5]]) {
    if (a.height(x, z) !== b.height(x, z)) same = false;
    if (a.height(x, z) !== c.height(x, z)) diff = true;
  }
  check('相同种子 → 高度完全一致', same);
  check('不同种子 → 高度不同', diff);
}

console.log('== 2. bandFactor 边界语义 ==');
{
  check('区间内 = 1', bandFactor(5, 0, 10, 2) === 1);
  check('min 处 = 1', bandFactor(0, 0, 10, 2) === 1);
  check('max 处 = 1', bandFactor(10, 0, 10, 2) === 1);
  check('min-feather 处 = 0', bandFactor(-2, 0, 10, 2) === 0);
  check('max+feather 处 = 0', bandFactor(12, 0, 10, 2) === 0);
  check('过渡中点 ≈ 0.5', near(bandFactor(11, 0, 10, 2), 0.5, 1e-9));
}

console.log('== 3. 权重归一化 ==');
{
  const rules = cloneDefaults();
  let ok = true;
  for (let i = 0; i < 5000; i++) {
    const h = -50 + Math.random() * 150;
    const s = Math.random() * 90;
    const r = evaluateRules(h, s, rules);
    const sum = r.normalized.reduce((x, y) => x + y, 0);
    if (!near(sum, 1, 1e-9)) { ok = false; break; }
  }
  check('随机采样 5000 点归一化权重总和恒为 1', ok);
}

console.log('== 4. 默认规则全地形无回退 ==');
{
  const hf = makeHeightfield(1337);
  const rules = cloneDefaults();
  let fallbackCount = 0;
  const half = hf.size / 2 - 2;
  for (let z = -half; z <= half; z += 4) {
    for (let x = -half; x <= half; x += 4) {
      if (evaluateRules(hf.height(x, z), hf.slopeDeg(x, z), rules).fallbackActive) fallbackCount++;
    }
  }
  check('默认规则覆盖整个地形（回退次数 = 0）', fallbackCount === 0, `fallback=${fallbackCount}`);
}

console.log('== 5. 无覆盖时显式回退 ==');
{
  const gap = makeGapRules();
  // 坡度 22°、低海拔：草(≤17°) 岩(≥28°) 雪(≥60m) 都不覆盖
  const r = evaluateRules(0, 22, gap);
  check('fallbackActive = true', r.fallbackActive);
  check('回退层权重 = 1', r.normalized[FALLBACK] === 1);
  check('其余层权重 = 0', r.normalized.slice(0, 3).every((w) => w === 0));
  check('winner = FALLBACK', r.winner === FALLBACK);
}

console.log('== 6. 重叠时优先级决定分配 ==');
{
  // 两层覆盖率完全相同，优先级 1 vs 3
  const rules: LayerRule[] = [
    { name: 'A', heightMin: -100, heightMax: 100, heightFeather: 1, slopeMin: 0, slopeMax: 90, slopeFeather: 1, priority: 1, textureScale: 5 },
    { name: 'B', heightMin: -100, heightMax: 100, heightFeather: 1, slopeMin: 0, slopeMax: 90, slopeFeather: 1, priority: 3, textureScale: 5 },
    { name: 'C', heightMin: 500, heightMax: 600, heightFeather: 1, slopeMin: 0, slopeMax: 90, slopeFeather: 1, priority: 9, textureScale: 5 },
  ];
  const r = evaluateRules(0, 10, rules);
  check('覆盖率相同 → 归一化比 = 优先级比 (0.25 / 0.75)',
    near(r.normalized[0], 0.25, 1e-9) && near(r.normalized[1], 0.75, 1e-9),
    `got ${r.normalized[0].toFixed(3)} / ${r.normalized[1].toFixed(3)}`);
  check('胜者为优先级高的层', r.winner === 1);

  const r2 = evaluateRules(0, 10, rules.map((x) => ({ ...x, priority: 1 })));
  check('优先级拉平 → 各分一半', near(r2.normalized[0], 0.5, 1e-9) && near(r2.normalized[1], 0.5, 1e-9));
}

console.log('== 7. 预设测试点确实卡在边界上 ==');
{
  const hf = makeHeightfield(1337);
  const rules = cloneDefaults();

  const p1 = PRESETS[0].find(hf);
  const h1 = hf.height(p1.x, p1.z);
  const s1 = hf.slopeDeg(p1.x, p1.z);
  check('P1 高度 ≈ 20 (草max/雪min 边界)', near(h1, 20, 1.5), `h=${h1.toFixed(2)}`);
  check('P1 坡度 < 12° (排除岩石干扰)', s1 < 12, `slope=${s1.toFixed(2)}°`);
  const e1 = evaluateRules(h1, s1, rules);
  check('P1 草与雪都在起作用', e1.normalized[GRASS] > 0.05 && e1.normalized[SNOW] > 0.05,
    `草=${(e1.normalized[GRASS] * 100).toFixed(1)}% 雪=${(e1.normalized[SNOW] * 100).toFixed(1)}%`);

  const p2 = PRESETS[1].find(hf);
  const h2 = hf.height(p2.x, p2.z);
  const s2 = hf.slopeDeg(p2.x, p2.z);
  check('P2 坡度 ≈ 26° (岩min 边界)', near(s2, 26, 2.5), `slope=${s2.toFixed(2)}°`);
  check('P2 高度 < 24 (排除雪干扰)', h2 < 24, `h=${h2.toFixed(2)}`);
  const e2 = evaluateRules(h2, s2, rules);
  check('P2 草与岩都在起作用', e2.normalized[GRASS] > 0.05 && e2.normalized[ROCK] > 0.05,
    `草=${(e2.normalized[GRASS] * 100).toFixed(1)}% 岩=${(e2.normalized[ROCK] * 100).toFixed(1)}%`);

  const p3 = PRESETS[2].find(hf);
  const h3 = hf.height(p3.x, p3.z);
  const s3 = hf.slopeDeg(p3.x, p3.z);
  check('P3 高度 > 30', h3 > 30, `h=${h3.toFixed(2)}`);
  check('P3 坡度在 25~55°', s3 > 25 && s3 < 55, `slope=${s3.toFixed(2)}°`);
  const e3 = evaluateRules(h3, s3, rules);
  check('P3 岩与雪都在起作用', e3.normalized[ROCK] > 0.05 && e3.normalized[SNOW] > 0.05,
    `岩=${(e3.normalized[ROCK] * 100).toFixed(1)}% 雪=${(e3.normalized[SNOW] * 100).toFixed(1)}%`);

  const p4 = PRESETS[3].find(hf);
  const e4 = evaluateRules(hf.height(p4.x, p4.z), hf.slopeDeg(p4.x, p4.z), makeGapRules());
  check('P4 在缺口规则下触发回退', e4.fallbackActive,
    `h=${hf.height(p4.x, p4.z).toFixed(2)} slope=${hf.slopeDeg(p4.x, p4.z).toFixed(2)}°`);
}

console.log('');
if (failures > 0) {
  console.error(`验证失败: ${failures} 项未通过`);
  process.exit(1);
} else {
  console.log('全部验证通过 ✔');
}
