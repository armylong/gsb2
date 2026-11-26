/**
 * 纯三维数学内核: 向量 / 旋转矩阵 / OBB / SAT 碰撞检测。
 * 不依赖 three.js, 方便在 vitest 中做确定性单测。
 * 长度单位统一为毫米 (mm)。
 */

export type Vec3 = [number, number, number];
/** 行优先 3x3 矩阵, m[行*3+列] */
export type Mat3 = number[];

export interface BoxSize {
  /** 局部 x/y/z 三个方向的全尺寸 */
  size: Vec3;
}

export interface OBB {
  center: Vec3;
  /** 三个方向的半尺寸 */
  half: Vec3;
  /** 单位正交轴, 与 half 一一对应 */
  axes: [Vec3, Vec3, Vec3];
}

export interface Segment {
  a: Vec3;
  b: Vec3;
  /** 该边平行于 OBB 的哪个局部轴 */
  dirAxis: number;
}

// ---------- 向量 ----------

export const v = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l);
};
export const cloneV = (a: Vec3): Vec3 => [a[0], a[1], a[2]];

/** 矩阵作用于向量 (行优先) */
export function mulMatVec(m: Mat3, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
}

/** 矩阵乘法 A * B (行优先) */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 绕单位轴 axis 旋转 angle 弧度, Rodrigues 公式 */
export function rotAxis(axis: Vec3, angle: number): Mat3 {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const C = 1 - c;
  const [x, y, z] = k;
  return [
    c + x * x * C,
    x * y * C - z * s,
    x * z * C + y * s,
    y * x * C + z * s,
    c + y * y * C,
    y * z * C - x * s,
    z * x * C - y * s,
    z * y * C + x * s,
    c + z * z * C,
  ];
}

export const identityMat = (): Mat3 => [...IDENTITY];

// ---------- OBB ----------

/** 由中心、全尺寸和 (可选) 姿态构造 OBB; 缺省姿态为轴对齐 */
export function makeOBB(center: Vec3, size: Vec3, rotation?: Mat3): OBB {
  const r = rotation ?? identityMat();
  const axes: [Vec3, Vec3, Vec3] = [
    [r[0], r[3], r[6]],
    [r[1], r[4], r[7]],
    [r[2], r[5], r[8]],
  ];
  return {
    center: cloneV(center),
    half: [size[0] / 2, size[1] / 2, size[2] / 2],
    axes,
  };
}

export function transformOBB(o: OBB, rotation: Mat3, translation: Vec3): OBB {
  return {
    center: add(mulMatVec(rotation, o.center), translation),
    half: [...o.half] as Vec3,
    axes: [
      mulMatVec(rotation, o.axes[0]),
      mulMatVec(rotation, o.axes[1]),
      mulMatVec(rotation, o.axes[2]),
    ],
  };
}

/** OBB 的 12 条边 */
export function obbEdges(o: OBB): Segment[] {
  const corners: Vec3[] = [];
  for (let mask = 0; mask < 8; mask++) {
    let p = cloneV(o.center);
    for (let i = 0; i < 3; i++) {
      const sgn = mask & (1 << i) ? 1 : -1;
      p = add(p, scale(o.axes[i], sgn * o.half[i]));
    }
    corners.push(p);
  }
  const edges: Segment[] = [];
  for (let i = 0; i < 3; i++) {
    for (let mask = 0; mask < 8; mask++) {
      if (mask & (1 << i)) continue;
      const other = mask | (1 << i);
      edges.push({ a: corners[mask], b: corners[other], dirAxis: i });
    }
  }
  return edges;
}

/** 点到 OBB 的最近点 */
export function closestPointOnOBB(p: Vec3, o: OBB): Vec3 {
  const d = sub(p, o.center);
  let q = cloneV(o.center);
  for (let i = 0; i < 3; i++) {
    const t = Math.max(-o.half[i], Math.min(o.half[i], dot(d, o.axes[i])));
    q = add(q, scale(o.axes[i], t));
  }
  return q;
}

/** 两线段最近点距离与最近点对 (Ericson Real-Time Collision Detection 5.1.9) */
export function segmentSegment(a: Segment, b: Segment): { dist: number; pa: Vec3; pb: Vec3 } {
  const u = sub(a.b, a.a);
  const v = sub(b.b, b.a);
  const w0 = sub(a.a, b.a);
  const A = dot(u, u);
  const B = dot(u, v);
  const C = dot(v, v);
  const D = dot(u, w0);
  const E = dot(v, w0);
  const denom = A * C - B * B;
  let s: number;
  let t: number;
  if (denom > 1e-12) {
    s = (B * E - C * D) / denom;
    // 钳制 s, 再在对应端点上求 t
    if (s < 0) {
      s = 0;
      t = E / C;
    } else if (s > 1) {
      s = 1;
      t = (B + E) / C;
    } else {
      t = (B * s + E) / C;
    }
  } else {
    s = 0;
    t = E / C;
  }
  // 钳制 t, 再用钳制后的 t 重算 s
  if (t < 0) {
    t = 0;
    s = Math.max(0, Math.min(1, -D / A));
  } else if (t > 1) {
    t = 1;
    s = Math.max(0, Math.min(1, (B - D) / A));
  }
  const pa = add(a.a, scale(u, s));
  const pb = add(b.a, scale(v, t));
  return { dist: length(sub(pa, pb)), pa, pb };
}

