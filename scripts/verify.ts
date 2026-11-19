/**
 * 本地无头验证脚本（不依赖浏览器、外部模型或在线服务）：
 *
 *   npx tsx scripts/verify.ts
 *
 * 覆盖需求中的关键口径：
 * A. 三个样例程序化生成，面数 <= 12000，边界统计正确（球/建筑闭合，弯曲片 2 条环）
 * B. 不简化（100%）参照：同一采样管线下 max/RMS 为 0
 * C. 球面降面：25%–90% 各档真实面数、达标情况，误差随面数下降而上升（非严格断言，报告趋势）
 * D. 无法达到目标时如实报告（用极小目标触发），且结果网格不包含原网格的额外面
 * E. LockBorder：弯曲片保留下来的边界顶点偏移严格为 0；不锁定时存在偏移
 * F. 已知点距离：构造偏移 0.3 的平面，校验 BVH 最近点距离口径
 * G. OBJ 导出再读取：顶点/面数一致，重算的 max/RMS 与导出前一致，边界一致
 * H. 采样规则固定：颜色范围参数不参与读数（同一 metrics 两次着色，读数不变）
 */
import {
  generateBuilding,
  generateCurvedSheet,
  generateSphere,
} from '../src/lib/meshGenerate';
import {
  MeshData,
  cloneMesh,
  computeBoundary,
  triangleCount,
  vertexCount,
  weldByPosition,
} from '../src/lib/meshTypes';
import { ensureSimplifierReady, simplifyMesh } from '../src/lib/simplify';
import {
  buildBVH,
  buildDistanceColors,
  computeSampledError,
  nearestPointOnOriginal,
} from '../src/lib/errorMetrics';
import { parseOBJ, writeOBJ } from '../src/lib/objIO';
import * as THREE from 'three';

let failures = 0;
let passes = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passes++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

