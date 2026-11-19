import { defineConfig } from 'vite';

// 纯前端静态页，无需外部服务；构建产物在 dist/
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
