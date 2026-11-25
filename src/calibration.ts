import type { MarkedLine, Vec2, Vec3 } from './types';

/**
 * 相机模型:主点固定在图像中心,方形像素,零畸变。
 * 图像坐标 x 向右、y 向下;相机坐标 x 右、y 下、z 朝前(右手系)。
 * 世界坐标:Y 向上,X/Z 为地面两个互相垂直方向,地面为 y=0。
 * R 为 3x3 世界->相机旋转(R[i] 为第 i 行,即相机第 i 轴在世界坐标中的表达)。
 */

export interface Calibration {
  ok: boolean;
  issues: string[];
  focal: number;           // px
  vpX: Vec2 | null;
  vpZ: Vec2 | null;
  horizon: { a: number; b: number; c: number } | null; // ax+by+c=0,图像坐标
  R: number[][];           // 3x3,行主序
  cameraHeight: number;    // m
  heightFromRef: boolean;
  fovDeg: number;
  yawDeg: number;
  depressionDeg: number;
  residuals: Map<number, number>; // lineId -> 灭点到该线距离(px)
  rmsX: number;
  rmsZ: number;
  orthoErrDeg: number;     // 两灭点方向夹角与 90° 的偏差
}

const MIN_LINE_LEN = 40;        // px,短于此长度提示
const MIN_GROUP_ANGLE_DEG = 0.4; // 组内最小夹角,小于此值灭点不可信
const FAR_VP_FACTOR = 5;         // 灭点距离超过 5 倍图像对角线提示不稳定

function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function dot2(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }
function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** 线段 -> 归一化齐次直线 (a,b,c),a^2+b^2=1 */
function lineHomog(p1: Vec2, p2: Vec2): Vec3 {
  const a = p1.y - p2.y;
  const b = p2.x - p1.x;
  const c = p1.x * p2.y - p2.x * p1.y;
  const l = Math.hypot(a, b) || 1;
  return [a / l, b / l, c / l];
}

/** 对称 3x3 矩阵最小特征值对应的特征向量 (Jacobi 旋转) */
function smallestEigenvector(M: number[][]): Vec3 {
  const a = M.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep++) {
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { p = 0; q = 2; max = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > max) { p = 1; q = 2; max = Math.abs(a[1][2]); }
    if (max < 1e-14) break;
    const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = c * apk - s * aqk;
      a[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  let mi = 0;
  if (a[1][1] < a[mi][mi]) mi = 1;
  if (a[2][2] < a[mi][mi]) mi = 2;
  return [v[0][mi], v[1][mi], v[2][mi]];
}

interface GroupResult {
  vp: Vec2 | null;      // 有限灭点
  vpFar: boolean;       // 灭点过远(近无穷)
  minAngleDeg: number;  // 组内最小夹角
  count: number;
}

/** 一组平行线的最小二乘灭点 */
function vanishingPoint(lines: MarkedLine[], diag: number): GroupResult {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const ln of lines) {
    const l = lineHomog(ln.p1, ln.p2);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        M[i][j] += l[i] * l[j];
  }
  const v = smallestEigenvector(M);
  // 组内最小夹角
  let minAngle = Infinity;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const d1 = sub(lines[i].p2, lines[i].p1);
      const d2 = sub(lines[j].p2, lines[j].p1);
      const cos = Math.abs(dot2(d1, d2)) / ((Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) || 1);
      const ang = Math.acos(Math.min(1, cos)) * 180 / Math.PI;
      if (ang < minAngle) minAngle = ang;
    }
  }
  if (lines.length < 2) minAngle = 0;
  if (Math.abs(v[2]) < 1e-9) {
    return { vp: null, vpFar: true, minAngleDeg: minAngle, count: lines.length };
  }
  const vp = { x: v[0] / v[2], y: v[1] / v[2] };
  const far = Math.hypot(vp.x, vp.y) > FAR_VP_FACTOR * diag;
  return { vp, vpFar: far, minAngleDeg: minAngle, count: lines.length };
}

