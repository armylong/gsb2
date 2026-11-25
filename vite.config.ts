import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// base './' + singlefile => dist/index.html 可直接双击(file://)离线运行
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
