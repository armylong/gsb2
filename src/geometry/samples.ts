import type { Scene, Shape } from './types'
import { newId } from './types'
import { ellipseSubPath, rectSubPath, smoothClosedSubPath } from './primitives'
import { multiply, rotateM, scaleM, transformShape } from './transform'

// 内置样例：覆盖曲线交叠、环形区域（带洞）、完全包含、相切、变换后相减。
// 每个样例都是纯函数，重复调用可恢复初始状态，便于反复比较。

const PALETTE = ['#e8734a', '#4a90e8', '#50b86c', '#b05cc9', '#e8b84a', '#4ac9c0']

let sampleCounter = 0
function shape(name: string, fill: string, subpaths: Shape['subpaths']): Shape {
  return { id: newId(), name, fill, subpaths }
}

function sampleCurveOverlap(): Scene {
  const blobA = shape(
    '曲线团 A',
    PALETTE[0],
    [
      smoothClosedSubPath([
        { x: 300, y: 300 },
        { x: 420, y: 250 },
        { x: 540, y: 300 },
        { x: 560, y: 420 },
        { x: 460, y: 500 },
        { x: 330, y: 470 },
        { x: 260, y: 390 },
      ]),
    ],
  )
  const blobB = shape(
    '曲线团 B',
    PALETTE[1],
    [transformShape({ id: '', name: '', fill: '', subpaths: [ellipseSubPath(520, 380, 150, 90)] }, rotateM(35, { x: 520, y: 380 })).subpaths[0]],
  )
  return { shapes: [blobA, blobB], selectedIds: [blobA.id, blobB.id] }
}

function sampleRing(): Scene {
  // 环形区域：外圆 − 内圆 的复合路径（内层子路径即孔洞），
  // 另放一个与环相交的矩形，便于验证「带洞结果再次参与运算」。
  const ring = shape('环形（带洞）', PALETTE[2], [ellipseSubPath(420, 380, 150, 150), ellipseSubPath(430, 370, 60, 60)])
  const bar = shape('横穿矩条', PALETTE[0], [rectSubPath(380, 260, 70, 260)])
  return { shapes: [ring, bar], selectedIds: [ring.id, bar.id] }
}

function sampleContainment(): Scene {
  const big = shape('大矩形', PALETTE[1], [rectSubPath(280, 220, 420, 320)])
  const small = shape('内部椭圆', PALETTE[4], [ellipseSubPath(490, 380, 80, 55)])
  return { shapes: [big, small], selectedIds: [big.id, small.id] }
}

function sampleTangent(): Scene {
  const a = shape('圆 A', PALETTE[0], [ellipseSubPath(420, 380, 90, 90)])
  // 与圆 A 在 (510, 380) 处外切
  const b = shape('圆 B（与 A 相切）', PALETTE[1], [ellipseSubPath(600, 380, 90, 90)])
  return { shapes: [a, b], selectedIds: [a.id, b.id] }
}

function sampleTransformedSubtract(): Scene {
  // 矩形先绕中心旋转 25° 再做非等比缩放（1.3, 0.7），变换已烘焙进坐标
  const c = { x: 430, y: 370 }
  const m = multiply(scaleM(1.3, 0.7, c), rotateM(25, c))
  const rect = transformShape(shape('', '', [rectSubPath(320, 280, 260, 180)]), m)
  const a = shape('变换后矩形', PALETTE[5], rect.subpaths)
  const b = shape('圆形', PALETTE[0], [ellipseSubPath(560, 400, 110, 110)])
  return { shapes: [a, b], selectedIds: [a.id, b.id] }
}

export const SAMPLES: Record<string, { label: string; hint: string; make: () => Scene }> = {
  'curve-overlap': {
    label: '曲线交叠',
    hint: '两个由三次曲线构成的闭合形状相互交叠，可尝试并集 / 交集 / 排除重叠。',
    make: sampleCurveOverlap,
  },
  ring: {
    label: '环形区域（带洞再运算）',
    hint: '环形对象自带孔洞。选中两个对象执行「相减」，观察孔洞在再次运算后仍然保持。',
    make: sampleRing,
  },
  containment: {
    label: '完全包含',
    hint: '小椭圆完全在大矩形内部：交集 = 小椭圆，相减（大 − 小）得到带孔矩形。',
    make: sampleContainment,
  },
  tangent: {
    label: '相切',
    hint: '两圆外切于一点：交集为空（源对象被移除，可撤销），并集面积为两圆之和。',
    make: sampleTangent,
  },
  'transformed-subtract': {
    label: '变换后相减',
    hint: '矩形已旋转并非等比缩放。执行「相减 A−B」或「相减 B−A」，结果与画面所见区域一致。',
    make: sampleTransformedSubtract,
  },
}
