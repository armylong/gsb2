/**
 * 生成 SVG/CSV 导出样例到 out/ 目录, 便于人工核对图纸质量。
 * 用法: node scripts/gen-export-samples.mjs
 */
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = process.cwd();
const outDir = join(root, 'out');
mkdirSync(outDir, { recursive: true });

await build({
  logLevel: 'silent',
  configFile: false,
  build: {
    ssr: true,
    write: true,
    outDir: join(outDir, 'ssr'),
    lib: {
      entry: join(root, 'scripts', '_export-entry.ts'),
      formats: ['es'],
    },
  },
});

const mod = await import(pathToFileURL(join(outDir, 'ssr', '_export-entry.js')).href);
mod.writeSamples(outDir);
console.log('导出生成完毕 →', outDir);
