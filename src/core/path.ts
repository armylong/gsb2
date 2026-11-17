/**
 * 折线路径：对顶点做去重并建立弧长参数化。
 * 所有采样都以“沿中心线累计长度 u”为坐标，虚线因此天然跨顶点连续。
 */
import { Vec2, distance, lerp, normalize, sub } from './math2d';

export interface PathSample {
  point: Vec2;
  /** 单位切向量（沿 u 增大方向） */
  tangent: Vec2;
}

export class PolyPath {
  /** 去重后的有效顶点 */
  readonly points: Vec2[];
  readonly closed: boolean;
  /** 每个有效顶点对应的累计弧长，长度与 points 相同；points[0] 处为 0 */
  readonly cum: number[];
  readonly totalLength: number;

  constructor(rawPoints: Vec2[], closed: boolean, eps = 1e-9) {
    const pts: Vec2[] = [];
    for (const p of rawPoints) {
      if (pts.length === 0 || distance(pts[pts.length - 1], p) > eps) pts.push(p);
    }
    // 闭合路径首尾相同点也要去掉
    if (closed && pts.length > 1 && distance(pts[0], pts[pts.length - 1]) <= eps) {
      pts.pop();
    }
    this.points = pts;
    this.closed = closed;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance(pts[i - 1], pts[i]));
    if (closed && pts.length > 1) {
      cum[cum.length - 1] = 0; // 占位，下面重新计算
      let total = 0;
      for (let i = 0; i < pts.length; i++) {
        cum[i] = total;
        total += distance(pts[i], pts[(i + 1) % pts.length]);
      }
      this.totalLength = total;
    } else {
      this.totalLength = cum[cum.length - 1] ?? 0;
    }
    this.cum = cum;
  }

  get isValid(): boolean {
    if (this.points.length < 2) return false;
    return this.totalLength > 1e-9;
  }

  /** 把任意 u 规范到闭合路径的 [0, totalLength) */
  private wrapU(u: number): number {
    if (!this.closed) return u;
    const T = this.totalLength;
    let r = u % T;
    if (r < 0) r += T;
    return r;
  }

  /**
   * 定位 u 所在线段。
   * 返回 [线段起点索引 i, 段内局部参数 s]，段为 points[i] -> points[next(i)]。
   * 开放路径 u == totalLength 时落在最后一段末端。
   */
  private locate(u: number): { i: number; s: number } {
    const n = this.points.length;
    if (this.closed) {
      const uu = this.wrapU(u);
      // 二分查找最后一个 cum[i] <= uu 的点
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.cum[mid] <= uu + 1e-12) lo = mid;
        else hi = mid - 1;
      }
      const i = lo;
      const segLen = this.cum[(i + 1) % n === 0 ? 0 : i + 1] !== undefined
        ? ((i + 1) % n === 0 ? this.totalLength : this.cum[i + 1]) - this.cum[i]
        : 0;
      const s = segLen > 1e-12 ? (uu - this.cum[i]) / segLen : 0;
      return { i, s: Math.min(1, Math.max(0, s)) };
    }
    const clamped = Math.min(Math.max(u, 0), this.totalLength);
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= clamped + 1e-12) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const segLen = this.cum[i + 1] - this.cum[i];
    const s = segLen > 1e-12 ? (clamped - this.cum[i]) / segLen : 0;
    return { i, s: Math.min(1, Math.max(0, s)) };
  }

  /** 顶点 i 的出射切向（沿 u 增大方向） */
  private outgoingTangent(i: number): Vec2 {
    const n = this.points.length;
    const next = this.closed ? (i + 1) % n : i + 1;
    return normalize(sub(this.points[next], this.points[i]));
  }

  /** 顶点 i 的入射切向（沿 u 增大方向到达该点的方向） */
  private incomingTangent(i: number): Vec2 {
    const n = this.points.length;
    const prev = this.closed ? (i - 1 + n) % n : i - 1;
    return normalize(sub(this.points[i], this.points[prev]));
  }

  /** 采样：开放路径 u 会被夹在 [0, totalLength]，闭合路径按周期回绕 */
  sampleAt(u: number): PathSample {
    const { i, s } = this.locate(u);
    const n = this.points.length;
    const next = this.closed ? (i + 1) % n : i + 1;
    const a = this.points[i];
    const b = this.points[next];
    return { point: lerp(a, b, s), tangent: normalize(sub(b, a)) };
  }

  /** 顶点处的入射/出射切向；非转角点（开放路径端点）返回 null */
  vertexTangents(i: number): { inT: Vec2; outT: Vec2 } | null {
    const n = this.points.length;
    if (!this.closed && (i === 0 || i === n - 1)) return null;
    return { inT: this.incomingTangent(i), outT: this.outgoingTangent(i) };
  }

  /**
   * 枚举落在 (u0, u1) 内部的路径顶点（转角事件）。
   * 闭合路径回绕区间同样处理；接缝顶点按普通顶点返回（i=0，u≈0/T）。
   */
  interiorVertices(u0: number, u1: number): { index: number; u: number }[] {
    const out: { index: number; u: number }[] = [];
    const n = this.points.length;
    if (this.closed) {
      const T = this.totalLength;
      for (let i = 0; i < n; i++) {
        let uu = this.cum[i];
        // 把顶点参数平移到 (u0, u0+T] 这个周期窗口内：
        // 接缝顶点（u=0）会被平移到 T，作为普通转角而不是被排除。
        while (uu <= u0 + 1e-10) uu += T;
        while (uu > u0 + T + 1e-10) uu -= T;
        if (uu > u0 + 1e-10 && uu <= u1 + 1e-10) out.push({ index: i, u: uu });
      }
    } else {
      for (let i = 1; i < n - 1; i++) {
        if (this.cum[i] > u0 + 1e-10 && this.cum[i] < u1 - 1e-10) {
          out.push({ index: i, u: this.cum[i] });
        }
      }
    }
    return out.sort((a, b) => a.u - b.u);
  }
}
