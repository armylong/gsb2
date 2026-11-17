import { defineConfig } from 'vite';

// 纯本地开发服务器, 不连接任何外部服务
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
