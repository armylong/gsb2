import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';

const results: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  results.push(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

await page.goto(BASE, { waitUntil: 'networkidle' });

// 1. 基础渲染: 侧带表、键盘、频谱画布都在
const rowCount = await page.locator('#sideband-table tbody tr').count();
check('sideband table populated', rowCount > 5, `${rowCount} rows`);
const keyCount = await page.locator('.key').count();
check('keyboard rendered with 2 octaves', keyCount === 24, `${keyCount} keys`);
check('no console errors on load', errors.length === 0, errors.join('; '));

// 2. 侧带表内容: 存在载波行 n=0 且标为带内
const carrierRow = page.locator('#sideband-table tbody tr', { hasText: '' }).first();
await carrierRow.waitFor();
const firstRowText = await page.locator('#sideband-table tbody tr').first().innerText();
check('carrier row order 0 present', firstRowText.trimStart().startsWith('0'), firstRowText.replace(/\n/g, ' | '));

// 3. 强侧带电铃预设: 侧带数量应显著增多
await page.click('#preset-bell');
await page.waitForTimeout(100);
const bellRows = await page.locator('#sideband-table tbody tr').count();
check('bright bell yields many sidebands', bellRows >= 8, `${bellRows} rows`);
const bellSummary = await page.locator('#freq-summary').innerText();
check('bell summary shows I=4', bellSummary.includes('4.00'), bellSummary);

// 4. 调制归零: 只剩载波一条高于阈值的带内分量
await page.click('#mod-zero');
await page.waitForTimeout(100);
const zeroRows = await page.locator('#sideband-table tbody tr').count();
check('I=0 collapses to single carrier row', zeroRows === 1, `${zeroRows} rows`);
const zeroText = await page.locator('#sideband-table tbody tr').first().innerText();
check('surviving band is carrier n=0 at ~0dB', zeroText.includes('0') && zeroText.includes('带内'), zeroText.replace(/\n/g, ' '));

// 5. 近纯音预设: 侧带行数可以有几个(J2 仍在 -60dB 阈值之上),
//    但所有非载波分量都必须很弱(近纯音)
await page.click('#preset-pure');
await page.waitForTimeout(100);
const pureRows = await page.locator('#sideband-table tbody tr').allInnerTexts();
const nonCarrierLevels = pureRows
  .filter((r) => !r.trimStart().startsWith('0\t'))
  .map((r) => parseFloat(r.split('\t')[3]));
const maxSideDb = Math.max(...nonCarrierLevels);
check(
  'pure-tone preset: all sidebands below -20dB',
  nonCarrierLevels.length > 0 && maxSideDb < -20,
  `max sideband ${maxSideDb.toFixed(1)}dB across ${pureRows.length} rows`,
);

// 6. 触发一个音符 (模拟 pointerdown/up), 验证不报错且分析器挂上
await page.dispatchEvent('.white-key[data-midi="69"]', 'pointerdown', { pointerId: 1 });
await page.waitForTimeout(300);
await page.dispatchEvent('.white-key[data-midi="69"]', 'pointerup', { pointerId: 1 });
await page.waitForTimeout(100);
check('note trigger produced no errors', errors.length === 0, errors.join('; '));

// 7. Nyquist 折叠提示: 切到固定高频 + 强深度, 强制产生超 Nyquist 侧带
await page.click('#preset-bell');
await page.locator('.seg-btn[data-mode="fixed"]').click();
await page.fill('#fixed-freq', '6000');
await page.waitForTimeout(100);
const warningVisible = await page.locator('#nyquist-warning').isVisible();
const warningText = await page.locator('#nyquist-warning').innerText().catch(() => '');
check('above-Nyquist warning shown', warningVisible, warningText.slice(0, 60));
if (warningVisible) {
  const aliasTags = await page.locator('#sideband-table .tag-alias').count();
  check('aliased sidebands tagged', aliasTags > 0, `${aliasTags} aliased`);
}

// 8. WAV 导出: 监听 download 事件, 校验文件头
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#export-btn'),
]);
const path = await download.path();
check('download produced a file', !!path);
if (path) {
  const buf = await download.createReadStream().then(
    (stream) =>
      new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      }),
  );
  const riff = buf.slice(0, 4).toString('ascii');
  const wave = buf.slice(8, 12).toString('ascii');
  check('WAV header RIFF/WAVE', riff === 'RIFF' && wave === 'WAVE', `${riff}/${wave}`);
  const dataSize = buf.readUInt32LE(40);
  check('WAV data chunk non-trivial', dataSize > 1000, `${dataSize} bytes`);
  const expectedMin = 44 + dataSize;
  check('WAV total size matches header', buf.length === expectedMin, `${buf.length} vs ${expectedMin}`);
}

await browser.close();

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
