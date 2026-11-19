import paper from 'paper'
import type { Shape, SubPath } from './types'
import { samePt } from './types'

// Paper.js 仅作为布尔几何引擎使用：模型 ↔ paper 路径双向转换，
// 结果再转回纯数据模型，保证撤销快照与序列化不依赖 paper 对象。

let ready = false
export function ensurePaper(): void {
  if (!ready) {
    paper.setup(new paper.Size(2048, 2048))
    ready = true
  }
}

/** 面积小于该值视为空结果（用户坐标单位²） */
export const AREA_EPS = 1e-6

export function validateShape(shape: Shape): string | null {
  if (!shape.subpaths.length) return `对象「${shape.name}」不包含任何路径`
  for (const sp of shape.subpaths) {
    if (sp.segments.length < 2) return `对象「${shape.name}」存在退化子路径（节点数不足 2 个），无法参与运算`
    for (const s of sp.segments) {
      for (const q of [s.p, s.hi, s.ho]) {
        if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) {
          return `对象「${shape.name}」包含非法坐标，无法参与运算`
        }
      }
    }
    if (sp.closed) {
      const xs = sp.segments.map((s) => s.p.x)
      const ys = sp.segments.map((s) => s.p.y)
      if (Math.max(...xs) - Math.min(...xs) < 1e-9 && Math.max(...ys) - Math.min(...ys) < 1e-9) {
        return `对象「${shape.name}」存在面积为零的退化子路径，无法参与运算`
      }
    }
  }
  return null
}

function toPaperPath(sp: SubPath): paper.Path {
  const segs = sp.segments
  const path = new paper.Path()
  path.moveTo(new paper.Point(segs[0].p.x, segs[0].p.y))
  const n = segs.length
  const count = sp.closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const a = segs[i]
    const b = segs[(i + 1) % n]
    if (samePt(a.ho, a.p) && samePt(b.hi, b.p)) {
      path.lineTo(new paper.Point(b.p.x, b.p.y))
    } else {
      path.cubicCurveTo(
        new paper.Point(a.ho.x, a.ho.y),
        new paper.Point(b.hi.x, b.hi.y),
        new paper.Point(b.p.x, b.p.y),
      )
    }
  }
  if (sp.closed) path.closePath()
  return path
}

export function shapeToPaperItem(shape: Shape): paper.PathItem {
  ensurePaper()
  if (shape.subpaths.length === 1) return toPaperPath(shape.subpaths[0])
  const paths = shape.subpaths.map(toPaperPath)
  return new paper.CompoundPath(paths)
}

export function paperItemToSubpaths(item: paper.PathItem): SubPath[] {
  const paths: paper.Path[] =
    item instanceof paper.CompoundPath ? (item.children as paper.Path[]) : [item as paper.Path]
  return paths
    .filter((p) => p.segments.length > 0)
    .map((p) => ({
      closed: p.closed,
      segments: p.segments.map((s) => ({
        p: { x: s.point.x, y: s.point.y },
        hi: s.handleIn.isZero()
          ? { x: s.point.x, y: s.point.y }
          : { x: s.point.x + s.handleIn.x, y: s.point.y + s.handleIn.y },
        ho: s.handleOut.isZero()
          ? { x: s.point.x, y: s.point.y }
          : { x: s.point.x + s.handleOut.x, y: s.point.y + s.handleOut.y },
      })),
    }))
}

/** outer 是否完整包含 inner（布尔结果的子路径互不相交，逐锚点测试即可，相切点按边界计入） */
function containsPath(outer: paper.Path, inner: paper.Path): boolean {
  for (const seg of inner.segments) {
    const p = seg.point
    if (!outer.contains(p)) {
      const near = outer.getNearestPoint(p)
      if (!near || near.getDistance(p) > 1e-6) return false
    }
  }
  return true
}

/**
 * 复合路径在 evenodd 填充规则下的真实面积。
 * paper 的 item.area 是带符号面积之和，对「排除重叠」产生的并列区域会错误地抵消为 0；
 * 这里按每个子路径的嵌套深度（被多少其他子路径包含）决定正负号，与 evenodd 填充一致。
 */
function itemArea(item: paper.PathItem): number {
  if (item instanceof paper.CompoundPath) {
    const children = item.children as paper.Path[]
    let total = 0
    for (let i = 0; i < children.length; i++) {
      let depth = 0
      for (let j = 0; j < children.length; j++) {
        if (i !== j && containsPath(children[j], children[i])) depth++
      }
      total += (depth % 2 === 0 ? 1 : -1) * Math.abs(children[i].area)
    }
    return Math.abs(total)
  }
  return Math.abs((item as paper.Path).area)
}

export type BoolOp = 'unite' | 'intersect' | 'subtract' | 'exclude'

export interface BoolOutput {
  subpaths: SubPath[]
  area: number
}

/**
 * 对两个对象执行布尔运算。
 * 返回 null 表示结果为空（调用方负责移除源对象，不留下残留图形）。
 * 抛出 Error 表示输入不可用（开放路径、退化路径或几何库无法处理）。
 */
export function booleanOp(a: Shape, b: Shape, op: BoolOp): BoolOutput | null {
  for (const s of [a, b]) {
    const err = validateShape(s)
    if (err) throw new Error(err)
    if (s.subpaths.some((sp) => !sp.closed)) {
      throw new Error(`对象「${s.name}」包含开放路径，开放路径不能直接参与区域运算，请先闭合`)
    }
  }
  const pa = shapeToPaperItem(a)
  const pb = shapeToPaperItem(b)
  let res: paper.PathItem
  try {
    res =
      op === 'unite'
        ? pa.unite(pb)
        : op === 'intersect'
          ? pa.intersect(pb)
          : op === 'subtract'
            ? pa.subtract(pb)
            : pa.exclude(pb)
  } catch {
    pa.remove()
    pb.remove()
    throw new Error('几何运算失败：路径过于退化或自交情况无法处理，请调整形状后重试')
  }
  const area = itemArea(res)
  const subpaths = paperItemToSubpaths(res)
  pa.remove()
  pb.remove()
  res.remove()
  if (!Number.isFinite(area) || area < AREA_EPS || subpaths.length === 0) return null
  return { subpaths, area }
}

/** 对象总面积（孔洞按负面积计入），供测试与信息展示使用 */
export function shapeArea(shape: Shape): number {
  const item = shapeToPaperItem(shape)
  const a = itemArea(item)
  item.remove()
  return a
}
