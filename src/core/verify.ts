/**
 * 可重复验证：全部为确定性样例与解析预期值，不依赖渲染与随机数。
 * 页面验证面板与 vitest 共用本模块。
 */
import { Vec2 } from './math2d';
import { PolyPath } from './path';
import { planDashes } from './dash';
import { buildStrokeMesh } from './mesh';
import { buildIntervalPolygon } from './stroke';
import { DEFAULT_STROKE, StrokeOptions } from './types';

export interface CheckResult {
  id: string;
  name: string;
  expected: string;
  measured: string;
  pass: boolean;
}

const EPS = 1e-6;
const ok = (cond: boolean): boolean => cond;
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : String(x));

function bboxOf(positions: Float32Array) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
  }
  return { minX, maxX, minY, maxY };
}

/** 1. 直线笔画的宽度与端点范围（三种端帽） */
function checkStraightCaps(): CheckResult {
  const pts: Vec2[] = [{ x: -4, y: 0 }, { x: 4, y: 0 }];
  const w = 1;
  const rows: string[] = [];
  let pass = true;
  const expected: Record<string, [number, number, number, number]> = {
    // [xMin, xMax, yMin, yMax]
    butt: [-4, 4, -0.5, 0.5],
    square: [-4.5, 4.5, -0.5, 0.5],
    round: [-4.5, 4.5, -0.5, 0.5],
  };
  for (const cap of ['butt', 'square', 'round'] as const) {
    const opt: StrokeOptions = { ...DEFAULT_STROKE, width: w, cap };
    const res = buildStrokeMesh(pts, false, opt, { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
    if (!res.mesh) { pass = false; rows.push(`${cap}: 无网格`); continue; }
    const b = bboxOf(res.mesh.positions);
    const e = expected[cap];
    // 平头/方头轮廓是 4 边形 → 2 个三角形；圆头含两段半圆细分，三角形明显更多
    const triOk = cap === 'round' ? res.mesh.triangleCount > 2 : res.mesh.triangleCount === 2;
    const good =
      Math.abs(b.minX - e[0]) < EPS && Math.abs(b.maxX - e[1]) < EPS &&
      Math.abs(b.minY - e[2]) < EPS && Math.abs(b.maxY - e[3]) < EPS &&
      triOk;
    pass = pass && good;
    rows.push(`${cap}: 实测 x[${f3(b.minX)},${f3(b.maxX)}] y[${f3(b.minY)},${f3(b.maxY)}] 三角${res.mesh.triangleCount}`);
  }
  return {
    id: 'caps',
    name: '直线宽度与端帽范围',
    expected: 'butt x∈[-4,4]；square/round x∈[-4.5,4.5]；三种 y∈[-0.5,0.5]；平头/方头 2 个三角形，圆头因圆弧细分 >2',
    measured: rows.join('；'),
    pass,
  };
}

/** 2. 已知折线跨转角的虚线起止位置 */
function checkDashIntervals(): CheckResult {
  // (0,0)->(4,0)->(4,3)：累计长度 0, 4, 7；dash=2 gap=1
  const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }];
  const path = new PolyPath(pts, false);
  const iv = planDashes(path, { dashed: true, dashLength: 2, gapLength: 1, offset: 0 });
  const measuredU = iv.map((d) => `[${f3(d.u0)},${f3(d.u1)}]`).join(',');
  // 弧长节奏 [0,2],[3,5],[6,8]...，夹到定义域 [0,7] → [0,2],[3,5],[6,7]；
  // 区间 [3,5] 跨过转角 u=4，不重新起算。
  const expectExact = ['[0.000,2.000]', '[3.000,5.000]', '[6.000,7.000]'].join(',');
  const res = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1 }, {
    dashed: true, dashLength: 2, gapLength: 1, offset: 0,
  });
  const joinAtVertex = res.mesh?.joins.some((j) => Math.abs(j.u - 4) < 1e-9) ?? false;
  const pass = measuredU === expectExact && joinAtVertex && (res.mesh?.intervalCount ?? 0) === 3;
  return {
    id: 'dash-interval',
    name: '虚线起止与跨顶点连续性',
    expected: `${expectExact}（累计弧长节奏，非每段重置）；区间 [3,5] 内含 u=4 转角`,
    measured: `${measuredU}；跨转角连接=${joinAtVertex}；区间数=${res.mesh?.intervalCount ?? 0}`,
    pass: ok(pass),
  };
}

