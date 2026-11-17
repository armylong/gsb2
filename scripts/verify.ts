/**
 * 自动验证:npm run verify
 *
 * 每个用例都有独立推导的已知期望值(硬编码常数,或在测试内按 IEC 61966-2-1
 * 公式独立计算),不是把同一处理函数的两次输出互相比对。
 *
 * 覆盖:解析器拒绝行为、通道顺序、网格点、网格中间值(三线性 vs 最近点)、
 * 两种色彩空间下的强度混合、非默认输入范围与超范围截断、alpha 保留与透明
 * 边沿无黑边、PNG 导出回读一致性、示例素材有效性。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCube, CubeParseError, type Lut3D } from '../src/lut/cubeParser';
import { applyLutToImage, applyLutToPixel, sampleLut, type ApplyOptions } from '../src/lut/applyLut';
import { decodeImage, encodePng } from '../server/imageIo';
import { generateSamples, SAMPLES_DIR } from './generate-samples';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function closeVec(name: string, actual: number[], expected: number[], tol: number) {
  const bad = actual.some((a, i) => Math.abs(a - expected[i]) > tol);
  ok(name, !bad, `实际 [${actual.map((v) => v.toFixed(5))}] 期望 [${expected.map((v) => v.toFixed(5))}] 容差 ${tol}`);
}

function expectReject(name: string, fn: () => unknown, msgPart: string) {
  try {
    fn();
    ok(name, false, '未抛出异常');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(name, e instanceof CubeParseError && msg.includes(msgPart), msg);
  }
}

/** 程序化构造色表(与解析器无关的独立数据) */
function makeLut(
  size: number,
  fn: (r: number, g: number, b: number) => [number, number, number],
  domain?: { min: [number, number, number]; max: [number, number, number] }
): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let p = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const v = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[p++] = v[0];
        data[p++] = v[1];
        data[p++] = v[2];
      }
    }
  }
  return {
    name: 'test',
    size,
    domainMin: domain?.min ?? [0, 0, 0],
    domainMax: domain?.max ?? [1, 1, 1],
    data,
  };
}

const OPTS = (over: Partial<ApplyOptions>): ApplyOptions => ({
  interpolation: 'trilinear',
  mode: 'srgb',
  strength: 1,
  ...over,
});

// IEC 61966-2-1 传递函数 —— 测试内独立实现,不引用被测代码
const sl = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const ls = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