export function calibrate(
  lines: MarkedLine[],
  imgW: number,
  imgH: number,
  refLenM: number,
): Calibration {
  const issues: string[] = [];
  const c: Vec2 = { x: imgW / 2, y: imgH / 2 };
  const diag = Math.hypot(imgW, imgH);
  const residuals = new Map<number, number>();

  const result: Calibration = {
    ok: false, issues, focal: 0, vpX: null, vpZ: null, horizon: null,
    R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], cameraHeight: 1.6, heightFromRef: false,
    fovDeg: 0, yawDeg: 0, depressionDeg: 0, residuals,
    rmsX: NaN, rmsZ: NaN, orthoErrDeg: NaN,
  };

  // 线段长度检查
  for (const ln of lines) {
    if (ln.dir === 'REF') continue;
    const len = Math.hypot(ln.p2.x - ln.p1.x, ln.p2.y - ln.p1.y);
    if (len < MIN_LINE_LEN) {
      issues.push(`${ln.dir} 方向:线段 #${ln.id} 太短(${len.toFixed(0)}px < ${MIN_LINE_LEN}px),方向不可靠`);
    }
  }

  const linesX = lines.filter((l) => l.dir === 'X');
  const linesZ = lines.filter((l) => l.dir === 'Z');

  if (linesX.length < 2) issues.push(`X 方向线不足:至少需要 2 条线确定灭点(当前 ${linesX.length} 条)`);
  if (linesZ.length < 2) issues.push(`Z 方向线不足:至少需要 2 条线确定灭点(当前 ${linesZ.length} 条)`);
  if (linesX.length < 2 || linesZ.length < 2) return result;

  const gx = vanishingPoint(linesX, diag);
  const gz = vanishingPoint(linesZ, diag);

  for (const [name, g] of [['X', gx], ['Z', gz]] as const) {
    if (g.count >= 2 && g.minAngleDeg < MIN_GROUP_ANGLE_DEG) {
      issues.push(`${name} 方向:组内线条几乎平行(最小夹角 ${g.minAngleDeg.toFixed(2)}°),灭点交点无法稳定确定`);
    }
    if (g.vpFar) {
      issues.push(`${name} 方向:灭点过远(接近无穷远),该方向接近正视,结果对画线误差非常敏感`);
    }
  }

  if (!gx.vp || !gz.vp) {
    issues.push('灭点在无穷远处,无法在当前模型(主点居中)下求解焦距');
    return result;
  }
  result.vpX = gx.vp;
  result.vpZ = gz.vp;

  // 正交约束:(v1-c)·(v2-c) + f^2 = 0
  const d1 = sub(gx.vp, c);
  const d2 = sub(gz.vp, c);
  const f2 = -dot2(d1, d2);
  if (!(f2 > 1)) {
    issues.push(`两组灭点与"方向互相垂直 + 主点居中"矛盾(f² = ${f2.toFixed(0)} ≤ 0),请检查方向分组或画线位置`);
    return result;
  }
  const f = Math.sqrt(f2);
  result.focal = f;
  result.fovDeg = 2 * Math.atan(imgW / (2 * f)) * 180 / Math.PI;

  // 世界轴在相机坐标中的方向
  const uX = norm3([d1.x, d1.y, f]);
  const uZraw = norm3([d2.x, d2.y, f]);
  const cosAng = dot3(uX, uZraw);
  result.orthoErrDeg = Math.abs(Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180 / Math.PI - 90);
  // 正交化
  const uZ = norm3([
    uZraw[0] - cosAng * uX[0],
    uZraw[1] - cosAng * uX[1],
    uZraw[2] - cosAng * uX[2],
  ]);
  let uXf = uX;
  let uY = cross3(uZ, uXf) as Vec3; // e_Y = e_Z × e_X
  // 地面应出现在地平线下方:若朝向反了,翻转 X 轴符号(轴方向本身无正负)
  const nDotDown = uY[0] * 0 + uY[1] * (imgH / 4) + uY[2] * f;
  if (nDotDown > 0) {
    uXf = [-uX[0], -uX[1], -uX[2]];
    uY = cross3(uZ, uXf) as Vec3;
  }
  // R 的列 = 世界轴在相机坐标中的表达
  result.R = [
    [uXf[0], uY[0], uZ[0]],
    [uXf[1], uY[1], uZ[1]],
    [uXf[2], uY[2], uZ[2]],
  ];

  // 地平线:过两灭点的直线
  const hl = cross3([gx.vp.x, gx.vp.y, 1], [gz.vp.x, gz.vp.y, 1]);
  const hn = Math.hypot(hl[0], hl[1]) || 1;
  result.horizon = { a: hl[0] / hn, b: hl[1] / hn, c: hl[2] / hn };

  // 朝向
  const fwd = result.R[2]; // 相机 z 轴在世界坐标中的方向
  result.yawDeg = Math.atan2(fwd[0], fwd[2]) * 180 / Math.PI;
  result.depressionDeg = Math.asin(Math.max(-1, Math.min(1, -fwd[1]))) * 180 / Math.PI;

  // 残差:每条线到其组灭点的距离
  const rms = (group: MarkedLine[], vp: Vec2): number => {
    let sum = 0;
    for (const ln of group) {
      const l = lineHomog(ln.p1, ln.p2);
      const r = Math.abs(l[0] * vp.x + l[1] * vp.y + l[2]);
      residuals.set(ln.id, r);
      sum += r * r;
    }
    return Math.sqrt(sum / group.length);
  };
  result.rmsX = rms(linesX, gx.vp);
  result.rmsZ = rms(linesZ, gz.vp);

  // 尺度:参考线段已知实际长度 -> 求相机高度
  const refLine = lines.find((l) => l.dir === 'REF');
  if (refLine) {
    const n = uY;
    const ray = (p: Vec2): Vec3 => [p.x - c.x, p.y - c.y, f];
    const ra = ray(refLine.p1);
    const rb = ray(refLine.p2);
    const da = dot3(n, ra);
    const db = dot3(n, rb);
    if (da >= -1e-6 || db >= -1e-6) {
      issues.push('参考线端点位于地平线之上,无法反投影到地面,使用默认高度 1.6m(尺度任意)');
    } else {
      // h=1 时的地面交点
      const Xa = ra.map((v) => v * (-1 / da)) as Vec3;
      const Xb = rb.map((v) => v * (-1 / db)) as Vec3;
      const distAtUnitH = Math.hypot(Xa[0] - Xb[0], Xa[1] - Xb[1], Xa[2] - Xb[2]);
      if (distAtUnitH < 1e-6) {
        issues.push('参考线过短或退化,无法确定尺度,使用默认高度 1.6m');
      } else {
        result.cameraHeight = refLenM / distAtUnitH;
        result.heightFromRef = true;
      }
    }
  } else {
    issues.push('未画参考长度线:使用默认相机高度 1.6m,地面尺度为任意值');
  }

  result.ok = true;
  return result;
}

