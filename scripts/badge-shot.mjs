import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: { width: 1360, height: 940, deviceScaleFactor: 2 },
});
const p = await b.newPage();
await p.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 400));
await p.keyboard.press('ArrowRight');
await new Promise((r) => setTimeout(r, 260));
await p.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 300));
await p.screenshot({ path: 'tmp/shots/10-occupied-badge.png' });
await b.close();
console.log('shot done');
