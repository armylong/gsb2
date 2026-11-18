import { test, expect } from '@playwright/test';

// 渲染与交互层验证：三维场景、坐标显示、控件状态、重置同步、状态提示。
// 空间听感（左右/距离/朝向的真实音频输出）在 audio.test.js 中用离线渲染验证。

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  // 等首声源卡片渲染出来即说明模块初始化完成；canvas 与卡片都由同一入口创建
  await expect(page.locator('[data-testid="card-s1"]')).toBeVisible();
  await expect(page.locator('#scene canvas')).toBeVisible();
});

test('初始场景：1 个听者 + 3 个声源，显示坐标与朝向，音频未启用提示可见', async ({ page }) => {
  await expect(page.locator('#audio-status')).toHaveAttribute('data-kind', 'disabled');
  await expect(page.locator('#audio-status')).toContainText('启用声音');
  await expect(page.locator('#enable-audio')).toBeEnabled();

  await expect(page.locator('#listener-coord')).toContainText('x  0.00');
  await expect(page.locator('#listener-yaw')).toHaveText('0.0°');
  for (const id of ['s1', 's2', 's3']) {
    await expect(page.locator(`[data-testid="coord-${id}"]`)).toContainText('x');
    await expect(page.locator(`[data-testid="play-${id}"]`)).toHaveText(/播放/);
  }
});

test('数字输入修改听者位置与朝向，面板和场景标签同步更新', async ({ page }) => {
  await page.fill('[data-testid="listener-x"]', '3.5');
  await expect(page.locator('#listener-coord')).toContainText('x  3.50');

  await page.fill('[data-testid="listener-yaw-input"]', '90');
  await expect(page.locator('#listener-yaw')).toHaveText('90.0°');

  // 等待下一帧渲染，store 与画面同源：直接读内部状态确认 3D 对象也已移动
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const pos = await page.evaluate(() => {
    const { sceneView } = window.__app;
    return { x: sceneView.listenerGroup.position.x, yaw: sceneView.listenerGroup.rotation.y };
  });
  expect(pos.x).toBeCloseTo(3.5, 5);
  expect(pos.yaw).toBeCloseTo(Math.PI / 2, 5);
});

test('朝向按钮（或 Q/E 键）以 15° 步进旋转听者', async ({ page }) => {
  await page.click('#listener-turn-right');
  await page.click('#listener-turn-right');
  await expect(page.locator('#listener-yaw')).toHaveText('30.0°');
  await page.keyboard.press('q');
  await expect(page.locator('#listener-yaw')).toHaveText('15.0°');
});

test('声源方位标签随听者转向变化：右侧声源转到身后再转到左侧', async ({ page }) => {
  const tag = page.locator('[data-testid="tag-s1"]');
  await expect(tag).toContainText('右');
  await page.fill('[data-testid="listener-yaw-input"]', '90');
  await page.press('[data-testid="listener-yaw-input"]', 'Enter');
  await expect(tag).toContainText('后');
  await page.fill('[data-testid="listener-yaw-input"]', '180');
  await page.press('[data-testid="listener-yaw-input"]', 'Enter');
  await expect(tag).toContainText('左');
});

test('多声源同时播放时各自按钮与音量互不覆盖', async ({ page }) => {
  await page.click('#enable-audio');
  await expect(page.locator('#audio-status')).toHaveAttribute('data-kind', 'running');

  await page.click('[data-testid="play-s1"]');
  await page.click('[data-testid="play-s2"]');
  await page.click('[data-testid="play-s3"]');
  await expect(page.locator('[data-testid="play-s1"]')).toHaveText(/暂停/);
  await expect(page.locator('[data-testid="play-s2"]')).toHaveText(/暂停/);
  await expect(page.locator('[data-testid="play-s3"]')).toHaveText(/暂停/);

  // 只调 s2 音量、只暂停 s3，其余状态保持
  await page.locator('[data-testid="vol-s2"]').fill('0.25');
  await page.click('[data-testid="play-s3"]');
  await expect(page.locator('[data-testid="volval-s2"]')).toHaveText('25%');
  await expect(page.locator('[data-testid="play-s3"]')).toHaveText(/播放/);
  await expect(page.locator('[data-testid="play-s1"]')).toHaveText(/暂停/);
  await expect(page.locator('[data-testid="volval-s1"]')).toHaveText('80%');
});

