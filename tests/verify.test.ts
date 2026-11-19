import { describe, expect, it } from 'vitest'
import type { Pt, Shape } from '../src/geometry/types'
import { corner, newId } from '../src/geometry/types'
import { ellipseSubPath, rectSubPath, smoothClosedSubPath } from '../src/geometry/primitives'
import { booleanOp, shapeArea } from '../src/geometry/paperBridge'
import { commit, initHistory, undo, redo, booleanCommand, canRedo } from '../src/geometry/store'
import { multiply, rotateM, scaleM, transformShape, translateM, det, type Mat } from '../src/geometry/transform'
import { sceneToJSON, sceneFromJSON, sceneToSVG, sceneFromSVG, subPathToD, parsePathD } from '../src/geometry/serialize'
import { SAMPLES } from '../src/geometry/samples'

let n = 0
function mkShape(name: string, subpaths: Shape['subpaths'], fill = '#000000'): Shape {
  return { id: `t${n++}`, name, fill, subpaths }
}

const relClose = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))

/** 用「与微小圆的交集是否非空」判断点是否落在填充区域内（含 evenodd 孔洞语义） */
function pointInShape(s: Shape, p: Pt): boolean {
  const dot = mkShape('dot', [ellipseSubPath(p.x, p.y, 0.5, 0.5)])
  return booleanOp(s, dot, 'intersect') !== null
}

describe('布尔运算：面积合理性与包含关系', () => {
  const rectA = mkShape('A', [rectSubPath(0, 0, 100, 100)])
  const rectB = mkShape('B', [rectSubPath(50, 0, 100, 100)])

  it('重叠矩形：并/交/减/异或面积精确', () => {
    expect(booleanOp(rectA, rectB, 'unite')!.area).toBeCloseTo(15000, 4)
    expect(booleanOp(rectA, rectB, 'intersect')!.area).toBeCloseTo(5000, 4)
    expect(booleanOp(rectA, rectB, 'subtract')!.area).toBeCloseTo(5000, 4)
    expect(booleanOp(rectA, rectB, 'exclude')!.area).toBeCloseTo(10000, 4)
  })

  it('互不相交：交集为空（null），并集为两个独立区域，异或面积相加', () => {
    const d1 = mkShape('d1', [rectSubPath(0, 0, 10, 10)])
    const d2 = mkShape('d2', [rectSubPath(100, 100, 10, 10)])
    expect(booleanOp(d1, d2, 'intersect')).toBeNull()
    const u = booleanOp(d1, d2, 'unite')!
    expect(u.subpaths.length).toBe(2)
    expect(u.area).toBeCloseTo(200, 6)
    expect(booleanOp(d1, d2, 'exclude')!.area).toBeCloseTo(200, 6)
  })

  it('完全包含：交集=小圆，大−小产生孔洞，小−大为空', () => {
    const big = mkShape('big', [ellipseSubPath(0, 0, 100, 100)])
    const small = mkShape('small', [ellipseSubPath(0, 0, 40, 40)])
    const inter = booleanOp(big, small, 'intersect')!
    expect(relClose(inter.area, shapeArea(small), 1e-3)).toBe(true)
    const ring = booleanOp(big, small, 'subtract')!
    expect(ring.subpaths.length).toBe(2) // 外轮廓 + 孔洞
    expect(relClose(ring.area, shapeArea(big) - shapeArea(small), 1e-3)).toBe(true)
    expect(booleanOp(small, big, 'subtract')).toBeNull()
  })

  it('相切两圆：交集为空，并集面积≈两圆之和', () => {
    const c1 = mkShape('c1', [ellipseSubPath(0, 0, 50, 50)])
    const c2 = mkShape('c2', [ellipseSubPath(100, 0, 50, 50)])
    expect(booleanOp(c1, c2, 'intersect')).toBeNull()
    const u = booleanOp(c1, c2, 'unite')!
    expect(relClose(u.area, 2 * Math.PI * 50 * 50, 1e-3)).toBe(true)
  })
})

describe('带洞结果再次参与运算', () => {
  it('环形的孔洞在第二次相减后仍保持（洞不会被当作实心）', () => {
    const outer = mkShape('outer', [ellipseSubPath(0, 0, 100, 100)])
    const inner = mkShape('inner', [ellipseSubPath(0, 0, 40, 40)])
    const donut = mkShape('donut', booleanOp(outer, inner, 'subtract')!.subpaths)
    expect(donut.subpaths.length).toBe(2)

    // 竖条穿过圆心，覆盖孔洞的一部分
    const bar = mkShape('bar', [rectSubPath(-10, -120, 20, 240)])
    const donutArea = shapeArea(donut)
    const overlap = booleanOp(donut, bar, 'intersect')!.area
    const donut2 = mkShape('donut2', booleanOp(donut, bar, 'subtract')!.subpaths)

    // 面积守恒：减去的是重叠部分，而不是把整个孔洞也填上
    expect(relClose(shapeArea(donut2), donutArea - overlap, 1e-6)).toBe(true)

    // 孔洞中未被竖条覆盖的点仍然不在填充区域内
    expect(pointInShape(donut2, { x: 30, y: 0 })).toBe(false)
    expect(pointInShape(donut2, { x: 0, y: 30 })).toBe(false)
    // 环体上的点仍在
    expect(pointInShape(donut2, { x: 70, y: 0 })).toBe(true)
    // 被竖条切掉的环体点不再填充
    expect(pointInShape(donut2, { x: 0, y: 70 })).toBe(false)

    // 孔洞区域 ∩ 结果 ≈ 0（孔洞没有被当作实心参与运算）
    const holeRegion = mkShape('hole', [ellipseSubPath(0, 0, 39, 39)])
    const leak = booleanOp(donut2, holeRegion, 'intersect')
    expect(leak === null || leak.area < 1).toBe(true)
  })
})

