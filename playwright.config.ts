import { defineConfig } from '@playwright/test';

// 验证前请先执行 npm run build（verify 脚本已包含）。
// webServer 会自动拉起故障模拟服务（8791）与前端预览（5317）。
// reuseExistingServer: false —— 若端口被占用直接报错，绝不误用别的项目的服务。
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  retries: 0,
  workers: 1, // 故障规则是服务端全局状态，串行执行避免互相干扰
  use: {
    baseURL: 'http://127.0.0.1:5317',
  },
  webServer: [
    {
      command: 'node server/index.js',
      url: 'http://127.0.0.1:8791/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm --prefix web run preview -- --port 5317 --strictPort',
      url: 'http://127.0.0.1:5317',
      reuseExistingServer: false,
    },
  ],
});
