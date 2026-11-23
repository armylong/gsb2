/**
 * 端到端冒烟：真实 Chromium + 真实 WebAudio/IndexedDB 验证。
 * 用法：先 `npm run preview -- --port 4317`，再 `node scripts/e2e-smoke.mjs`
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SAMPLER_URL ?? 'http://localhost:4317';
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra: extra ? String(extra) : '' });
  if (!cond) console.error(`✗ ${name} ${extra}`);
}

const dir = mkdtempSync(join(tmpdir(), 'sampler-e2e-'));
// 生成一个 0.2s 220Hz 正弦 WAV（16bit PCM 单声道 22050Hz）
function makeWav(path) {
  const sr = 22050, n = Math.floor(sr * 0.2);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * (i / sr)) * 26000), 44 + i * 2);
  }
  writeFileSync(path, buf);
}
const wavPath = join(dir, 'kick.wav');
makeWav(wavPath);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => check('页面无未捕获异常', false, e.stack ?? e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('console.error:', msg.text());
});
await page.goto(BASE);
// 清掉上一次运行留在 IndexedDB 的数据，保证冒烟从默认映射开始
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = indexedDB.deleteDatabase('footstep-sampler');
      r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
    }),
);
await page.reload();
await new Promise((r) => setTimeout(r, 500));

const S = () => page.evaluate(() => window.__sampler);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 0. 初始化音频，等待 5 个内置素材全部 ready ----
await page.click('text=启用音频');
await page.waitForFunction(
  () => Object.values(window.__sampler.engine.getSnapshot().sampleStates).every((s) => s.status === 'ready'),
  null, { timeout: 10000 },
);
check('内置素材全部 ready', true);

// ---- 1. 每次触发恰好一条 started，seq 单调，不漏不重 ----
const before = await page.evaluate(() => window.__sampler.engine.events.length);
await page.evaluate(() => { const e = window.__sampler.engine; for (const v of [20, 20, 76, 110]) e.trigger(v); });
await wait(300);
const started = await page.evaluate(
  (b) => window.__sampler.engine.events.recent(200).filter((e) => e.seq >= b && e.kind === 'trigger-started'),
  before,
);
check('4 次触发 => 4 条 started（不漏不重）', started.length === 4, `got ${started.length}`);
const seqs = started.map((e) => e.seq).sort((a, b) => a - b);
check('事件 seq 单调递增', seqs.every((x, i) => i === 0 || x > seqs[i - 1]));

// ---- 2. 轮转：同区域连续触发变体 0,1,0,1 ----
const rot = await page.evaluate(() => {
  const e = window.__sampler.engine;
  e.resetRotation();
  for (let i = 0; i < 4; i++) e.trigger(20);
  return e.events
    .recent(20)
    .filter((x) => x.kind === 'trigger-started')
    .slice(0, 4)
    .map((x) => x.payload.layers[0].variantIndex)
    .reverse();
});
check('轻区变体按 0,1,0,1 轮转', JSON.stringify(rot) === JSON.stringify([0, 1, 0, 1]), JSON.stringify(rot));

// ---- 3. 交叉区混合：v=76 两层，权重平方和≈1；边界 v=64 低区权重≈1 ----
const cross = await page.evaluate(() => {
  const e = window.__sampler.engine;
  e.trigger(76);
  const a = e.events.recent(1)[0].payload.layers;
  e.trigger(64);
  const b = e.events.recent(1)[0].payload.layers;
  return { mid: a, edge: b };
});
check('交叉点产生 2 个混合层', cross.mid.length === 2, `got ${cross.mid.length}`);
const sq = cross.mid.reduce((acc, l) => acc + l.weight ** 2, 0);
check('等功率权重平方和≈1', Math.abs(sq - 1) < 1e-4, String(sq));
check('交叉边界低区权重≈1、高区≈0', cross.edge.length === 2 && cross.edge[0].weight > 0.999 && cross.edge[1].weight < 1e-6);

// ---- 4. 确定性：重置后相同力度序列 => 相同变体/权重 ----
const det = await page.evaluate(() => {
  const e = window.__sampler.engine;
  const m = e.getMapping();
  const vel = [10, 76, 120, 70, 30, 88, 64, 50];
  e.resetRotation();
  vel.forEach((v) => e.trigger(v));
  const r1 = e.events.recent(vel.length).map((x) => JSON.stringify(x.payload.layers?.map((l) => [l.variantIndex, l.sampleId, l.weight])));
  e.resetRotation();
  vel.forEach((v) => e.trigger(v));
  const r2 = e.events.recent(vel.length).map((x) => JSON.stringify(x.payload.layers?.map((l) => [l.variantIndex, l.sampleId, l.weight])));
  return JSON.stringify(r1) === JSON.stringify(r2);
});
check('重置后相同力度序列结果完全一致', det);

// ---- 5. 连按超 maxVoices => 旧声被偷，台账可见 stolen ----
await page.evaluate(() => { const e = window.__sampler.engine; e.stopAll(); });
const stolenBase = await page.evaluate(() => window.__sampler.engine.events.length);
await page.evaluate(() => { const e = window.__sampler.engine; for (let i = 0; i < 6; i++) e.trigger(100); });
await wait(150);
const stolen = await page.evaluate(
  (b) => window.__sampler.engine.events
    .recent(300)
    .filter((e) => e.seq >= b && e.kind === 'voice-ended' && e.payload.reason === 'stolen').length,
  stolenBase,
);
const active = await page.evaluate(() => window.__sampler.engine.getSnapshot().voices.length);
check('6 连按(maxVoices=4) 产生 2 条偷旧声', stolen === 2, `got ${stolen}`);
check('活动声音不超过上限', active <= 4, `got ${active}`);

// ---- 6. 松键只结束自己 press 的声音 ----
const rel = await page.evaluate(() => {
  const e = window.__sampler.engine;
  e.stopAll();
  const p1 = e.trigger(50);
  const p2 = e.trigger(50);
  const beforeCount = e.getSnapshot().voices.length;
  e.release(p1);
  const after = e.getSnapshot().voices.map((v) => v.pressId);
  return { beforeCount, after, p2 };
});
check('松键前两个声音独立存在', rel.beforeCount === 2);
check('松键只结束本 press，另一声保留', rel.after.length === 1 && rel.after[0] === rel.p2, JSON.stringify(rel.after));

// ---- 7. 拦截原因可查：把现有区域改成力度空洞后触发（通过真实 UI 输入） ----
const zoneCount = await page.locator('.zone-card').count();
for (let i = 0; i < zoneCount; i++) {
  const card = page.locator('.zone-card').first();
  await card.locator('input[type=number]').nth(0).fill('40');
  await card.locator('input[type=number]').nth(1).fill('80');
}
await page.evaluate(() => window.__sampler.engine.trigger(10));
const blocked = await page.evaluate(() => window.__sampler.engine.events.recent(1)[0]);
check('空洞力度触发被拦且原因明确', blocked.kind === 'trigger-blocked' && blocked.payload.blocked[0].reason === 'no-zone');

// ---- 8. 上传本地 WAV：解码 ready，通过 UI 挂进变体并播出 ----
// 先删光第 7 步改过的区域，再新建一个干净的全力度单区（全部走 UI，保证 React state 与引擎一致）
while ((await page.locator('.zone-card').count()) > 0) {
  await page.locator('.zone-card .danger').first().click();
}
await page.click('text=+ 加区域');
const sole = page.locator('.zone-card').first();
await sole.locator('input[type=number]').nth(0).fill('1');
await sole.locator('input[type=number]').nth(1).fill('127');
await sole.locator('input').first().fill('单区');

await page.setInputFiles('input[type=file]', wavPath);
await page.waitForFunction(
  () => window.__sampler.engine.getMapping().samples.some((s) => s.source.kind === 'upload'),
  null, { timeout: 10000 },
);
await page.waitForFunction(
  () => {
    const e = window.__sampler.engine;
    const up = e.getMapping().samples.find((s) => s.source.kind === 'upload');
    return up && e.getSampleState(up.id).status === 'ready';
  },
  null, { timeout: 10000 },
);
// 通过真实 UI 加一条变体并选中上传素材（保证 React 状态与引擎一致）
await page.click('text=+ 加一条轮换变体');
const uploadSampleId = await page.evaluate(() =>
  window.__sampler.engine.getMapping().samples.find((s) => s.source.kind === 'upload').id);
await page.locator('.variant-row select').first().selectOption(uploadSampleId);
const upload = await page.evaluate((expected) => {
  const e = window.__sampler.engine;
  const press = e.trigger(77);
  const row = e.events.recent(1)[0];
  return { press, kind: row.kind, sample: row.payload.layers?.[0]?.sampleId, expected };
}, uploadSampleId);
check('上传 WAV 解码并能播出', upload && upload.press !== null && upload.kind === 'trigger-started' && upload.sample === upload.expected);

// ---- 9. 持久化：保存后重开页面，映射（含上传素材引用）恢复 ----
await page.click('text=保存映射');
await wait(1000);
await page.reload();
await wait(500);
const restored = await page.evaluate(() => {
  const e = window.__sampler.engine;
  const m = e.getMapping();
  return { zone: m.zones[0]?.label, hasUpload: m.samples.some((s) => s.source.kind === 'upload'), counters: Object.keys(e.getSnapshot().counters).length };
});
check('重开后映射恢复', restored.zone === '单区' && restored.hasUpload);
check('重开后轮转计数器归零（确定性从干净状态开始）', restored.counters === 0);
// 重开后 AudioContext 需要重新初始化，随后内置与上传素材都会自动重新解码
await page.click('text=启用音频');
await page.waitForFunction(
  () => Object.values(window.__sampler.engine.getSnapshot().sampleStates).every((s) => s.status === 'ready'),
  null, { timeout: 10000 },
);
const replayAfterReload = await page.evaluate(() => {
  const e = window.__sampler.engine;
  const p = e.trigger(77);
  const row = e.events.recent(1)[0];
  return !!row && row.kind === 'trigger-started' && p !== null;
});
check('重开后上传素材从 IndexedDB 重新解码可播', replayAfterReload);

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
for (const r of failed) console.error(`FAIL: ${r.name} ${r.extra}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
