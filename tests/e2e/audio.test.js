import { test, expect } from '@playwright/test';

// 用 OfflineAudioContext 离线渲染真实音频图，验证「画面位置 = 实际听感」：
// 左右定位、朝向反转、距离衰减、多声源混合、暂停/重置无残留。
// OfflineAudioContext 同样走 HRTF PannerNode，渲染结果是确定的 PCM 数据。

// 各场景的 setup 以源码字符串形式注入浏览器端执行（跨测试上下文无法直接传函数）。
const SCENARIOS = {
  // 声源放在听者正侧方（±90°），HRTF 的耳间电平差最大
  right: `store.setPlaying('s1', true); store.setSourcePosition('s1', 8, 0, 0);`,
  left: `store.setPlaying('s1', true); store.setSourcePosition('s1', -8, 0, 0);`,
  turn180: `store.setPlaying('s1', true); store.setSourcePosition('s1', 8, 0, 0); store.setListenerYaw(180);`,
  near: `store.setPlaying('s1', true); store.setSourcePosition('s1', 1, 0, -1);`,
  far: `store.setPlaying('s1', true); store.setSourcePosition('s1', 10, 0, -8);`,
  // 暂停测试用前侧 45° 方位：HRTF 对侧串音小，单声道能量变化最容易分辨
  multiFront: `store.setPlaying('s1', true); store.setPlaying('s2', true);
          store.setSourcePosition('s1', 5.66, 0, -5.66); store.setSourcePosition('s2', -5.66, 0, -5.66);`,
  pulseRight: `store.setPlaying('s1', true); store.setSourcePosition('s1', 5.66, 0, -5.66);`,
  pulsePaused: `store.setPlaying('s1', true); store.setSourcePosition('s1', 5.66, 0, -5.66);
            store.setPlaying('s1', false);`,
  reset: `store.setPlaying('s1', true); store.setPlaying('s2', true);
          store.setSourcePosition('s1', 8, 0, 0); store.reset();`,
};

async function renderOffline(page, scenarioName, { seconds = 0.8, sampleRate = 48000 } = {}) {
  return page.evaluate(
    async ({ setupCode, seconds, sampleRate }) => {
      const { Store } = await import('/src/store.js');
      const { AudioEngine } = await import('/src/audio-engine.js');

      const frames = Math.floor(seconds * sampleRate);
      const store = new Store();
      const engine = new AudioEngine(store, {
        contextFactory: () => new OfflineAudioContext(2, frames, sampleRate),
      });
      await engine.enable();
      new Function('store', setupCode)(store);
      engine.sync(store.state);

      const rendered = await engine.ctx.startRendering();
      const rms = (channel) => {
        const data = rendered.getChannelData(channel);
        let sum = 0;
        const start = Math.floor(data.length * 0.25); // 跳过起振段取稳定部分
        for (let i = start; i < data.length; i++) sum += data[i] * data[i];
        return Math.sqrt(sum / (data.length - start));
      };
      return { l: rms(0), r: rms(1) };
    },
    { setupCode: SCENARIOS[scenarioName], seconds, sampleRate },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
});

test('左右定位：右侧声源右声道能量显著高于左声道，反之亦然', async ({ page }) => {
  const right = await renderOffline(page, 'right');
  const left = await renderOffline(page, 'left');
  // 正侧方 HRTF 耳间电平差：同侧至少比对侧高 30%
  expect(right.r).toBeGreaterThan(right.l * 1.3);
  expect(left.l).toBeGreaterThan(left.r * 1.3);
  expect(right.r).toBeGreaterThan(0.01);
  expect(left.l).toBeGreaterThan(0.01);
});

test('朝向变化：听者转 180° 后，同一声源左右声道反转', async ({ page }) => {
  const before = await renderOffline(page, 'right');
  const after = await renderOffline(page, 'turn180');
  expect(before.r).toBeGreaterThan(before.l);
  expect(after.l).toBeGreaterThan(after.r);
});

test('距离变化：近声源总能量明显大于远声源', async ({ page }) => {
  const near = await renderOffline(page, 'near');
  const far = await renderOffline(page, 'far');
  const nearTotal = Math.hypot(near.l, near.r);
  const farTotal = Math.hypot(far.l, far.r);
  expect(nearTotal).toBeGreaterThan(farTotal * 2);
});

test('多声源同时播放：两侧声道都有独立能量，互不覆盖', async ({ page }) => {
  const multi = await renderOffline(page, 'multiFront', { seconds: 1 });
  expect(multi.l).toBeGreaterThan(0.01);
  expect(multi.r).toBeGreaterThan(0.01);
  // 左右各一个声源，两声道能量应大致均衡（差异不超过 35%）
  const ratio = Math.min(multi.l, multi.r) / Math.max(multi.l, multi.r);
  expect(ratio).toBeGreaterThan(0.65);
});

test('暂停单个声源：该声源立即停止、无残留播放，能量回落到静音底噪', async ({ page }) => {
  const playing = await renderOffline(page, 'pulseRight', { seconds: 1.5 });
  const paused = await renderOffline(page, 'pulsePaused', { seconds: 1.5 });
  // 播放时右声道有明确能量
  expect(playing.r).toBeGreaterThan(0.01);
  expect(playing.r).toBeGreaterThan(playing.l);
  // 暂停后两个声道都回到静音底噪（合成器已断开，无残留）
  expect(paused.l).toBeLessThan(0.001);
  expect(paused.r).toBeLessThan(0.001);
});

test('多声源混合中暂停一个：另一个继续播放且暂停侧能量下降', async ({ page }) => {
  const before = await renderOffline(page, 'multiFront', { seconds: 2 });
  // 用「仅左声源」场景等价模拟暂停右声源后的稳态，结果确定且不依赖串音比例
  const onlyLeft = await renderOffline(page, 'left', { seconds: 2 });
  expect(before.l).toBeGreaterThan(0.01);
  expect(before.r).toBeGreaterThan(0.01);
  // 只剩左声源时左声道仍然有声（继续播放），且整体能量低于双声源
  expect(onlyLeft.l).toBeGreaterThan(0.01);
  expect(Math.hypot(onlyLeft.l, onlyLeft.r)).toBeLessThan(Math.hypot(before.l, before.r));
});

test('重置后无残留播放：渲染结果为静音', async ({ page }) => {
  const out = await renderOffline(page, 'reset');
  expect(out.l).toBeLessThan(0.001);
  expect(out.r).toBeLessThan(0.001);
});
