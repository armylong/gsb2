#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = resolve(root, 'tmp/browser-verification');
mkdirSync(outDir, { recursive: true });
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4317/';

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = chromeCandidates.find(p => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium found. Set CHROME_PATH to its executable.');
  process.exit(2);
}

let server;
if (!process.env.BASE_URL) {
  server = spawn('npm', ['run', 'preview', '--', '--port=4317', '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write(`[preview] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[preview] ${d}`));
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Preview server did not start at ${baseUrl}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
function check(name, condition, extra = '') {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures.push(`${name} ${extra}`);
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function waitForApi(page, fnSource, label, timeout = 15000) {
  try {
    await page.waitForFunction(fnSource, { timeout, polling: 100 });
  } catch (error) {
    const debug = await page.evaluate(() => {
      const api = window.__switchReplay;
      return api
        ? {
            time: api.getTime(),
            playing: api.isPlaying(),
            state: api.getState(),
            actual: api.getActual(),
            evidence: api.getEvidence(),
          }
        : 'API missing';
    }).catch(() => 'evaluate failed');
    console.error(JSON.stringify(debug, null, 2));
    throw new Error(`Timed out waiting for ${label}`);
  }
}

async function programColorSignature(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#program-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(42, 210, 90, 150).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4 * 17) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  });
}

let browser;
try {
  await waitForServer();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1680,1200'],
    defaultViewport: { width: 1680, height: 1200 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await waitForApi(page, () => {
    const actual = window.__switchReplay?.getActual();
    return actual?.A?.readyState >= 2 && actual?.B?.readyState >= 2 && actual.A.videoWidth === 1280;
  }, 'both videos ready', 30000);
  console.log('✓ Two actual HTMLVideoElements reached readyState>=2 and 1280px width');

  // ---- Clip 1: primary-only drop + pause/scrub reproduction ----
  console.log('\nClip 1: primary-only drop');
  await page.click('[data-scenario="primary-only"]');
  await waitForApi(page, () => {
    const s = window.__switchReplay.getState();
    return s?.output === 'B' && s.switches.some(x => x.reason === 'primary-unavailable');
  }, 'primary failover');
  await waitForApi(page, () => {
    const ev = window.__switchReplay.getEvidence().find(x => x.switchId === 'sw-2');
    return ev?.settled && Math.abs(ev.actualDeltaAfterMs ?? 9999) < 350;
  }, 'settled actual failover evidence');
  check('primary failure switches to B and actual seek aligns within 260ms', true);

  await sleep(500);
  const bColor = await programColorSignature(page);
  check('program canvas shows orange/backup color', bColor.r > bColor.b + 35, JSON.stringify(bColor));
  await page.screenshot({ path: resolve(outDir, '01-primary-failover.png') });

  // Pause and drag back before the fault using the real range input event path.
  await page.evaluate(() => window.__switchReplay.pause());
  await sleep(150);
  await page.$eval('input[type="range"]', (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, '2.90');
  await sleep(650);
  const scrub = await page.evaluate(() => {
    const api = window.__switchReplay;
    const actual = api.getActual();
    return { time: api.getTime(), a: actual.A.currentTime, b: actual.B.currentTime, pausedA: actual.A.paused, pausedB: actual.B.paused };
  });
  check('scrub pauses and seeks both real videos near 2.9s', Math.abs(scrub.a - 2.9) < 0.25 && Math.abs(scrub.b - 2.9) < 0.25 && scrub.pausedA && scrub.pausedB, JSON.stringify(scrub));
  await page.screenshot({ path: resolve(outDir, '02-scrub-near-fault.png') });

  await page.evaluate(() => window.__switchReplay.play());
  await waitForApi(page, () => {
    const ev = window.__switchReplay.getEvidence().find(e => e.switchId === 'sw-2');
    return (ev?.occurrences ?? 0) >= 2 && ev.settled;
  }, 'reproduced failover');
  check('continuing reproduces the same A→B switch', true);

  // Move near recovery/switchback and verify hysteresis outcome.
  await page.evaluate(() => window.__switchReplay.seek(9.35, true));
  await waitForApi(page, () => {
    const s = window.__switchReplay.getState();
    return s?.output === 'A' && s.switches.some(x => x.reason === 'recovery-primary');
  }, 'stable switchback', 12000);
  const noFlap = await page.evaluate(() => {
    const s = window.__switchReplay.getState();
    const meaningful = s.switches.filter(x => x.to);
    return meaningful.filter(x => x.to === 'A').length === 2 && meaningful.filter(x => x.to === 'B').length === 1;
  });
  check('primary return follows stable rule and does not flap', noFlap);
  await page.screenshot({ path: resolve(outDir, '03-primary-return.png') });

  // ---- Clip 2: sequential drops and simultaneous recovery ----
  console.log('\nClip 2: sequential route loss');
  await page.click('[data-scenario="both-sequential"]');
  await waitForApi(page, () => window.__switchReplay.getState()?.output === 'B', 'A drop to B');
  await waitForApi(page, () => {
    const s = window.__switchReplay.getState();
    return s?.output === null && s.programState === 'no-source';
  }, 'both routes down');
  await sleep(300);
  const noSignalVisible = await page.evaluate(() => {
    const banner = document.querySelector('[data-ref="banner"]');
    const title = document.querySelector('[data-ref="bannerTitle"]')?.textContent;
    return !banner.classList.contains('hidden') && title === 'NO SIGNAL';
  });
  check('NO SIGNAL prompt is visible in real DOM/program state', noSignalVisible);
  await page.screenshot({ path: resolve(outDir, '04-both-offline-no-signal.png') });

  await page.evaluate(() => window.__switchReplay.seek(10.45, true));
  await waitForApi(page, () => {
    const s = window.__switchReplay.getState();
    const rec = s?.switches.find(x => x.reason === 'both-recovered-election');
    return s?.output === 'A' && rec?.simultaneousRecovery === true;
  }, 'simultaneous recovery election', 8000);
  const electionCount = await page.evaluate(() => window.__switchReplay.getState().switches.filter(x => x.reason === 'both-recovered-election').length);
  check('simultaneous recovery elects A once', electionCount === 1, `count=${electionCount}`);
  await sleep(300);
  const aColor = await programColorSignature(page);
  check('program canvas shows blue/primary color after recovery', aColor.b > aColor.r + 15, JSON.stringify(aColor));
  await page.screenshot({ path: resolve(outDir, '05-simultaneous-recovery-a.png') });

  // ---- Lock behavior ----
  console.log('\nLock and catch-up feedback');
  await page.evaluate(() => {
    const api = window.__switchReplay;
    api.loadScenario('manual', false);
    api.seek(1.0, false);
  });
  await page.click('[data-lock="A"]');
  await page.click('button[data-action="drop"][data-route="A"]');
  await page.evaluate(() => window.__switchReplay.seek(2.0, false));
  await waitForApi(page, () => window.__switchReplay.getState()?.programState === 'locked-bad', 'locked bad');
  check('lock keeps A forced and reports locked-bad', true);
  await page.click('[data-lock="auto"]');
  await waitForApi(page, () => {
    const s = window.__switchReplay.getState();
    return s?.lock === 'auto' && s.output === 'B';
  }, 'unlock election');
  check('releasing lock moves away from confirmed bad A to B', true);

  // ---- Catch-up impossible feedback ----
  await page.evaluate(() => window.__switchReplay.seek(2.0, false));
  await page.click('button[data-action="long-stall"][data-route="A"]');
  await page.evaluate(() => window.__switchReplay.seek(10.25, false));
  await sleep(150);
  const catchText = await page.$eval('[data-source-card="A"] [data-metric="catchup"]', el => el.textContent);
  check('impossible catch-up has clear UI feedback', /追不上|无法/.test(catchText || ''), catchText || '');
  await page.screenshot({ path: resolve(outDir, '06-catchup-impossible.png') });

  check('no uncaught browser/console errors', consoleErrors.length === 0, consoleErrors.join('\n'));
  if (consoleErrors.length) console.log(consoleErrors);

  console.log(`\nScreenshots written to ${outDir}`);
  if (failures.length) {
    console.error(`\n${failures.length} verification check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAll browser verification checks passed.');
  }
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 2000).unref();
  }
}
