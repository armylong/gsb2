/**
 * 三向投影 (triplanar mapping) 的纯 CPU 参考实现。
 *
 * GLSL 着色器 (src/shaders.ts) 中的权重/采样坐标逻辑与此文件逐行对应，
 * 验证命令 tests/weights.test.ts 直接测试这里，保证 GPU 与 CPU 一致。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Axis = 0 | 1 | 2; // 0 = X 轴, 1 = Y 轴, 2 = Z 轴

export interface TriplanarParams {
  /** 各轴的额外权重乘子（UI 里的 X/Y/Z 权重滑杆），默认 1 */
  biases: Vec3;
  /** 过渡陡度：1 = 线性混合，越大过渡带越窄（锐化），可到 16 */
  sharpness: number;
}

export interface AxisResult {
  /** 该轴的归一化混合权重 [0,1]，三个轴之和为 1 */
  weight: number;
  /** 投影平面上的原始采样坐标（缩放/偏移之前） */
  uv: [number, number];
  /** 主导方向符号：法线在该轴上为正取 +1，为负取 -1 */
  sign: 1 | -1;
}

export interface TriplanarResult {
  axes: [AxisResult, AxisResult, AxisResult];
  /** 权重最大的轴 */
  dominantAxis: Axis;
  /** 主导轴的归一化权重；小于约 0.55 表示该面位于“接近轴界面”的混合区 */
  maxWeight: number;
}

/** 单个轴的线性权重分量：|法线分量| * bias（陡度指数在归一化之后施加） */
export function rawAxisWeight(n: Vec3, axis: Axis, p: TriplanarParams): number {
  const c = Math.abs(n[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z']);
  const bias = p.biases[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'];
  return c * bias;
}

/**
 * 投影平面 UV（缩放/偏移之前），与 GLSL 中 planeX/Y/Z 一致：
 * - X 平面: (ny ? -z : z, y)
 * - Y 平面: (x, nz ? -z : z)
 * - Z 平面: (x, y)
 */
export function planeUV(p: Vec3, n: Vec3, axis: Axis): [number, number] {
  switch (axis) {
    case 0:
      return [n.x < 0 ? p.z : -p.z, p.y];
    case 1:
      return [p.x, n.y < 0 ? -p.z : p.z];
    case 2:
      return [p.x, p.y];
  }
}

/**
 * 计算一个点/法线的三向投影权重与各轴采样坐标。
 * 法线不需要归一化，内部会归一化。
 */
export function triplanarWeights(point: Vec3, normal: Vec3, params: TriplanarParams): TriplanarResult {
  const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const n: Vec3 = { x: normal.x / len, y: normal.y / len, z: normal.z / len };

  const raw: [number, number, number] = [
    rawAxisWeight(n, 0, params),
    rawAxisWeight(n, 1, params),
    rawAxisWeight(n, 2, params),
  ];
  // 零向量法线（退化面）回退为等权，保证输出仍归一化且无 NaN
  const degenerate = raw[0] + raw[1] + raw[2] === 0;
  const linearSum = degenerate ? 1 : raw[0] + raw[1] + raw[2];

  // 标准 triplanar 锐化：先做线性归一化，再整体取 sharpness 次幂，
  // 最后二次归一化。sharpness=1 时等价于线性混合。
  const shaped = raw.map((r) =>
    degenerate ? 1 / 3 : Math.pow(r / linearSum, params.sharpness),
  ) as [number, number, number];
  const shapedSum = shaped[0] + shaped[1] + shaped[2] || 1;

  const axes = [0, 1, 2].map((axis) => {
    const a = axis as Axis;
    const component = n[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'];
    return {
      weight: shaped[axis] / shapedSum,
      uv: planeUV(point, n, a),
      sign: (component < 0 ? -1 : 1) as 1 | -1,
    };
  }) as TriplanarResult['axes'];

  let dominantAxis: Axis = 0;
  for (let a = 1 as Axis; a <= 2; a = (a + 1) as Axis) {
    if (axes[a].weight > axes[dominantAxis].weight) dominantAxis = a;
  }

  return {
    axes,
    dominantAxis,
    maxWeight: axes[dominantAxis].weight,
  };
}

/** 应用纹理缩放与世界/物体空间偏移后的最终采样坐标 */
export function sampleCoordinates(uv: [number, number], scale: number, offset: Vec3): [number, number] {
  return [uv[0] * scale + offset.x, uv[1] * scale + offset.y];
}

export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;
