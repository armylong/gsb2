/**
 * 可复现的接缝测量与不变量验证（纯 Node 运行，无需浏览器 / WebGL）。
 *
 * 运行：npm run verify
 *
 * 覆盖：
 *  1. 默认密度差（4 vs 16）：直接拼接必然有缝，修正后缝差归零
 *  2. 反转一侧边参数方向后仍正确配对
 *  3. 另一侧变成疏侧（A 密 B 疏）
 *  4. 密度相同：无裂缝，fixSeam 不改动任何顶点
 *  5. 拖动共享控制点后，两侧边曲线仍逐点重合（共享引用不变量）
 *  6. 单侧改密度：另一侧的所有顶点（含外边界）逐坐标不变
 *  7. 不同“观察距离”下的屏幕空间像素偏离（针孔相机投影，确定性计算）
 */
import {
  Patch,
  MeshData,
  createInitialPatches,
  tessellate,
  fixSeam,
  measureGap,
  sharedPointAt,
  evaluateSharedEdge,
  endpointsCoincide,
  edgePolyline,
} from '../src/core/surface';
import { Vec3, distance } from '../src/core/vec3';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/**
 * 针孔相机投影：把世界空间缝差换算为屏幕像素。
 * fov 为垂直视场角，screenHeightPx 为画布高，viewDist 为相机到接缝的距离。
 */
function worldGapToPixels(worldGap: number, viewDist: number, fovDeg = 50, screenHeightPx = 900): number {
  const fov = (fovDeg * Math.PI) / 180;
  const worldPerPixel = (2 * viewDist * Math.tan(fov / 2)) / screenHeightPx;
  return worldGap / worldPerPixel;
}

function buildPair(patchA: Patch, patchB: Patch) {
  return { meshA: tessellate(patchA), meshB: tessellate(patchB) };
}

function orderedFineCoarse(meshA: MeshData, meshB: MeshData) {
  return meshA.nv >= meshB.nv ? { fine: meshA, coarse: meshB } : { fine: meshB, coarse: meshA };
}

console.log('== 场景 1：默认样例（A: 4 段, B: 16 段）==');
{
  const { patchA, patchB } = createInitialPatches();
  const { meshA, meshB } = buildPair(patchA, patchB);
  check('共享边端点严格重合', endpointsCoincide(meshA, meshB));

  const { fine, coarse } = orderedFineCoarse(meshA, meshB);
  const gap = measureGap(fine, coarse);
  console.log(`  直接拼接最大偏离: ${gap.maxDeviation.toExponential(4)} 世界单位` +
    ` (密→疏 ${gap.maxFineToCoarse.toExponential(3)}, 疏→密 ${gap.maxCoarseToFine.toExponential(3)}` +
    ` @s=${gap.worstS.toFixed(3)})`);
  check('直接拼接存在可测裂缝', gap.maxDeviation > 1e-4,
    `maxDeviation=${gap.maxDeviation.toExponential(3)}`);

  const { fixedA, fixedB } = fixSeam(meshA, meshB);
  const fixedPair = orderedFineCoarse(fixedA, fixedB);
  const gapFixed = measureGap(fixedPair.fine, fixedPair.coarse);
  console.log(`  修正后最大偏离:   ${gapFixed.maxDeviation.toExponential(4)} 世界单位`);
  check('修正后缝差归零（<1e-10）', gapFixed.maxDeviation < 1e-10,
    `maxDeviation=${gapFixed.maxDeviation.toExponential(3)}`);

  console.log('  不同观察距离下的屏幕空间像素偏离（直接拼接 / 修正后）:');
  for (const d of [6, 12, 24, 48]) {
    const px = worldGapToPixels(gap.maxDeviation, d);
    const pxFixed = worldGapToPixels(gapFixed.maxDeviation, d);
    console.log(`    距离 ${String(d).padStart(2)} → ${px.toFixed(3)} px / ${pxFixed.toExponential(1)} px`);
    check(`距离 ${d} 像素偏离可复现`, Number.isFinite(px) && px >= 0);
  }
}

