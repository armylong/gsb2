import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // worklet 必须是独立同源脚本（addModule 对 data URL 支持不可靠），
    // 关闭资源内联，?url 引入的 worklet 会输出为单独的 .js 文件
    assetsInlineLimit: 0,
  },
});