/** 世界点 -> 图像像素;在相机后方返回 null */
export function projectPoint(
  P: Vec3, cal: Calibration, imgW: number, imgH: number,
): Vec2 | null {
  const { R, focal: f, cameraHeight: h } = cal;
  const dx = P[0], dy = P[1] - h, dz = P[2]; // C = (0, h, 0)
  const xc = R[0][0] * dx + R[0][1] * dy + R[0][2] * dz;
  const yc = R[1][0] * dx + R[1][1] * dy + R[1][2] * dz;
  const zc = R[2][0] * dx + R[2][1] * dy + R[2][2] * dz;
  if (zc <= 1e-6) return null;
  return { x: imgW / 2 + f * xc / zc, y: imgH / 2 + f * yc / zc };
}

/** 图像像素 -> 地面交点(世界 X/Z);射线不落地返回 null */
export function groundPoint(
  p: Vec2, cal: Calibration, imgW: number, imgH: number,
): { x: number; z: number } | null {
  const { R, focal: f, cameraHeight: h } = cal;
  const r: Vec3 = [p.x - imgW / 2, p.y - imgH / 2, f];
  const n: Vec3 = [R[0][1], R[1][1], R[2][1]]; // uY,地面法向(相机坐标)
  const denom = dot3(n, r);
  if (denom >= -1e-9) return null;
  const t = -h / denom;
  const xc: Vec3 = [r[0] * t, r[1] * t, r[2] * t];
  // Xw = C + R^T Xc
  const x = R[0][0] * xc[0] + R[1][0] * xc[1] + R[2][0] * xc[2];
  const z = R[0][2] * xc[0] + R[1][2] * xc[1] + R[2][2] * xc[2];
  return { x, z };
}

/** 参考线两端反投影得到的地面点(用于 3D 视图显示) */
export function refLineGroundPoints(
  refLine: MarkedLine, cal: Calibration, imgW: number, imgH: number,
): { a: { x: number; z: number }; b: { x: number; z: number } } | null {
  const a = groundPoint(refLine.p1, cal, imgW, imgH);
  const b = groundPoint(refLine.p2, cal, imgW, imgH);
  if (!a || !b) return null;
  return { a, b };
}
