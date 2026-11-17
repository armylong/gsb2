/**
 * 一键生成/恢复示例素材(public/samples/):
 * - gradient.png         平滑三通道渐变(便于观察三线性 vs 最近点差异)
 * - color-blocks.png     已知颜色的色块
 * - transparent-edge.png 透明边沿图(验证 alpha 保留、无黑边)
 * - identity.cube        恒等表
 * - swap-rb.cube         红蓝通道交换表
 * - warm-range.cube      暖调表(非默认输入范围 LUT_3D_INPUT_RANGE 0.1 0.9)
 * - invalid-1d.cube      一维表(用于演示解析器明确拒绝)
 */

import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/samples');

interface CubeSpec {
  title: string;
  size: number;
  inputRange?: [number, number];
  fn: (r: number, g: number, b: number) => [number, number, number];
}

const fmt = (n: number): string => String(Number(n.toFixed(6)));

/** 生成标准 .cube 文本:红色变化最快,其次绿色,最慢蓝色 */
export function cubeText(spec: CubeSpec): string {
  const lines = [`TITLE "${spec.title}"`, `LUT_3D_SIZE ${spec.size}`];
  if (spec.inputRange) {
    lines.push(`LUT_3D_INPUT_RANGE ${fmt(spec.inputRange[0])} ${fmt(spec.inputRange[1])}`);
  }
  for (let b = 0; b < spec.size; b++) {
    for (let g = 0; g < spec.size; g++) {
      for (let r = 0; r < spec.size; r++) {
        const v = spec.fn(r / (spec.size - 1), g / (spec.size - 1), b / (spec.size - 1));
        lines.push(`${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

async function writePng(file: string, width: number, height: number, fill: (x: number, y: number) => number[]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * width + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = a;
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path.join(SAMPLES_DIR, file));
}

export async function generateSamples(): Promise<string[]> {
  mkdirSync(SAMPLES_DIR, { recursive: true });
  const written: string[] = [];

  // 渐变图:三个通道分别沿不同方向平滑变化
  const gw = 512;
  const gh = 256;
  await writePng('gradient.png', gw, gh, (x, y) => [
    Math.round((x / (gw - 1)) * 255),
    Math.round((y / (gh - 1)) * 255),
    Math.round((x / (gw - 1)) * (1 - y / (gh - 1)) * 255),
    255,
  ]);
  written.push('gradient.png');

  // 色块图:6×4 已知颜色
  const colors: [number, number, number][] = [
    [204, 26, 26], [26, 178, 51], [38, 76, 230], [230, 204, 26], [204, 51, 204], [26, 204, 204],
    [242, 242, 242], [128, 128, 128], [26, 26, 26], [230, 128, 51], [76, 51, 38], [51, 128, 76],
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255],
    [64, 64, 64], [192, 192, 192], [153, 76, 0], [0, 76, 153], [76, 0, 153], [0, 153, 76],
  ];
  const bw = 80;
  await writePng('color-blocks.png', bw * 6, bw * 4, (x, y) => {
    const idx = Math.floor(y / bw) * 6 + Math.floor(x / bw);
    const [r, g, b] = colors[idx];
    return [r, g, b, 255];
  });
  written.push('color-blocks.png');

  // 透明边沿图:红色圆形,alpha 在边缘 10px 内平滑过渡;
  // 过渡区(含完全透明的外圈)RGB 保持纯红,用于验证处理不会把透明区拉黑
  const ts = 256;
  const cx = (ts - 1) / 2;
  await writePng('transparent-edge.png', ts, ts, (x, y) => {
    const dist = Math.hypot(x - cx, y - cx);
    const alpha = Math.min(1, Math.max(0, (90 - dist) / 10));
    const inside = dist <= 100;
    return [inside ? 230 : 0, inside ? 40 : 0, inside ? 40 : 0, Math.round(alpha * 255)];
  });
  written.push('transparent-edge.png');

  // 恒等表
  writeFileSync(
    path.join(SAMPLES_DIR, 'identity.cube'),
    cubeText({ title: '恒等 Identity', size: 4, fn: (r, g, b) => [r, g, b] })
  );
  written.push('identity.cube');

  // 红蓝通道交换表
  writeFileSync(
    path.join(SAMPLES_DIR, 'swap-rb.cube'),
    cubeText({ title: '红蓝交换 Swap R-B', size: 4, fn: (r, g, b) => [b, g, r] })
  );
  written.push('swap-rb.cube');

  // 暖调表:非默认输入范围 0.1..0.9
  writeFileSync(
    path.join(SAMPLES_DIR, 'warm-range.cube'),
    cubeText({
      title: '暖调 Warm(范围 0.1-0.9)',
      size: 4,
      inputRange: [0.1, 0.9],
      fn: (r, g, b) => [Math.min(1, r * 1.08 + 0.03), g * 0.98, Math.max(0, b * 0.9 - 0.02)],
    })
  );
  written.push('warm-range.cube');

  // 一维表:应被解析器明确拒绝
  const lines1d = ['TITLE "一维表(非法)"', 'LUT_1D_SIZE 16'];
  for (let i = 0; i < 16; i++) {
    const v = fmt(i / 15);
    lines1d.push(`${v} ${v} ${v}`);
  }
  writeFileSync(path.join(SAMPLES_DIR, 'invalid-1d.cube'), lines1d.join('\n') + '\n');
  written.push('invalid-1d.cube');

  return written;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  generateSamples().then((files) => {
    console.log(`已生成 ${files.length} 个示例素材到 ${SAMPLES_DIR}:`);
    for (const f of files) console.log(`  - ${f}`);
  });
}
