// 将 npm 安装的 three 运行时文件拷贝到 vendor/，使应用完全脱离 node_modules 运行（可离线、可直接托管静态目录）。
// 用法：npm i 后执行 npm run vendor:three
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const copies = [
  ['node_modules/three/build/three.module.js', 'vendor/three/three.module.js'],
  ['node_modules/three/build/three.core.js', 'vendor/three/three.core.js'],
  ['node_modules/three/examples/jsm/controls/OrbitControls.js', 'vendor/three/OrbitControls.js'],
];

for (const [from, to] of copies) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    console.error(`缺少 ${from}，请先执行 npm install`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copied ${from} -> ${to}`);
}
