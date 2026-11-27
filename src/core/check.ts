// 可本地运行的检查：用「匀速直线」和「刚体旋转圆」这两个解析路径已知的场，
// 量化流线积分的偏离程度与停止位置是否正确。浏览器与 Node 共用本模块。
import { Vec2, TraceResult, dist, len } from './types.js';
import { createField, FieldId, WORLD, CYL, VORTEX_CORE_R } from './fields.js';
import { traceStreamline } from './integrator.js';

export interface CheckResult {
  fieldId: string;
  label: string;
  seed: Vec2;
  closed: boolean;
  pointCount: number;
  forwardReason: string;
  backwardReason: string;
  /** 每个折线点到解析路径的垂直距离（场景单位），仅解析场有值 */
  deviations: number[];
  maxDeviation: number;
  meanDeviation: number;
  /** 停止点与期望停止位置的距离（场景单位） */
  stopError: number;
  expected: string;
  pass: boolean;
  tolerance: number;
}

export interface CheckReport {
  generatedAt: string;
  arcStepNote: string;
  results: CheckResult[];
  allPass: boolean;
}

function stats(nums: number[]): { max: number; mean: number } {
  if (nums.length === 0) return { max: 0, mean: 0 };
  let max = 0;
  let sum = 0;
  for (const n of nums) {
    if (n > max) max = n;
    sum += n;
  }
  return { max, mean: sum / nums.length };
}

/** 点到水平线 y=y0 的垂直距离 */
function distToHorizontalLine(p: Vec2, y0: number): number {
  return Math.abs(p.y - y0);
}

/** 点到圆心在原点、半径 r 的圆的径向偏差 */
function distToCircle(p: Vec2, r: number): number {
  return Math.abs(Math.hypot(p.x, p.y) - r);
}

const DEV_TOLERANCE = 1.2; // 场景单位，约 0.3 个积分步长
const STOP_TOLERANCE = 5; // 停止位置容差（一个步长多一点）