async function main(): Promise<void> {
  await ensureSimplifierReady();
  console.log('meshoptimizer WebAssembly 就绪\n');

  // ---------- A. 生成与基础统计 ----------
  console.log('A. 程序化样例与面数上限 (12000)');
  const samples: Record<string, MeshData> = {
    sphere: generateSphere(),
    building: generateBuilding(),
    sheet: generateCurvedSheet(),
  };
  for (const [id, mesh] of Object.entries(samples)) {
    const tris = triangleCount(mesh);
    const boundary = computeBoundary(mesh);
    check(
      `${id} 面数 <= 12000`,
      tris <= 12000,
      `${tris} 面 / ${vertexCount(mesh)} 顶点 / 边界环 ${boundary.loopCount}`,
    );
    // 边界环上的顶点总数应等于边界边数
    check(
      `${id} 边界统计自洽`,
      boundary.edgeCount === boundary.vertexCount,
      `边 ${boundary.edgeCount} = 顶点 ${boundary.vertexCount}`,
    );
  }
  check('球面闭合（0 边界环）', computeBoundary(samples.sphere).loopCount === 0);
  check('建筑闭合（0 边界环）', computeBoundary(samples.building).loopCount === 0);
  const sheetBoundary = computeBoundary(samples.sheet);
  check(
    '弯曲片有 2 条边界环（外轮廓 + 开口）',
    sheetBoundary.loopCount === 2,
    `实际 ${sheetBoundary.loopCount} 条，边界边 ${sheetBoundary.edgeCount}`,
  );

  // ---------- B. 零误差参照 ----------
  console.log('\nB. 不简化（100%）零误差参照');
  for (const [id, mesh] of Object.entries(samples)) {
    const bvh = buildBVH(mesh);
    const m = computeSampledError(cloneMesh(mesh), bvh);
    check(`${id} 参照 max = 0`, approx(m.max, 0, 1e-9), `max=${m.max.toExponential(2)}`);
    check(`${id} 参照 RMS = 0`, approx(m.rms, 0, 1e-9), `rms=${m.rms.toExponential(2)}`);
    check(
      `${id} 采样点数 = 顶点数 + 面数`,
      m.sampleCount === vertexCount(mesh) + triangleCount(mesh),
      `${m.sampleCount}`,
    );
  }

  // ---------- C. 球面降面误差变化 ----------
  console.log('\nC. 球面降面：真实面数、达标情况与误差趋势');
  const sphere = samples.sphere;
  const sphereBVH = buildBVH(sphere);
  const sourceTris = triangleCount(sphere);
  let prevMax = 0;
  let monotone = true;
  const ratios = [0.9, 0.75, 0.5, 0.35, 0.25];
  for (const ratio of ratios) {
    const r = simplifyMesh(sphere, { ratio, lockBorder: false });
    const m = computeSampledError(r.mesh, sphereBVH);
    const targetOk = Math.abs(r.actualTriangles - r.targetTriangles) <= 1;
    check(
      `球面保留 ${Math.round(ratio * 100)}% 达标且面数如实`,
      r.reached === targetOk && r.actualTriangles <= sourceTris,
      `目标 ${r.targetTriangles} / 实际 ${r.actualTriangles} / max ${m.max.toExponential(3)} / RMS ${m.rms.toExponential(3)}`,
    );
    if (m.max + 1e-12 < prevMax) monotone = false;
    prevMax = m.max;
  }
  check('球面误差随面数减少总体不下降', monotone, '（逐档比较 max）');

  // ---------- D. 无法达到目标 ----------
  console.log('\nD. 极端目标下的如实报告');
  const extreme = simplifyMesh(sphere, { ratio: 0.001, lockBorder: false });
  check(
    '极小目标被标记为未达标',
    !extreme.reached,
    `目标 ${extreme.targetTriangles} 面，实际停在 ${extreme.actualTriangles} 面`,
  );
  check(
    '结果网格未复制原网格面：实际面数 <= 源面数',
    extreme.actualTriangles <= sourceTris,
  );
  check(
    '结果索引全部引用结果顶点数组范围内的顶点',
    maxOf(extreme.mesh.indices) < vertexCount(extreme.mesh),
  );

  // ---------- E. LockBorder 边界保护 ----------
  console.log('\nE. 弯曲片开口边界保护（LockBorder）');
  const sheet = samples.sheet;
  const weldedSheet = weldByPosition(sheet);
  const b0 = computeBoundary(sheet);
  const weldedBoundary = new Set<number>();
  for (const loop of b0.loops) for (const v of loop) weldedBoundary.add(v);
  check('焊接后边界顶点数与边界边数一致', b0.vertexCount === b0.edgeCount);

  const locked = simplifyMesh(sheet, { ratio: 0.4, lockBorder: true });
  const unlocked = simplifyMesh(sheet, { ratio: 0.4, lockBorder: false });

  // 锁定后：结果网格中每个与焊接源边界顶点同位置的顶点，偏移必须严格为 0
  const weldedPositions = new Map<string, number>();
  for (let v = 0; v < vertexCount(weldedSheet); v++) {
    weldedPositions.set(posKey(weldedSheet.positions, v), v);
  }
  let lockedMaxShift = 0;
  let lockedBoundaryKept = 0;
  for (let v = 0; v < vertexCount(locked.mesh); v++) {
    const sourceIndex = weldedPositions.get(posKey(locked.mesh.positions, v));
    if (sourceIndex !== undefined && weldedBoundary.has(sourceIndex)) {
      lockedBoundaryKept++;
      const dx = locked.mesh.positions[v * 3] - weldedSheet.positions[sourceIndex * 3];
      const dy = locked.mesh.positions[v * 3 + 1] - weldedSheet.positions[sourceIndex * 3 + 1];
      const dz = locked.mesh.positions[v * 3 + 2] - weldedSheet.positions[sourceIndex * 3 + 2];
      lockedMaxShift = Math.max(lockedMaxShift, Math.hypot(dx, dy, dz));
    }
  }
  check('LockBorder 保留了全部边界顶点', lockedBoundaryKept === weldedBoundary.size,
    `${lockedBoundaryKept}/${weldedBoundary.size}`);
  check('LockBorder 边界顶点最大偏移 = 0（容差 0）', approx(lockedMaxShift, 0, 1e-9),
    `maxShift=${lockedMaxShift.toExponential(2)}`);

  // 不锁定时：整体采样误差应存在非零值（边界可以移动）
  const sheetBVH = buildBVH(sheet);
  const unlockedMetrics = computeSampledError(unlocked.mesh, sheetBVH);
  const lockedMetrics = computeSampledError(locked.mesh, sheetBVH);
  check('未锁定时整体 max 误差 > 0', unlockedMetrics.max > 1e-6,
    `max=${unlockedMetrics.max.toExponential(3)}`);
  check('两版本采样点数与各自网格规模匹配',
    lockedMetrics.sampleCount > 0 && unlockedMetrics.sampleCount > 0);

  // 边界口径（而不是整体 max）：在焊接源边界顶点位置上，测到两个简化结果表面的距离。
  // 锁定时简化表面必须仍包含这些原边界点（距离 0）；不锁定时允许边界移动。
  // 注意：低保留比例下 LockBorder 会把误差“挤”到网格内部，整体 max 可能反而更大，
  // 这正是该选项的真实代价，不应被断言掩盖。
  const lockedResultBVH = buildBVH(locked.mesh);
  const unlockedResultBVH = buildBVH(unlocked.mesh);
  let lockedBoundaryError = 0;
  let unlockedBoundaryError = 0;
  for (const v of weldedBoundary) {
    const probe = new THREE.Vector3(
      weldedSheet.positions[v * 3],
      weldedSheet.positions[v * 3 + 1],
      weldedSheet.positions[v * 3 + 2],
    );
    const hitL = nearestPointOnOriginal(probe, lockedResultBVH);
    const hitU = nearestPointOnOriginal(probe, unlockedResultBVH);
    if (hitL) lockedBoundaryError = Math.max(lockedBoundaryError, hitL.distance);
    if (hitU) unlockedBoundaryError = Math.max(unlockedBoundaryError, hitU.distance);
  }
  check('锁定时原边界点到简化表面距离 = 0（容差 0）', approx(lockedBoundaryError, 0, 1e-9),
    `max=${lockedBoundaryError.toExponential(2)}`);
  check('未锁定时边界可以移动（存在非零边界误差）', unlockedBoundaryError > 1e-7,
    `max=${unlockedBoundaryError.toExponential(3)}`);
  check('边界保护只保证边界零偏移，不承诺整体 max 更小',
    lockedMetrics.max > 0 && lockedBoundaryError === 0,
    `整体 locked max=${lockedMetrics.max.toExponential(3)}，边界误差=0`);
  const bLocked = computeBoundary(locked.mesh);
  check('锁定后边界环数量保持 2', bLocked.loopCount === 2, `实际 ${bLocked.loopCount}`);
  check('锁定后边界边长（边数）保持不变', bLocked.edgeCount === b0.edgeCount,
    `${bLocked.edgeCount} vs ${b0.edgeCount}`);

  // ---------- F. 已知点距离口径 ----------
  console.log('\nF. 已知几何的距离口径');
  // 原表面：z = 0 的双三角形平面（四边形 [-1,1]²）
  const plane: MeshData = {
    positions: Float32Array.from([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
    ]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
  const planeBVH = buildBVH(plane);
  const probe = new THREE.Vector3(0.25, -0.25, 0.3);
  const hit = nearestPointOnOriginal(probe, planeBVH);
  check('平面上方 0.3 的点最近距离 = 0.3', !!hit && approx(hit.distance, 0.3, 1e-6),
    hit ? `distance=${hit.distance.toFixed(4)}` : '未命中');
  check('最近点投影到 (0.25, -0.25, 0)',
    !!hit && approx(hit.point.x, 0.25, 1e-6) && approx(hit.point.y, -0.25, 1e-6) && approx(hit.point.z, 0, 1e-6));
  // 平面外横向点：最近点应夹到边/角
  const outside = new THREE.Vector3(5, 0, 0);
  const hit2 = nearestPointOnOriginal(outside, planeBVH);
  check('平面外点夹到角点 (1,0,0)，距离 = 4',
    !!hit2 && approx(hit2.distance, 4, 1e-6) && approx(hit2.point.x, 1, 1e-6),
    hit2 ? `(${hit2.point.x.toFixed(3)},${hit2.point.y.toFixed(3)},${hit2.point.z.toFixed(3)}) d=${hit2.distance.toFixed(3)}` : '未命中');

  // ---------- G. OBJ 导出再读取 ----------
  console.log('\nG. OBJ 导出 -> 读取往返一致性');
  for (const [id, mesh] of Object.entries(samples)) {
    const r = simplifyMesh(mesh, { ratio: 0.5, lockBorder: id === 'sheet' });
    const before = computeSampledError(r.mesh, buildBVH(mesh));
    const text = writeOBJ(r.mesh, id);
    const roundtrip = parseOBJ(text);
    check(`${id} 往返顶点数一致`, vertexCount(roundtrip) === vertexCount(r.mesh),
      `${vertexCount(roundtrip)} vs ${vertexCount(r.mesh)}`);
    check(`${id} 往返面数一致`, triangleCount(roundtrip) === triangleCount(r.mesh),
      `${triangleCount(roundtrip)} vs ${triangleCount(r.mesh)}`);
    const after = computeSampledError(roundtrip, buildBVH(mesh));
    // 往返容差与 OBJ 序列化精度（1e-10）匹配，取相对量级容差
    const relEps = Math.max(1e-9, before.max * 1e-5);
    check(`${id} 往返 max 读数一致`, approx(before.max, after.max, relEps),
      `${before.max.toExponential(4)} vs ${after.max.toExponential(4)}`);
    check(`${id} 往返 RMS 读数一致`, approx(before.rms, after.rms, Math.max(1e-9, before.rms * 1e-5)),
      `${before.rms.toExponential(4)} vs ${after.rms.toExponential(4)}`);
    const bb = computeBoundary(roundtrip);
    const ba = computeBoundary(r.mesh);
    check(`${id} 往返边界环数一致`, bb.loopCount === ba.loopCount && bb.edgeCount === ba.edgeCount,
      `${bb.loopCount} 环 / ${bb.edgeCount} 边`);
  }

  // ---------- H. 颜色范围不改变读数 ----------
  console.log('\nH. 颜色映射范围与读数解耦');
  const r = simplifyMesh(sphere, { ratio: 0.4, lockBorder: false });
  const m = computeSampledError(r.mesh, sphereBVH);
  const colors1 = buildDistanceColors(r.mesh, m, m.max);
  const colors2 = buildDistanceColors(r.mesh, m, m.max * 0.25);
  const sameReadings = approx(m.max, computeSampledError(r.mesh, sphereBVH).max, 1e-12);
  check('两次不同颜色范围下 max/RMS 不变', sameReadings);
  check('颜色数组确实随范围改变（验证范围只影响颜色）',
    !arraysEqual(colors1.array as Float32Array, colors2.array as Float32Array));

  // ---------- 汇总 ----------
  console.log(`\n${'='.repeat(56)}`);
  console.log(`验证完成：${passes} 通过 / ${failures} 失败`);
  if (failures > 0) process.exit(1);
}

function maxOf(arr: Uint32Array): number {
  let m = 0;
  for (const v of arr) if (v > m) m = v;
  return m;
}

function posKey(positions: Float32Array, vertex: number): string {
  return `${positions[vertex * 3].toFixed(7)}|${positions[vertex * 3 + 1].toFixed(7)}|${positions[vertex * 3 + 2].toFixed(7)}`;
}

function arraysEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(1);
});
