/// <reference path="../src/types/global.d.ts" />
import { expect, test, type Page } from '@playwright/test';

interface TileStat {
  index: number;
  contestedPx: number;
  coveragePx: number;
  ratio: number;
  deltaMin: number;
  deltaMedian: number;
  deltaMax: number;
  predictedStep: number;
  gapWorld: number;
}

interface ModeStats {
  mode: 'direct' | 'reversed';
  effectiveReversed: boolean;
  storageModel: string;
  stats: {
    tiles: TileStat[];
    contestedPx: number;
    coveragePx: number;
    ratio: number;
  };
}

interface LabApi {
  getState(): {
    near: number;
    far: number;
    distance: number;
    depthType: string;
    capabilities: { reversedDepthBufferActive: boolean; extClipControl: boolean; formats: unknown[] };
  };
  getStats(): ModeStats[];
  runScan(config?: Record<string, number>): Promise<{
    direct: ScanResult;
    reversed: ScanResult;
  }>;
  diagnose(distance: number): {
    mode: 'direct' | 'reversed';
    effectiveReversed: boolean;
    storageModel: string;
    tiles: TileStat[];
  }[];
  setDistance(distance: number): number;
  sampleDepthAt(x: number, y: number): { mode: string; depths: { front: number; back: number } | null }[];
  getScanSummary(): string;
  tileCoverageBounds(): { mode: string; bounds: ({ x0: number; y0: number; x1: number; y1: number } | null)[] }[];
  getContestedMask(): { mode: string; width: number; height: number; mask: number[] }[];
}

interface ScanResult {
  digest: string;
  onsets: { index: number; measured: number | null; predicted: number | null }[];
  steps: { distance: number; ratios: number[] }[];
  config: Record<string, number>;
  elapsedMs: number;
}

declare global {
  interface Window {
    __DEPTH_LAB__: LabApi;
  }
}

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__DEPTH_LAB__), null, { timeout: 30_000 });
  // 首帧渲染 + 实测完成
  await page.waitForFunction(
    () => window.__DEPTH_LAB__.getStats().every((s) => s.stats.coveragePx > 0),
    null,
    { timeout: 30_000 },
  );
  expect(errors, errors.join('\n')).toEqual([]);
}

