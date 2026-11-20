import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e 由 Playwright 负责，不要在 vitest 里重复执行。
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
