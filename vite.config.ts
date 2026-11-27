import { defineConfig } from 'vite';
import { workletPlugin } from './vite-plugin-worklet';

export default defineConfig({
  base: './',
  plugins: [workletPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