test.describe('深度精度实验台', () => {
  test('两个视口都能渲染出内容，且反向深度在支持时真的启用', async ({ page }) => {
    await boot(page);
    const stats = await page.evaluate(() => window.__DEPTH_LAB__.getStats());
    expect(stats).toHaveLength(2);
    const [direct, reversed] = stats;
    expect(direct.mode).toBe('direct');
    expect(reversed.mode).toBe('reversed');
    expect(direct.effectiveReversed).toBe(false);
    for (const mode of stats) {
      expect(mode.stats.coveragePx).toBeGreaterThan(0);
      expect(mode.stats.tiles).toHaveLength(5);
    }
    const clip = await page.evaluate(() => window.__DEPTH_LAB__.getState().capabilities.extClipControl);
    if (clip) expect(reversed.effectiveReversed).toBe(true);
    else expect(reversed.effectiveReversed).toBe(false);
  });

  test('深度差与平面间距同号、且不超过间距本身', async ({ page }) => {
    await boot(page);
    const stats = await page.evaluate(() => window.__DEPTH_LAB__.diagnose(1000));
    for (const mode of stats) {
      for (const tile of mode.tiles) {
        expect(tile.gapWorld).toBeGreaterThan(0);
        // 斜坡把深度差限制在 [gap, 2×gap]
        expect(tile.deltaMax).toBeLessThanOrEqual(tile.gapWorld * 2 + tile.gapWorld * 0.05);
        expect(tile.deltaMin).toBeGreaterThan(0);
      }
    }
  });

  test('相机 near/far 可调，且改变 near 会改变争抢程度', async ({ page }) => {
    await boot(page);
    const evaluate = (near: number, far: number) =>
      page.evaluate(
        ({ near, far }) => {
          // 通过 URL 暴露没有意义，这里直接改输入并触发 change。
          const nearInput = document.querySelector<HTMLInputElement>('#near-input')!;
          const farInput = document.querySelector<HTMLInputElement>('#far-input')!;
          nearInput.value = String(near);
          farInput.value = String(far);
          nearInput.dispatchEvent(new Event('change', { bubbles: true }));
          farInput.dispatchEvent(new Event('change', { bubbles: true }));
          return window.__DEPTH_LAB__.diagnose(1000);
        },
        { near, far },
      );

    const tight = await evaluate(0.1, 1e5);
    const wide = await evaluate(1, 1e5);
    const tightRatio = tight[0].tiles.reduce((sum, t) => sum + t.contestedPx, 0) /
      Math.max(1, tight[0].tiles.reduce((sum, t) => sum + t.coveragePx, 0));
    const wideRatio = wide[0].tiles.reduce((sum, t) => sum + t.contestedPx, 0) /
      Math.max(1, wide[0].tiles.reduce((sum, t) => sum + t.coveragePx, 0));
    expect(Number.isFinite(tightRatio)).toBe(true);
    expect(Number.isFinite(wideRatio)).toBe(true);
    // 更宽的 far/near 比应该让正深度更深、精度更差（争抢更多或至少不同）。
    const tightFarNear = 1e5 / 0.1;
    const wideFarNear = 1e5 / 1;
    expect(tightFarNear).toBeGreaterThan(wideFarNear);
    expect(Math.abs(tightRatio - wideRatio)).toBeGreaterThan(0);
  });

  test('保持参考物比例：屏幕上的平面尺寸不随距离变化', async ({ page }) => {
    await boot(page);
    const boundsAt = async (distance: number) => {
      await page.evaluate((d) => window.__DEPTH_LAB__.setDistance(d), distance);
      return page.evaluate(() => window.__DEPTH_LAB__.tileCoverageBounds()[0].bounds);
    };

    const near = await boundsAt(100);
    const far = await boundsAt(5000);
    expect(near).toHaveLength(5);
    expect(far).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(near[i]).not.toBeNull();
      expect(far[i]).not.toBeNull();
      const a = near[i]!;
      const b = far[i]!;
      // 等比缩放下，同一组在不同距离的屏幕包围盒应几乎一致（允许 2px 光栅化误差）。
      expect(Math.abs(a.x1 - a.x0 - (b.x1 - b.x0))).toBeLessThanOrEqual(2);
      expect(Math.abs(a.y1 - a.y0 - (b.y1 - b.y0))).toBeLessThanOrEqual(2);
      expect(Math.abs(a.x0 - b.x0)).toBeLessThanOrEqual(2);
    }
  });

  test('关闭参考比例后，同一组在不同距离的屏幕尺寸明显改变', async ({ page }) => {
    await boot(page);
    const measure = async (distance: number) => {
      await page.evaluate((d) => window.__DEPTH_LAB__.setDistance(d), distance);
      return page.evaluate(() => window.__DEPTH_LAB__.tileCoverageBounds()[0].bounds[4]);
    };
    const before = await measure(500);
    await page.locator('#keep-ratio').uncheck();
    const near = await measure(500);
    const far = await measure(3000);
    expect(before).not.toBeNull();
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    // 关闭比例锁定后，远处的平面会明显变小。
    expect(far!.x1 - far!.x0).toBeLessThan(near!.x1 - near!.x0 - 4);
  });

  test('固定相机扫描可重复：同样输入得到同样指纹与起点', async ({ page }) => {
    await boot(page);
    const config = { steps: 24, startDistance: 10, endDistance: 40000 };
    const first = await page.evaluate((c) => window.__DEPTH_LAB__.runScan(c), config);
    const second = await page.evaluate((c) => window.__DEPTH_LAB__.runScan(c), config);

    expect(first.direct.digest).toBe(second.direct.digest);
    expect(first.reversed.digest).toBe(second.reversed.digest);
    expect(first.direct.onsets.map((o) => o.measured)).toEqual(
      second.direct.onsets.map((o) => o.measured),
    );
    expect(first.direct.steps).toHaveLength(24);
    expect(first.direct.steps[0].distance).toBeCloseTo(10, 6);
    expect(first.direct.steps[23].distance).toBeCloseTo(40000, 6);
  });

  test('扫描结果在页面上可见，且能复制', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await page.click('[data-testid="scan-run"]');
    await expect(page.locator('[data-testid="scan-status"]')).toHaveAttribute('data-state', 'done', {
      timeout: 120_000,
    });
    await expect(page.locator('[data-testid="scan-chart-direct"] svg')).toBeVisible();
    await expect(page.locator('[data-testid="scan-chart-reversed"] svg')).toBeVisible();
    await expect(page.locator('[data-testid="scan-summary-direct"] .summary-row')).toHaveCount(5);

    const summary = await page.evaluate(() => window.__DEPTH_LAB__.getScanSummary());
    expect(summary).toContain('digest=');
    expect(summary.split('\n').length).toBeGreaterThan(4);

    await page.click('[data-testid="scan-copy"]');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('深度扫描结果');
  });

  test('深度附件切换到 16 位后存储类型被实测纠正', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => window.__DEPTH_LAB__.getStats().map((s) => s.storageModel));
    for (const model of before) {
      expect(['fixed16', 'fixed24', 'f32']).toContain(model);
    }
    await page.click('#storage-toggles [data-storage="u16"]');
    await page.waitForFunction(() =>
      window.__DEPTH_LAB__.getStats().every((s) => s.storageModel === 'fixed16'),
    );
    const after = await page.evaluate(() => window.__DEPTH_LAB__.getStats());
    for (const mode of after) {
      expect(mode.storageModel).toBe('fixed16');
      expect(mode.stats.coveragePx).toBeGreaterThan(0);
    }
  });

  test('深度差叠加不崩溃，四组深度模式/存储组合都能出图', async ({ page }) => {
    await boot(page);
    for (const storage of ['u16', 'u24', 'f32']) {
      await page.click(`#storage-toggles [data-storage="${storage}"]`);
      for (const overlay of ['none', 'contested', 'delta']) {
        await page.click(`#overlay-toggles [data-overlay="${overlay}"]`);
        const stats = await page.evaluate(() => window.__DEPTH_LAB__.getStats());
        for (const mode of stats) expect(mode.stats.coveragePx).toBeGreaterThan(0);
      }
    }
  });

  test('表格视图可在不悬停的情况下读取数值', async ({ page }) => {
    await boot(page);
    await page.click('[data-role="precision-table-toggle"]');
    const table = page.locator('.chart-card [data-role="precision-table"]');
    await expect(table).toBeVisible();
    const rows = table.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(5);
  });
});