/** 3. 尖角限制触发与限制前后差异 */
function checkMiterLimit(): CheckResult {
  // 尖角 V 形（与界面“尖角折线”样例同构，缩小比例）：
  // (-4,2)->(1,0)->(-4,-2)。两段切向偏转 |δ|≈136.4°，外角 θ≈43.6°，
  // 标准 Canvas miter：ratio = 1/sin(θ/2) ≈ 2.70（小夹角 → 长刺）。
  const pts: Vec2[] = [{ x: -4, y: 2 }, { x: 1, y: 0 }, { x: -4, y: -2 }];
  const P: Vec2 = { x: 1, y: 0 };
  const width = 1;
  // 外角 θ：由两段单位切向的点积求 |δ|，θ = π - |δ|
  const t0norm = Math.hypot(5, -2);
  const t1norm = Math.hypot(-5, -2);
  const dotT = (5 * -5 + -2 * -2) / (t0norm * t1norm);
  const absDelta = Math.acos(Math.max(-1, Math.min(1, dotT)));
  const theta = Math.PI - absDelta;
  // Canvas/SVG 标准：miterRatio = 1/sin(θ/2)；miterLen（尖点到 P）= width·ratio/2
  const ratioExpected = 1 / Math.sin(theta / 2);
  // 尖点方向：外角平分方向（指向 V 的开口侧，即 +x）
  const spikeDir: Vec2 = { x: 1, y: 0 };
  const miterLenExpected = (ratioExpected * width) / 2; // 尖点到 P 的距离

  /** 轮廓点在尖角方向（+x）上相对 P 的最大投影 */
  const spikeProjection = (positions: Float32Array): number => {
    let m = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const q = { x: positions[i], y: positions[i + 1] };
      m = Math.max(m, (q.x - P.x) * spikeDir.x + (q.y - P.y) * spikeDir.y);
    }
    return m;
  };
  const build = (lim: number) =>
    buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width, join: 'miter', miterLimit: lim, cap: 'butt' },
      { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
  const bevel = build(1.5);  // ratio≈2.70 > 1.5 → 削平
  const miter = build(4);    // ratio≈2.70 < 4 → 保留尖角
  const projBevel = bevel.mesh ? spikeProjection(bevel.mesh.positions) : NaN;
  const projMiter = miter.mesh ? spikeProjection(miter.mesh.positions) : NaN;
  const effBevel = bevel.mesh?.joins[0]?.effective;
  const effMiter = miter.mesh?.joins[0]?.effective;
  const ratioMeasured = miter.mesh?.joins[0]?.miterRatio ?? NaN;

  // 连续扫过限制边界：所有结果有限、无 NaN、无飞点；尖点投影不超过解析 miterLength
  let sweepOk = true;
  let maxObserved = 0;
  for (let lim = 0.5; lim <= 4.0001; lim += 0.1) {
    const res = build(lim);
    if (!res.mesh) { sweepOk = false; break; }
    for (const x of res.mesh.positions) if (!Number.isFinite(x)) sweepOk = false;
    maxObserved = Math.max(maxObserved, spikeProjection(res.mesh.positions));
  }
  const pass =
    effBevel === 'bevel' && effMiter === 'miter' &&
    Math.abs(projMiter - miterLenExpected) < 1e-6 &&
    projBevel < projMiter - 0.5 && // 削平后尖点方向明显缩短（无长刺）
    Math.abs(ratioMeasured - ratioExpected) < 1e-6 &&
    sweepOk && maxObserved <= miterLenExpected + 1e-6;
  return {
    id: 'miter',
    name: '尖角限制触发',
    expected: `外角θ=${(theta * 180 / Math.PI).toFixed(1)}°，ratio=1/sin(θ/2)=${f3(ratioExpected)}；limit=1.5→bevel 无长刺；limit=4→miter 尖点投影=${f3(miterLenExpected)}；扫描无飞点`,
    measured: `limit1.5: ${effBevel} 投影 ${f3(projBevel)}；limit4: ${effMiter} 投影 ${f3(projMiter)}，ratio=${f3(ratioMeasured)}；扫描最大投影 ${f3(maxObserved)}`,
    pass: ok(pass),
  };
}