console.log('== 场景 2：反转 Patch B 的边参数方向 ==');
{
  const { patchA, patchB } = createInitialPatches();
  patchB.edgeReversed = true;
  const { meshA, meshB } = buildPair(patchA, patchB);

  // s 是物理边参数：反转不改变 s→曲线上点的映射，两侧同 s 必为同一点
  let pairingError = 0;
  for (let k = 0; k <= 20; k++) {
    const s = k / 20;
    pairingError = Math.max(pairingError, distance(sharedPointAt(patchA, s), sharedPointAt(patchB, s)));
  }
  check('反转后统一参数 s 配对误差 < 1e-12', pairingError < 1e-12, `err=${pairingError.toExponential(2)}`);
  // 反转是整块曲面的采样重参数化：网格局部 v 索引 j 处的顶点，
  // 必须取自曲面局部参数 vLocal = 1 - j/nv（共享边上即 evaluateSharedEdge(patch, 1-j/nv)）。
  let localMapError = 0;
  const edgeU = patchB.sharedEdge === 'u0' ? 0 : meshB.nu;
  for (let jj = 0; jj <= meshB.nv; jj++) {
    const sampled = meshB.positions[edgeU * (meshB.nv + 1) + jj];
    const expected = evaluateSharedEdge(patchB, 1 - jj / meshB.nv);
    localMapError = Math.max(localMapError, distance(sampled, expected));
  }
  check('反转侧网格按局部 vLocal=1-j/nv 采样', localMapError < 1e-12, `err=${localMapError.toExponential(2)}`);
  // 端点物理重合：A 的 s=0 端点对应 B 的 s=0 端点（B 内部即其局部 v=1）
  check('反转后边端点仍严格重合', endpointsCoincide(meshA, meshB));
  // 两条边折线按 s 递增排列，逐位置相同
  const lineA = edgePolyline(meshA);
  const lineB = edgePolyline(meshB);
  check('反转后边起点为同一物理点', distance(lineA[0], lineB[0]) < 1e-12);
  check('反转后边终点为同一物理点',
    distance(lineA[lineA.length - 1], lineB[lineB.length - 1]) < 1e-12);

  const { fine, coarse } = orderedFineCoarse(meshA, meshB);
  const gap = measureGap(fine, coarse);
  const { fixedA, fixedB } = fixSeam(meshA, meshB);
  const fixedPair = orderedFineCoarse(fixedA, fixedB);
  const gapFixed = measureGap(fixedPair.fine, fixedPair.coarse);
  check('反转后直接拼接仍有裂缝', gap.maxDeviation > 1e-4);
  check('反转后修正仍归零', gapFixed.maxDeviation < 1e-10,
    `maxDeviation=${gapFixed.maxDeviation.toExponential(3)}`);
}

console.log('== 场景 3：疏密度对调（A: 20 段, B: 3 段）==');
{
  const { patchA, patchB } = createInitialPatches();
  patchA.subdivV = 20;
  patchB.subdivV = 3;
  const { meshA, meshB } = buildPair(patchA, patchB);
  const { fine, coarse } = orderedFineCoarse(meshA, meshB);
  check('密侧为 A', fine === meshA);
  const gap = measureGap(fine, coarse);
  const { fixedA, fixedB } = fixSeam(meshA, meshB);
  const fixedPair = orderedFineCoarse(fixedA, fixedB);
  const gapFixed = measureGap(fixedPair.fine, fixedPair.coarse);
  check('对调后直接拼接有裂缝', gap.maxDeviation > 1e-4);
  check('对调后修正归零', gapFixed.maxDeviation < 1e-10);
}

