import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      // 优先使用本机 Chrome + Metal；没有就退回 SwiftShader，保证 CI 也能跑。
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      args: ['--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
