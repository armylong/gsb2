/**
 * 笔画轮廓生成：把一个弧长区间 [u0, u1] 沿折线展开为单一闭合多边形，
 * 再交给 earcut 三角化。端帽、转角、尖角限制全部在此处理。
 *
 * 约定（界面与 README 中同样说明）：
 * miterLimit = 外尖角顶点到中心线转角点的距离 / 笔画宽度 width。
 * 理论值 miterLength = (width/2) / sin(δ/2)，δ 为两切向夹角（0~π）。
 */
import {
  Vec2,
  add,
  angleOf,
  arcAngles,
  cross,
  distance,
  leftNormal,
  rayIntersect,
  scale,
  sub,
  wrapAngle,
} from './math2d';
import { PolyPath } from './path';
import { StrokeOptions } from './types';

export interface PolygonResult {
  /** 闭合多边形顶点（首尾不重复） */
  polygon: Vec2[];
  /** 本区间实际触发的转角信息，用于界面/验证 */
  joins: JoinInfo[];
}

export interface JoinInfo {
  vertexIndex: number;
  u: number;
  /** 转角偏转角（弧度，绝对值） */
  deflection: number;
  /** 实际采用的连接方式（miter 超限后可能变为 bevel） */
  effective: 'miter' | 'bevel' | 'round';
  /** 尖角延伸比 miterLength / width */
  miterRatio: number;
}

const EPS = 1e-9;

/** 求单侧偏移线交点：过 P 沿法向 n 偏移 r 的两条直线（方向 t0、t1） */
function offsetIntersect(P: Vec2, n0: Vec2, n1: Vec2, t0: Vec2, t1: Vec2, r: number): Vec2 | null {
  const A = add(P, scale(n0, r));
  const B = add(P, scale(n1, r));
  const hit = rayIntersect(A, t0, B, t1);
  if (!hit) return null;
  if (!Number.isFinite(hit.t) || Math.abs(hit.t) > 1e6) return null;
  return add(A, scale(t0, hit.t));
}

function arcPoints(center: Vec2, r: number, a0: number, a1: number, dir: 1 | -1, seg: number): Vec2[] {
  return arcAngles(a0, a1, dir, Math.max(1, seg)).map((a) => ({
    x: center.x + r * Math.cos(a),
    y: center.y + r * Math.sin(a),
  }));
}

/** 去掉与数组末点重合的点 */
function pushDedup(arr: Vec2[], p: Vec2): void {
  const last = arr[arr.length - 1];
  if (!last || distance(last, p) > 1e-10) arr.push(p);
}

/**
 * 为一个弧长区间生成笔画多边形。
 * @param fullLoop 闭合路径且该区间覆盖整圈时为 true：不生成端帽，接缝按普通转角。
 */