console.log('== 场景 4：密度相同（均为 8 段）==');
{
  const { patchA, patchB } = createInitialPatches();
  patchA.subdivV = 8;
  patchB.subdivV = 8;
  const { meshA, meshB } = buildPair(patchA, patchB);
  const { fine, coarse } = orderedFineCoarse(meshA, meshB);
  const gap = measureGap(fine, coarse);
  check('等密度直接拼接无裂缝', approx(gap.maxDeviation, 0, 1e-12),
    `maxDeviation=${gap.maxDeviation.toExponential(2)}`);
  const { fixedA, fixedB } = fixSeam(meshA, meshB);
  check('等密度时 fixSeam 原样返回（同一引用）', fixedA === meshA && fixedB === meshB);
}

console.log('== 场景 5：拖动共享控制点，两侧曲线仍重合 ==');
{
  const { patchA, patchB } = createInitialPatches();
  const shared = patchA.grid[3][1];
  shared.x += 0.7;
  shared.y -= 0.4;
  shared.z += 0.9;
  check('共享控制点是同一引用', patchA.grid[3][1] === patchB.grid[0][1]);
  let err = 0;
  for (let k = 0; k <= 30; k++) {
    const s = k / 30;
    err = Math.max(err, distance(sharedPointAt(patchA, s), sharedPointAt(patchB, s)));
  }
  check('拖动后整条共享边逐点重合', err < 1e-12, `err=${err.toExponential(2)}`);
}

console.log('== 场景 6：单侧改密度，另一侧顶点（含外边界）逐坐标不变 ==');
{
  const { patchA, patchB } = createInitialPatches();
  const before = tessellate(patchA);
  const beforeSnapshot = before.positions.map((p) => ({ ...p }));

  patchB.subdivV = 24; // 只改 B 的密度
  const afterA = tessellate(patchA);
  let moved = 0;
  let maxMove = 0;
  afterA.positions.forEach((p, i) => {
    const d = distance(p, beforeSnapshot[i]);
    maxMove = Math.max(maxMove, d);
    if (d > 0) moved++;
  });
  check('A 的顶点数量不变', afterA.positions.length === beforeSnapshot.length);
  check('A 的全部顶点零位移（含外边界）', moved === 0, `moved=${moved}, maxMove=${maxMove}`);

  // 修正阶段同样不允许动疏侧
  const meshB = tessellate(patchB);
  const { fixedA } = fixSeam(afterA, meshB);
  const coarseLineBefore = edgePolyline(afterA);
  const coarseLineAfter = edgePolyline(fixedA);
  let coarseMoved = 0;
  coarseLineAfter.forEach((p, i) => {
    if (distance(p, coarseLineBefore[i]) > 0) coarseMoved++;
  });
  check('修正后疏侧 A 的共享边顶点零位移', coarseMoved === 0);
  check('修正后疏侧 A 全网格零位移',
    fixedA.positions.every((p, i) => distance(p, afterA.positions[i]) === 0));
}

console.log('== 场景 7：修正仅改密侧共享边，密侧自身外边界不动 ==');
{
  const { patchA, patchB } = createInitialPatches();
  const meshA = tessellate(patchA);
  const meshB = tessellate(patchB);
  const { fixedB } = fixSeam(meshA, meshB);
  // B 的外边界是 u=nu 那一列（sharedEdge=u0 → 共享边在 u=0 列）
  const outerColB = (m: MeshData) => {
    const pts: Vec3[] = [];
    for (let j = 0; j <= m.nv; j++) pts.push(m.positions[m.nu * (m.nv + 1) + j]);
    return pts;
  };
  const beforeOuter = outerColB(meshB);
  const afterOuter = outerColB(fixedB);
  check('密侧外边界零位移', afterOuter.every((p, i) => distance(p, beforeOuter[i]) === 0));
  // 密侧内部顶点也不动（仅允许共享边列变化）
  let interiorMoved = 0;
  for (let i = 1; i < fixedB.nu; i++) {
    for (let j = 0; j <= fixedB.nv; j++) {
      const idx = i * (fixedB.nv + 1) + j;
      if (distance(fixedB.positions[idx], meshB.positions[idx]) > 0) interiorMoved++;
    }
  }
  check('密侧内部顶点零位移', interiorMoved === 0, `moved=${interiorMoved}`);
}

