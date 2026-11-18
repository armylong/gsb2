import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:8137/index.html');
await page.waitForSelector('[data-testid="card-s1"]');
await page.waitForTimeout(800);
await page.screenshot({ path: 'scripts/shot-default.png' });

// 启用音频并播放两个声源、转向听者，验证状态变化后的画面
await page.click('#enable-audio');
await page.click('[data-testid="play-s1"]');
await page.click('[data-testid="play-s2"]');
await page.fill('[data-testid="listener-yaw-input"]', '45');
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/shot-playing.png' });
console.log(await page.locator('#audio-status').textContent());
await browser.close();