export function buildIntervalPolygon(
  path: PolyPath,
  u0: number,
  u1: number,
  opt: StrokeOptions,
  fullLoop: boolean,
): PolygonResult {
  const r = opt.width / 2;
  const chainL: Vec2[] = [];
  const chainR: Vec2[] = [];
  const capEnd: Vec2[] = [];
  const capStart: Vec2[] = [];
  const joins: JoinInfo[] = [];

  const s0 = path.sampleAt(u0);
  const s1 = path.sampleAt(u1);

  // ---- 起点截面（整圈闭合时不生成：接缝由转角交点链自然闭合） ----
  const startExtend = opt.cap === 'square' && !fullLoop ? r : 0;
  const cStart = sub(s0.point, scale(s0.tangent, startExtend));
  const nL0 = leftNormal(s0.tangent);
  const LStart = add(cStart, scale(nL0, r));
  const RStart = sub(cStart, scale(nL0, r));
  if (!fullLoop) {
    chainL.push(LStart);
    chainR.push(RStart);
  }

  // ---- 内部转角 ----
  const verts = path.interiorVertices(u0, u1);
  for (const ev of verts) {
    const tg = path.vertexTangents(ev.index);
    if (!tg) continue;
    const { inT: t0, outT: t1 } = tg;
    const P = path.sampleAt(ev.u).point;
    const n0 = leftNormal(t0);
    const n1 = leftNormal(t1);
    const delta = wrapAngle(Math.atan2(cross(t0, t1), t0.x * t1.x + t0.y * t1.y));
    const absDelta = Math.abs(delta);

    // 共线：两侧偏移点重合，直接延续
    if (absDelta < 1e-6) {
      pushDedup(chainL, add(P, scale(n1, r)));
      pushDedup(chainR, sub(P, scale(n1, r)));
      joins.push({ vertexIndex: ev.index, u: ev.u, deflection: absDelta, effective: opt.join, miterRatio: 0 });
      continue;
    }

    const mL = offsetIntersect(P, n0, n1, t0, t1, r); // 左侧偏移线交点
    const mR = offsetIntersect(P, scale(n0, -1), scale(n1, -1), t0, t1, r); // 右侧
    const Lo0 = add(P, scale(n0, r));
    const Lo1 = add(P, scale(n1, r));
    const Ro0 = sub(P, scale(n0, r));
    const Ro1 = sub(P, scale(n1, r));

    const outerIsLeft = delta > 0; // 左转：内侧在左，外侧在右
    const outerMiter = outerIsLeft ? mR : mL;
    const innerMiter = outerIsLeft ? mL : mR;
    const miterLen = outerMiter ? distance(P, outerMiter) : Infinity;
    // Canvas/SVG 标准 miterLimit：外角 θ = π - |δ|，
    // miterRatio = miterLength / width = 1 / sin(θ/2) = 1 / cos(δ/2)。
    // 注意 miterLen（尖点到中心线转角点的距离）= r/sin(θ/2)，除以 width=2r 后再乘 2。
    // 直角时 ratio = √2 ≈ 1.414；切向越接近折返，ratio 越大，越容易触发削平。
    const cosHalf = Math.cos(absDelta / 2);
    const analyticRatio = cosHalf > EPS ? 1 / cosHalf : Infinity;
    const ratio = Number.isFinite(miterLen) ? (2 * miterLen) / opt.width : analyticRatio;
    const miterAllowed = opt.join === 'miter' && ratio <= opt.miterLimit && Number.isFinite(miterLen);

    let effective: JoinInfo['effective'];
    if (opt.join === 'round') effective = 'round';
    else if (opt.join === 'miter' && miterAllowed) effective = 'miter';
    else effective = 'bevel';

    if (effective === 'miter' && mL && mR) {
      pushDedup(chainL, mL);
      pushDedup(chainR, mR);
    } else if (effective === 'round') {
      const seg = Math.max(4, Math.ceil((absDelta / Math.PI) * opt.arcSegments));
      if (outerIsLeft) {
        // 外侧=右：右侧走圆弧，左侧用内交点
        if (innerMiter) pushDedup(chainL, innerMiter);
        else pushDedup(chainL, Lo1);
        const a0 = angleOf(Ro0, P);
        const a1 = angleOf(Ro1, P);
        for (const ap of arcPoints(P, r, a0, a1, 1, seg).slice(1)) pushDedup(chainR, ap);
      } else {
        if (innerMiter) pushDedup(chainR, innerMiter);
        else pushDedup(chainR, Ro1);
        const a0 = angleOf(Lo0, P);
        const a1 = angleOf(Lo1, P);
        for (const ap of arcPoints(P, r, a0, a1, -1, seg).slice(1)) pushDedup(chainL, ap);
      }
    } else {
      // bevel：内侧用交点（没有交点时退化为弦），外侧用弦
      if (outerIsLeft) {
        if (innerMiter) pushDedup(chainL, innerMiter);
        else {
          pushDedup(chainL, Lo0);
          pushDedup(chainL, Lo1);
        }
        pushDedup(chainR, Ro0);
        pushDedup(chainR, Ro1);
      } else {
        if (innerMiter) pushDedup(chainR, innerMiter);
        else {
          pushDedup(chainR, Ro0);
          pushDedup(chainR, Ro1);
        }
        pushDedup(chainL, Lo0);
        pushDedup(chainL, Lo1);
      }
    }

    joins.push({
      vertexIndex: ev.index,
      u: ev.u,
      deflection: absDelta,
      effective,
      miterRatio: Number.isFinite(ratio) ? ratio : Infinity,
    });
  }

  // ---- 终点截面（整圈闭合时不生成） ----
  const endExtend = opt.cap === 'square' && !fullLoop ? r : 0;
  const cEnd = add(s1.point, scale(s1.tangent, endExtend));
  const nL1 = leftNormal(s1.tangent);
  const LEnd = add(cEnd, scale(nL1, r));
  const REnd = sub(cEnd, scale(nL1, r));
  if (!fullLoop) {
    pushDedup(chainL, LEnd);
    pushDedup(chainR, REnd);
  }

  // ---- 端帽圆弧（不含端点，端点已在两条链上） ----
  if (!fullLoop && opt.cap === 'round') {
    const seg = Math.max(6, Math.ceil(opt.arcSegments));
    // 终点帽：L -> R 经前方（切向方向）
    const aL1 = angleOf(LEnd, cEnd);
    const aR1 = angleOf(REnd, cEnd);
    capEnd.push(...arcPoints(cEnd, r, aL1, aR1, -1, seg).slice(1, -1));
    // 起点帽：R -> L 经后方
    const aR0 = angleOf(RStart, cStart);
    const aL0 = angleOf(LStart, cStart);
    capStart.push(...arcPoints(cStart, r, aR0, aL0, -1, seg).slice(1, -1));
  }

  // ---- 拼装闭合环：左链向前 + 终点帽 + 右链反向 + 起点帽 ----
  let polygon: Vec2[];
  if (fullLoop) {
    // 每个转角在左、右链各产生一个偏移交点，接缝转角也不例外：
    // 两条链各含 n 个点且互不重合（接缝的左/右分量是两个不同点），
    // 朴素拼接左链 + 反向右链即得 2n 点的闭合环，无端帽、无重复。
    polygon = [...chainL, ...chainR.slice().reverse()];
  } else {
    polygon = [...chainL, ...capEnd, ...chainR.slice().reverse(), ...capStart];
  }

  // 相邻重复点（含闭合环首尾）防御性去重：处理连续重复顶点与零长度区间。
  const cleaned: Vec2[] = [];
  for (const p of polygon) {
    if (cleaned.length === 0 || distance(cleaned[cleaned.length - 1], p) > 1e-10) cleaned.push(p);
  }
  if (cleaned.length >= 2 && distance(cleaned[0], cleaned[cleaned.length - 1]) <= 1e-10) cleaned.pop();

  return { polygon: cleaned, joins };
}
