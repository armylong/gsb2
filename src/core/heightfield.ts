/**
 * 程序化「带方向」的凹凸纹理：斜向锯齿条纹 + 不对称凹坑。
 * 条纹沿对角方向、波形不对称（sin + 二次谐波），所以镜像/翻转后
 * 受光方向会明显不同 —— 正是复现「亮暗翻转」所需的方向性。
 *
 * 纯函数，页面（生成 CanvasTexture）与验证脚本（CPU 采样）共用。
 */
import { v3, type Vec3 } from './tangentSpace';

const TAU = Math.PI * 2;

function wrap01(x: number): number {
  return ((x % 1) + 1) % 1;
}

function gauss(u: number, v: number, cu: number, cv: number, r: number): number {
  const du = u - cu, dv = v - cv;
  return Math.exp(-(du * du + dv * dv) / (2 * r * r));
}

/** 高度场 h(u, v)，u/v 任意取值（内部 wrap，条纹按整数频率可平铺） */
export function heightAt(u: number, v: number): number {
  u = wrap01(u);
  v = wrap01(v);
  // 斜向不对称条纹：基频 + 二次谐波让坡度左右不对称（方向性来源）
  const th = TAU * (3 * u + 2 * v);
  let h = Math.sin(th) + 0.35 * Math.sin(2 * th + 1.0);
  // 不对称凹坑/凸包，方便肉眼辨认纹理朝向
  h += 0.9 * gauss(u, v, 0.30, 0.35, 0.06);
  h -= 0.9 * gauss(u, v, 0.72, 0.62, 0.05);
  h += 0.5 * gauss(u, v, 0.55, 0.18, 0.04);
  return h;
}

/**
 * 由高度场数值微分得到切线空间法线（OpenGL 约定：G+ = +v 方向）。
 * 这是「纹理里存的」法线；切换纵向编码约定时在采样处翻转 y。
 */
export function normalAt(u: number, v: number, strength = 0.12): Vec3 {
  const e = 1 / 512;
  const dx = (heightAt(u + e, v) - heightAt(u - e, v)) / (2 * e);
  const dy = (heightAt(u, v + e) - heightAt(u, v - e)) / (2 * e);
  return v3.normalize([-dx * strength, -dy * strength, 1]);
}

/** 纵向编码约定：opengl = G+ 向上；directx = G+ 向下（采样时翻绿通道） */
export type GreenConvention = 'opengl' | 'directx';

/** 采样切线空间法线，可按约定翻转绿通道 */
export function sampleTSNormal(u: number, v: number, convention: GreenConvention): Vec3 {
  const n = normalAt(u, v);
  return convention === 'directx' ? [n[0], -n[1], n[2]] : n;
}