async function main() {
  console.log('\n[1] 解析器:合法文件与严格拒绝');
  {
    const text = [
      'TITLE "Demo"',
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 1 1 1',
      '0 0 0', '1 0 0', '0 1 0', '1 1 0',
      '0 0 1', '1 0 1', '0 1 1', '1 1 1',
    ].join('\n');
    const lut = parseCube(text);
    ok('解析合法 size=2 色表', lut.size === 2 && lut.name === 'Demo' && lut.data.length === 24);

    const ranged = parseCube('LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0.2 0.8\n' + '0 0 0\n'.repeat(8));
    closeVec('LUT_3D_INPUT_RANGE 解析', [...ranged.domainMin, ...ranged.domainMax], [0.2, 0.2, 0.2, 0.8, 0.8, 0.8], 1e-9);

    expectReject('拒绝一维表', () => parseCube('LUT_1D_SIZE 16\n' + '0 0 0\n'.repeat(16)), '一维');
    expectReject('拒绝条目不足', () => parseCube('LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(7)), '条目不足');
    expectReject('拒绝条目过多', () => parseCube('LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(9)), '条目过多');
    expectReject(
      '拒绝不合法范围',
      () => parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 0.6 0 0\nDOMAIN_MAX 0.5 1 1\n' + '0 0 0\n'.repeat(8)),
      '范围'
    );
    expectReject('拒绝缺少 LUT_3D_SIZE', () => parseCube('TITLE "x"\n0 0 0\n'), 'LUT_3D_SIZE');
    expectReject('拒绝无法识别的行', () => parseCube('LUT_3D_SIZE 2\nFOO_BAR 1\n' + '0 0 0\n'.repeat(8)), '无法识别');
  }

  console.log('\n[2] 通道顺序与网格位置(红色最快)');
  {
    // 8 个网格点放入可区分的 R 值,验证 red-fastest 布局解释
    const text = [
      'LUT_3D_SIZE 2',
      '0.1 0 0', '0.2 0 0', '0.3 0 0', '0.4 0 0',
      '0.5 0 0', '0.6 0 0', '0.7 0 0', '0.8 0 0',
    ].join('\n');
    const lut = parseCube(text);
    closeVec('网格点 (1,0,0)', sampleLut(lut, 1, 0, 0, 'trilinear'), [0.2, 0, 0], 1e-6);
    closeVec('网格点 (0,1,0)', sampleLut(lut, 0, 1, 0, 'trilinear'), [0.3, 0, 0], 1e-6);
    closeVec('网格点 (0,0,1)', sampleLut(lut, 0, 0, 1, 'trilinear'), [0.5, 0, 0], 1e-6);
    closeVec('网格点 (1,1,1)', sampleLut(lut, 1, 1, 1, 'trilinear'), [0.8, 0, 0], 1e-6);
    closeVec('最近点模式命中同一网格点', sampleLut(lut, 1, 0, 0, 'nearest'), [0.2, 0, 0], 1e-6);
  }

  console.log('\n[3] 三线性插值 vs 最近点(网格中间值,手算期望)');
  {
    // 角点值:r 通道在 r==b 时为 0 否则为 1;g 通道等于 g;b 通道恒 0.5
    const lut = makeLut(2, (r, g, b) => [r === b ? 0 : 1, g, 0.5]);
    // 中心点 (0.5,0.5,0.5):8 角点等权 → r=0.5, g=0.5, b=0.5
    closeVec('三线性 中心点', sampleLut(lut, 0.5, 0.5, 0.5, 'trilinear'), [0.5, 0.5, 0.5], 1e-6);
    // (0.25,0.5,0.75):r 通道 = (1-0.25)*0.75*1 + 0.25*(1-0.75)*1 = 0.5625+0.0625 = 0.625
    closeVec('三线性 (0.25,0.5,0.75)', sampleLut(lut, 0.25, 0.5, 0.75, 'trilinear'), [0.625, 0.5, 0.5], 1e-6);
    // 最近点 (0.4,0.5,0.6) → 网格点 (0,1,1):r≠b → r=1, g=1, b=0.5
    closeVec('最近点 (0.4,0.5,0.6)', sampleLut(lut, 0.4, 0.5, 0.6, 'nearest'), [1, 1, 0.5], 1e-6);
    // 同一点两种模式结果必须不同(三线性不是最近点的伪装)
    const tri = sampleLut(lut, 0.4, 0.5, 0.6, 'trilinear');
    const near = sampleLut(lut, 0.4, 0.5, 0.6, 'nearest');
    ok('三线性与最近点结果不同', Math.abs(tri[0] - near[0]) > 0.1, `tri=${tri[0]} nearest=${near[0]}`);
  }

  console.log('\n[4] 恒等变换(两种空间、任意强度)');
  {
    const identity = makeLut(4, (r, g, b) => [r, g, b]);
    const px: [number, number, number][] = [
      [0.13, 0.57, 0.91],
      [0, 0, 0],
      [1, 1, 1],
      [0.5, 0.25, 0.75],
    ];
    for (const [r, g, b] of px) {
      closeVec(`sRGB 空间恒等 (${r},${g},${b})`, applyLutToPixel(r, g, b, identity, OPTS({ strength: 0.7 })), [r, g, b], 1e-5);
      closeVec(
        `线性光空间恒等 (${r},${g},${b})`,
        applyLutToPixel(r, g, b, identity, OPTS({ mode: 'linear', strength: 0.7 })),
        [r, g, b],
        1e-5
      );
    }
  }

  console.log('\n[5] 强度混合(两种空间,独立期望)');
  {
    const swap = makeLut(2, (r, g, b) => [b, g, r]);
    // sRGB 空间:c=(0.8,0.2,0.5),交换后 (0.5,0.2,0.8),强度 0.3
    // 期望 = 0.7*c + 0.3*swap = (0.71, 0.2, 0.59)
    closeVec(
      'sRGB 空间强度 0.3',
      applyLutToPixel(0.8, 0.2, 0.5, swap, OPTS({ strength: 0.3 })),
      [0.71, 0.2, 0.59],
      1e-6
    );
    // 强度 0 精确恢复原图,强度 1 完整应用
    closeVec('强度 0 = 原图', applyLutToPixel(0.8, 0.2, 0.5, swap, OPTS({ strength: 0 })), [0.8, 0.2, 0.5], 0);
    closeVec('强度 1 = 完整色表', applyLutToPixel(0.8, 0.2, 0.5, swap, OPTS({ strength: 1 })), [0.5, 0.2, 0.8], 1e-6);

    // 线性光空间锚点:srgbToLinear(0.5) 手算 ≈ 0.21404114
    ok('线性化锚点 sl(0.5)≈0.21404', Math.abs(sl(0.5) - 0.21404114) < 1e-5, String(sl(0.5)));
    // 线性光空间:c=(0.5,0.2,0.8),强度 0.5
    // 期望 = ls( (sl(c) + sl(swap(c))) / 2 ),由测试内独立公式计算
    const lc = [sl(0.5), sl(0.2), sl(0.8)];
    const lsw = [sl(0.8), sl(0.2), sl(0.5)];
    const expected = lc.map((v, i) => ls(Math.min(1, Math.max(0, (v + lsw[i]) / 2))));
    closeVec(
      '线性光空间强度 0.5',
      applyLutToPixel(0.5, 0.2, 0.8, swap, OPTS({ mode: 'linear', strength: 0.5 })),
      expected,
      1e-4
    );
    // 两种空间的中间强度结果必须不同(不能混用空间)
    const a = applyLutToPixel(0.5, 0.2, 0.8, swap, OPTS({ mode: 'srgb', strength: 0.5 }));
    const b = applyLutToPixel(0.5, 0.2, 0.8, swap, OPTS({ mode: 'linear', strength: 0.5 }));
    ok('两空间强度混合结果不同', Math.abs(a[0] - b[0]) > 0.01, `srgb=${a[0].toFixed(4)} linear=${b[0].toFixed(4)}`);
  }

  console.log('\n[6] 非默认输入范围与超范围截断');
  {
    // 输入范围 0.2..0.8 的恒等表:范围内恒等;范围外截断到边界网格值
    const lut = makeLut(2, (r, g, b) => [r, g, b], { min: [0.2, 0.2, 0.2], max: [0.8, 0.8, 0.8] });
    closeVec('范围内恒等 (0.5)', applyLutToPixel(0.5, 0.5, 0.5, lut, OPTS({})), [0.5, 0.5, 0.5], 1e-6);
    closeVec('超上界截断 (0.9→1.0)', applyLutToPixel(0.9, 0.9, 0.9, lut, OPTS({})), [1, 1, 1], 1e-6);
    closeVec('超下界截断 (0.1→0.0)', applyLutToPixel(0.1, 0.1, 0.1, lut, OPTS({})), [0, 0, 0], 1e-6);
  }

  console.log('\n[7] 透明通道与透明边沿');
  {
    const swap = makeLut(2, (r, g, b) => [b, g, r]);
    // 两个像素:同色不同 alpha(0 与 128)
    const img = new Uint8ClampedArray([200, 30, 60, 0, 200, 30, 60, 128]);
    const out = applyLutToImage(img, 2, 1, swap, OPTS({}));
    ok('alpha 原样保留', out[3] === 0 && out[7] === 128, `alpha=${out[3]},${out[7]}`);
    // (200,30,60) 交换 → (60,30,200);透明像素与半透明像素的 RGB 必须一致(无黑边)
    ok(
      '透明像素 RGB 正常处理(无黑边)',
      out[0] === 60 && out[1] === 30 && out[2] === 200 && out[4] === 60 && out[5] === 30 && out[6] === 200,
      `px0=[${out[0]},${out[1]},${out[2]}] px1=[${out[4]},${out[5]},${out[6]}]`
    );
  }

  console.log('\n[8] PNG 导出回读一致性(全分辨率,与缩放无关)');
  {
    // 32×32 测试图:已知渐变 + 变化的 alpha(含 0)
    const w = 32;
    const h = 32;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        src[o] = Math.round((x / (w - 1)) * 255);
        src[o + 1] = Math.round((y / (h - 1)) * 255);
        src[o + 2] = 128;
        src[o + 3] = (x * 16 + y * 7) % 256;
      }
    }
    const swap = makeLut(4, (r, g, b) => [b, g, r]);
    const opts = OPTS({ mode: 'linear', strength: 0.7 });
    const graded = applyLutToImage(src, w, h, swap, opts);
    ok('输出尺寸与输入一致', graded.length === src.length);

    const png = await encodePng(graded, w, h);
    const back = await decodeImage(png);
    ok('回读尺寸一致', back.width === w && back.height === h);
    let maxDiff = 0;
    for (let i = 0; i < graded.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(graded[i] - back.data[i]));
    }
    ok('回读像素与导出完全一致(PNG 无损)', maxDiff === 0, `最大差 ${maxDiff}`);

    // alpha 通道逐字节一致
    let alphaDiff = 0;
    for (let p = 0; p < w * h; p++) {
      alphaDiff = Math.max(alphaDiff, Math.abs(src[p * 4 + 3] - back.data[p * 4 + 3]));
    }
    ok('alpha 通道回读一致', alphaDiff === 0, `最大差 ${alphaDiff}`);

    // 无色表导出 = 原图回读
    const plain = await decodeImage(await encodePng(src, w, h));
    let plainDiff = 0;
    for (let i = 0; i < src.length; i++) {
      plainDiff = Math.max(plainDiff, Math.abs(src[i] - plain.data[i]));
    }
    ok('无色表导出回读 = 原图', plainDiff === 0, `最大差 ${plainDiff}`);
  }

  console.log('\n[9] 示例素材(一键恢复后全部有效)');
  {
    const files = await generateSamples();
    ok('素材生成', files.length === 7, files.join(','));

    const identity = parseCube(readFileSync(path.join(SAMPLES_DIR, 'identity.cube'), 'utf8'));
    ok('identity.cube 可解析', identity.size === 4);
    closeVec(
      'identity.cube 恒等',
      applyLutToPixel(0.37, 0.62, 0.11, identity, OPTS({})),
      [0.37, 0.62, 0.11],
      1e-5
    );

    const swapLut = parseCube(readFileSync(path.join(SAMPLES_DIR, 'swap-rb.cube'), 'utf8'));
    closeVec('swap-rb.cube 交换', applyLutToPixel(0.8, 0.2, 0.5, swapLut, OPTS({})), [0.5, 0.2, 0.8], 1e-5);

    const warm = parseCube(readFileSync(path.join(SAMPLES_DIR, 'warm-range.cube'), 'utf8'));
    ok('warm-range.cube 非默认范围', warm.domainMin[0] === 0.1 && warm.domainMax[0] === 0.9);

    expectReject(
      'invalid-1d.cube 被拒绝',
      () => parseCube(readFileSync(path.join(SAMPLES_DIR, 'invalid-1d.cube'), 'utf8')),
      '一维'
    );

    const grad = await decodeImage(readFileSync(path.join(SAMPLES_DIR, 'gradient.png')));
    ok('gradient.png 解码', grad.width === 512 && grad.height === 256);
    const edge = await decodeImage(readFileSync(path.join(SAMPLES_DIR, 'transparent-edge.png')));
    let hasTransparent = false;
    let hasOpaque = false;
    let hasMid = false;
    for (let p = 0; p < edge.width * edge.height; p++) {
      const a = edge.data[p * 4 + 3];
      if (a === 0) hasTransparent = true;
      else if (a === 255) hasOpaque = true;
      else hasMid = true;
    }
    ok('transparent-edge.png 含透明/半透明/不透明像素', hasTransparent && hasOpaque && hasMid);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('验证脚本执行出错:', e);
  process.exit(1);
});