console.log('== 场景 8：T 型点消除的拓扑正确性（4 对 3、非整数倍密度）==');
{
  const { patchA, patchB } = createInitialPatches();
  patchA.subdivV = 4;
  patchB.subdivV = 3; // 互不为倍数，疏侧顶点都落在密侧线段中部
  const meshA = tessellate(patchA);
  const meshB = tessellate(patchB);
  const { fixedA, fixedB } = fixSeam(meshA, meshB);
  // A=4 段、B=3 段时 A 才是密侧；统一用分段数判定，不假设名字
  const { fine: fineFixed, coarse } = orderedFineCoarse(fixedA, fixedB);
  const finePatch = fineFixed === fixedA ? patchA : patchB;

  // 1. 所有索引在位置数组范围内
  const outOfRange = fineFixed.indices.filter((ix) => ix < 0 || ix >= fineFixed.positions.length);
  check('修正后索引全部合法', outOfRange.length === 0, `越界 ${outOfRange.length} 个`);

  // 2. 三角形数量：内部格点保持原三角化，贴边环按合并边链逐段扇形展开，
  //    贴边环三角形数 = 边链总段数；其余 (nu-1)*nv 个内部单元每单元 2 个。
  const edgeChainSegments = fineFixed.edgeIndices.length - 1;
  const fineNu = fineFixed.nu;
  const fineNv = fineFixed.nv;
  const expectedTris = (fineNu - 1) * fineNv * 2 + edgeChainSegments;
  check('三角形数量随插入点正确增长',
    fineFixed.indices.length / 3 === expectedTris,
    `got=${fineFixed.indices.length / 3}, expect=${expectedTris}`);

  // 3. 无退化三角形（三个顶点互不相同）
  let degenerate = 0;
  for (let t = 0; t < fineFixed.indices.length; t += 3) {
    const [a, b, c] = fineFixed.indices.slice(t, t + 3);
    if (a === b || b === c || a === c) degenerate++;
  }
  check('无退化三角形', degenerate === 0, `degenerate=${degenerate}`);

  // 4. 疏侧每个边参数 s 都必须出现在密侧边链的参数集合中（T 型点被消除）。
  //    位置以统一数学曲线 sharedPointAt 为基准比较，规避两网格离散采样差异。
  const fineS = new Set(fineFixed.edgeS.map((s) => s));
  const missingS = coarse.edgeS.filter((s) => !fineS.has(s));
  check('疏侧全部边参数已并入密侧边链', missingS.length === 0, `missing=${missingS.length}`);
  // 插入点（疏侧 s 对应的新顶点）必须与疏侧顶点逐位相同，且落在数学曲线上；
  // 密侧原有的边顶点则被吸附到疏侧弦上（允许偏离曲线，这是消缝的代价）。
  const coarseS = new Set(coarse.edgeS);
  let insertedOnCurveError = 0;
  fineFixed.edgeS.forEach((s, slot) => {
    if (!coarseS.has(s)) return;
    insertedOnCurveError = Math.max(
      insertedOnCurveError,
      distance(fineFixed.positions[fineFixed.edgeIndices[slot]], sharedPointAt(finePatch, s)),
    );
  });
  check('疏侧插入点与数学曲线严格重合', insertedOnCurveError < 1e-10,
    `err=${insertedOnCurveError.toExponential(2)}`);

  // 5. 双向缝差归零
  const gapFixed = measureGap(fineFixed, coarse);
  check('非整数倍密度下修正仍归零', gapFixed.maxDeviation < 1e-10,
    `maxDeviation=${gapFixed.maxDeviation.toExponential(3)}`);
}

console.log('');
if (failures > 0) {
  console.error(`验证失败：${failures} 项未通过`);
  process.exit(1);
}
console.log('全部验证通过 ✓');
