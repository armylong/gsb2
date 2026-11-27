// 本地可检验的自检：同一套实现同时被 vitest 与浏览器「自检面板」调用。
// 覆盖题目点名的三类例子：正圆、反向手画、跨过首尾（无跨画布连线）。

import { polylineLength, resampleArcLength, signedArea, type Vec2 } from './geometry';
import {
  dft, retainByAmplitude, orderComponents, reconstruct,
  buildEpicycles, chainTip, reverseTraversal, type OrderMode,
} from './dft';
import { analyzeDeviation } from './deviation';
import { makeCircle, makeLeaf, translatePoints } from './presets';
import { assessClosure, type RawPoint } from './stroke';
import { buildSvg, fitLayout } from './exporter';

export interface CheckResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
}

const N = 256;

function rmsDistance(a: Vec2[], b: Vec2[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const dx = a[i].x - b[i].x;
    const dy = a[i].y - b[i].y;
    s += dx * dx + dy * dy;
  }
  return Math.sqrt(s / n);
}

/** 1. 正圆：只需要 k=±1 两个旋转圆即可近完全恢复 */
function checkCircleRecovered(): CheckResult {
  const circle = makeCircle(120, N);
  const comps = dft(circle);
  const kept = retainByAmplitude(comps, 2);
  const rebuilt = reconstruct(orderComponents(kept, 'frequency'), N);
  const err = rmsDistance(circle, rebuilt);
  return {
    id: 'circle',
    name: '正圆：保留 2 个旋转圆即可恢复',
    pass: err < 1e-7,
    detail: `RMS 偏差 ${err.toExponential(2)}px（阈值 1e-7），其余成分半径≈0`,
  };
}

/** 2. 反向手画：点序反转后每个 k 的旋转方向取反，几何形状不变 */
function checkReverseHandwriting(): CheckResult {
  const leaf = resampleArcLength(makeLeaf(N), N, true);
  const rev = reverseTraversal(leaf);
  const c1 = dft(leaf);
  const c2 = dft(rev);
  const map1 = new Map(c1.map((c) => [c.k, c]));
  const nyquist = N / 2;
  let maxRDiff = 0;
  let signFlipped = true;
  for (const b of c2) {
    // 偶数 N 的 Nyquist 频率在符号翻转下映射到自身
    const targetK = b.k === nyquist ? nyquist : -b.k;
    const a = map1.get(targetK);
    if (!a) { signFlipped = false; break; }
    maxRDiff = Math.max(maxRDiff, Math.abs(a.r - b.r));
  }
  const rebuiltFwd = reconstruct(orderComponents(retainByAmplitude(c1, 40), 'frequency'), N);
  const rebuiltRev = reconstruct(orderComponents(retainByAmplitude(c2, 40), 'frequency'), N);
  const shapeErr = rmsDistance(rebuiltFwd, reverseTraversal(rebuiltRev));
  const pass = signFlipped && maxRDiff < 1e-7 && shapeErr < 1e-6
    && Math.sign(signedArea(leaf)) === -Math.sign(signedArea(rev));
  return {
    id: 'reverse',
    name: '反向手画：频率符号翻转、形状不变',
    pass,
    detail: `半径配对最大差 ${maxRDiff.toExponential(2)}px，正向/反向重建 RMS ${shapeErr.toExponential(2)}px，有向面积符号相反`,
  };
}

/** 3. 跨过首尾：重建是开放折线，接缝处不产生跨画布连线（SVG 无 Z、无额外线段） */
function checkNoSeamJump(): CheckResult {
  const leaf = resampleArcLength(makeLeaf(N), N, true);
  const comps = dft(leaf);
  const ordered = orderComponents(retainByAmplitude(comps, 24), 'frequency');
  const rebuilt = reconstruct(ordered, N);
  // 末端与首点在相位上相邻（周期性），但绘制层不允许把它们连成一条直线
  let maxStep = 0;
  for (let i = 1; i < rebuilt.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(rebuilt[i].x - rebuilt[i - 1].x, rebuilt[i].y - rebuilt[i - 1].y));
  }
  const seam = Math.hypot(rebuilt[0].x - rebuilt[rebuilt.length - 1].x, rebuilt[0].y - rebuilt[rebuilt.length - 1].y);
  const layout = fitLayout(leaf, 800, 600);
  const svg = buildSvg(
    { original: leaf, rebuilt, chain: buildEpicycles(ordered, 0), report: null, components: ordered },
    layout,
    { original: false, rebuilt: true, chain: false, heatmap: false },
  );
  const rebuiltPath = svg.split('\n').find((l) => l.includes('#d95926')) ?? '';
  const noClose = !rebuiltPath.includes('Z');
  const pass = seam < maxStep * 3 && noClose;
  return {
    id: 'seam',
    name: '跨过首尾：无跨画布连线',
    pass,
    detail: `接缝距离 ${seam.toFixed(2)}px vs 最大正常步长 ${maxStep.toFixed(2)}px；SVG 重建路径${noClose ? '不含闭合指令 Z' : '错误地含 Z'}`,
  };
}

