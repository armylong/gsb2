import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level checks. The heavy lifting is done by the vitest suites against
 * the pure vision model; Playwright only verifies the parts that can only be
 * observed through the canvas: zoom-aware picking, the mode separation, and
 * that the UI never paints hidden enemies.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    deviceScaleFactor: 1,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
