import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5217,
    strictPort: true,
    open: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
