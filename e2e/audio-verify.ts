import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const results: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  results.push(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

/** 解析 16-bit PCM 单声道 WAV, 返回 Float32 采样 */
function parseWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  const sampleRate = buf.readUInt32LE(24);
  const dataSize = buf.readUInt32LE(40);
  const samples = new Float32Array(dataSize / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buf.readInt16LE(44 + i * 2) / 0x8000;
  }
  return { samples, sampleRate };
}

/** Goertzel 单频幅度 */
function goertzel(samples: Float32Array, freq: number, sr: number): number {
  const k = (2 * Math.PI * freq) / sr;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + 2 * Math.cos(k) * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 / samples.length) * Math.hypot(s1 - Math.cos(k) * s2, Math.sin(k) * s2);
}

async function exportWav(page: import('playwright').Page): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#export-btn'),
  ]);
  const stream = await download.createReadStream();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });

// ---- A. 按住同一音符重复按下不重触发: 计数底层振荡器创建次数 ----
// 用电脑键盘 'a' = C4(60) 的真实 keydown/keyup, 走与鼠标相同的 noteOn/noteOff 路径
await page.evaluate(() => {
  const w = window as unknown as Record<string, unknown>;
  w.__oscCount = 0;
  const proto = AudioContext.prototype;
  const orig = proto.createOscillator;
  proto.createOscillator = function (this: AudioContext) {
    (window as unknown as { __oscCount: number }).__oscCount++;
    return orig.call(this);
  };
});

await page.keyboard.down('a');
await page.waitForTimeout(150);
const afterFirst = await page.evaluate(() => (window as unknown as { __oscCount: number }).__oscCount);
check('first strike creates 2 oscillators (carrier+modulator)', afterFirst === 2, `count=${afterFirst}`);

// 仍按住时重复 keydown(浏览器对长按会发 repeat, 应用层也应吞掉)
await page.keyboard.down('a');
await page.waitForTimeout(100);
const afterRepeat = await page.evaluate(() => (window as unknown as { __oscCount: number }).__oscCount);
check('repeat press while held creates NO new oscillator', afterRepeat === afterFirst, `count=${afterRepeat}`);

await page.keyboard.up('a');
await page.waitForTimeout(150);
await page.keyboard.down('a'); // 松手后重新按
await page.waitForTimeout(150);
const afterReStrike = await page.evaluate(() => (window as unknown as { __oscCount: number }).__oscCount);
check('re-strike after release creates 2 new oscillators', afterReStrike === afterFirst + 2, `count=${afterReStrike}`);
await page.keyboard.up('a');

// ---- B. 导出 WAV 的真实频谱核对 ----
const fc = 440;
const ratio = 2.76;
const fm = fc * ratio;

// 通过测试钩子把深度曲线拉平为恒值 1, 使整段处于峰值指数 I, 便于稳态侧带核对
async function flattenDepthCurve(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() => {
    const lab = (window as unknown as { __fmLab: { setCurve: (p: { t: number; v: number }[]) => void } }).__fmLab;
    lab.setCurve([
      { t: 0, v: 1 },
      { t: 1, v: 1 },
    ]);
  });
}

// B1. 强侧带电铃 + 恒定峰值深度
await page.click('#preset-bell');
await page.waitForTimeout(100);
await flattenDepthCurve(page);
const bellBuf = await exportWav(page);
const bell = parseWav(bellBuf);
// 取起音后 0.05s 起、0.5s 的稳态段
const bStart = Math.floor(0.05 * bell.sampleRate);
const bSeg = bell.samples.slice(bStart, bStart + Math.floor(0.5 * bell.sampleRate));
const bCarrier = goertzel(bSeg, fc, bell.sampleRate);
const bSide1 = goertzel(bSeg, fc + fm, bell.sampleRate);
const bSide2 = goertzel(bSeg, fc + 2 * fm, bell.sampleRate);
check(
  'bell WAV has strong real sidebands at fc+n*fm',
  bSide1 / bCarrier > 0.1 && bSide2 / bCarrier > 0.1,
  `n1=${(20 * Math.log10(bSide1 / bCarrier)).toFixed(1)}dB n2=${(20 * Math.log10(bSide2 / bCarrier)).toFixed(1)}dB`,
);

// B2. 调制归零: 先恢复 A4 导出音符与默认曲线, 再独立对照, 排除上一步状态污染
await page.selectOption('#export-note', '69');
await page.evaluate(() => {
  const lab = (window as unknown as { __fmLab: { setCurve: (p: { t: number; v: number }[]) => void } }).__fmLab;
  lab.setCurve([
    { t: 0, v: 1 },
    { t: 0.25, v: 0.55 },
    { t: 0.6, v: 0.18 },
    { t: 1, v: 0 },
  ]);
});
await page.click('#mod-zero');
await page.waitForTimeout(100);
const zeroBuf = await exportWav(page);
const zero = parseWav(zeroBuf);
const zStart = Math.floor(0.1 * zero.sampleRate);
const zSeg = zero.samples.slice(zStart, zStart + Math.floor(0.5 * zero.sampleRate));
const zCarrier = goertzel(zSeg, fc, zero.sampleRate);
const zSide1 = goertzel(zSeg, fc + fm, zero.sampleRate);
check(
  'I=0 WAV is spectrally a pure tone (sidebands < -45dB)',
  20 * Math.log10(zSide1 / Math.max(zCarrier, 1e-9)) < -45,
  `n1=${(20 * Math.log10(zSide1 / Math.max(zCarrier, 1e-9))).toFixed(1)}dB`,
);
check(
  'I=0 WAV still contains a loud carrier (real sound, not silence)',
  zCarrier > 0.05,
  `carrier amp=${zCarrier.toFixed(3)}`,
);

// B3. 两份导出的采样率一致, 且时长覆盖自然衰减尾巴
const tail = zero.samples.slice(-4096);
const tailPeak = Math.max(...tail.map((v) => Math.abs(v)));
check('export tail decays to near silence (natural release kept)', tailPeak < 0.01, `tail peak=${tailPeak.toFixed(4)}`);
check('both WAVs use same sample rate', bell.sampleRate === zero.sampleRate, `${bell.sampleRate}`);

await browser.close();

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