describe('变换一致性', () => {
  const A = mkShape('A', [smoothClosedSubPath([
    { x: 0, y: 0 }, { x: 120, y: -30 }, { x: 200, y: 40 }, { x: 150, y: 150 }, { x: 40, y: 120 },
  ])])
  const B = mkShape('B', [ellipseSubPath(130, 60, 90, 70)])
  // 平移 + 旋转 + 非等比缩放
  const M: Mat = multiply(translateM(13, -7), multiply(rotateM(33, { x: 5, y: 5 }), scaleM(1.5, 0.8, { x: 5, y: 5 })))

  it('面积按 |det| 缩放', () => {
    const tA = transformShape(A, M)
    expect(relClose(shapeArea(tA), Math.abs(det(M)) * shapeArea(A), 1e-6)).toBe(true)
  })

  it('先变换再布尔 = 先布尔再变换（四种运算）', () => {
    const tA = transformShape(A, M)
    const tB = transformShape(B, M)
    for (const op of ['unite', 'intersect', 'subtract', 'exclude'] as const) {
      const r1 = booleanOp(A, B, op)
      const r2 = booleanOp(tA, tB, op)
      if (r1 === null) {
        expect(r2).toBeNull()
        continue
      }
      expect(r2).not.toBeNull()
      expect(relClose(r2!.area, Math.abs(det(M)) * r1.area, 1e-4)).toBe(true)
    }
  })
})

describe('撤销 / 重做', () => {
  it('快照恢复对象顺序、选择状态与孔洞关系；新编辑使重做分支失效', () => {
    const a = mkShape('a', [rectSubPath(0, 0, 100, 100)], '#111111')
    const b = mkShape('b', [ellipseSubPath(50, 50, 30, 30)], '#222222')
    let h = initHistory({ shapes: [], selectedIds: [] })
    h = commit(h, { shapes: [a], selectedIds: [a.id] })
    h = commit(h, { shapes: [a, b], selectedIds: [a.id, b.id] })

    // 布尔相减产生带洞结果
    const res = booleanCommand(h.present, 'subtract', false)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    h = commit(h, res.scene)
    expect(h.present.shapes.length).toBe(1)
    expect(h.present.shapes[0].subpaths.length).toBe(2) // 带洞
    expect(h.present.selectedIds).toEqual([h.present.shapes[0].id])

    // 撤销：恢复两个原对象、顺序与选择
    h = undo(h)
    expect(h.present.shapes.map((s) => s.id)).toEqual([a.id, b.id])
    expect(h.present.selectedIds).toEqual([a.id, b.id])
    h = undo(h)
    expect(h.present.shapes.map((s) => s.id)).toEqual([a.id])
    expect(h.present.selectedIds).toEqual([a.id])

    // 重做回到带洞结果
    h = redo(h)
    h = redo(h)
    expect(h.present.shapes.length).toBe(1)
    expect(h.present.shapes[0].subpaths.length).toBe(2)

    // 撤销后走新分支：旧重做分支失效
    h = undo(h)
    const c = mkShape('c', [rectSubPath(300, 300, 50, 50)], '#333333')
    h = commit(h, { shapes: [...h.present.shapes, c], selectedIds: [c.id] })
    expect(canRedo(h)).toBe(false)
    expect(h.present.shapes.some((s) => s.id === c.id)).toBe(true)
  })

  it('空结果不残留旧图形，撤销可恢复', () => {
    const d1 = mkShape('d1', [rectSubPath(0, 0, 10, 10)])
    const d2 = mkShape('d2', [rectSubPath(100, 100, 10, 10)])
    let h = initHistory({ shapes: [d1, d2], selectedIds: [d1.id, d2.id] })
    const res = booleanCommand(h.present, 'intersect', false)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    h = commit(h, res.scene)
    expect(h.present.shapes.length).toBe(0) // 空结果：源对象已移除，无残留
    h = undo(h)
    expect(h.present.shapes.map((s) => s.id)).toEqual([d1.id, d2.id])
  })

  it('快照为深拷贝：修改当前场景不影响历史', () => {
    const a = mkShape('a', [rectSubPath(0, 0, 10, 10)])
    let h = initHistory({ shapes: [a], selectedIds: [] })
    h = commit(h, { shapes: [a, mkShape('b', [rectSubPath(20, 20, 10, 10)])], selectedIds: [] })
    h.present.shapes[0].subpaths[0].segments[0].p.x = 9999
    h = undo(h)
    expect(h.present.shapes[0].subpaths[0].segments[0].p.x).toBe(0)
  })
})

