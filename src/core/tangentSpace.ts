/**
 * 切线空间核心数学 —— 纯 TypeScript，无 three.js / DOM 依赖。
 * 页面 (src/main.ts) 与验证脚本 (scripts/verify.ts) 共用这一份实现，
 * 保证「页面上看到的」和「命令行验证的」是同一套数学。
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

// ---------- 基础向量运算 ----------
export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  normalize(a: Vec3): Vec3 {
    const l = v3.len(a);
    return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** UV 雅可比行列式小于该值视为退化坐标（切线未定义） */
export const DEGENERATE_DET_EPS = 1e-8;

export interface TangentFrame {
  /** 世界空间切线（未归一化，长度反映 UV 缩放） */
  T: Vec3;
  /** 世界空间副切线（未归一化） */
  B: Vec3;
  /** 世界空间法线 */
  N: Vec3;
  /** 手性 sign((T×B)·N)：+1 正常，-1 镜像 UV 区域 */
  w: 1 | -1;
  /** UV 雅可比行列式，|det| < DEGENERATE_DET_EPS 为退化 */
  det: number;
}

/**
 * 由三角形位置与 UV 计算切线框架。
 * det < 0 即镜像 UV（本页右半区），此时 w = -1。
 * 退化（det ≈ 0）时返回 null。
 */
export function frameFromTriangle(
  p0: Vec3, p1: Vec3, p2: Vec3,
  uv0: Vec2, uv1: Vec2, uv2: Vec2,
): TangentFrame | null {
  const e1 = v3.sub(p1, p0);
  const e2 = v3.sub(p2, p0);
  const du1 = uv1[0] - uv0[0], dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0], dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;

  const N = v3.normalize(v3.cross(e1, e2));
  if (Math.abs(det) < DEGENERATE_DET_EPS) {
    return null; // 退化 UV：切线无定义
  }
  const inv = 1 / det;
  const T: Vec3 = [
    (e1[0] * dv2 - e2[0] * dv1) * inv,
    (e1[1] * dv2 - e2[1] * dv1) * inv,
    (e1[2] * dv2 - e2[2] * dv1) * inv,
  ];
  const B: Vec3 = [
    (-e1[0] * du2 + e2[0] * du1) * inv,
    (-e1[1] * du2 + e2[1] * du1) * inv,
    (-e1[2] * du2 + e2[2] * du1) * inv,
  ];
  const w = (v3.dot(v3.cross(T, B), N) >= 0 ? 1 : -1) as 1 | -1;
  return { T, B, N, w, det };
}

/** 绕 (0.5, 0.5) 旋转 UV（对应页面「旋转纹理」） */
export function rotateUV(uv: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const x = uv[0] - 0.5, y = uv[1] - 0.5;
  return [0.5 + x * c - y * s, 0.5 + x * s + y * c];
}

/** 水平镜像 UV（模型另一侧的典型做法） */
export function mirrorUVu(uv: Vec2): Vec2 {
  return [1 - uv[0], uv[1]];
}

/**
 * 切线空间法线 → 世界空间。
 * useHandedness = true  ：正确处理 —— B 乘以 w，镜像区域亮暗一致；
 * useHandedness = false ：错误处理 —— 强行 w = 1，镜像区域亮暗翻转（bug 复现）。
 */
export function worldNormalFromTS(ts: Vec3, frame: TangentFrame, useHandedness: boolean): Vec3 {
  const T = v3.normalize(frame.T);
  const N = v3.normalize(frame.N);
  const w = useHandedness ? frame.w : 1;
  const B = v3.scale(v3.cross(N, T), w);
  return v3.normalize(v3.add(v3.add(v3.scale(T, ts[0]), v3.scale(B, ts[1])), v3.scale(N, ts[2])));
}

/** Lambert 漫反射 */
export function diffuse(worldN: Vec3, lightDir: Vec3): number {
  return Math.max(0, v3.dot(v3.normalize(worldN), v3.normalize(lightDir)));
}

// ---------- 轴向灯光验证 ----------
export interface AxisLight {
  name: string;
  dir: Vec3;
}
export const AXIS_LIGHTS: AxisLight[] = [
  { name: '+X', dir: [1, 0, 0] },
  { name: '-X', dir: [-1, 0, 0] },
  { name: '+Y', dir: [0, 1, 0] },
  { name: '-Y', dir: [0, -1, 0] },
  { name: '+Z', dir: [0, 0, 1] },
  { name: '-Z', dir: [0, 0, -1] },
];

export interface AxisValidationRow {
  axis: string;
  left: number;
  right: number;
  delta: number;
}

/** 关于接缝平面 (x=0) 的镜像 */
export const mirrorX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

/**
 * 内置轴向灯光验证：6 个轴向光分别打向左右区域的对称点。
 * 注意不变量：镜像贴图的正确结果不是「左右相同」，而是「左右互为镜像」——
 * 右区在镜像光 mirrorX(L) 下的响应应等于左区在 L 下的响应。
 * 手性未修正时，v 分量被错误翻转，既不满足相同也不满足镜像（亮暗翻转）。
 */
export function runAxisValidation(sample: (region: 'left' | 'right', lightDir: Vec3) => number): AxisValidationRow[] {
  return AXIS_LIGHTS.map((a) => {
    const left = sample('left', a.dir);
    const right = sample('right', mirrorX(a.dir));
    return { axis: a.name, left, right, delta: right - left };
  });
}
