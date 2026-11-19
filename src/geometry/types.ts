// 核心数据模型：所有几何都以「段 + 绝对控制柄」的形式保存，
// 变换直接烘焙进坐标，撤销/重做通过场景快照实现，不引用任何可变外部对象。

export interface Pt {
  x: number
  y: number
}

/** 一个锚点及其两侧控制柄（绝对坐标）。hi/ho 与 p 重合表示该侧无控制柄（直线）。 */
export interface Segment {
  p: Pt
  hi: Pt
  ho: Pt
}

export interface SubPath {
  segments: Segment[]
  closed: boolean
}

/** 一个对象可含多条闭合子路径（复合路径），渲染与导出均使用 evenodd 填充规则，
 *  因此内层子路径自然表现为孔洞，孔洞中再嵌套的区域也能正确交替填充。 */
export interface Shape {
  id: string
  name: string
  fill: string
  subpaths: SubPath[]
}

export interface Scene {
  shapes: Shape[]
  /** 有序选择：布尔运算按选择顺序取前两个对象 */
  selectedIds: string[]
}

let counter = 0
export function newId(): string {
  return `s${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

export function corner(x: number, y: number): Segment {
  return { p: { x, y }, hi: { x, y }, ho: { x, y } }
}

export function emptyScene(): Scene {
  return { shapes: [], selectedIds: [] }
}

export function cloneScene(s: Scene): Scene {
  return JSON.parse(JSON.stringify(s)) as Scene
}

const EPS = 1e-9
export function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS
}
