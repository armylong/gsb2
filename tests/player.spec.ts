import { test, expect, Page } from '@playwright/test';

interface LabState {
  phase: string;
  currentTime: number;
  duration: number;
  currentLevel: number;
  manualLevel: number;
  paused: boolean;
  errorMessage: string;
  requests: {
    sn: number;
    levelLabel: string;
    rangeStart: number;
    rangeEnd: number;
    attempt: number;
    status: string;
  }[];
}

async function lab(page: Page): Promise<LabState> {
  return page.evaluate(() => (window as any).__lab.getState());
}

async function waitReady(page: Page) {
  await page.waitForFunction(
    () => {
      const s = (window as any).__lab.getState();
      // 元数据就绪即可：此时可能已开始缓冲，phase 不一定恰好停在 ready
      return s.duration > 0 && (s.phase === 'ready' || s.phase === 'buffering');
    },
    null,
    { timeout: 30_000 },
  );
}

test.beforeEach(async ({ page }) => {
  // 故障规则是服务端全局状态，每个用例开始前先清空
  await page.request.fetch('/api/faults', { method: 'DELETE' });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__lab);
});

test('场景A：快速连续定位，最终内容对应最后一次操作', async ({ page }) => {
  await page.getByRole('button', { name: /场景A/ }).click();
  await waitReady(page);
  await page.evaluate(() => (window as any).__lab.play());

  // 快速连续拖动：最后一次落在 45s
  for (const t of [5, 30, 12, 45]) {
    await page.evaluate((t) => (window as any).__lab.seek(t), t);
    await page.waitForTimeout(120);
  }

  // 采样 4 秒：位置不能回退、不能从头播放，必须稳定在最后一次定位附近
  for (let i = 0; i < 10; i++) {
    const s = await lab(page);
    expect(s.phase).not.toBe('failed');
    expect(s.currentTime).toBeGreaterThan(40);
    await page.waitForTimeout(400);
  }

  const s = await lab(page);
  expect(s.currentTime).toBeGreaterThan(43);

  // 界面显示的时间与实际播放位置一致
  const text = await page.getByTestId('time-display').innerText();
  const shown = parseFloat(text.split('/')[0]);
  expect(Math.abs(shown - s.currentTime)).toBeLessThan(0.6);

  // 最近完成的分片应覆盖当前位置（旧位置的迟到分片没有覆盖新位置）
  const ok = s.requests.filter((r) => r.status === 'ok');
  expect(ok.some((r) => r.rangeStart <= s.currentTime && s.currentTime <= r.rangeEnd)).toBeTruthy();
});

test('场景C：慢分片期间连续切换清晰度，时间连续且最终清晰度生效', async ({ page }) => {
  await page.getByRole('button', { name: /场景C/ }).click();
  await waitReady(page);
  await page.evaluate(() => (window as any).__lab.play());
  await page.waitForFunction(() => (window as any).__lab.getState().currentTime > 2, null, {
    timeout: 30_000,
  });

  // 慢请求期间连续切换：0 → 2 → 1，最后选择 480p
  for (const lvl of [0, 2, 1]) {
    await page.evaluate((l) => (window as any).__lab.setLevel(l), lvl);
    await page.waitForTimeout(300);
  }

  // 采样 10 秒：时间不能回退、不能归零重播
  let last = 0;
  for (let i = 0; i < 25; i++) {
    const s = await lab(page);
    expect(s.currentTime + 0.3).toBeGreaterThanOrEqual(last);
    last = s.currentTime;
    await page.waitForTimeout(400);
  }

  const s = await lab(page);
  expect(s.phase).not.toBe('failed');
  expect(s.manualLevel).toBe(1);
  expect(s.currentLevel).toBe(1); // 最后一次选择最终生效
  expect(s.currentTime).toBeGreaterThan(2);
});

test('场景B：单段故障重试有上限，关闭故障后可恢复且界面状态一致', async ({ page }) => {
  await page.getByRole('button', { name: /场景B/ }).click();
  await waitReady(page);
  await page.evaluate(() => {
    (window as any).__lab.seek(18);
    (window as any).__lab.play();
  });

  // 第 5 段（20–24s）持续 500，重试耗尽后进入 failed
  await page.waitForFunction(() => (window as any).__lab.getState().phase === 'failed', null, {
    timeout: 40_000,
  });
  await expect(page.getByTestId('fatal-banner')).toBeVisible();

  // 重试有上限：每个清晰度对第 5 段最多 1 + 3 次尝试
  const s1 = await lab(page);
  const seg5 = s1.requests.filter((r) => r.rangeStart >= 19.5 && r.rangeStart < 20.5);
  expect(seg5.length).toBeGreaterThan(0);
  for (const r of seg5) expect(r.attempt).toBeLessThanOrEqual(4);

  // 关闭故障 → 恢复播放，必须真正越过故障分片
  await page.getByTestId('fault-clear').click();
  await page.getByRole('button', { name: '恢复播放' }).click();
  await page.waitForFunction(
    () => {
      const s = (window as any).__lab.getState();
      return s.currentTime > 25 && s.phase !== 'failed';
    },
    null,
    { timeout: 40_000 },
  );

  const s2 = await lab(page);
  expect(s2.currentTime).toBeGreaterThan(25);
  // 请求记录中能看到第 5 段最终成功（不是恢复成功的假象）
  expect(
    s2.requests.some((r) => r.rangeStart >= 19.5 && r.rangeStart < 20.5 && r.status === 'ok'),
  ).toBeTruthy();
  // 界面显示与实际位置一致
  const text = await page.getByTestId('time-display').innerText();
  const shown = parseFloat(text.split('/')[0]);
  expect(Math.abs(shown - s2.currentTime)).toBeLessThan(0.6);
});

test('无效清单给出可读说明，不会一直停在加载状态', async ({ page }) => {
  await page.getByTestId('manifest-input').fill('/media/sample/does-not-exist.m3u8');
  await page.getByRole('button', { name: '打开' }).click();
  await page.waitForFunction(() => (window as any).__lab.getState().phase === 'failed', null, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('fatal-banner')).toContainText('清单');
});
