/**
 * 列主序 2D 仿射矩阵, 与 DOMMatrix / CanvasTransform 的字段顺序一致:
 * | a c e |
 * | b d f |
 * | 0 0 1 |
 * 即 p' = (a*x + c*y + e, b*x + d*y + f)。
 */
import type { Vec2 } from './path';

export interface Mat3 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function identity(): Mat3 {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function multiply(m1: Mat3, m2: Mat3): Mat3 {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function apply(m: Mat3, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function invert(m: Mat3): Mat3 {
  const det = m.a * m.d - m.b * m.c;
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

export function translation(tx: number, ty: number): Mat3 {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function rotation(radians: number): Mat3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** 绕 pivot 旋转的复合矩阵: T(pivot) · R · T(-pivot)。 */
export function rotationAround(pivot: Vec2, radians: number): Mat3 {
  return multiply(
    translation(pivot.x, pivot.y),
    multiply(rotation(radians), translation(-pivot.x, -pivot.y)),
  );
}

/**
 * 让物体在屏幕上跟随指针平移:
 * 新矩阵 = T(指针位移, 屏幕空间) · 旧矩阵。
 */
export function translatedBy(m: Mat3, dx: number, dy: number): Mat3 {
  return multiply(translation(dx, dy), m);
}

/**
 * 让物体绕屏幕空间的 pivot 再转 delta:
 * 新矩阵 = R(pivot, delta) · 旧矩阵, 物体自身 pivot 保持不动。
 */
export function rotatedBy(m: Mat3, pivot: Vec2, delta: number): Mat3 {
  return multiply(rotationAround(pivot, delta), m);
}

export function toCssMatrix(m: Mat3): string {
  return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
}

export function setCanvasTransform(ctx: CanvasRenderingContext2D, m: Mat3): void {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
}
