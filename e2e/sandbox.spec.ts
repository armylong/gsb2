import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __stage: {
      camera: { zoom: number; centre: { x: number; y: number }; viewport: { width: number; height: number } };
      sandbox: import('../src/sandbox').Sandbox;
      loadScenario: (id: string) => void;
      setMode: (mode: 'player' | 'edit' | 'debug') => void;
      selectUnit: (id: 'A' | 'B') => void;
      toggleDoorAt: (col: number, row: number) => void;
      queueEdit: (col: number, row: number) => void;
      applyPending: () => void;
      setPaused: (paused: boolean) => void;
      centreOf: (col: number, row: number) => { x: number; y: number };
      pick: (sx: number, sy: number) => { q: number; r: number; col: number; row: number };
    };
  }
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__stage && window.__stage.sandbox));
  await page.waitForTimeout(150);
}

/** Screen position of a cell centre, using the live camera. */
async function screenOf(page: import('@playwright/test').Page, col: number, row: number) {
  const box = await (await page.$('#map'))!.boundingBox();
  const point = await page.evaluate(
    ([col, row]) => {
      const { camera, centreOf } = window.__stage;
      const c = centreOf(col, row);
      return {
        x: (c.x - camera.centre.x) * camera.zoom + camera.viewport.width / 2,
        y: (c.y - camera.centre.y) * camera.zoom + camera.viewport.height / 2,
      };
    },
    [col, row],
  );
  return { x: box!.x + point.x, y: box!.y + point.y };
}

test.describe('hex recon sandbox', () => {
  test('picking stays on the right cell after zooming and panning', async ({ page }) => {
    await boot(page);
    const before = await screenOf(page, 5, 6);
    // Zoom in around the projected point, then pan a little.
    await page.mouse.move(before.x, before.y);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x + 90, before.y + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);

    const zoom = await page.evaluate(() => window.__stage.camera.zoom);
    expect(zoom).toBeGreaterThan(30);

    // Wherever a cell's centre now projects, picking must return that cell.
    for (const [col, row] of [[5, 6], [3, 5], [7, 6], [4, 7]] as const) {
      const point = await screenOf(page, col, row);
      const picked = await page.evaluate(
        ({ x, y }) => {
          const box = document.getElementById('map')!.getBoundingClientRect();
          return window.__stage.pick(x - box.left, y - box.top);
        },
        point,
      );
      expect(picked).toMatchObject({ col, row });
    }
  });

  test('clicking after zoom selects the unit under the cursor and moves it', async ({ page }) => {
    await boot(page);
    const target = await screenOf(page, 4, 6);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(120);

    const state = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      const a = s.units.find((u) => u.id === 'A')!;
      return { col: s.cellCoordinates(a.q, a.r).col, row: s.cellCoordinates(a.q, a.r).row };
    });
    expect(state).toEqual({ col: 4, row: 6 });
  });

  test('player view never paints hidden enemies, debug view does', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__stage.loadScenario('corner'));
    await page.waitForTimeout(150);

    const playerEnemies = await page.evaluate(() =>
      window.__stage.sandbox.visibleEnemies().map((e) => e.id),
    );
    const allEnemies = await page.evaluate(() => window.__stage.sandbox.enemies.map((e) => e.id));
    expect(allEnemies.length).toBeGreaterThan(playerEnemies.length);

    // Canvas pixel probe: a hidden enemy's cell centre must not carry enemy red.
    const hidden = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      const e = s.enemies.find((x) => !s.vision.isVisible(x.q, x.r));
      return e ? { col: s.cellCoordinates(e.q, e.r).col, row: s.cellCoordinates(e.q, e.r).row } : null;
    });
    expect(hidden).not.toBeNull();

    const pixel = await page.evaluate(
      ({ col, row }) => {
        const s = window.__stage;
        const c = s.centreOf(col, row);
        const cam = s.camera;
        const x = Math.round((c.x - cam.centre.x) * cam.zoom + cam.viewport.width / 2);
        const y = Math.round((c.y - cam.centre.y) * cam.zoom + cam.viewport.height / 2);
        const canvas = document.getElementById('map') as HTMLCanvasElement;
        const dpr = canvas.width / cam.viewport.width;
        const ctx = canvas.getContext('2d')!;
        const data = ctx.getImageData(Math.round(x * dpr) - 2, Math.round(y * dpr) - 2, 5, 5).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          if (r > 90 && r - g > 35 && r - b > 25) red++;
        }
        return { red };
      },
      hidden!,
    );
    expect(pixel.red).toBe(0);

    await page.evaluate(() => window.__stage.setMode('debug'));
    await page.waitForTimeout(150);
    const debugPixel = await page.evaluate(
      ({ col, row }) => {
        const s = window.__stage;
        const c = s.centreOf(col, row);
        const cam = s.camera;
        const x = Math.round((c.x - cam.centre.x) * cam.zoom + cam.viewport.width / 2);
        const y = Math.round((c.y - cam.centre.y) * cam.zoom + cam.viewport.height / 2);
        const canvas = document.getElementById('map') as HTMLCanvasElement;
        const dpr = canvas.width / cam.viewport.width;
        const ctx = canvas.getContext('2d')!;
        const data = ctx.getImageData(Math.round(x * dpr) - 2, Math.round(y * dpr) - 2, 5, 5).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          if (r > 90 && r - g > 35 && r - b > 25) red++;
        }
        return { red };
      },
      hidden!,
    );
    expect(debugPixel.red).toBeGreaterThan(0);
  });

  test('toggling a door in the UI recomputes real vision data', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__stage.loadScenario('door'));
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      const c = s.map.getAtOffset(9, 5);
      return s.vision.isVisible(c.q, c.r);
    });
    expect(before).toBe(false);
    await page.evaluate(() => window.__stage.toggleDoorAt(7, 5));
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      const c = s.map.getAtOffset(9, 5);
      return s.vision.isVisible(c.q, c.r);
    });
    expect(after).toBe(true);
  });

  test('edit mode queues changes while paused and applies them on demand', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      window.__stage.loadScenario('corner');
      window.__stage.setMode('edit');
      window.__stage.setPaused(true);
    });
    const before = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      const c = s.map.getAtOffset(5, 6);
      return { visible: s.vision.isVisible(c.q, c.r), explored: [...s.vision.exploredCells].length };
    });
    // Queue a wall between A and the probe cell; nothing should change yet.
    await page.evaluate(() => window.__stage.queueEdit(4, 6));
    const queued = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      const c = s.map.getAtOffset(5, 6);
      return { visible: s.vision.isVisible(c.q, c.r), terrain: s.map.getAtOffset(4, 6).terrain };
    });
    expect(queued.visible).toBe(before.visible);
    expect(queued.terrain).toBe('floor');

    await page.evaluate(() => window.__stage.applyPending());
    const applied = await page.evaluate(() => {
      const s = window.__stage.sandbox;
      return { terrain: s.map.getAtOffset(4, 6).terrain, explored: [...s.vision.exploredCells].length };
    });
    expect(applied.terrain).toBe('wall');
    expect(applied.explored).toBeGreaterThanOrEqual(before.explored);
  });

  test('scenario checklist reports real vision data and all rows pass', async ({ page }) => {
    await boot(page);
    for (const id of ['sandbox', 'corner', 'door', 'handoff']) {
      await page.evaluate((id) => window.__stage.loadScenario(id), id);
      await page.waitForTimeout(80);
      const rows = await page.locator('#checklist .mark').allTextContents();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.trim() === '✓')).toBe(true);
    }
  });
});
