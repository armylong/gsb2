/**
 * 本地验证(Node, 无 DOM):
 *  1. 斜向交叠 / 故意留缝 / 仅共边 / 正常拼接 四个场景的幕布采样点
 *     —— 图案位置(两台映射是否对得上)与亮度(含交界两侧)
 *  2. 自交/退化四边形必须被判非法
 *  3. 烘焙导出 PNG -> 解码 -> 作为位图源重新合成, 与实时合成逐像素核对
 * 运行: npm run verify
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario, SCREEN_W } from '../core/scenarios.ts';
import { buildView, buildBitmapView, liveSampler } from '../core/view.ts';
import {
  applyH,
  bbox,
  convexPolygonIntersection,
  pointInPolygon,
  pt,
  validateQuad,
} from '../core/geometry.ts';
import type { Point } from '../core/types.ts';
import {
  bakeOutput,
  computeOverlap,
  renderComposite,
  sampleAt,
  type CompositeMode,
  type ProjectorView,
  type RGB,
} from '../core/blend.ts';
import { PATTERN_W, PATTERN_H, samplePattern, samplePatternBilinear } from '../core/pattern.ts';
import { encodePNG, decodePNG } from './png.ts';
import type { ProjectorState, Quad } from '../core/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../tmp/verify');

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function gray(c: RGB | null): number | null {
  if (!c) return null;
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

interface Views {
  v1: ProjectorView & { forwardH: number[] };
  v2: ProjectorView & { forwardH: number[] };
}

function makeViews(states: ProjectorState[]): Views {
  return { v1: buildView(states[0]), v2: buildView(states[1]) };
}

function probe(states: ProjectorState[], _bw: number, p: Point, tag: string): void {
  const { v1, v2 } = makeViews(states);
  const s = sampleAt(p, v1, v2, 1, PATTERN_W, PATTERN_H);
  const cover = s.in1 && s.in2 ? '重叠' : s.in1 ? '仅P1' : s.in2 ? '仅P2' : '未覆盖';
  const pat = s.patternPoint ? `(${s.patternPoint.x.toFixed(1)}, ${s.patternPoint.y.toFixed(1)})` : '—';
  const g = gray(s.composite);
  const rg = gray(s.reference);
  console.log(
    `    [${tag}] (${p.x},${p.y}) ${cover} w=(${s.w1.toFixed(3)},${s.w2.toFixed(3)}) ` +
      `图案=${pat} 合成灰=${g === null ? '—' : g.toFixed(1)} 参考灰=${rg === null ? '—' : rg.toFixed(1)} ` +
      `Δ=${s.delta === null ? '—' : s.delta.toFixed(2)}`,
  );
}

/** 输出 uv 经裁剪映射换算为主测试图像素坐标 */
function toPatternPixel(st: ProjectorState, uv: Point): Point {
  return {
    x: (st.patternU0 + uv.x * (st.patternU1 - st.patternU0)) * (PATTERN_W - 1),
    y: (st.patternV0 + uv.y * (st.patternV1 - st.patternV0)) * (PATTERN_H - 1),
  };
}

/** 重叠区内任一点: 两台逆映射得到的主测试图坐标必须一致 */
function checkAlignment(states: ProjectorState[], _bw: number, label: string): void {
  const { v1, v2 } = makeViews(states);
  const overlap = convexPolygonIntersection([...states[0].quad], [...states[1].quad]);
  check(`${label}: 两台存在重叠区`, overlap.length >= 3, `实际交点数=${overlap.length}`);
  if (overlap.length < 3) return;
  const box = bbox(overlap);
  let maxErr = 0;
  let tested = 0;
  for (let i = 1; i <= 6; i++) {
    for (let j = 1; j <= 4; j++) {
      const p = pt(
        box.minX + ((box.maxX - box.minX) * i) / 7,
        box.minY + ((box.maxY - box.minY) * j) / 5,
      );
      if (!pointInPolygon(p, overlap)) continue;
      const s = sampleAt(p, v1, v2, 1, PATTERN_W, PATTERN_H);
      if (!s.in1 || !s.in2) continue;
      tested++;
      const px1 = toPatternPixel(states[0], applyH(v1.invH, p.x, p.y));
      const px2 = toPatternPixel(states[1], applyH(v2.invH, p.x, p.y));
      maxErr = Math.max(maxErr, Math.hypot(px1.x - px2.x, px1.y - px2.y));
    }
  }
  check(
    `${label}: 重叠区 ${tested} 个采样点两台图案坐标对齐(误差≤0.5px)`,
    maxErr <= 0.5,
    `maxErr=${maxErr.toFixed(3)}`,
  );
}

