import type { Pt, SubPath } from './types'
import { corner } from './types'

export function rectSubPath(x: number, y: number, w: number, h: number): SubPath {
  return {
    closed: true,
    segments: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
  }
}

const KAPPA = 0.5522847498307936 // 四次贝塞尔逼近圆弧的标准系数

/** 椭圆用 4 段三次贝塞尔逼近，最大径向误差约为半径的 0.027%（见 README 误差说明） */
export function ellipseSubPath(cx: number, cy: number, rx: number, ry: number): SubPath {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const seg = (x: number, y: number, hix: number, hiy: number, hox: number, hoy: number) => ({
    p: { x, y },
    hi: { x: x + hix, y: y + hiy },
    ho: { x: x + hox, y: y + hoy },
  })
  return {
    closed: true,
    segments: [
      seg(cx + rx, cy, 0, -ky, 0, ky),
      seg(cx, cy + ry, kx, 0, -kx, 0),
      seg(cx - rx, cy, 0, ky, 0, -ky),
      seg(cx, cy - ry, -kx, 0, kx, 0),
    ],
  }
}

/** Catmull-Rom 样条转三次贝塞尔闭合路径（tension=1 为标准 Catmull-Rom） */
export function smoothClosedSubPath(pts: Pt[], tension = 1): SubPath {
  const n = pts.length
  const segments = pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n]
    const next = pts[(i + 1) % n]
    const hx = ((next.x - prev.x) / 6) * tension
    const hy = ((next.y - prev.y) / 6) * tension
    return {
      p: { x: p.x, y: p.y },
      hi: { x: p.x - hx, y: p.y - hy },
      ho: { x: p.x + hx, y: p.y + hy },
    }
  })
  return { closed: true, segments }
}
