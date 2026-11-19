import type { Pt, Scene, Shape, SubPath } from './types'
import { corner, newId, samePt } from './types'

// 序列化：工程 JSON 与独立 SVG 导出。
// SVG 只输出 M / L / C / Z 绝对命令，坐标保留 4 位小数（误差 ≤ 1e-4 用户单位），
// 填充规则固定为 evenodd，保证导出文件在浏览器中与编辑区显示一致。

const fmt = (n: number): string => {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? '0' : String(r)
}

export function subPathToD(sp: SubPath): string {
  const segs = sp.segments
  if (!segs.length) return ''
  let d = `M ${fmt(segs[0].p.x)} ${fmt(segs[0].p.y)}`
  const n = segs.length
  const count = sp.closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const a = segs[i]
    const b = segs[(i + 1) % n]
    if (samePt(a.ho, a.p) && samePt(b.hi, b.p)) {
      d += ` L ${fmt(b.p.x)} ${fmt(b.p.y)}`
    } else {
      d += ` C ${fmt(a.ho.x)} ${fmt(a.ho.y)} ${fmt(b.hi.x)} ${fmt(b.hi.y)} ${fmt(b.p.x)} ${fmt(b.p.y)}`
    }
  }
  if (sp.closed) d += ' Z'
  return d
}

export function shapeToD(shape: Shape): string {
  return shape.subpaths
    .filter((sp) => sp.closed)
    .map(subPathToD)
    .filter(Boolean)
    .join(' ')
}

export function sceneToSVG(scene: Scene, width = 1200, height = 800): string {
  const parts: string[] = []
  for (const s of scene.shapes) {
    const closed = s.subpaths.filter((sp) => sp.closed)
    const open = s.subpaths.filter((sp) => !sp.closed)
    if (closed.length) {
      const d = closed.map(subPathToD).filter(Boolean).join(' ')
      parts.push(`  <path d="${d}" fill="${s.fill}" fill-rule="evenodd" stroke="#222222" stroke-width="1"/>`)
    }
    for (const sp of open) {
      parts.push(`  <path d="${subPathToD(sp)}" fill="none" stroke="#222222" stroke-width="1"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n${parts.join('\n')}\n</svg>\n`
}

/** 解析 M/L/C/Z（绝对与相对）命令的 path d 字符串，返回子路径列表 */
export function parsePathD(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || []
  const subs: SubPath[] = []
  let i = 0
  let cur: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  let segments: SubPath['segments'] = []
  let closed = false
  let cmd = ''
  const flush = () => {
    if (segments.length) subs.push({ segments, closed })
    segments = []
    closed = false
  }
  const num = (): number => {
    if (i >= tokens.length) throw new Error('路径数据不完整')
    return parseFloat(tokens[i++])
  }
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t
      i++
    }
    switch (cmd) {
      case 'M':
      case 'm': {
        flush()
        const x = num()
        const y = num()
        const p = cmd === 'm' ? { x: cur.x + x, y: cur.y + y } : { x, y }
        cur = p
        start = p
        segments = [corner(p.x, p.y)]
        cmd = cmd === 'm' ? 'l' : 'L'
        break
      }
      case 'L':
      case 'l': {
        const x = num()
        const y = num()
        const p = cmd === 'l' ? { x: cur.x + x, y: cur.y + y } : { x, y }
        segments.push(corner(p.x, p.y))
        cur = p
        break
      }
      case 'C':
      case 'c': {
        let x1 = num()
        let y1 = num()
        let x2 = num()
        let y2 = num()
        let x = num()
        let y = num()
        if (cmd === 'c') {
          x1 += cur.x
          y1 += cur.y
          x2 += cur.x
          y2 += cur.y
          x += cur.x
          y += cur.y
        }
        segments[segments.length - 1].ho = { x: x1, y: y1 }
        segments.push({ p: { x, y }, hi: { x: x2, y: y2 }, ho: { x, y } })
        cur = { x, y }
        break
      }
      case 'Z':
      case 'z': {
        closed = true
        cur = start
        // 闭合边若已显式画回起点（终点与起点重合），合并其入控制柄到首段，避免产生重复节点
        if (segments.length > 1 && samePt(segments[segments.length - 1].p, start)) {
          segments[0].hi = segments[segments.length - 1].hi
          segments.pop()
        }
        flush()
        break
      }
      default:
        throw new Error(`不支持的路径命令: ${cmd || t}`)
    }
  }
  flush()
  return subs
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`)) || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`))
  return m ? m[1] : null
}

/** 从导出的 SVG 文本回读场景（用于验证导出回读一致性，也可用于导入简单 SVG） */
export function sceneFromSVG(svg: string): Scene {
  const shapes: Shape[] = []
  const re = /<path\b[^>]*>/g
  let m: RegExpExecArray | null
  let idx = 0
  while ((m = re.exec(svg))) {
    const tag = m[0]
    const d = attr(tag, 'd')
    if (!d) continue
    const fill = attr(tag, 'fill') || '#888888'
    const subpaths = parsePathD(d)
    if (!subpaths.length) continue
    shapes.push({ id: newId(), name: `导入路径${++idx}`, fill, subpaths })
  }
  if (!shapes.length) throw new Error('SVG 中未找到可解析的 path 元素')
  return { shapes, selectedIds: [] }
}

const PROJECT_VERSION = 1

export function sceneToJSON(scene: Scene): string {
  return JSON.stringify({ app: 'path-boolean-editor', version: PROJECT_VERSION, scene }, null, 2)
}

export function sceneFromJSON(json: string): Scene {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  const obj = data as { app?: string; version?: number; scene?: Scene }
  if (obj.app !== 'path-boolean-editor' || !obj.scene || !Array.isArray(obj.scene.shapes)) {
    throw new Error('文件不是本编辑器保存的工程')
  }
  for (const s of obj.scene.shapes) {
    if (!s.id || !Array.isArray(s.subpaths)) throw new Error('工程数据损坏：对象缺少必要字段')
    for (const sp of s.subpaths) {
      if (!Array.isArray(sp.segments)) throw new Error('工程数据损坏：子路径缺少节点')
      for (const seg of sp.segments) {
        for (const q of [seg.p, seg.hi, seg.ho]) {
          if (typeof q?.x !== 'number' || typeof q?.y !== 'number') {
            throw new Error('工程数据损坏：坐标非法')
          }
        }
      }
    }
  }
  return {
    shapes: obj.scene.shapes,
    selectedIds: Array.isArray(obj.scene.selectedIds) ? obj.scene.selectedIds : [],
  }
}