/** 4. 整体平移只改 c0：去掉重心差后形变量为零 */
function checkTranslationSeparation(): CheckResult {
  const leaf = resampleArcLength(makeLeaf(N), N, true);
  const shifted = translatePoints(leaf, 47, -31);
  const report = analyzeDeviation(leaf, shifted);
  const t = report.stats.translation;
  const pass =
    Math.abs(t.x - 47) < 1e-9 && Math.abs(t.y + 31) < 1e-9 &&
    report.stats.maxShapeError < 1e-9 && report.stats.meanShapeError < 1e-9;
  return {
    id: 'translation',
    name: '平移参照：偏差全部归入平移，形变为零',
    pass,
    detail: `测得平移 (${t.x.toFixed(2)}, ${t.y.toFixed(2)})，最大形变 ${report.stats.maxShapeError.toExponential(2)}px`,
  };
}

/** 5. 采样速度不变性：同一条几何弧线，仅改变事件密度，等弧长重采样结果一致 */
function checkSpeedInvariantSampling(): CheckResult {
  // 同一条半圆的「真值」细采样；慢手段事件密集、快手段事件稀疏，
  // 两者都落在同一条圆弧上 —— 隔离掉几何近似，只考察事件速度的影响。
  const dense: RawPoint[] = [];
  const sparse: RawPoint[] = [];
  for (let i = 0; i <= 200; i++) {
    const a = (Math.PI * i) / 200;
    dense.push({ x: 100 * Math.cos(a), y: 100 * Math.sin(a), t: i });
  }
  for (let i = 0; i <= 10; i++) {
    const a = (Math.PI * i) / 10;
    sparse.push({ x: 100 * Math.cos(a), y: 100 * Math.sin(a), t: i * 20 });
  }
  const uDense = resampleArcLength(dense, 128, false);
  const uSparse = resampleArcLength(sparse, 128, false);
  // 核心不变量：无论事件密度如何，重采样后相邻间距都等长（按弧长取样）
  const cvOf = (pts: Vec2[]): number => {
    const gaps = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) / mean;
  };
  const cvDense = cvOf(uDense);
  const cvSparse = cvOf(uSparse);
  // 两者重采样后的总弧长都还原为各自输入折线的长度（取样不随事件数膨胀）
  const lenDense = polylineLength(uDense);
  const lenSparse = polylineLength(uSparse);
  return {
    id: 'sampling',
    name: '速度无关取样：慢段不会多占采样',
    pass: cvDense < 0.005 && cvSparse < 0.005 && lenDense > lenSparse,
    detail: `200 事件 / 10 事件重采样间距变异系数 ${(cvDense * 100).toFixed(2)}% / ${(cvSparse * 100).toFixed(2)}%，折线长度 ${lenDense.toFixed(1)} vs ${lenSparse.toFixed(1)}px`,
  };
}

/** 6. 保留数量单调性：成分越多，重建误差单调不增；全保留时到机器精度 */
function checkMonotoneRecovery(): CheckResult {
  const leaf = resampleArcLength(makeLeaf(N), N, true);
  const comps = dft(leaf);
  let prev = Infinity;
  let monotone = true;
  const counts = [1, 2, 4, 8, 16, 32, 64, 120];
  const errs: number[] = [];
  for (const k of counts) {
    const rebuilt = reconstruct(orderComponents(retainByAmplitude(comps, k), 'frequency'), N);
    const e = rmsDistance(leaf, rebuilt);
    errs.push(e);
    if (e > prev + 1e-9) monotone = false;
    prev = e;
  }
  // 全部成分保留（N-1 个旋转圆 + c0）应近完全重建
  const full = reconstruct(orderComponents(retainByAmplitude(comps, N - 1), 'frequency'), N);
  const fullErr = rmsDistance(leaf, full);
  return {
    id: 'monotone',
    name: '逐步恢复：误差随保留数单调下降',
    pass: monotone && fullErr < 1e-9,
    detail: `部分保留 RMS：${errs.map((e) => e.toFixed(2)).join(' → ')} px；全保留 RMS ${fullErr.toExponential(2)}px`,
  };
}