describe('输入校验', () => {
  it('开放路径不能参与区域运算', () => {
    const open = mkShape('open', [{ closed: false, segments: [corner(0, 0), corner(100, 0), corner(100, 100)] }])
    const rect = mkShape('rect', [rectSubPath(0, 0, 50, 50)])
    const res = booleanCommand({ shapes: [open, rect], selectedIds: [open.id, rect.id] }, 'unite', false)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('开放路径')
  })

  it('退化路径给出明确错误而不是假成功', () => {
    const degenerate = mkShape('deg', [{ closed: true, segments: [corner(5, 5)] }])
    const rect = mkShape('rect', [rectSubPath(0, 0, 50, 50)])
    const res = booleanCommand({ shapes: [degenerate, rect], selectedIds: [degenerate.id, rect.id] }, 'unite', false)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('退化')
  })

  it('非法坐标给出明确错误', () => {
    const bad = mkShape('bad', [
      { closed: true, segments: [corner(0, 0), corner(NaN, 10), corner(10, 10)] },
    ])
    const rect = mkShape('rect', [rectSubPath(0, 0, 50, 50)])
    const res = booleanCommand({ shapes: [bad, rect], selectedIds: [bad.id, rect.id] }, 'unite', false)
    expect(res.ok).toBe(false)
  })
})

describe('保存 / 导出 / 回读一致性', () => {
  const donut = (): Shape => {
    const outer = mkShape('outer', [ellipseSubPath(300, 300, 120, 120)])
    const inner = mkShape('inner', [ellipseSubPath(310, 290, 45, 45)])
    return mkShape('donut', booleanOp(outer, inner, 'subtract')!.subpaths, '#e8734a')
  }

  it('工程 JSON 往返完全相等', () => {
    const scene = { shapes: [donut(), mkShape('r', [rectSubPath(500, 200, 100, 80)], '#4a90e8')], selectedIds: [] }
    const back = sceneFromJSON(sceneToJSON(scene))
    expect(back).toEqual(scene)
  })

  it('导出 SVG 使用 evenodd，回读后面积极其接近，再次布尔结果一致', () => {
    const d = donut()
    const r = mkShape('r', [rectSubPath(330, 240, 60, 200)], '#4a90e8')
    const scene = { shapes: [d, r], selectedIds: [d.id, r.id] }
    const svg = sceneToSVG(scene)
    expect(svg).toContain('fill-rule="evenodd"')

    const back = sceneFromSVG(svg)
    expect(back.shapes.length).toBe(2)
    // 回读面积一致（容差覆盖 4 位小数舍入）
    expect(relClose(shapeArea(back.shapes[0]), shapeArea(d), 1e-6)).toBe(true)
    expect(relClose(shapeArea(back.shapes[1]), shapeArea(r), 1e-6)).toBe(true)
    // 回读后的带洞结果再次参与运算，与原始对象直接运算结果一致
    const opOriginal = booleanOp(d, r, 'subtract')
    const opReloaded = booleanOp(back.shapes[0], back.shapes[1], 'subtract')
    expect(opOriginal).not.toBeNull()
    expect(opReloaded).not.toBeNull()
    expect(relClose(opReloaded!.area, opOriginal!.area, 1e-6)).toBe(true)
    expect(opReloaded!.subpaths.length).toBe(opOriginal!.subpaths.length)
  })

  it('路径 d 字符串往返稳定（幂等）', () => {
    const d = donut()
    const once = subPathToD(d.subpaths[0]) + ' ' + subPathToD(d.subpaths[1])
    const parsed = parsePathD(once)
    const twice = parsed.map(subPathToD).join(' ')
    expect(twice).toBe(once)
  })
})

describe('内置样例', () => {
  it('每个样例可恢复初始状态且几何有效', () => {
    for (const [key, s] of Object.entries(SAMPLES)) {
      const scene1 = s.make()
      const scene2 = s.make() // 重新生成 = 恢复初始状态
      expect(scene1.shapes.length).toBeGreaterThan(0)
      expect(scene1.shapes.map((x) => x.subpaths)).toEqual(scene2.shapes.map((x) => x.subpaths))
      for (const sh of scene1.shapes) {
        expect(sh.subpaths.every((sp) => sp.closed)).toBe(true)
        expect(shapeArea(sh)).toBeGreaterThan(0)
      }
      // 样例中前两个对象可直接完成一次布尔运算
      const res = booleanCommand(scene1, 'unite', false)
      expect(res.ok, `样例 ${key} 布尔运算失败`).toBe(true)
    }
  })

  it('环形样例的主体对象自带孔洞（复合路径）', () => {
    const scene = SAMPLES['ring'].make()
    expect(scene.shapes[0].subpaths.length).toBe(2)
  })
})
