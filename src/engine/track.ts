/**
 * 程序生成的跑道：顺时针圆角矩形中心线（封闭参数曲线，fraction∈[0,1)）。
 * 闸门建在四条直道的中点，闸门线段沿跑道宽度方向布置，
 * 正方向 = 该位置的跑道切线（顺时针）。
 */
import { Vec2, v, add, sub, scale, normalize, lerp, len } from './geometry';

export interface Gate {
  index: number;
  /** 闸门在中心线上的中点 */
  center: Vec2;
  /** 闸门两端点（横跨跑道宽度） */
  a: Vec2;
  b: Vec2;
  /** 跑道切线（顺时针通行方向） */
  tangent: Vec2;
  /** 闸门在中心线上的 fraction */
  fraction: number;
  /** 名称，如 G0 */
  name: string;
}

export interface Track {
  width: number;
  gates: Gate[];
  /** 中心线在 fraction 处的位置 */
  positionAt(fraction: number): Vec2;
  /** 中心线在 fraction 处的单位切线（顺时针方向） */
  tangentAt(fraction: number): Vec2;
  /** 中心线在 fraction 处的朝内法线 */
  normalAt(fraction: number): Vec2;
  /** 中心线总长度（像素） */
  perimeter: number;
  /** 离某个世界坐标最近的中心线 fraction（样例路径辅助） */
  nearestFraction(p: Vec2): number;
  /** 渲染用：整条中心线折线 */
  centerline: Vec2[];
  /** 渲染用：内/外边界折线 */
  innerEdge: Vec2[];
  outerEdge: Vec2[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface ArcDef {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
}
interface Segment {
  kind: 'line' | 'arc';
  s0: number;
  s1: number;
  // line
  p0?: Vec2;
  p1?: Vec2;
  // arc
  arc?: ArcDef;
}

const wrap01 = (f: number): number => ((f % 1) + 1) % 1;

export function createTrack(opts?: {
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  radius?: number;
  width?: number;
}): Track {
  const cx = opts?.cx ?? 450;
  const cy = opts?.cy ?? 320;
  const rx = opts?.rx ?? 330;
  const ry = opts?.ry ?? 200;
  const radius = opts?.radius ?? 90;
  const width = opts?.width ?? 96;

  const left = cx - rx;
  const right = cx + rx;
  const top = cy - ry;
  const bottom = cy + ry;
  const r = Math.min(radius, ry - 1, rx - 1);

  // 顺时针（屏幕坐标 y 朝下）：右直道向下 → 底直道向左 → 左直道向上 → 顶直道向右。
  // 起点取右直道上端，沿 4 直线 + 4 圆弧交替回到起点。
  const arcs: ArcDef[] = [
    { cx: right - r, cy: bottom - r, r, a0: 0, a1: Math.PI / 2 }, // 右下：朝右 → 朝下
    { cx: left + r, cy: bottom - r, r, a0: Math.PI / 2, a1: Math.PI }, // 左下：朝下 → 朝左
    { cx: left + r, cy: top + r, r, a0: Math.PI, a1: Math.PI * 1.5 }, // 左上：朝左 → 朝上
    { cx: right - r, cy: top + r, r, a0: Math.PI * 1.5, a1: Math.PI * 2 }, // 右上：朝上 → 朝右
  ];
  const lineEnds: Vec2[] = [
    v(right, bottom - r), // 段0 右直道终点
    v(left + r, bottom), // 段1 底直道终点
    v(left, top + r), // 段2 左直道终点
    v(right - r, top), // 段3 顶直道终点
  ];
  const arcPoint = (a: ArcDef, t: number): Vec2 => {
    const ang = a.a0 + (a.a1 - a.a0) * t;
    return v(a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang));
  };

  // 8 个分段（4 直线 + 4 圆弧），带累计弧长
  const segments: Segment[] = [];
  let s = 0;
  // 右直道上端（右上圆弧终点），顺时针沿右直道向下出发
  let prev = v(right, top + r);
  for (let i = 0; i < 4; i++) {
    const end = lineEnds[i];
    const lineLen = len(sub(end, prev));
    segments.push({ kind: 'line', s0: s, s1: s + lineLen, p0: prev, p1: end });
    s += lineLen;
    const arc = arcs[i];
    const arcLen = Math.abs(arc.a1 - arc.a0) * arc.r;
    segments.push({ kind: 'arc', s0: s, s1: s + arcLen, arc });
    s += arcLen;
    prev = arcPoint(arc, 1);
  }
  const perimeter = s;

  const locate = (dist: number): { seg: Segment; t: number } => {
    const d = ((dist % perimeter) + perimeter) % perimeter;
    for (const seg of segments) {
      if (d <= seg.s1 + 1e-9) {
        return { seg, t: (d - seg.s0) / Math.max(1e-12, seg.s1 - seg.s0) };
      }
    }
    const last = segments[segments.length - 1];
    return { seg: last, t: 1 };
  };

  const positionAtDist = (dist: number): Vec2 => {
    const { seg, t } = locate(dist);
    if (seg.kind === 'line') return lerp(seg.p0!, seg.p1!, t);
    return arcPoint(seg.arc!, t);
  };

  const positionAt = (fraction: number): Vec2 => positionAtDist(wrap01(fraction) * perimeter);

  const tangentAt = (fraction: number): Vec2 => {
    const d = wrap01(fraction) * perimeter;
    const e = perimeter * 1e-5;
    return normalize(sub(positionAtDist(d + e), positionAtDist(d - e)));
  };

  const normalAt = (fraction: number): Vec2 => {
    const t = tangentAt(fraction);
    // y-down 坐标下顺时针行驶，内侧在前进方向右侧：右手法线 (-ty, tx)
    return v(-t.y, t.x);
  };

  // 渲染折线：均匀采样
  const SAMPLES = 480;
  const centerline: Vec2[] = [];
  for (let i = 0; i < SAMPLES; i++) centerline.push(positionAt(i / SAMPLES));

  const offsetPolyline = (points: Vec2[], inward: boolean): Vec2[] =>
    points.map((p, i) => {
      const prevP = points[(i - 1 + points.length) % points.length];
      const nextP = points[(i + 1) % points.length];
      const tan = normalize(sub(nextP, prevP));
      const n = v(-tan.y, tan.x); // 朝内（y-down 顺时针的右手法线）
      return add(p, scale(n, inward ? width / 2 : -width / 2));
    });

  const innerEdge = offsetPolyline(centerline, true);
  const outerEdge = offsetPolyline(centerline, false);

  // 已知世界坐标 → 中心线 fraction 的解析反查（先粗采样找最近分段，再线性细化）
  let bestFrac = 0;
  const nearestFraction = (p: Vec2): number => {
    let best = Infinity;
    let bestI = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const d = len(sub(centerline[i], p));
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    // 在最近采样点附近做 20 细分，把误差压到一个像素的几十分之一
    const span = 4 / SAMPLES;
    for (let k = 0; k <= 20; k++) {
      const f = wrap01(bestI / SAMPLES - span + (2 * span * k) / 20);
      const d = len(sub(positionAt(f), p));
      if (d < best) {
        best = d;
        bestFrac = f;
      }
    }
    return bestFrac;
  };

  // 四扇闸门：四条直道的几何中点。直道在分段表中的下标为 0/2/4/6，
  // 顺序即 G0(右)→G1(底)→G2(左)→G3(顶) 的顺时针次序。用直道弧长参数精确求
  // fraction，避免离散采样把闸门定位到圆角上（方向随之偏转）。
  const gateFractions = [0, 2, 4, 6].map((i) => (segments[i].s0 + segments[i].s1) / 2 / perimeter);

  const gates: Gate[] = gateFractions.map((fraction, index) => {
    const n = normalAt(fraction);
    const center = positionAt(fraction);
    return {
      index,
      center,
      a: add(center, scale(n, -width / 2)),
      b: add(center, scale(n, width / 2)),
      tangent: tangentAt(fraction),
      fraction,
      name: `G${index}`,
    };
  });

  return {
    width,
    gates,
    positionAt,
    tangentAt,
    normalAt,
    perimeter,
    nearestFraction,
    centerline,
    innerEdge,
    outerEdge,
    bounds: { minX: left - r, minY: top, maxX: right, maxY: bottom },
  };
}
