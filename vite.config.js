import { defineConfig } from 'vite';

// 纯前端静态项目：npm run dev 本地启动，npm run build 输出到 dist/
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
