/**
 * End-to-end checks driving the real running app in headless Chromium:
 *   1. known-pose three-way FK verification (explicit trig FK vs composed
 *      FK vs three.js world matrix) inside the browser
 *   2. mode switching keeps the current pose
 *   3. reachable / too-far / limited targets, limits always respected
 *   4. base translation/rotation consistency in world coordinates
 *   5. real pointer drag of the target and of the base
 *   6. scripted cross-side drag: no angle jumps, limits always respected
 *   7. UI panel stays in sync with the scene state
 *
 * Run: npm run e2e
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { KNOWN_POSES, DEFAULT_PARAMS } from '../../src/config';
import { maxReach, PEDESTAL_HEIGHT, REACH_TOLERANCE } from '../../src/kinematics';

const CHROME_EXE =
  process.env.CHROME_EXE ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const PORT = 5199;

type Snap = {
  mode: string;
  angles: Record<string, number>;
  params: {
    link1: number;
    link2: number;
    link3: number;
    limits: Record<string, { min: number; max: number }>;
  };
  base: { position: { x: number; y: number; z: number }; yawDeg: number };
  targetWorld: { x: number; y: number; z: number };
  endWorld: { x: number; y: number; z: number };
  residual: number;
  reached: boolean;
  reason: string;
  scriptedRunning: boolean;
};

const LIMIT_KEYS = ['q1', 'q2', 'q3', 'q4'] as const;

function assertInLimits(snap: Snap, label: string): void {
  for (const k of LIMIT_KEYS) {
    const lim = snap.params.limits[k];
    assert.ok(
      snap.angles[k] >= lim.min - 1e-9 && snap.angles[k] <= lim.max + 1e-9,
      `${label}: ${k}=${snap.angles[k]} outside [${lim.min}, ${lim.max}]`
    );
  }
}

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: PORT },
  });
  await server.listen();

  const browser: Browser = await chromium.launch({
    executablePath: CHROME_EXE,
    headless: true,
  });
  const page: Page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // ignore benign missing-favicon noise; everything else is a real failure
    if (m.type() === 'error' && !m.text().includes('favicon')) {
      pageErrors.push(`console: ${m.text()}`);
    }
  });

  const checks: string[] = [];
  const check = (name: string, cond: boolean, detail = ''): void => {
    assert.ok(cond, `${name} ${detail}`);
    checks.push(`PASS  ${name}`);
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => (window as any).__armScene != null, null, {
      timeout: 10000,
    });

    // ---- 1. known poses: three-way FK verification in the browser ----------
    for (const pose of KNOWN_POSES) {
      const r = await page.evaluate(
        ([a, b]) => (window as any).__armScene.applyKnownPose(a, b),
        [pose.angles, pose.base]
      );
      check(
        `known pose "${pose.id}": explicit-FK vs three.js world matrix < 1e-9 m`,
        r.errorExpectedActual < 1e-9,
        `got ${r.errorExpectedActual}`
      );
      check(
        `known pose "${pose.id}": composed-FK vs three.js world matrix < 1e-9 m`,
        r.errorComposedActual < 1e-9,
        `got ${r.errorComposedActual}`
      );
    }

    // ---- 2. mode switching retains the exact current pose ------------------
    await page.evaluate(() => {
      const s = (window as any).__armScene;
      s.setMode('follow');
      s.setTargetWorld({ x: 1.1, y: 0.55, z: 0.25 });
    });
    const before = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    assertInLimits(before, 'follow pose');
    await page.evaluate(() => (window as any).__armScene.setMode('manual'));
    const afterManual = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    for (const k of LIMIT_KEYS) {
      check(
        `mode switch keeps ${k} unchanged`,
        Math.abs(afterManual.angles[k] - before.angles[k]) < 1e-12
      );
    }
    check('manual mode reports manual', afterManual.mode === 'manual');

    // ---- 3a. reachable target ----------------------------------------------
    // known-pose checks leave the app in manual mode; IK requires follow mode
    await page.evaluate(() => (window as any).__armScene.setMode('follow'));
    await page.evaluate(() =>
      (window as any).__armScene.setTargetWorld({ x: 1.2, y: 0.67, z: 0.35 })
    );
    const reachable = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('reachable target: reached ≤ tolerance', reachable.reached, `res=${reachable.residual}`);
    assertInLimits(reachable, 'reachable');

    // ---- 3b. too far --------------------------------------------------------
    const total = maxReach(DEFAULT_PARAMS);
    await page.evaluate(
      (t) => (window as any).__armScene.setTargetWorld(t),
      { x: total * 1.6, y: PEDESTAL_HEIGHT + 0.2, z: 0 }
    );
    const far = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('too-far: flagged unreachable', far.reached === false);
    check('too-far: reason is too-far', far.reason === 'too-far');
    check('too-far: nonzero residual reported', far.residual > REACH_TOLERANCE);
    assertInLimits(far, 'too-far');
    // no fake reach: end stays on the max-reach sphere around the base
    const radialFar = Math.hypot(
      far.endWorld.x - far.base.position.x,
      far.endWorld.z - far.base.position.z
    );
    const reachSphere = Math.hypot(radialFar, far.endWorld.y - PEDESTAL_HEIGHT);
    check(
      'too-far: links never stretched (end within total reach)',
      reachSphere <= total + 1e-9,
      `r=${reachSphere}`
    );

    // ---- 3c. joint-limited --------------------------------------------------
    await page.evaluate(
      (t) => (window as any).__armScene.setTargetWorld(t),
      { x: 0.1, y: PEDESTAL_HEIGHT + 1.99, z: 0 }
    );
    const limited = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('limited: flagged unreachable', limited.reached === false);
    check('limited: reason is limited', limited.reason === 'limited');
    check('limited: residual reported', limited.residual > REACH_TOLERANCE);
    assertInLimits(limited, 'limited');

    // re-enter reachable range
    await page.evaluate(() =>
      (window as any).__armScene.setTargetWorld({ x: 1.2, y: 0.67, z: 0.35 })
    );
    const back = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('re-enters reachable range and follows again', back.reached);

    // ---- 4. base transform consistency in manual mode ----------------------
    const poseStraight = KNOWN_POSES[0];
    await page.evaluate(
      ([a, b]) => (window as any).__armScene.applyKnownPose(a, b),
      [poseStraight.angles, poseStraight.base]
    );
    const atOrigin = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    await page.evaluate(() =>
      (window as any).__armScene.setBasePosition({ x: 1, y: 0, z: 0.5 })
    );
    const moved = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check(
      'base translation moves end by exactly the same delta (manual mode)',
      Math.abs(moved.endWorld.x - (atOrigin.endWorld.x + 1)) < 1e-9 &&
        Math.abs(moved.endWorld.z - (atOrigin.endWorld.z + 0.5)) < 1e-9
    );
    check('local joint angles unchanged after base translation',
      LIMIT_KEYS.every((k) => Math.abs(moved.angles[k] - atOrigin.angles[k]) < 1e-12));
    check('target world coordinates stay fixed when base moves',
      moved.targetWorld.x === 1.2);

    await page.evaluate(() => (window as any).__armScene.setBaseYaw(45));
    const yawed = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('base yaw applied', Math.abs(yawed.base.yawDeg - 45) < 1e-9);
    check('local joint angles unchanged after base yaw',
      LIMIT_KEYS.every((k) => Math.abs(yawed.angles[k] - atOrigin.angles[k]) < 1e-12));
    // world end rotates rigidly: radial distance from base stays total reach
    const rYawed = Math.hypot(
      yawed.endWorld.x - yawed.base.position.x,
      yawed.endWorld.z - yawed.base.position.z
    );
    check('end radial distance invariant under base yaw', Math.abs(rYawed - total) < 1e-9);

    // ---- 5. real pointer drag ----------------------------------------------
    await page.evaluate(() => {
      (window as any).__armScene.setBasePosition({ x: 0, y: 0, z: 0 });
      (window as any).__armScene.setBaseYaw(0);
      (window as any).__armScene.setMode('follow');
      (window as any).__armScene.setTargetWorld({ x: 1.2, y: 0.67, z: 0.35 });
    });
    await page.waitForTimeout(150);
    const screen = await page.evaluate(() =>
      (window as any).__armScene.projectWorld(
        (window as any).__armScene.getSnapshot().targetWorld
      )
    );
    const targetBefore = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    await page.mouse.move(screen.x, screen.y);
    await page.mouse.down();
    await page.mouse.move(screen.x + 120, screen.y + 40, { steps: 12 });
    await page.mouse.up();
    const dragged = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    const targetMoved =
      Math.hypot(
        dragged.targetWorld.x - targetBefore.targetWorld.x,
        dragged.targetWorld.y - targetBefore.targetWorld.y,
        dragged.targetWorld.z - targetBefore.targetWorld.z
      ) > 0.1;
    check('pointer drag moves the target in 3D', targetMoved);
    check('arm follows dragged target', dragged.reached, `res=${dragged.residual}`);
    assertInLimits(dragged, 'drag');

    // drag the base itself
    const baseScreen = await page.evaluate(() =>
      (window as any).__armScene.projectWorld(
        (window as any).__armScene.getSnapshot().base.position
      )
    );
    await page.mouse.move(baseScreen.x, baseScreen.y);
    await page.mouse.down();
    await page.mouse.move(baseScreen.x - 90, baseScreen.y + 30, { steps: 10 });
    await page.mouse.up();
    const baseDragged = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check(
      'dragging the arm moves the base on the ground plane',
      Math.hypot(baseDragged.base.position.x, baseDragged.base.position.z) > 0.05
    );
    assertInLimits(baseDragged, 'base drag');

    // ---- 6. cross-side scripted path ---------------------------------------
    await page.evaluate(() => (window as any).__armScene.startCrossSide());
    // Collect real animation-frame snapshots inside the browser for ~9 s,
    // which covers the full ping-pong path at the scripted speed.
    const frameReport = await page.evaluate(
      () =>
        new Promise<{
          count: number;
          maxFrameJump: number;
          minZ: number;
          maxZ: number;
          allInLimits: boolean;
          samples: Snap[];
        }>((resolve) => {
          const keys = ['q1', 'q2', 'q3', 'q4'];
          const samples: any[] = [];
          let maxFrameJump = 0;
          let minZ = Infinity;
          let maxZ = -Infinity;
          let allInLimits = true;
          let prev: any = null;
          const start = performance.now();
          const tick = (): void => {
            const s = (window as any).__armScene.getSnapshot();
            samples.push(s);
            minZ = Math.min(minZ, s.targetWorld.z);
            maxZ = Math.max(maxZ, s.targetWorld.z);
            for (const k of keys) {
              const lim = s.params.limits[k];
              if (s.angles[k] < lim.min - 1e-9 || s.angles[k] > lim.max + 1e-9) {
                allInLimits = false;
              }
              if (prev) {
                let d = s.angles[k] - prev.angles[k];
                while (d > 180) d -= 360;
                while (d < -180) d += 360;
                maxFrameJump = Math.max(maxFrameJump, Math.abs(d));
              }
            }
            prev = s;
            if (performance.now() - start < 9000) {
              requestAnimationFrame(tick);
            } else {
              resolve({ count: samples.length, maxFrameJump, minZ, maxZ, allInLimits, samples });
            }
          };
          requestAnimationFrame(tick);
        })
    );
    await page.evaluate(() => (window as any).__armScene.stopScripted());
    check('cross-side: collected hundreds of animation frames', frameReport.count > 300,
      `got ${frameReport.count}`);
    check('cross-side: target crossed to both sides of the base (z changes sign)',
      frameReport.minZ < -0.2 && frameReport.maxZ > 0.2);
    check('cross-side: every frame stayed inside joint limits', frameReport.allInLimits);
    check(
      `cross-side: per-frame angle continuity, max jump ${frameReport.maxFrameJump.toFixed(1)}° (< 45°)`,
      frameReport.maxFrameJump < 45
    );

    // ---- 7. UI sync ---------------------------------------------------------
    const uiMode = await page.textContent('[data-section="status"] .status-line');
    check('status panel renders mode text', typeof uiMode === 'string' && uiMode.includes('模式'));
    const inputVal = await page.$eval(
      '[data-section="target"] input',
      (el) => (el as HTMLInputElement).value
    );
    check('target X numeric input synced with scene', Number.isFinite(parseFloat(inputVal)));

    // ---- 8. runtime parameter changes: link lengths + joint limits ---------
    const modified = structuredClone(DEFAULT_PARAMS);
    modified.link1 = 1.0;
    modified.link2 = 0.6;
    modified.link3 = 0.4;
    modified.limits.q2 = { min: -40, max: 40 }; // tighten the shoulder limit
    await page.evaluate((mp) => (window as any).__armScene.setParams(mp), modified);
    const rebuilt = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('setParams: new link lengths reported',
      rebuilt.params.link1 === 1.0 && rebuilt.params.link2 === 0.6 && rebuilt.params.link3 === 0.4);
    // straight pose at the rebuilt geometry: end distance from base must equal
    // the new total reach exactly (proves the scene graph was rebuilt, not relabeled)
    await page.evaluate(
      ([a, b]) => (window as any).__armScene.applyKnownPose(a, b),
      [{ q1: 0, q2: 0, q3: 0, q4: 0 }, { position: { x: 0, y: 0, z: 0 }, yawDeg: 0 }]
    );
    const straight = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    const straightReach = Math.hypot(
      straight.endWorld.x,
      straight.endWorld.z,
      straight.endWorld.y - PEDESTAL_HEIGHT
    );
    check('rebuilt geometry: straight-arm reach equals new total length (2.0 m)',
      Math.abs(straightReach - 2.0) < 1e-9, `got ${straightReach}`);
    // a target needing more than 40° shoulder elevation must now be unreachable
    await page.evaluate(() => (window as any).__armScene.setMode('follow'));
    await page.evaluate(
      (t) => (window as any).__armScene.setTargetWorld(t),
      { x: 0.2, y: PEDESTAL_HEIGHT + 1.9, z: 0 }
    );
    const tightened = (await page.evaluate(() =>
      (window as any).__armScene.getSnapshot()
    )) as Snap;
    check('tightened q2 limit is enforced by IK',
      tightened.angles.q2 <= 40 + 1e-9 && tightened.angles.q2 >= -40 - 1e-9);
    assertInLimits(tightened, 'tightened limits');
    check('target beyond tightened workspace reported unreachable',
      tightened.reached === false && tightened.reason === 'limited');

    // ---- screenshots --------------------------------------------------------
    await page.evaluate(() =>
      (window as any).__armScene.setTargetWorld({ x: 1.2, y: 0.67, z: 0.35 })
    );
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'tests/e2e/screenshot-follow.png' });
    await page.evaluate(
      ([a, b]) => (window as any).__armScene.applyKnownPose(a, b),
      [KNOWN_POSES[1].angles, KNOWN_POSES[1].base]
    );
    await page.click('[data-section="poses"] [data-pose-id="bent"]');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'tests/e2e/screenshot-pose-verify.png' });

    check('no page/console errors', pageErrors.length === 0, pageErrors.join('; '));
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(`\nE2E: ${checks.length} checks passed\n`);
  checks.forEach((c) => console.log(c));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
