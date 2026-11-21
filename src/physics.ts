/**
 * 薄膜干涉物理核心（TypeScript 侧）。
 * 与 src/glsl.ts 中的 GLSL 实现使用同一套公式，保证点选读数与画面渲染一致。
 *
 * 模型：空气(n1) / 透明薄膜(n2, 厚度 d) / 深色基底(n3)。
 * 多光束干涉用 Airy 公式（振幅形式），s/p 偏振分别计算后取平均。
 * d = 0 时公式自然退化为空气-基底单界面的菲涅尔反射率（约定的底层模型）。
 * 掠射角（cosθ → 0）时反射率趋于 1，全程有限。
 */

export const N_AIR = 1.0;
export const N_FILM = 1.45; // 类 SiO2 透明涂层
export const N_SUBSTRATE = 2.6; // 深色高折射基底

export const LAMBDA_MIN = 380;
export const LAMBDA_MAX = 780;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 单界面振幅反射系数（s、p 偏振），全实数（无吸收、无全反射的取向上）。 */
function interfaceR(nA: number, cosA: number, nB: number, cosB: number): [number, number] {
  const rs = (nA * cosA - nB * cosB) / (nA * cosA + nB * cosB);
  const rp = (nB * cosA - nA * cosB) / (nB * cosA + nA * cosB);
  return [rs, rp];
}

function airy(r12: number, r23: number, phase: number): number {
  // r = (r12 + r23·e^{i·2δ}) / (1 + r12·r23·e^{i·2δ})，返回 |r|²
  const c = Math.cos(2 * phase);
  const s = Math.sin(2 * phase);
  const numRe = r12 + r23 * c;
  const numIm = r23 * s;
  const denRe = 1 + r12 * r23 * c;
  const denIm = r12 * r23 * s;
  return (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
}

/**
 * 薄膜在波长 lambdaNm、入射角余弦 cosTheta（相对法线）、膜厚 thicknessNm 下的反射率 [0,1]。
 */
export function filmReflectance(
  lambdaNm: number,
  cosTheta: number,
  thicknessNm: number,
  n1 = N_AIR,
  n2 = N_FILM,
  n3 = N_SUBSTRATE,
): number {
  // 夹紧到接近掠射的下限：读数保持有限且连续
  const cos1 = clamp(cosTheta, 0.02, 1);
  const sin1 = Math.sqrt(1 - cos1 * cos1);
  const sin2 = (n1 / n2) * sin1;
  const cos2 = Math.sqrt(Math.max(0, 1 - sin2 * sin2));
  const sin3 = (n1 / n3) * sin1;
  const cos3 = Math.sqrt(Math.max(0, 1 - sin3 * sin3));

  const [r12s, r12p] = interfaceR(n1, cos1, n2, cos2);
  const [r23s, r23p] = interfaceR(n2, cos2, n3, cos3);
  // 相位厚度 δ = 2π·n2·d·cosθ2 / λ
  const delta = (2 * Math.PI * n2 * thicknessNm * cos2) / lambdaNm;

  const Rs = airy(r12s, r23s, delta);
  const Rp = airy(r12p, r23p, delta);
  return clamp(0.5 * (Rs + Rp), 0, 1);
}

/** 分段高斯（Wyman et al. 2013 对 CIE 1931 配色函数的解析拟合，参数为逆宽度）。 */
function g(lambda: number, mu: number, sigma1: number, sigma2: number): number {
  const t = (lambda - mu) * (lambda < mu ? sigma1 : sigma2);
  return Math.exp(-0.5 * t * t);
}

export function cie1931(lambda: number): [number, number, number] {
  const x =
    1.056 * g(lambda, 599.8, 0.0264, 0.0323) +
    0.362 * g(lambda, 442.0, 0.0624, 0.0374) -
    0.065 * g(lambda, 501.1, 0.049, 0.0382);
  const y =
    0.821 * g(lambda, 568.8, 0.0213, 0.0247) +
    0.286 * g(lambda, 530.9, 0.0613, 0.0322);
  const z =
    1.217 * g(lambda, 437.0, 0.0845, 0.0278) +
    0.681 * g(lambda, 459.0, 0.0385, 0.0725);
  return [x, y, z];
}

/** XYZ → 线性 sRGB */
export function xyzToLinearSrgb(x: number, y: number, z: number): [number, number, number] {
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
}

export function linearToSrgb(c: number): number {
  c = clamp(c, 0, 1);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * 在给定视角与膜厚下积分可见光谱，返回显示用 sRGB（已 gamma，[0,1]）。
 * 等能白光源近似；积分步长 10nm。
 */
export function filmColorSrgb(cosTheta: number, thicknessNm: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0, norm = 0;
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += 10) {
    const r = filmReflectance(l, cosTheta, thicknessNm);
    const [cx, cy, cz] = cie1931(l);
    X += r * cx;
    Y += r * cy;
    Z += r * cz;
    norm += cy;
  }
  X /= norm; Y /= norm; Z /= norm;
  const [r, g2, b] = xyzToLinearSrgb(X, Y, Z);
  return [linearToSrgb(r), linearToSrgb(g2), linearToSrgb(b)];
}

/** 光谱采样：用于读数面板的反射率曲线。 */
export function reflectanceSpectrum(
  cosTheta: number,
  thicknessNm: number,
  stepNm = 5,
): Array<{ lambda: number; r: number }> {
  const out: Array<{ lambda: number; r: number }> = [];
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += stepNm) {
    out.push({ lambda: l, r: filmReflectance(l, cosTheta, thicknessNm) });
  }
  return out;
}
