import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    // three.js 本身约 600 kB，单页演示不需要再拆包。
    chunkSizeWarningLimit: 800,
  },
});