// ---------------- 场景 1: 正常拼接 ----------------
console.log('\n=== 场景 normal: 正常横向拼接 ===');
{
  const { projectors } = buildScenario('normal');
  const seamX = 800; // 主平面中点对应的幕布 x(flat master: 120 + 1360/2)
  probe(projectors, 1, pt(seamX - 180, 340), '交界左侧·独占P1');
  probe(projectors, 1, pt(seamX - 30, 340), '交界左侧·重叠带');
  probe(projectors, 1, pt(seamX, 340), '交界中线');
  probe(projectors, 1, pt(seamX + 30, 340), '交界右侧·重叠带');
  probe(projectors, 1, pt(seamX + 180, 340), '交界右侧·独占P2');
  probe(projectors, 1, pt(300, 200), 'P1 内部网格点');
  probe(projectors, 1, pt(1300, 200), 'P2 内部网格点');

  const { v1, v2 } = makeViews(projectors);
  const sLeft = sampleAt(pt(seamX - 180, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  const sMid = sampleAt(pt(seamX, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  check('独占区 Δ≈0(亮度与参考一致)', sLeft.delta !== null && Math.abs(sLeft.delta!) <= 2, `Δ=${sLeft.delta?.toFixed(2)}`);
  check(
    '重叠中线两机权重都在 (0,1)',
    sMid.w1 > 0 && sMid.w1 < 1 && sMid.w2 > 0 && sMid.w2 < 1,
    `w1=${sMid.w1.toFixed(3)} w2=${sMid.w2.toFixed(3)}`,
  );
  check('重叠中线权重和接近 1(无热斑/暗带)', approx(sMid.w1 + sMid.w2, 1, 0.08), `sum=${(sMid.w1 + sMid.w2).toFixed(3)}`);

  // 整个重叠区网格逐点核对: 权重互补(和≈1)
  {
    const overlap = computeOverlap(projectors[0].quad, projectors[1].quad)!;
    const box = bbox(overlap);
    let maxSumErr = 0;
    let count = 0;
    for (let i = 1; i <= 10; i++) {
      for (let j = 1; j <= 8; j++) {
        const p = pt(
          box.minX + ((box.maxX - box.minX) * i) / 11,
          box.minY + ((box.maxY - box.minY) * j) / 9,
        );
        if (!pointInPolygon(p, overlap)) continue;
        const s = sampleAt(p, v1, v2, 1, PATTERN_W, PATTERN_H);
        if (!s.in1 || !s.in2) continue;
        count++;
        maxSumErr = Math.max(maxSumErr, Math.abs(s.w1 + s.w2 - 1));
      }
    }
    check(`重叠区 ${count} 点权重互补(|w1+w2-1|≤0.05)`, maxSumErr <= 0.05, `maxErr=${maxSumErr.toFixed(4)}`);
  }
  checkAlignment(projectors, 1, 'normal');
}

// ---------------- 场景 2: 斜向交叠 ----------------
console.log('\n=== 场景 diagonal: 斜向交叠(透视倾斜) ===');
{
  const { projectors } = buildScenario('diagonal');
  const overlap = convexPolygonIntersection([...projectors[0].quad], [...projectors[1].quad]);
  const box = bbox(overlap);
  probe(projectors, 1, pt(box.minX + 40, 340), '重叠带左端');
  probe(projectors, 1, pt((box.minX + box.maxX) / 2, 340), '重叠带中部');
  probe(projectors, 1, pt(box.maxX - 40, 340), '重叠带右端');
  probe(projectors, 1, pt(350, 250), 'P1 独占区');
  probe(projectors, 1, pt(1250, 420), 'P2 独占区');

  const { v1, v2 } = makeViews(projectors);
  const states: string[] = [];
  for (let x = 200; x <= 1400; x += 50) {
    const s = sampleAt(pt(x, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
    states.push(s.in1 && s.in2 ? 'X' : s.in1 ? '1' : s.in2 ? '2' : '.');
  }
  const seq = states.join('');
  check('斜向交叠覆盖序列含 1→X→2 转换', /1+X+2+/.test(seq), seq);
  const sMid = sampleAt(pt((box.minX + box.maxX) / 2, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  // 独占区没有权重衰减, 亮度差直接等于增益差: P1=0.95 应偏暗, P2=1.05 应偏亮
  const sP1Only = sampleAt(pt(350, 250), v1, v2, 1, PATTERN_W, PATTERN_H);
  const sP2Only = sampleAt(pt(1250, 420), v1, v2, 1, PATTERN_W, PATTERN_H);
  check('亮度 0.95/1.05 差异可被检出(P1 独占区偏暗)', sP1Only.delta !== null && sP1Only.delta! < -2,
    `Δ=${sP1Only.delta?.toFixed(2)}`);
  check('亮度 0.95/1.05 差异可被检出(P2 独占区偏亮)', sP2Only.delta !== null && sP2Only.delta! > 1,
    `Δ=${sP2Only.delta?.toFixed(2)}`);
  void sMid;
  checkAlignment(projectors, 1, 'diagonal');
}

// ---------------- 场景 3: 故意留缝 ----------------
console.log('\n=== 场景 gap: 故意留缝 ===');
{
  const { projectors } = buildScenario('gap');
  const { v1, v2 } = makeViews(projectors);
  // 主平面 u∈[0.47,0.55] 为缝; flat master: x = 120 + 1360u
  const gapX = 120 + 1360 * 0.51;
  const sGap = sampleAt(pt(gapX, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  check('缝隙中点无人覆盖', !sGap.in1 && !sGap.in2);
  check('缝隙处合成输出为空', sGap.composite === null);
  probe(projectors, 1, pt(120 + 1360 * 0.46, 340), '缝左缘(P1)');
  probe(projectors, 1, pt(gapX, 340), '缝中');
  probe(projectors, 1, pt(120 + 1360 * 0.56, 340), '缝右缘(P2)');
  const sL = sampleAt(pt(120 + 1360 * 0.4, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  const sR = sampleAt(pt(120 + 1360 * 0.62, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  check('缝两侧独占区权重为 1', sL.w1 === 1 && sR.w2 === 1);
  check('留缝场景无重叠区', convexPolygonIntersection([...projectors[0].quad], [...projectors[1].quad]).length === 0);
}

// ---------------- 场景 4: 仅共边 ----------------
console.log('\n=== 场景 edge: 仅共边(零重叠) ===');
{
  const { projectors } = buildScenario('edge');
  const { v1, v2 } = makeViews(projectors);
  const edgeX = 120 + 1360 * 0.5;
  const sOn = sampleAt(pt(edgeX, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  check('共边线处至少一台覆盖(无空隙)', sOn.in1 || sOn.in2);
  const sL = sampleAt(pt(edgeX - 2, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  const sR = sampleAt(pt(edgeX + 2, 340), v1, v2, 1, PATTERN_W, PATTERN_H);
  check('共边左侧仅 P1、右侧仅 P2', sL.in1 && !sL.in2 && sR.in2 && !sR.in1);
  probe(projectors, 1, pt(edgeX - 2, 340), '共边左 2px');
  probe(projectors, 1, pt(edgeX + 2, 340), '共边右 2px');
}

// ---------------- 自交 / 退化四边形 ----------------
console.log('\n=== 非法四边形保护 ===');
{
  const bowtie: Quad = [pt(200, 100), pt(700, 500), pt(700, 100), pt(200, 500)];
  const r1 = validateQuad(bowtie);
  check('蝴蝶结自交被拒绝', !r1.valid && /自交/.test(r1.reason ?? ''), r1.reason ?? '');
  const degenerate: Quad = [pt(200, 100), pt(700, 100), pt(700, 100), pt(200, 500)];
  const r2 = validateQuad(degenerate);
  check('重合点退化被拒绝', !r2.valid, r2.reason ?? '');
  const collinear: Quad = [pt(0, 0), pt(100, 0), pt(200, 0), pt(50, 80)];
  const r3 = validateQuad(collinear);
  check('三点共线退化被拒绝', !r3.valid, r3.reason ?? '');
  const good: Quad = [pt(0, 0), pt(100, 0), pt(100, 80), pt(0, 80)];
  check('正常矩形通过校验', validateQuad(good).valid);
}

// ---------------- 导出 PNG 往返一致性 ----------------
console.log('\n=== 导出/导入往返: 烘焙 PNG 再合成 ===');
for (const scenarioId of ['normal', 'diagonal', 'gap']) {
  const { projectors } = buildScenario(scenarioId);
  const { v1, v2 } = makeViews(projectors);

  const scale = 0.5;
  const w = Math.round(SCREEN_W * scale);
  const h = Math.round(720 * scale);
  const live = renderComposite({
    width: w, height: h, scale, blendRatio: 1, p1: v1, p2: v2, mode: 'blend' as CompositeMode,
  });

  // 烘焙两台输出并实际走一遍 PNG 编码/解码
  const overlap = computeOverlap(projectors[0].quad, projectors[1].quad);
  const baked1 = bakeOutput(v1, v1.forwardH, projectors[1].quad, projectors[0].outputWidth, projectors[0].outputHeight, 1, overlap);
  const baked2 = bakeOutput(v2, v2.forwardH, projectors[0].quad, projectors[1].outputWidth, projectors[1].outputHeight, 1, overlap);
  mkdirSync(OUT_DIR, { recursive: true });
  const f1 = resolve(OUT_DIR, `${scenarioId}-p1.png`);
  const f2 = resolve(OUT_DIR, `${scenarioId}-p2.png`);
  writeFileSync(f1, encodePNG(baked1, projectors[0].outputWidth, projectors[0].outputHeight));
  writeFileSync(f2, encodePNG(baked2, projectors[1].outputWidth, projectors[1].outputHeight));

  const dec1 = decodePNG(readFileSync(f1));
  const dec2 = decodePNG(readFileSync(f2));
  const bv1 = buildBitmapView(projectors[0], dec1.rgba, dec1.width, dec1.height);
  const bv2 = buildBitmapView(projectors[1], dec2.rgba, dec2.width, dec2.height);
  const reimported = renderComposite({
    width: w, height: h, scale, blendRatio: 1, p1: bv1, p2: bv2, mode: 'blend' as CompositeMode,
  });

  // 判据 1: 覆盖掩码必须逐像素一致(几何位置零误差)
  let maskMismatch = 0;
  for (let i = 0; i < live.coverage.length; i++) {
    if (live.coverage[i] !== reimported.coverage[i]) maskMismatch++;
  }
  check(`${scenarioId}: 导出前后覆盖掩码逐像素一致`, maskMismatch === 0, `不一致像素=${maskMismatch}`);

  // 判据 2: 覆盖区内颜色差异统计。
  // 测试图含大量硬网格线, 烘焙(超采样)与逐点(单采样)是两种低通滤波,
  // 高频边缘处差异不可避免; 故看整体均值而非逐像素严格相等。
  let sumAbs = 0;
  let coveredSamples = 0;
  let maxDiff = 0;
  for (let i = 0; i < live.coverage.length; i++) {
    if (live.coverage[i] === 0) continue;
    const o = i * 4;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(live.rgba[o + k] - reimported.rgba[o + k]);
      sumAbs += d;
      coveredSamples++;
      maxDiff = Math.max(maxDiff, d);
    }
  }
  const meanAbs = sumAbs / Math.max(1, coveredSamples);
  check(`${scenarioId}: 重导入整体平均色差 < 5(高频网格线允许局部差异)`, meanAbs < 5,
    `meanAbs=${meanAbs.toFixed(2)} maxDiff=${maxDiff}`);

  // 判据 2b: 平滑区域(测试图底部灰阶 ramp, 无硬边)应高度一致
  let smoothSum = 0;
  let smoothN = 0;
  // ramp 带在测试图 y∈[520,560), 映射到幕布纵向约 87%~93% 处
  const y0 = Math.round(h * 0.88);
  const y1 = Math.round(h * 0.92);
  for (let py = y0; py < y1; py++) {
    for (let px = 0; px < w; px++) {
      const i = py * w + px;
      if (live.coverage[i] === 0) continue;
      const o = i * 4;
      for (let k = 0; k < 3; k++) smoothSum += Math.abs(live.rgba[o + k] - reimported.rgba[o + k]);
      smoothN += 3;
    }
  }
  const smoothMean = smoothSum / Math.max(1, smoothN);
  check(`${scenarioId}: 平滑 ramp 区平均色差 < 1.5`, smoothMean < 1.5, `meanAbs=${smoothMean.toFixed(2)}`);

  // 判据 3: 采样点级别核对。探针放在测试图底部的平滑灰阶 ramp 带
  // (图案 y≈540, 无网格/无基准点), 严格检验几何与亮度, 不被高频边缘滤波差干扰;
  // 网格线/基准点上的差异由判据 2 的整体统计覆盖。
  const seamX = scenarioId === 'gap' ? 120 + 1360 * 0.4 : 800;
  // 幕布 y: 主画面纵向 100..580 对应图案 0..600, ramp 带图案 y≈540
  const screenY = 100 + (540 / 600) * 480;
  for (const dx of [-120, -30, 0, 30, 120]) {
    const p = pt(seamX + dx, screenY);
    const a = sampleAt(p, v1, v2, 1, PATTERN_W, PATTERN_H);
    const b = sampleAt(p, bv1, bv2, 1, PATTERN_W, PATTERN_H);
    const ga = gray(a.composite);
    const gb = gray(b.composite);
    if (ga === null && gb === null) continue;
    // gap 最外侧点贴近投影边(抗锯齿软化区);
    // 重叠区经历两次透视重采样(烘焙缩小+回映), 允许累积滤波差, 独占区严容差
    const nearSoftEdge = scenarioId === 'gap' && Math.abs(dx) >= 120;
    const inOverlap = a.in1 && a.in2;
    const tol = nearSoftEdge ? 25 : inOverlap ? 12 : 5;
    check(
      `${scenarioId}: ramp采样点(${p.x.toFixed(0)})导出前后灰度一致(容差${tol})`,
      ga !== null && gb !== null && approx(ga, gb, tol),
      `live=${ga?.toFixed(1)} reimport=${gb?.toFixed(1)}`,
    );
  }

  // 判据 4: 重叠区内部点的图案位置(PNG 反演后仍应映射到同一主测试图坐标)
  if (overlap) {
    const box = bbox(overlap);
    const p = pt((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
    const a = sampleAt(p, v1, v2, 1, PATTERN_W, PATTERN_H);
    const b = sampleAt(p, bv1, bv2, 1, PATTERN_W, PATTERN_H);
    check(
      `${scenarioId}: 重叠中心导出前后图案坐标一致(≤1.5px)`,
      a.patternPoint !== null && b.patternPoint !== null &&
        Math.hypot(a.patternPoint.x - b.patternPoint.x, a.patternPoint.y - b.patternPoint.y) <= 1.5,
      `live=(${a.patternPoint?.x.toFixed(1)},${a.patternPoint?.y.toFixed(1)}) ` +
        `reimport=(${b.patternPoint?.x.toFixed(1)},${b.patternPoint?.y.toFixed(1)})`,
    );
  }
}

// ---------------- 纯图案确定性 ----------------
console.log('\n=== 测试图确定性 ===');
{
  const a = samplePattern(317, 211);
  const b = samplePattern(317, 211);
  check('同一坐标重复采样结果相同', a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
  const corners = [samplePattern(0, 0), samplePattern(PATTERN_W - 1, PATTERN_H - 1)];
  check('角落可采样且为合法 RGB', corners.every((c) => c.every((v) => v >= 0 && v <= 255)));
  const { projectors } = buildScenario('normal');
  const st = projectors[0];
  const smp = liveSampler(st);
  const c = smp(0.5, 0.5);
  // liveSampler 内部走双线性, 期望值同样用双线性采样
  const expect = samplePatternBilinear(
    (st.patternU0 + 0.5 * (st.patternU1 - st.patternU0)) * (PATTERN_W - 1),
    0.5 * (PATTERN_H - 1),
  );
  check('liveSampler 裁剪映射正确', c.every((v, k) => Math.abs(v - expect[k]) <= 1));
}

console.log(`\n结果: ${passes} 通过, ${failures} 失败`);
if (failures > 0) process.exit(1);
console.log(`烘焙 PNG 输出目录: ${OUT_DIR}`);
