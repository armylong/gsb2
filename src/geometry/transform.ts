import type { Pt, Shape } from './types'

/** 2x3 仿射矩阵 [a, b, c, d, e, f]，与 SVG transform matrix 一致 */
export type Mat = [number, number, number, number, number, number]

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** m1 ∘ m2：先应用 m2 再应用 m1 */
export function multiply(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

export function applyToPt(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

export function translateM(dx: number, dy: number): Mat {
  return [1, 0, 0, 1, dx, dy]
}

export function rotateM(deg: number, c: Pt): Mat {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  // 绕 c 旋转：p → R·(p − c) + c
  return [cos, sin, -sin, cos, c.x - cos * c.x + sin * c.y, c.y - sin * c.x - cos * c.y]
}

export function scaleM(sx: number, sy: number, c: Pt): Mat {
  return [sx, 0, 0, sy, c.x - sx * c.x, c.y - sy * c.y]
}

export function det(m: Mat): number {
  return m[0] * m[3] - m[1] * m[2]
}

/** 仿射变换对三次贝塞尔曲线是精确的：只需变换锚点与两个控制柄。 */
export function transformShape(shape: Shape, m: Mat): Shape {
  return {
    ...shape,
    subpaths: shape.subpaths.map((sp) => ({
      ...sp,
      segments: sp.segments.map((s) => ({
        p: applyToPt(m, s.p),
        hi: applyToPt(m, s.hi),
        ho: applyToPt(m, s.ho),
      })),
    })),
  }
}
