/**
 * 无头调参脚本：按预设跑仿真，打印关键轨迹与卡榫检查，
 * 用来校准 presets.ts 里的配重数值。浏览器构建不包含本文件。
 *
 * 运行：npx esbuild tools/tune.ts --bundle --platform=node --format=esm --outfile=dist/tune.mjs && node dist/tune.mjs
 */
import { Engine } from '../src/model.js';
import { H_MAX, H_MIN, LATCH_BANDS } from '../src/geometry.js';
import { PRESETS } from '../src/presets.js';

const BODY_IDS = ['carriage1', 'lantern', 'carriage2'] as const;

for (const preset of PRESETS) {
  console.log(`\n=== ${preset.name} (${preset.id}) ===`);
  const eng = new Engine(preset.weights);
  for (const id of preset.arm) eng.toggleLatch(id);

  let peakLanternSpeed = 0;
  let bandCrossing = '';
  const frames = 60 * 16;
  for (let f = 0; f < frames; f++) {
    eng.step();
    peakLanternSpeed = Math.max(peakLanternSpeed, Math.abs(eng.v.lantern));
    const band = LATCH_BANDS.find((b) => b.id === preset.arm[0]);
    if (band && !bandCrossing && eng.h.lantern <= band.hMax && eng.h.lantern >= band.hMin) {
      bandCrossing = `首次进窗格 t=${eng.time.toFixed(2)}s hL=${eng.h.lantern.toFixed(1)} |v|=${Math.abs(eng.v.lantern).toFixed(1)}（阈值 ${band.vMax}）`;
    }
    if (eng.engagedLatch) break;
    if (BODY_IDS.every((id) => eng.contacts[id] !== null)) break;
  }

  const s = eng.snapshot();
  console.log(
    `终态 t=${s.time.toFixed(2)}s h1=${s.h.carriage1.toFixed(1)} hL=${s.h.lantern.toFixed(1)} h2=${s.h.carriage2.toFixed(1)}`,
  );
  console.log(
    `速度 v1=${s.v.carriage1.toFixed(1)} vL=${s.v.lantern.toFixed(1)} v2=${s.v.carriage2.toFixed(1)} | 接触:`,
    JSON.stringify(s.contacts),
    `| 卡榫: ${s.engagedLatch ?? '无'}`,
  );
  console.log('纸灯峰值速度:', peakLanternSpeed.toFixed(1), 'px/s | 张力:', s.tension.toFixed(1));
  if (bandCrossing) console.log(bandCrossing);
  for (const c of eng.checks)
    console.log(`  检查#${c.id} t=${c.time.toFixed(2)} ${c.result} |v|=${c.speed.toFixed(1)} :: ${c.note}`);
  for (const e of eng.events) console.log(`  事件 t=${e.time.toFixed(2)} ${e.text}`);
  const inRange = Object.values(s.h).every((x) => x >= H_MIN - 1e-6 && x <= H_MAX + 1e-6);
  console.log('行程内:', inRange, '| 绳长和:', s.ropeSum.toFixed(4), '(应=660)');
}
