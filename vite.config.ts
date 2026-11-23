import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // three.js 单包约 600 KB, 这个页面本身就是三维检查工具, 不必拆包
    chunkSizeWarningLimit: 900,
  },
});
