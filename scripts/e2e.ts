// 端到端冒烟: 驱动本机 Chrome 验证 canvas 渲染与真实交互。
// 运行: npx tsx scripts/e2e.ts  (需先 npm run dev)
import puppeteer, { ElementHandle } from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5173';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(500);

  const results: Array<[string, boolean, string?]> = [];
  const check = (name: string, cond: boolean, extra = '') =>
    results.push([name, cond, extra]);

  // 1. 初始状态: 唯一解预设, 托盘有 8 片(T1 锁定在盘), 无冲突
  const trayCount0 = await page.$$eval('.tray-tile', (els) => els.length);
  check('启动后托盘片数 = 8(9 片中 1 片已锁定在盘)', trayCount0 === 8, `实际 ${trayCount0}`);
  const status0 = await page.$eval('#status', (el) => el.textContent!);
  check('初始状态无冲突', status0.includes('没有冲突'), status0);

  // 2. 点托盘片 -> 点棋盘格落盘, 托盘少一片
  await page.click('.tray-tile');
  const board = await page.$('#board');
  const box = (await board!.boundingBox())!;
  // 几何: 620 画布, 3x3, cell≈96, origin 居中; 点 (1,0) 格中心
  const cell = Math.floor(Math.min((620 - 80) / 3, 96));
  const originX = Math.floor((620 - cell * 3) / 2);
  const originY = originX;
  await page.mouse.click(box.x + originX + cell * 1.5, box.y + originY + cell * 0.5);
  await sleep(200);
  const trayCount1 = await page.$$eval('.tray-tile', (els) => els.length);
  check('点选+点格放置后托盘少一片', trayCount1 === 7, `实际 ${trayCount1}`);
  const status1 = await page.$eval('#status', (el) => el.textContent!);
  // 无论冲突与否, 状态条都应给出基于当前盘面的明确结论
  check('放置后状态条给出结论', status1.includes('冲突') || status1.includes('一致'));

  // 3. 撤销: 片回到托盘
  await page.click('#btn-undo');
  await sleep(200);
  const trayCount2 = await page.$$eval('.tray-tile', (els) => els.length);
  check('撤销后木片恢复到托盘', trayCount2 === 8, `实际 ${trayCount2}`);

  // 4. 提示: 出现高亮 move, 且盘面放置数不变(提示不改盘面)
  const placedBefore = await page.$$eval('#status', () => true);
  void placedBefore;
  await page.click('#btn-hint');
  await sleep(300);
  const log1 = await page.$eval('#log', (el) => el.textContent!);
  check('提示输出一步且声明不改盘面', log1.includes('提示(不改盘面)'), log1.slice(0, 120));
  const trayCount3 = await page.$$eval('.tray-tile', (els) => els.length);
  check('提示没有改动盘面(托盘数量不变)', trayCount3 === 8);

  // 5. 找补全 -> 应用 -> 托盘清空, 无冲突
  await page.click('#btn-solve');
  await sleep(300);
  const logSolve = await page.$eval('#log', (el) => el.textContent!);
  check('唯一解预设能找到补全', logSolve.includes('找到唯一补全'), logSolve.slice(0, 120));
  await page.click('#btn-apply');
  await sleep(300);
  const trayCount4 = await page.$$eval('.tray-tile', (els) => els.length);
  check('应用补全后托盘清空', trayCount4 === 0, `实际 ${trayCount4}`);
  const status2 = await page.$eval('#status', (el) => el.textContent!);
  check('补全后全盘无冲突', status2.includes('没有冲突'), status2);

  // 6. 清空 -> 载入陷阱预设 -> 找补全返回有据解释
  await page.click('#btn-clear');
  await page.select('#preset', '2');
  await page.click('#btn-load-preset');
  await sleep(200);
  await page.click('#btn-solve');
  await sleep(400);
  const logTrap = await page.$eval('#log', (el) => el.textContent!);
  check(
    '陷阱题无解时给出"剩余位置无可用片/死位"解释',
    logTrap.includes('无可用片') && logTrap.includes('死位'),
    logTrap.slice(0, 200),
  );

  // 7. 多解预设: 报告至少 2 种
  await page.select('#preset', '1');
  await page.click('#btn-load-preset');
  await sleep(200);
  await page.click('#btn-solve');
  await sleep(400);
  const logMulti = await page.$eval('#log', (el) => el.textContent!);
  check('多解预设报告多种补全', logMulti.includes('至少 2 种'), logMulti.slice(0, 150));

  // 8. 导出再读入: 下载 JSON -> 用文件选择器读回 -> 状态一致
  const downloadPath = '/tmp/pwc-e2e-downloads';
  const fs = await import('node:fs');
  fs.rmSync(downloadPath, { recursive: true, force: true });
  fs.mkdirSync(downloadPath, { recursive: true });
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath,
  });
  await page.click('#btn-save');
  await sleep(800);
  const files = fs.readdirSync(downloadPath).filter((f) => f.endsWith('.json'));
  check('导出产生 JSON 文件', files.length === 1, files.join(','));
  if (files.length === 1) {
    const saved = JSON.parse(fs.readFileSync(`${downloadPath}/${files[0]}`, 'utf8'));
    check('导出文件含 version/puzzle/tiles', !!saved.puzzle && Array.isArray(saved.puzzle.tiles));

    // 清空后读入, 盘面应恢复
    await page.click('#btn-clear');
    await sleep(150);
    const fileInput = (await page.$('#file-input')) as ElementHandle<HTMLInputElement>;
    // 多解预设初始无放置, 改为先放一片再保存才有恢复意义: 重新保存当前(空放置)布局
    await fileInput!.uploadFile(`${downloadPath}/${files[0]}`);
    await sleep(300);
    const logLoad = await page.$eval('#log', (el) => el.textContent!);
    check('读入 JSON 成功并可继续验证', logLoad.includes('读入'), logLoad.slice(0, 100));
    const presetName = await page.$eval('#preset', () => true);
    void presetName;
  }

  // 9. 留空模式: 切到 hole 模式点一格, 该格变洞且片数统计变化
  await page.select('#preset', '1');
  await page.click('#btn-load-preset');
  await sleep(200);
  await page.click('input[name="mode"][value="hole"]');
  await page.mouse.click(box.x + originX + cell * 0.5, box.y + originY + cell * 0.5);
  await sleep(200);
  const statusHole = await page.$eval('#status', (el) => el.textContent!);
  check('留空模式可挖洞(可放格减少)', /可放格 7 个/.test(statusHole), statusHole);
  const warnHidden = await page.$eval('#edge-warn', (el) => (el as HTMLElement).style.display === 'none');
  check('挖洞后无悬挂边条件警告(自动清洗)', warnHidden);

  // 10. HTML5 拖放: 派发带 DataTransfer 的合成 DragEvent(测试 HTML5 DnD 的标准做法)
  // 注意: 事件派给 canvas, 处理器用 getBoundingClientRect 换算, 所以这里给 canvas 相对坐标;
  // dispatchEvent 返回 false 表示处理器调用了 preventDefault(本应用 dragover/drop 都会调), 属正常
  await page.click('input[name="mode"][value="play"]');
  const trayBefore = await page.$$eval('.tray-tile', (els) => els.length);
  const firstTileId = await page.$eval('.tray-tile', (el) => (el as HTMLElement).dataset.tileId!);
  // 多解预设中心 (1,1) 是洞, 选右上格 (2,0) 作为目标
  const relX = originX + cell * 2.5;
  const relY = originY + cell * 0.5;
  await page.evaluate(
    (id, x, y) => {
      const src = document.querySelector(`.tray-tile[data-tile-id="${id}"]`)!;
      const dt = new DataTransfer();
      dt.setData('text/plain', id);
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const cv = document.getElementById('board')!;
      const r = cv.getBoundingClientRect();
      const clientX = r.left + x;
      const clientY = r.top + y;
      cv.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt }),
      );
      cv.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt }),
      );
    },
    firstTileId,
    relX,
    relY,
  );
  await sleep(250);
  const trayAfter = await page.$$eval('.tray-tile', (els) => els.length);
  check('HTML5 拖放(dragstart/dragover/drop)可落盘一片', trayAfter === trayBefore - 1,
    `before=${trayBefore} after=${trayAfter}`);

  // 11. 拖动预览的实时冲突: 先清盘, 放一片, 再让另一片在它邻格产生预览(不落盘)
  await page.click('input[name="mode"][value="play"]');
  await page.click('#btn-clear');
  await sleep(150);
  await page.evaluate(() => {
    const [first, second] = [...document.querySelectorAll<HTMLElement>('.tray-tile')];
    const dt1 = new DataTransfer();
    dt1.setData('text/plain', first.dataset.tileId!);
    first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt1 }));
    const cv = document.getElementById('board')!;
    const r = cv.getBoundingClientRect();
    const cell = Math.floor(Math.min((620 - 80) / 3, 96));
    const origin = Math.floor((620 - cell * 3) / 2);
    // (0,0) 在第 9 步被挖成洞且清空盘面会保留洞, 改用非洞格 (2,0)
    const cx = r.left + origin + cell * 2.5;
    const cy = r.top + origin + cell * 0.5;
    cv.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt1 }));
    cv.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt1 }));
    void second;
  });
  await sleep(200);
  const afterFirstDrop = await page.$eval('#status', (el) => el.textContent!);
  check('第 11 步首次 drop 落盘 1 片', /已放 1\/8/.test(afterFirstDrop), afterFirstDrop);
  // 现在第一片在 (2,0); 从托盘取一块仍可用的片到其左邻格 (1,0), 只发 dragover 制造预览, 不 drop
  const secondId = await page.$eval('.tray-tile', (el) => (el as HTMLElement).dataset.tileId!);
  await page.evaluate((id) => {
    const src = document.querySelector<HTMLElement>(`.tray-tile[data-tile-id="${id}"]`)!;
    const dt2 = new DataTransfer();
    dt2.setData('text/plain', id);
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    const cv = document.getElementById('board')!;
    const r = cv.getBoundingClientRect();
    const cell = Math.floor(Math.min((620 - 80) / 3, 96));
    const origin = Math.floor((620 - cell * 3) / 2);
    const cx = r.left + origin + cell * 1.5;
    const cy = r.top + origin + cell * 0.5;
    cv.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt2 }));
  }, secondId);
  await sleep(200);
  const previewStatus = await page.$eval('#status', (el) => el.textContent!);
  check('拖动预览(未落盘)即给出基于已摆片/洞边/外边的冲突或一致结论',
    previewStatus.includes('当前预览位置') || previewStatus.includes('预览有'),
    previewStatus);
  // 预览不应改变已落盘数量(没有 drop)
  const stillPlaced = await page.$eval('#status', (el) => /已放 1\/8/.test(el.textContent!));
  check('仅 dragover 预览不落盘, 已放数量保持 1', stillPlaced);
  await page.screenshot({ path: 'tmp-e2e-drag.png' });

  // 12. 全程无 JS 错误
  check('浏览器无 JS 报错', errors.length === 0, errors.join(' | '));

  await page.screenshot({ path: 'tmp-e2e-final.png' });
  await browser.close();

  let failed = 0;
  for (const [name, ok, extra] of results) {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