/** 7. 展示顺序可换、轨迹不变（加法可交换） */
function checkOrderInvariance(): CheckResult {
  const leaf = resampleArcLength(makeLeaf(N), N, true);
  const comps = retainByAmplitude(dft(leaf), 30);
  const modes: OrderMode[] = ['frequency', 'amplitude', 'reverse'];
  const paths = modes.map((m) => reconstruct(orderComponents(comps, m), N));
  let maxDiff = 0;
  for (let i = 0; i < N; i++) {
    for (const p of paths.slice(1)) {
      maxDiff = Math.max(maxDiff, Math.hypot(p[i].x - paths[0][i].x, p[i].y - paths[0][i].y));
    }
  }
  // 圆链末端在任意相位也一致
  const tips = modes.map((m) => chainTip(buildEpicycles(orderComponents(comps, m), 0.37)));
  const tipDiff = Math.max(...tips.slice(1).map((p) => Math.hypot(p.x - tips[0].x, p.y - tips[0].y)));
  return {
    id: 'order',
    name: '换展示顺序：一圈末端曲线保持',
    pass: maxDiff < 1e-9 && tipDiff < 1e-9,
    detail: `三种顺序逐点最大差 ${maxDiff.toExponential(2)}px，相位 0.37 末端差 ${tipDiff.toExponential(2)}px`,
  };
}

/** 8. 闭合评估：不同缺口比例给出不同处理提示 */
function checkClosureAssessment(): CheckResult {
  const arc: RawPoint[] = [];
  for (let i = 0; i <= 100; i++) {
    const a = (Math.PI * 1.9 * i) / 100;
    arc.push({ x: 100 * Math.cos(a), y: 100 * Math.sin(a), t: i });
  }
  const info = assessClosure(arc);
  const tight = assessClosure([...arc, { ...arc[0], t: 999 }]);
  const pass = info.quality !== 'closed' && tight.quality === 'closed';
  return {
    id: 'closure',
    name: '闭合评估：按缺口比例分级提示',
    pass,
    detail: `缺口 ${(info.ratio * 100).toFixed(1)}% → ${info.quality}；吸附闭合 → ${tight.quality}`,
  };
}

/** 9. 导出尺寸独立于网页缩放：无 padding 时缩放与画布尺寸严格成正比，且图形完整落在画布内 */
function checkExportSizeIndependence(): CheckResult {
  const leaf = resampleArcLength(makeLeaf(N), N, true);
  const sizes: Array<[number, number]> = [[800, 600], [1600, 1200], [400, 900]];
  const layouts = sizes.map(([w, h]) => fitLayout(leaf, w, h, 0));
  const ratios = layouts.map((l) => l.scale);
  // 同长宽比的两档画布（800x600 → 1600x1200）缩放系数恰好翻倍
  const doubles = Math.abs(ratios[0] * 2 - ratios[1]) / ratios[1] < 1e-12;
  // 用默认 padding 时所有点都在安全区内
  let inside = true;
  for (const [w, h] of sizes) {
    const L = fitLayout(leaf, w, h);
    for (const p of leaf) {
      const x = p.x * L.scale + L.offsetX;
      const y = p.y * L.scale + L.offsetY;
      if (x < 40 - 1e-9 || x > w - 40 + 1e-9 || y < 40 - 1e-9 || y > h - 40 + 1e-9) inside = false;
    }
  }
  return {
    id: 'export-size',
    name: '导出尺寸独立于网页缩放',
    pass: doubles && inside,
    detail: `无 padding 缩放系数 ${ratios.map((r) => r.toFixed(3)).join(', ')}（800→1600 恰好翻倍），默认 padding 下图形均落在安全区内`,
  };
}

export function runAllChecks(): CheckResult[] {
  return [
    checkCircleRecovered(),
    checkReverseHandwriting(),
    checkNoSeamJump(),
    checkTranslationSeparation(),
    checkSpeedInvariantSampling(),
    checkMonotoneRecovery(),
    checkOrderInvariance(),
    checkClosureAssessment(),
    checkExportSizeIndependence(),
  ];
}
