import { defineConfig } from 'vite';

// 纯本地演示:无外部资源、无后端。npm run dev 后访问终端打印的 localhost 地址。
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
