// 探针场数学的独立验证: 不依赖浏览器/three.js
// 运行: npm run verify
import {
  Color3,
  Probe,
  directionalColor,
  presetMissing,
  presetWarmCool,
  rawWeight,
  sampleField,
} from '../src/probes';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
  if (!ok) failures++;
}

const UP = { x: 0, y: 1, z: 0 };
const maxColorDelta = (a: Color3, b: Color3) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

// --- 1. 权重归一化: 影响区内 Σŵ = 1 ----------------------------------------
{
  const { probes, fallback } = presetWarmCool();
  let ok = true;
  for (let x = -5; x <= 5; x += 0.1) {
    const s = sampleField(probes, { x, y: 1, z: 0 }, UP, 'blend', fallback);
    if (s.source === 'fallback') continue;
    const sum = s.weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) ok = false;
  }
  check('影响区内权重归一化 (Σŵ = 1)', ok);
}

// --- 2. 边界连续性: blend 模式逐帧颜色变化有界 ------------------------------
{
  const { probes, fallback } = presetWarmCool();
  let prev: Color3 | null = null;
  let maxStep = 0;
  for (let x = -5.5; x <= 5.5; x += 0.005) {
    const s = sampleField(probes, { x, y: 1, z: 0 }, UP, 'blend', fallback);
    if (prev) maxStep = Math.max(maxStep, maxColorDelta(s.color, prev));
    prev = s.color;
  }
  check('blend 模式全路径颜色连续 (最大单步变化 < 0.02)', maxStep < 0.02, `maxStep=${maxStep.toFixed(4)}`);
}

// --- 3. 对照: nearest 模式在分界处存在跳变 ----------------------------------
{
  const { probes, fallback } = presetWarmCool();
  let prev: Color3 | null = null;
  let maxStep = 0;
  for (let x = -5.5; x <= 5.5; x += 0.005) {
    const s = sampleField(probes, { x, y: 1, z: 0 }, UP, 'nearest', fallback);
    if (prev) maxStep = Math.max(maxStep, maxColorDelta(s.color, prev));
    prev = s.color;
  }
  check('nearest 模式存在可观测跳变 (最大单步变化 > 0.1)', maxStep > 0.1, `maxStep=${maxStep.toFixed(4)}`);
}

// --- 4. 场外明确规则: 精确取回退色 ------------------------------------------
{
  const { probes, fallback } = presetWarmCool();
  const s = sampleField(probes, { x: 100, y: 1, z: 0 }, UP, 'blend', fallback);
  check(
    '场外取回退色且权重全 0',
    s.source === 'fallback' &&
      maxColorDelta(s.color, fallback) === 0 &&
      s.weights.every((w) => w === 0),
  );
}

// --- 5. 影响区外缘向回退色软过渡 (无硬边) ------------------------------------
{
  const probe: Probe = {
    id: 'p', name: 'p', position: { x: 0, y: 0, z: 0 }, radius: 2, enabled: true,
    dirColors: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]],
  };
  const fallback: Color3 = [0, 0, 0];
  let prev: Color3 | null = null;
  let maxStep = 0;
  for (let x = 1.8; x <= 2.2; x += 0.002) {
    const s = sampleField([probe], { x, y: 0, z: 0 }, UP, 'blend', fallback);
    if (prev) maxStep = Math.max(maxStep, maxColorDelta(s.color, prev));
    prev = s.color;
  }
  const outside = sampleField([probe], { x: 2.01, y: 0, z: 0 }, UP, 'blend', fallback);
  check('跨越影响半径边缘颜色连续', maxStep < 0.02, `maxStep=${maxStep.toFixed(4)}`);
  check('边缘外侧精确等于回退色', maxColorDelta(outside.color, fallback) === 0);
}

// --- 6. 禁用探针: 剩余权重即时重新归一 ---------------------------------------
{
  const { probes, fallback } = presetWarmCool();
  probes[1].enabled = false; // 禁用冷色探针
  const s = sampleField(probes, { x: 2.2, y: 1, z: 0 }, UP, 'blend', fallback);
  const sum = s.weights.reduce((a, b) => a + b, 0);
  check(
    '禁用探针后权重重新归一 (禁用者 w=0, 其余 Σŵ = 1)',
    s.weights[1] === 0 && (sum === 0 || Math.abs(sum - 1) < 1e-6),
    `weights=[${s.weights.map((w) => w.toFixed(3))}]`,
  );
  // 在暖色探针中心附近, 颜色应退化到暖色探针与回退色的混合
  const near = sampleField(probes, { x: -2.2, y: 1, z: 0 }, UP, 'blend', fallback);
  check('禁用后存活探针仍主导其附近采样', near.weights[0] > 0.99, `w0=${near.weights[0].toFixed(3)}`);
}

// --- 7. 方向颜色独立: 法线正对某轴时精确取该方向颜色 --------------------------
{
  const { probes } = presetWarmCool();
  const p = probes[0];
  const cX = directionalColor(p, { x: 1, y: 0, z: 0 });
  const cNX = directionalColor(p, { x: -1, y: 0, z: 0 });
  check(
    '方向颜色独立 (+X/-X 各取各色)',
    maxColorDelta(cX, p.dirColors[0]) < 1e-9 && maxColorDelta(cNX, p.dirColors[1]) < 1e-9,
  );
  // 修改 +X 方向颜色不影响 -X 采样
  const before = directionalColor(p, { x: -1, y: 0, z: 0 });
  p.dirColors[0] = [0, 1, 0];
  const after = directionalColor(p, { x: -1, y: 0, z: 0 });
  check('修改 +X 方向不影响 -X 方向采样', maxColorDelta(before, after) === 0);
}

// --- 8. 常色探针任意法线返回该色 ---------------------------------------------
{
  const { probes } = presetMissing();
  const mid = probes[1];
  mid.enabled = true;
  const uniform: Color3 = [0.4, 1.0, 0.45];
  mid.dirColors = mid.dirColors.map(() => [...uniform] as Color3);
  const a = directionalColor(mid, { x: 0.3, y: 0.8, z: 0.5 });
  check('常色探针任意法线返回该色', maxColorDelta(a, uniform) < 1e-9);
}

// --- 9. 原始权重在边界处 C1 连续 ---------------------------------------------
{
  const { probes } = presetWarmCool();
  const p = probes[0];
  const eps = 1e-4;
  const inside = rawWeight(p, { x: p.position.x + p.radius - eps, y: 1, z: 0 });
  const outside = rawWeight(p, { x: p.position.x + p.radius + eps, y: 1, z: 0 });
  check('原始权重在边界处趋于 0 (C1 连续)', inside < 1e-6 && outside === 0, `inside=${inside.toExponential(2)}`);
}

// --- 10. 探针缺失预设: 路径中央落入回退区 -------------------------------------
{
  const { probes, fallback } = presetMissing();
  const s = sampleField(probes, { x: 0, y: 1, z: 0 }, UP, 'blend', fallback);
  check(
    '探针缺失现场: 中央覆盖空洞取回退色',
    s.source === 'fallback' && maxColorDelta(s.color, fallback) === 0,
  );
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
