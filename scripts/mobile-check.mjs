import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await p.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 400));
const overflow1 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log('L1 horizontal overflow px:', overflow1);
await p.screenshot({ path: 'tmp/shots/mobile-l1.png' });
const tabs = await p.$$('.level-tab');
await tabs[1].click();
await new Promise((r) => setTimeout(r, 400));
const overflow2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const canvasBox = await p.$eval('#game-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
console.log('L2 horizontal overflow px:', overflow2, 'canvas CSS:', JSON.stringify(canvasBox));
await p.screenshot({ path: 'tmp/shots/mobile-l2.png' });
await b.close();
