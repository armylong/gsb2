import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2022', outDir: 'dist' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.node.test.ts', 'node_modules/**'],
  },
});
