// 纯数学模块: 不依赖 three.js, 可在 Node 中直接验证 (npm run verify)
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export type Color3 = [number, number, number]; // 线性空间 RGB

/** 6 个轴对齐方向, 探针的每个方向颜色可独立设置 */
export const DIRS: readonly Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
export const DIR_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;

export interface Probe {
  id: string;
  name: string;
  position: Vec3;
  radius: number; // 影响半径
  enabled: boolean;
  dirColors: Color3[]; // 长度 6, 与 DIRS 对齐
}

export type SampleMode = 'blend' | 'nearest';
export type SampleSource = 'blend' | 'nearest' | 'fallback';

export interface FieldSample {
  weights: number[]; // 归一化权重, 与 probes 数组对齐; 回退时全 0
  rawTotal: number; // 归一化前的权重和, 反映覆盖度
  coverage: number; // min(1, rawTotal), 用于向回退色软过渡
  color: Color3; // 最终颜色 (已含回退混合)
  source: SampleSource;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * 原始权重: (1 - (d/r)^2)^2
 * 在影响边界 d=r 处函数值与一阶导数都为 0 (C1 连续),
 * 这是"走过边界颜色不突兀"的数学基础。
 */
export function rawWeight(probe: Probe, p: Vec3): number {
  if (!probe.enabled) return 0;
  const t = distance(probe.position, p) / probe.radius;
  if (t >= 1) return 0;
  const s = 1 - t * t;
  return s * s;
}

/**
 * 按法线方向解析探针颜色: 对 6 个方向做余弦平方瓣加权, 再按瓣权重归一。
 * 性质: 常色探针在任意法线下返回该色; 法线正对某轴时精确返回该方向的颜色。
 */
export function directionalColor(probe: Probe, n: Vec3): Color3 {
  let wsum = 0;
  const acc: Color3 = [0, 0, 0];
  for (let k = 0; k < 6; k++) {
    const d = DIRS[k];
    const a = Math.max(0, n.x * d.x + n.y * d.y + n.z * d.z);
    const w = a * a;
    wsum += w;
    const c = probe.dirColors[k];
    acc[0] += w * c[0];
    acc[1] += w * c[1];
    acc[2] += w * c[2];
  }
  if (wsum < 1e-8) return [0, 0, 0];
  return [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum];
}

/**
 * 采样整个探针场。
 *
 * blend 模式:
 *   - 权重按原始权重归一化 (Σŵ = 1), 探针进出影响区时权重平滑涨落, 颜色连续;
 *   - 覆盖度 coverage = min(1, Σw): 影响区边缘向"回退环境色"软过渡,
 *     场外 (coverage = 0) 按明确规则精确取回退色;
 *   - 禁用探针后剩余权重即时重新归一, 覆盖不足处自动退向回退色 (采样退化)。
 *
 * nearest 模式 (对照组):
 *   - 固定取"影响半径内最近"的启用探针, 权重为 one-hot, 不做混合;
 *   - 跨越两探针的 Voronoi 分界或影响半径边缘时颜色跳变;
 *   - 不在任何半径内时同样取回退色。
 */
export function sampleField(
  probes: Probe[],
  p: Vec3,
  normal: Vec3,
  mode: SampleMode,
  fallback: Color3,
): FieldSample {
  if (mode === 'nearest') {
    let best = -1;
    let bestD = Infinity;
    probes.forEach((pr, i) => {
      if (!pr.enabled) return;
      const d = distance(pr.position, p);
      if (d < pr.radius && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best < 0) {
      return {
        weights: probes.map(() => 0),
        rawTotal: 0,
        coverage: 0,
        color: [...fallback],
        source: 'fallback',
      };
    }
    return {
      weights: probes.map((_, i) => (i === best ? 1 : 0)),
      rawTotal: 1,
      coverage: 1,
      color: directionalColor(probes[best], normal),
      source: 'nearest',
    };
  }

  const raw = probes.map((pr) => rawWeight(pr, p));
  const total = raw.reduce((s, w) => s + w, 0);
  if (total <= 1e-8) {
    return {
      weights: raw.map(() => 0),
      rawTotal: 0,
      coverage: 0,
      color: [...fallback],
      source: 'fallback',
    };
  }
  const weights = raw.map((w) => w / total);
  const coverage = Math.min(1, total);
  const blended: Color3 = [0, 0, 0];
  probes.forEach((pr, i) => {
    if (weights[i] === 0) return;
    const c = directionalColor(pr, normal);
    blended[0] += weights[i] * c[0];
    blended[1] += weights[i] * c[1];
    blended[2] += weights[i] * c[2];
  });
  const color: Color3 = [
    fallback[0] * (1 - coverage) + blended[0] * coverage,
    fallback[1] * (1 - coverage) + blended[1] * coverage,
    fallback[2] * (1 - coverage) + blended[2] * coverage,
  ];
  return { weights, rawTotal: total, coverage, color, source: 'blend' };
}

// ---------------------------------------------------------------------------
// 预设场景
// ---------------------------------------------------------------------------

function makeProbe(
  id: string,
  name: string,
  x: number,
  radius: number,
  perDir: Color3[],
  enabled = true,
): Probe {
  return {
    id,
    name,
    position: { x, y: 1, z: 0 },
    radius,
    enabled,
    dirColors: perDir.map((c) => [...c] as Color3),
  };
}

/** 预设 1: 冷暖分界 —— 两个影响区重叠的探针, 暖色在左, 冷色在右 */
export function presetWarmCool(): { probes: Probe[]; fallback: Color3 } {
  const warm = makeProbe('warm', '暖色探针', -2.2, 3, [
    [1.0, 0.5, 0.2], // +X
    [0.9, 0.4, 0.15], // -X
    [1.0, 0.75, 0.45], // +Y 顶部更亮
    [0.35, 0.15, 0.06], // -Y 地面反弹暗
    [0.95, 0.5, 0.22], // +Z
    [0.95, 0.5, 0.22], // -Z
  ]);
  const cool = makeProbe('cool', '冷色探针', 2.2, 3, [
    [0.3, 0.55, 1.0],
    [0.25, 0.45, 0.9],
    [0.55, 0.75, 1.0],
    [0.1, 0.15, 0.3],
    [0.3, 0.55, 0.95],
    [0.3, 0.55, 0.95],
  ]);
  return { probes: [warm, cool], fallback: [0.04, 0.04, 0.05] };
}

/** 预设 2: 探针缺失现场 —— 中间探针默认禁用, 路径中央出现覆盖空洞 */
export function presetMissing(): { probes: Probe[]; fallback: Color3 } {
  const left = makeProbe('left', '左侧探针', -3.5, 2.5, [
    [1.0, 0.55, 0.25],
    [0.9, 0.45, 0.2],
    [1.0, 0.8, 0.5],
    [0.3, 0.15, 0.08],
    [0.95, 0.5, 0.25],
    [0.95, 0.5, 0.25],
  ]);
  const middle = makeProbe(
    'middle',
    '中间探针 (缺失)',
    0,
    2.5,
    [
      [0.4, 1.0, 0.45],
      [0.4, 1.0, 0.45],
      [0.7, 1.0, 0.7],
      [0.1, 0.3, 0.1],
      [0.4, 1.0, 0.45],
      [0.4, 1.0, 0.45],
    ],
    false, // 默认禁用, 模拟探针缺失
  );
  const right = makeProbe('right', '右侧探针', 3.5, 2.5, [
    [0.3, 0.55, 1.0],
    [0.3, 0.55, 1.0],
    [0.55, 0.75, 1.0],
    [0.1, 0.15, 0.3],
    [0.3, 0.5, 0.95],
    [0.3, 0.5, 0.95],
  ]);
  return { probes: [left, middle, right], fallback: [0.04, 0.04, 0.05] };
}