test('独奏只静音其他声源，退出后恢复，且不改写播放状态', async ({ page }) => {
  await page.click('#enable-audio');
  await page.click('[data-testid="play-s1"]');
  await page.click('[data-testid="play-s2"]');
  await page.click('[data-testid="solo-s1"]');

  await expect(page.locator('#solo-hint')).toBeVisible();
  await expect(page.locator('[data-testid="solo-s1"]')).toHaveText('退出独奏');
  await expect(page.locator('[data-testid="card-s2"]')).toHaveClass(/is-muted-by-solo/);

  const gains = await page.evaluate(async () => {
    const { audioEngine, store } = window.__app;
    // 等待 setTargetAtTime 平滑增益收敛（时间常数 30ms，给 12 倍）
    await new Promise((r) => setTimeout(r, 380));
    return store.state.sources.map((s) => audioEngine.voices.get(s.id)?.userGain.gain.value ?? null);
  });
  // s1 保持自身音量 0.8，s2 被静音到接近 0
  expect(gains[0]).toBeCloseTo(0.8, 1);
  expect(gains[1]).toBeLessThan(0.02);

  await page.click('[data-testid="solo-s1"]');
  await expect(page.locator('#solo-hint')).toBeHidden();
  const after = await page.evaluate(() => window.__app.store.state.sources.map((s) => s.playing));
  expect(after).toEqual([true, true, false]);
});

test('重置场景：位置、朝向、播放、独奏全部回到初始，画面同步', async ({ page }) => {
  await page.click('#enable-audio');
  await page.click('[data-testid="play-s1"]');
  await page.click('[data-testid="solo-s1"]');
  await page.fill('[data-testid="listener-x"]', '5');
  await page.press('[data-testid="listener-x"]', 'Enter');
  await page.fill('[data-testid="listener-yaw-input"]', '120');
  await page.press('[data-testid="listener-yaw-input"]', 'Enter');

  await page.click('#reset-scene');

  await expect(page.locator('#listener-coord')).toContainText('x  0.00');
  await expect(page.locator('#listener-yaw')).toHaveText('0.0°');
  await expect(page.locator('[data-testid="play-s1"]')).toHaveText(/播放/);
  await expect(page.locator('#solo-hint')).toBeHidden();

  // 等下一帧让 3D mesh 应用重置后的位置
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

  const state = await page.evaluate(() => {
    const { store, sceneView, audioEngine } = window.__app;
    return {
      listener: store.state.listener,
      playing: store.state.sources.map((s) => s.playing),
      meshX: sceneView.listenerGroup.position.x,
      voiceCount: audioEngine.voices.size,
    };
  });
  expect(state.listener).toEqual({ x: 0, y: 0, z: 0, yaw: 0 });
  expect(state.playing).toEqual([false, false, false]);
  expect(state.meshX).toBeCloseTo(0, 6);
  expect(state.voiceCount).toBe(0); // 无残留播放
});

test('快速连续拖动/转向/播放切换后，音频声像位置始终等于最新状态', async ({ page }) => {
  await page.click('#enable-audio');
  await page.click('[data-testid="play-s1"]');

  const result = await page.evaluate(async () => {
    const { store, audioEngine } = window.__app;
    // 同步爆发式更新：位置、朝向、播放状态交替快速变化
    for (let i = 0; i < 50; i++) {
      store.setSourcePosition('s1', i - 25, (i % 5) - 2, -(i % 7));
      store.setListenerYaw(i * 7);
      if (i % 3 === 0) store.togglePlaying('s1');
    }
    store.setPlaying('s1', true);
    store.setSourcePosition('s1', 6, 3, -6);
    // 等待平滑参数收敛（SMOOTH_TAU=30ms，给 10 倍时间常数）
    await new Promise((r) => setTimeout(r, 350));
    const p = audioEngine.voices.get('s1').panner;
    return {
      x: p.positionX.value,
      y: p.positionY.value,
      z: p.positionZ.value,
    };
  });

  expect(result.x).toBeCloseTo(6, 1);
  expect(result.y).toBeCloseTo(3, 1);
  expect(result.z).toBeCloseTo(-6, 1);
});

test('音频不可用场景：模拟 AudioContext 缺失时给出可理解提示', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
  });
  await page.reload();
  await page.click('#enable-audio');
  await expect(page.locator('#audio-status')).toHaveAttribute('data-kind', 'unavailable');
  await expect(page.locator('#audio-status')).toContainText('不支持 Web Audio');
});