// ---------- SAT ----------

export type AxisSource =
  | { type: 'face'; obb: 0 | 1; axisIndex: number }
  | { type: 'edge'; aAxisIndex: number; bAxisIndex: number };

export interface SatResult {
  /** true = 重叠或处于接触容差内 */
  contact: boolean;
  /** >0 侵入深度; <=0 为净距 (负值的绝对值) */
  depth: number;
  /** 单位法线, 由 A 指向 B (沿法线把 A 推开即可分离) */
  normal: Vec3;
  source: AxisSource;
  /** 最近/接触点 (两物体最近点对的中点) */
  point: Vec3;
}

function projectOBB(o: OBB, n: Vec3): [number, number] {
  const r =
    o.half[0] * Math.abs(dot(o.axes[0], n)) +
    o.half[1] * Math.abs(dot(o.axes[1], n)) +
    o.half[2] * Math.abs(dot(o.axes[2], n));
  const c = dot(o.center, n);
  return [c - r, c + r];
}

/**
 * SAT 检测两个 OBB。
 * @param contactTol 接触容差 (mm), 净距小于该值也算接触 (用于识别"贴边")
 */
export function satOBB(a: OBB, b: OBB, contactTol = 1e-6): SatResult {
  const candidates: { n: Vec3; source: AxisSource }[] = [];
  for (let i = 0; i < 3; i++) {
    candidates.push({ n: a.axes[i], source: { type: 'face', obb: 0, axisIndex: i } });
    candidates.push({ n: b.axes[i], source: { type: 'face', obb: 1, axisIndex: i } });
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const n = cross(a.axes[i], b.axes[j]);
      if (length(n) > 1e-9) {
        candidates.push({
          n: normalize(n),
          source: { type: 'edge', aAxisIndex: i, bAxisIndex: j },
        });
      }
    }
  }

  let minPenetration = Infinity;
  let minSrc: AxisSource = candidates[0].source;
  let minN: Vec3 = candidates[0].n;
  let maxGap = -Infinity;
  let gapSrc: AxisSource = candidates[0].source;
  let gapN: Vec3 = candidates[0].n;

  for (const { n, source } of candidates) {
    const [a0, a1] = projectOBB(a, n);
    const [b0, b1] = projectOBB(b, n);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap < minPenetration) {
      minPenetration = overlap;
      minSrc = source;
      minN = n;
    }
    const gap = -overlap;
    if (gap > maxGap) {
      maxGap = gap;
      gapSrc = source;
      gapN = n;
    }
  }

  // 法线方向: 由 A 指向 B
  const orient = (n: Vec3): Vec3 => (dot(sub(b.center, a.center), n) < 0 ? scale(n, -1) : n);

  if (minPenetration <= -contactTol) {
    // 明确分离: 多面体净距等于候选轴上的最大投影间隔
    const n = orient(gapN);
    return {
      contact: false,
      depth: -maxGap,
      normal: n,
      source: gapSrc,
      point: midClosest(a, b, gapSrc, gapN),
    };
  }

  const n = orient(minN);
  return {
    contact: true,
    depth: Math.max(0, minPenetration),
    normal: n,
    source: minSrc,
    point: midClosest(a, b, minSrc, minN),
  };
}

function midClosest(a: OBB, b: OBB, source: AxisSource, _n: Vec3): Vec3 {
  if (source.type === 'face') {
    if (source.obb === 0) {
      const pa = closestPointOnOBB(b.center, a);
      const pb = closestPointOnOBB(pa, b);
      return scale(add(pa, pb), 0.5);
    }
    const pb = closestPointOnOBB(a.center, b);
    const pa = closestPointOnOBB(pb, a);
    return scale(add(pa, pb), 0.5);
  }
  // 边-边: 在对应方向的边集合里找最近的一对
  const edgesA = obbEdges(a).filter((e) => e.dirAxis === source.aAxisIndex);
  const edgesB = obbEdges(b).filter((e) => e.dirAxis === source.bAxisIndex);
  let best = Infinity;
  let pa: Vec3 = a.center;
  let pb: Vec3 = b.center;
  for (const ea of edgesA) {
    for (const eb of edgesB) {
      const r = segmentSegment(ea, eb);
      if (r.dist < best) {
        best = r.dist;
        pa = r.pa;
        pb = r.pb;
      }
    }
  }
  return scale(add(pa, pb), 0.5);
}

/** 两个 OBB 的净距 (接触或侵入时返回 0) */
export function obbDistance(a: OBB, b: OBB, contactTol = 1e-6): number {
  const r = satOBB(a, b, contactTol);
  return r.contact ? 0 : -r.depth;
}
