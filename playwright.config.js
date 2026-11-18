import { defineConfig } from '@playwright/test';

// 测试前请先启动本地静态服务：npm run serve（默认端口 8137）
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8137',
    // 自动播放策略：click 本身是用户手势，这里再放开自动播放以便程序触发 resume
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    },
  },
});
