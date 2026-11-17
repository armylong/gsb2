import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api 与 /media 都代理到本地故障模拟服务（server/index.js, 端口 8791）
// 端口选用不常见的 5317，避免与本机其他项目的 dev server 冲突。
const proxy = {
  '/api': 'http://127.0.0.1:8791',
  '/media': 'http://127.0.0.1:8791',
};

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5317, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 5317, strictPort: true, proxy },
});