/** 4. 闭合路径接缝：按普通转角连接，无端帽，虚线节奏跨接缝连续 */
function checkClosedSeam(): CheckResult {
  // 矩形周长 20
  const pts: Vec2[] = [{ x: -3, y: -2 }, { x: 3, y: -2 }, { x: 3, y: 2 }, { x: -3, y: 2 }];
  const path = new PolyPath(pts, true);
  const solid = buildStrokeMesh(pts, true, { ...DEFAULT_STROKE, width: 1 },
    { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
  const solidOk =
    (solid.mesh?.intervalCount ?? 0) === 1 &&
    (solid.mesh?.joins.length ?? 0) === 4 &&
    (solid.mesh?.polygons[0].length ?? 0) === 8; // 每角一个交点，共 8 个轮廓点，无端帽点

  // 虚线 offset=0.5：第一段 [-0.5,1.5] 跨接缝；回绕采样一致性
  const iv = planDashes(path, { dashed: true, dashLength: 2, gapLength: 1, offset: 0.5 });
  const first = iv[0];
  const wrapA = path.sampleAt(first.u0).point;
  const wrapB = path.sampleAt(path.totalLength + first.u0).point;
  const wrapOk = Math.abs(wrapA.x - wrapB.x) < EPS && Math.abs(wrapA.y - wrapB.y) < EPS;
  const expectedFirst = 'u0=-0.500,u1=1.500';
  const pass = solidOk && wrapOk && Math.abs(first.u0 + 0.5) < EPS && Math.abs(first.u1 - 1.5) < EPS;
  return {
    id: 'seam',
    name: '闭合接缝连接与虚线节奏',
    expected: `实线：1 个整圈区间、4 个转角、轮廓 8 点无端帽；虚线 ${expectedFirst} 且负参数回绕采样一致`,
    measured: `区间=${solid.mesh?.intervalCount} 转角=${solid.mesh?.joins.length} 轮廓点=${solid.mesh?.polygons[0]?.length}；首段 u0=${f3(first.u0)},u1=${f3(first.u1)} 回绕一致=${wrapOk}`,
    pass: ok(pass),
  };
}

/** 5. 斜直线宽度与方向无关（法向投影宽度） */
function checkSlantedWidth(): CheckResult {
  const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 3, y: 4 }];
  const res = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1, cap: 'butt' },
    { dashed: false, dashLength: 1, gapLength: 1, offset: 0 });
  const n: Vec2 = { x: -4 / 5, y: 3 / 5 }; // 单位法向
  let min = Infinity, max = -Infinity;
  if (res.mesh) {
    for (let i = 0; i < res.mesh.positions.length; i += 3) {
      const p = n.x * res.mesh.positions[i] + n.y * res.mesh.positions[i + 1];
      min = Math.min(min, p); max = Math.max(max, p);
    }
  }
  const w = max - min;
  return {
    id: 'slanted-width',
    name: '斜直线法向宽度',
    expected: '法向投影宽度 1.000（与方向无关）',
    measured: `实测 ${f3(w)}`,
    pass: ok(Math.abs(w - 1) < EPS),
  };
}

/** 6. 连续重复点不产生错误网格 */
function checkDuplicatePoints(): CheckResult {
  const pts: Vec2[] = [
    { x: -4, y: 1 }, { x: -4, y: 1 }, { x: -1, y: 1 },
    { x: -1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -2 },
    { x: 3, y: -2 }, { x: 3, y: -2 },
  ];
  const res = buildStrokeMesh(pts, false, { ...DEFAULT_STROKE, width: 1, cap: 'round', join: 'round' },
    { dashed: true, dashLength: 1.5, gapLength: 0.8, offset: 0.3 });
  let finite = true;
  if (res.mesh) for (const x of res.mesh.positions) if (!Number.isFinite(x)) finite = false;
  const path = new PolyPath(pts, false);
  const pass = finite && path.points.length === 4 && (res.mesh?.triangleCount ?? 0) > 0;
  return {
    id: 'duplicates',
    name: '连续重复点健壮性',
    expected: '去重后 4 个顶点；网格全部有限且三角形数 > 0',
    measured: `去重后 ${path.points.length} 顶点；三角形=${res.mesh?.triangleCount ?? 0}；有限=${finite}`,
    pass: ok(pass),
  };
}

/** 7. 圆头端帽几何：帽顶沿切向恰好延伸 r，且为真实圆弧点而非缺口 */
function checkRoundCap(): CheckResult {
  const pts: Vec2[] = [{ x: -4, y: 0 }, { x: 4, y: 0 }];
  const opt: StrokeOptions = { ...DEFAULT_STROKE, width: 1, cap: 'round' };
  const path = new PolyPath(pts, false);
  const { polygon } = buildIntervalPolygon(path, 0, path.totalLength, opt, false);
  // 找最靠右的点，应在 (4.5, 0) 附近；同时检查半圆上 90° 位置的点 (4, 0.5) 存在
  let tip: Vec2 | null = null;
  for (const p of polygon) if (!tip || p.x > tip.x) tip = p;
  const hasShoulder = polygon.some((p) => Math.abs(p.x - 4) < 1e-6 && Math.abs(p.y - 0.5) < 1e-6);
  const pass = !!tip && Math.abs(tip.x - 4.5) < 1e-6 && Math.abs(tip.y) < 1e-6 && hasShoulder;
  return {
    id: 'round-cap',
    name: '圆头端帽延伸与完整圆弧',
    expected: '帽顶 (4.500,0.000)，肩部点 (4.000,0.500) 存在（无缺口）',
    measured: `帽顶 (${f3(tip?.x ?? NaN)},${f3(tip?.y ?? NaN)})，肩部=${hasShoulder}，轮廓点=${polygon.length}`,
    pass: ok(pass),
  };
}

export function runAllChecks(): CheckResult[] {
  return [
    checkStraightCaps(),
    checkDashIntervals(),
    checkMiterLimit(),
    checkClosedSeam(),
    checkSlantedWidth(),
    checkDuplicatePoints(),
    checkRoundCap(),
  ];
}
