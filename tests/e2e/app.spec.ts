import { test, expect, type Page } from '@playwright/test';

async function assertCount(page: Page, selector: string, n: number, msg: string) {
  await expect(page.locator(selector), msg).toHaveCount(n);
}

test.describe('纸模折叠页面端到端', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForTimeout(700);
  });

  test('初始渲染且全部几何检查通过', async ({ page }) => {
    await assertCount(page, '#modelSwitch button', 3, '渲染三个纸模按钮');
    const rows = page.locator('#validationList .check-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(7);
    expect(await page.locator('#validationList .badge.fail').count()).toBe(0);
  });

  test('三个预设切换后检查全通过且清除选择', async ({ page }) => {
    for (const key of ['prism', 'tetra', 'cube']) {
      await page.locator(`#modelSwitch button[data-key="${key}"]`).click();
      await page.waitForTimeout(250);
      expect(await page.locator('#validationList .badge.fail').count()).toBe(0);
      expect(await page.locator('#selectionInfo .muted').count()).toBe(1);
    }
  });

  test('播放、暂停与反向', async ({ page }) => {
    await page.locator('#progressSlider').fill('50');
    await page.locator('#playBtn').click();
    await page.waitForTimeout(600);
    await page.locator('#playBtn').click();
    const mid = Number(await page.inputValue('#progressSlider'));
    expect(mid).toBeGreaterThan(50);
    await page.locator('#reverseBtn').click();
    await page.waitForTimeout(3200);
    expect(Number(await page.inputValue('#progressSlider'))).toBeLessThanOrEqual(1);
  });

  test('手动铰链角度后回到统一进度不重复累加', async ({ page }) => {
    expect(await page.locator('#hingeSelect option').count()).toBeGreaterThanOrEqual(3);
    await page.locator('#hingeSelect').selectOption({ index: 1 });
    await page.locator('#hingeSlider').fill('45');
    await expect(page.locator('#hingeValue')).toContainText('45');
    await page.locator('#hingeReset').click();
    expect(await page.inputValue('#hingeSlider')).toBe('0');
  });

  test('三种视角可切换', async ({ page }) => {
    for (const v of ['orbit', 'root', 'top']) {
      await page.locator(`#viewSwitch button[data-view="${v}"]`).click();
      await expect(page.locator(`#viewSwitch button[data-view="${v}"].active`)).toHaveCount(1);
    }
  });

  test('点击展开图选面并展示指标', async ({ page }) => {
    const box = (await page.locator('#netCanvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    const info = await page.locator('#selectionInfo').textContent();
    expect(info).toContain('面心世界位置');
    expect(info).toContain('折叠边长度');
    expect(info).toContain('裁切边闭合端点误差');
  });

  test('2D 画布有实际绘制且无控制台错误', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const nonEmpty = await page.locator('#netCanvas').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    expect(nonEmpty).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });
});