export function runChecks(): CheckReport {
  const results: CheckResult[] = [];

  // ---- 1. 匀速直线：解析路径 y = seed.y ----
  {
    const field = createField('uniform');
    const seed = { x: -300, y: 120 };
    const t = traceStreamline(field, seed);
    const deviations = t.points.map((p) => distToHorizontalLine(p, seed.y));
    const st = stats(deviations);
    const fwdErr = Math.abs(t.forward.point.x - WORLD.xmax);
    const backErr = Math.abs(t.backward.point.x - WORLD.xmin);
    const stopError = Math.max(fwdErr, backErr);
    const pass =
      st.max <= DEV_TOLERANCE &&
      stopError <= STOP_TOLERANCE &&
      t.forward.reason === 'boundary' &&
      t.backward.reason === 'boundary';
    results.push({
      fieldId: 'uniform',
      label: '匀速直线',
      seed,
      closed: t.closed,
      pointCount: t.points.length,
      forwardReason: t.forward.reason,
      backwardReason: t.backward.reason,
      deviations,
      maxDeviation: st.max,
      meanDeviation: st.mean,
      stopError,
      expected: `水平线 y=${seed.y}，两端均停在场景左右边界`,
      pass,
      tolerance: DEV_TOLERANCE
    });
  }

  // ---- 2. 刚体旋转：解析路径为以原点为心、R=|seed| 的圆，应闭合 ----
  {
    const field = createField('rigid');
    const seed = { x: 220, y: 0 };
    const R = Math.hypot(seed.x, seed.y);
    const t = traceStreamline(field, seed);
    const deviations = t.points.map((p) => distToCircle(p, R));
    const st = stats(deviations);
    // 闭合时两端都应回到半径 R 的圆上（即起点附近）
    const stopError = Math.max(distToCircle(t.forward.point, R), distToCircle(t.backward.point, R));
    const pass =
      t.closed &&
      st.max <= DEV_TOLERANCE &&
      stopError <= STOP_TOLERANCE &&
      (t.forward.reason === 'closed' || t.backward.reason === 'closed');
    results.push({
      fieldId: 'rigid',
      label: '刚体旋转圆',
      seed,
      closed: t.closed,
      pointCount: t.points.length,
      forwardReason: t.forward.reason,
      backwardReason: t.backward.reason,
      deviations,
      maxDeviation: st.max,
      meanDeviation: st.mean,
      stopError,
      expected: `半径 R=${R} 的正圆，绕回起点附近闭合`,
      pass,
      tolerance: DEV_TOLERANCE
    });
  }

  // ---- 3. 绕静止圆区：顺流端必须停在圆柱表面，且全程不进入圆内 ----
  {
    const field = createField('cylinder');
    const seed = { x: -380, y: 160 };
    const t = traceStreamline(field, seed);
    const penetration = Math.max(
      0,
      ...t.points.map((p) => CYL.r - Math.hypot(p.x - CYL.x, p.y - CYL.y))
    );
    // 该起点高度 > 圆柱半径，流线从左到右绕过后出右边界
    const stopError = Math.abs(t.forward.point.x - WORLD.xmax);
    const pass =
      penetration <= 1e-6 &&
      t.backward.reason === 'boundary' &&
      (t.forward.reason === 'boundary' || t.forward.reason === 'zone') &&
      stopError <= STOP_TOLERANCE;
    results.push({
      fieldId: 'cylinder',
      label: '绕静止圆区',
      seed,
      closed: t.closed,
      pointCount: t.points.length,
      forwardReason: t.forward.reason,
      backwardReason: t.backward.reason,
      deviations: [],
      maxDeviation: 0,
      meanDeviation: 0,
      stopError,
      expected: `不进入 r=${CYL.r} 静止圆，逆流端停左边界，顺流端停右边界或圆面`,
      pass,
      tolerance: 0
    });
  }

  // ---- 4. 螺旋涡：顺流应收敛到涡核表面并以 zone 原因停止 ----
  {
    const field = createField('vortex');
    const seed = { x: 260, y: 60 };
    const t = traceStreamline(field, seed);
    const endR = Math.hypot(t.forward.point.x, t.forward.point.y);
    const stopError = Math.abs(endR - VORTEX_CORE_R);
    const pass = t.forward.reason === 'zone' && stopError <= STOP_TOLERANCE;
    results.push({
      fieldId: 'vortex',
      label: '螺旋涡收敛',
      seed,
      closed: t.closed,
      pointCount: t.points.length,
      forwardReason: t.forward.reason,
      backwardReason: t.backward.reason,
      deviations: [],
      maxDeviation: 0,
      meanDeviation: 0,
      stopError,
      expected: `顺流端停在涡核 r=${VORTEX_CORE_R} 表面，原因为进入静止区`,
      pass,
      tolerance: STOP_TOLERANCE
    });
  }

  // ---- 5. 两侧汇入：逆流端向外到边界，顺流端进入中心停滞盘 ----
  {
    const field = createField('converge');
    const seed = { x: -320, y: 40 };
    const t = traceStreamline(field, seed);
    const endR = Math.hypot(t.forward.point.x, t.forward.point.y);
    const stopError = Math.abs(endR - 10);
    const pass = t.forward.reason === 'zone' && stopError <= STOP_TOLERANCE;
    results.push({
      fieldId: 'converge',
      label: '两侧汇入',
      seed,
      closed: t.closed,
      pointCount: t.points.length,
      forwardReason: t.forward.reason,
      backwardReason: t.backward.reason,
      deviations: [],
      maxDeviation: 0,
      meanDeviation: 0,
      stopError,
      expected: '顺流端停在中心停滞盘 r=10 表面',
      pass,
      tolerance: STOP_TOLERANCE
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    arcStepNote: 'RK4 固定弧长步长 4 场景单位，按单位速度方向积分',
    results,
    allPass: results.every((r) => r.pass)
  };
}

/** 浏览器侧也用得到的单场追踪包装 */
export function traceForField(id: FieldId, seed: Vec2): TraceResult {
  return traceStreamline(createField(id), seed);
}

export { len };
