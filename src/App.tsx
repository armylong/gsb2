import { useEffect, useRef, useState } from 'react'
import type { Pt, Scene, Segment, Shape } from './geometry/types'
import { corner, emptyScene, newId, samePt } from './geometry/types'
import {
  booleanCommand,
  canRedo,
  canUndo,
  commit,
  initHistory,
  redo,
  undo,
  type History,
} from './geometry/store'
import type { BoolOp } from './geometry/paperBridge'
import { multiply, rotateM, scaleM, transformShape, translateM, type Mat } from './geometry/transform'
import { sceneFromJSON, sceneToJSON, sceneToSVG, subPathToD } from './geometry/serialize'
import { ellipseSubPath, rectSubPath } from './geometry/primitives'
import { SAMPLES } from './geometry/samples'

type Tool = 'select' | 'rect' | 'ellipse' | 'pen'
type ViewMode = 'both' | 'fill' | 'outline'

const FILLS = ['#e8734a', '#4a90e8', '#50b86c', '#b05cc9', '#e8b84a', '#4ac9c0']
let fillIdx = 0
const nextFill = () => FILLS[fillIdx++ % FILLS.length]

type DragState =
  | { kind: 'move'; start: Pt; base: Scene; ids: string[] }
  | { kind: 'anchor'; base: Scene; shapeId: string; si: number; gi: number }
  | { kind: 'handle'; base: Scene; shapeId: string; si: number; gi: number; which: 'hi' | 'ho' }
  | { kind: 'create'; start: Pt; base: Scene }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }

interface Msg {
  text: string
  kind: 'info' | 'error'
}

export default function App() {
  const [history, setHistory] = useState<History>(() => initHistory(emptyScene()))
  const [tool, setTool] = useState<Tool>('select')
  const [viewMode, setViewMode] = useState<ViewMode>('both')
  const [view, setView] = useState({ x: 30, y: 30, k: 1 })
  const [msg, setMsg] = useState<Msg | null>(null)
  const [transient, setTransient] = useState<Scene | null>(null)
  const [penSegs, setPenSegs] = useState<Segment[]>([])
  const [sampleKey, setSampleKey] = useState<string>('curve-overlap')
  const [tf, setTf] = useState({ dx: '0', dy: '0', rot: '0', sx: '1', sy: '1' })

  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const penDownRef = useRef<Pt | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const scene = transient ?? history.present

  const info = (text: string) => setMsg({ text, kind: 'info' })
  const error = (text: string) => setMsg({ text, kind: 'error' })

  const commitScene = (next: Scene, text?: string) => {
    setHistory((h) => commit(h, next))
    if (text) info(text)
  }

  /** 选择变化不进入历史（避免污染撤销栈），但会被下一次快照自然记录 */
  const setSelectionSilent = (ids: string[]) =>
    setHistory((h) => ({ ...h, present: { ...h.present, selectedIds: ids } }))

  const toWorld = (clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k }
  }

  // ---------- 撤销 / 重做 ----------
  const doUndo = () => setHistory((h) => undo(h))
  const doRedo = () => setHistory((h) => redo(h))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        doRedo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select') {
        const ids = history.present.selectedIds
        if (ids.length) {
          commitScene(
            { shapes: history.present.shapes.filter((s) => !ids.includes(s.id)), selectedIds: [] },
            '已删除选中对象',
          )
        }
      } else if (e.key === 'Enter' && tool === 'pen') {
        finishPen(false)
      } else if (e.key === 'Escape' && tool === 'pen') {
        setPenSegs([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- 缩放 / 平移 ----------
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setView((v) => {
        const k2 = Math.min(64, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)))
        const s = k2 / v.k
        return { k: k2, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---------- 指针交互 ----------
  const onSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button === 1) {
      dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const w = toWorld(e.clientX, e.clientY)
    if (tool === 'pen') {
      // 点击起点附近则闭合
      if (penSegs.length >= 2 && dist(w, penSegs[0].p) < 10 / view.k) {
        finishPen(true)
      } else {
        penDownRef.current = w
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (tool === 'rect' || tool === 'ellipse') {
      dragRef.current = { kind: 'create', start: w, base: history.present }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    // select：点击空白处取消选择
    setSelectionSilent([])
  }

  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    if (tool !== 'select' || e.button !== 0) return
    e.stopPropagation()
    const cur = history.present.selectedIds
    let ids: string[]
    if (e.shiftKey) {
      ids = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    } else {
      ids = cur.includes(id) ? cur : [id]
    }
    const base = { ...history.present, selectedIds: ids }
    setHistory((h) => ({ ...h, present: base }))
    if (ids.includes(id)) {
      dragRef.current = { kind: 'move', start: toWorld(e.clientX, e.clientY), base, ids }
      svgRef.current!.setPointerCapture(e.pointerId)
    }
  }

  const onAnchorPointerDown = (e: React.PointerEvent, shapeId: string, si: number, gi: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragRef.current = { kind: 'anchor', base: history.present, shapeId, si, gi }
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const onHandlePointerDown = (
    e: React.PointerEvent,
    shapeId: string,
    si: number,
    gi: number,
    which: 'hi' | 'ho',
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragRef.current = { kind: 'handle', base: history.present, shapeId, si, gi, which }
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const onSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d) return
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }))
      return
    }
    const w = toWorld(e.clientX, e.clientY)
    if (d.kind === 'move') {
      const m = translateM(w.x - d.start.x, w.y - d.start.y)
      setTransient({
        ...d.base,
        shapes: d.base.shapes.map((s) => (d.ids.includes(s.id) ? transformShape(s, m) : s)),
      })
    } else if (d.kind === 'anchor') {
      setTransient(updateSegment(d.base, d.shapeId, d.si, d.gi, (seg) => {
        const dx = w.x - seg.p.x
        const dy = w.y - seg.p.y
        return {
          p: w,
          hi: { x: seg.hi.x + dx, y: seg.hi.y + dy },
          ho: { x: seg.ho.x + dx, y: seg.ho.y + dy },
        }
      }))
    } else if (d.kind === 'handle') {
      setTransient(
        updateSegment(d.base, d.shapeId, d.si, d.gi, (seg) => ({ ...seg, [d.which]: w })),
      )
    } else if (d.kind === 'create') {
      const x = Math.min(d.start.x, w.x)
      const y = Math.min(d.start.y, w.y)
      const ww = Math.abs(w.x - d.start.x)
      const hh = Math.abs(w.y - d.start.y)
      const sp = tool === 'rect' ? rectSubPath(x, y, ww, hh) : ellipseSubPath(x + ww / 2, y + hh / 2, ww / 2, hh / 2)
      const temp: Shape = { id: '__temp__', name: '新建', fill: nextFill(), subpaths: [sp] }
      setTransient({ ...d.base, shapes: [...d.base.shapes, temp] })
    }
  }

  const onSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    // 钢笔工具：按下-抬起决定角点 / 平滑点
    if (tool === 'pen' && penDownRef.current) {
      const down = penDownRef.current
      penDownRef.current = null
      const w = toWorld(e.clientX, e.clientY)
      const dx = w.x - down.x
      const dy = w.y - down.y
      const seg: Segment =
        Math.hypot(dx, dy) > 6 / view.k
          ? { p: down, ho: { x: down.x + dx, y: down.y + dy }, hi: { x: down.x - dx, y: down.y - dy } }
          : corner(down.x, down.y)
      setPenSegs((segs) => [...segs, seg])
      return
    }
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.kind === 'pan') return
    if (d.kind === 'create') {
      const t = transient
      setTransient(null)
      const temp = t?.shapes.find((s) => s.id === '__temp__')
      if (t && temp) {
        const xs = temp.subpaths[0].segments.map((s) => s.p.x)
        const ys = temp.subpaths[0].segments.map((s) => s.p.y)
        if (Math.max(...xs) - Math.min(...xs) > 2 / view.k && Math.max(...ys) - Math.min(...ys) > 2 / view.k) {
          const shape: Shape = { ...temp, id: newId(), name: tool === 'rect' ? '矩形' : '椭圆' }
          commitScene({ shapes: [...d.base.shapes, shape], selectedIds: [shape.id] }, '已创建形状')
          setTool('select')
        }
      }
      return
    }
    if (transient) {
      // 一次拖动 = 一次历史记录
      commitScene(transient)
      setTransient(null)
    }
  }

  // ---------- 钢笔 ----------
  const finishPen = (close: boolean) => {
    if (penSegs.length < 2) {
      setPenSegs([])
      return
    }
    const shape: Shape = {
      id: newId(),
      name: close ? '钢笔路径' : '开放路径（不可参与区域运算）',
      fill: nextFill(),
      subpaths: [{ segments: penSegs, closed: close }],
    }
    commitScene({ shapes: [...history.present.shapes, shape], selectedIds: [shape.id] },
      close ? '已创建闭合路径' : '已创建开放路径：仅作轮廓展示，参与区域运算前需闭合')
    setPenSegs([])
    setTool('select')
  }

  // ---------- 布尔 ----------
  const doBoolean = (op: BoolOp, reverse: boolean) => {
    const res = booleanCommand(history.present, op, reverse)
    if (!res.ok) {
      error(res.message)
      return
    }
    commitScene(res.scene, res.message)
  }

  // ---------- 变换 ----------
  const applyTransform = () => {
    const ids = history.present.selectedIds
    if (!ids.length) {
      error('请先选择要变换的对象')
      return
    }
    const dx = parseFloat(tf.dx) || 0
    const dy = parseFloat(tf.dy) || 0
    const rot = parseFloat(tf.rot) || 0
    const sx = parseFloat(tf.sx) || 1
    const sy = parseFloat(tf.sy) || 1
    if (sx === 0 || sy === 0) {
      error('缩放系数不能为 0（会产生退化图形）')
      return
    }
    const sel = history.present.shapes.filter((s) => ids.includes(s.id))
    const c = bboxCenter(sel)
    let m: Mat = translateM(dx, dy)
    if (rot) m = multiply(rotateM(rot, c), m)
    if (sx !== 1 || sy !== 1) m = multiply(scaleM(sx, sy, c), m)
    commitScene(
      {
        ...history.present,
        shapes: history.present.shapes.map((s) => (ids.includes(s.id) ? transformShape(s, m) : s)),
      },
      '已应用变换（已烘焙进几何坐标）',
    )
  }

  // ---------- 文件 ----------
  const download = (filename: string, content: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const saveProject = () => download('project.pathbool.json', sceneToJSON(history.present), 'application/json')
  const exportSVG = () => download('drawing.svg', sceneToSVG(history.present), 'image/svg+xml')

  const loadProject = async (file: File) => {
    try {
      const s = sceneFromJSON(await file.text())
      commitScene(s, '工程已载入')
    } catch (e2) {
      error(e2 instanceof Error ? e2.message : String(e2))
    }
  }

  const loadSample = (key: string) => {
    const s = SAMPLES[key]
    if (!s) return
    commitScene(s.make(), `已载入样例「${s.label}」：${s.hint}`)
  }

  // ---------- 渲染 ----------
  const selShapes = scene.shapes.filter((s) => scene.selectedIds.includes(s.id))
  const singleSel = scene.selectedIds.length === 1 ? scene.shapes.find((s) => s.id === scene.selectedIds[0]) : undefined
  const k = view.k

  const renderShape = (shape: Shape) => {
    const sel = scene.selectedIds.includes(shape.id)
    const closed = shape.subpaths.filter((sp) => sp.closed)
    const open = shape.subpaths.filter((sp) => !sp.closed)
    const stroke = sel ? '#0b5fff' : '#3a3f47'
    return (
      <g key={shape.id} onPointerDown={(e) => onShapePointerDown(e, shape.id)}>
        {closed.length > 0 && (
          <path
            d={closed.map(subPathToD).join(' ')}
            fillRule="evenodd"
            fill={shape.fill}
            fillOpacity={viewMode === 'outline' ? 0 : 0.8}
            stroke={stroke}
            strokeWidth={(sel ? 2.5 : 1.2) / k}
            strokeOpacity={viewMode === 'fill' ? 0 : 1}
            style={{ pointerEvents: 'all', cursor: tool === 'select' ? 'move' : 'crosshair' }}
          />
        )}
        {open.map((sp, i) => (
          <path
            key={i}
            d={subPathToD(sp)}
            fill="none"
            stroke={sel ? '#0b5fff' : '#b3261e'}
            strokeWidth={1.5 / k}
            strokeDasharray={`${5 / k} ${4 / k}`}
            style={{ pointerEvents: 'stroke', cursor: tool === 'select' ? 'move' : 'crosshair' }}
          />
        ))}
      </g>
    )
  }

  const renderNodeOverlay = () => {
    if (tool !== 'select' || !singleSel) return null
    const a = 4 / k
    return (
      <g>
        {singleSel.subpaths.map((sp, si) =>
          sp.segments.map((seg, gi) => (
            <g key={`${si}-${gi}`}>
              {!samePt(seg.hi, seg.p) && (
                <g>
                  <line x1={seg.p.x} y1={seg.p.y} x2={seg.hi.x} y2={seg.hi.y} stroke="#999" strokeWidth={1 / k} />
                  <circle
                    cx={seg.hi.x}
                    cy={seg.hi.y}
                    r={3.5 / k}
                    fill="#fff"
                    stroke="#0b5fff"
                    strokeWidth={1.2 / k}
                    style={{ cursor: 'pointer' }}
                    onPointerDown={(e) => onHandlePointerDown(e, singleSel.id, si, gi, 'hi')}
                  />
                </g>
              )}
              {!samePt(seg.ho, seg.p) && (
                <g>
                  <line x1={seg.p.x} y1={seg.p.y} x2={seg.ho.x} y2={seg.ho.y} stroke="#999" strokeWidth={1 / k} />
                  <circle
                    cx={seg.ho.x}
                    cy={seg.ho.y}
                    r={3.5 / k}
                    fill="#fff"
                    stroke="#0b5fff"
                    strokeWidth={1.2 / k}
                    style={{ cursor: 'pointer' }}
                    onPointerDown={(e) => onHandlePointerDown(e, singleSel.id, si, gi, 'ho')}
                  />
                </g>
              )}
              <rect
                x={seg.p.x - a}
                y={seg.p.y - a}
                width={2 * a}
                height={2 * a}
                fill="#fff"
                stroke="#0b5fff"
                strokeWidth={1.4 / k}
                style={{ cursor: 'pointer' }}
                onPointerDown={(e) => onAnchorPointerDown(e, singleSel.id, si, gi)}
              />
            </g>
          )),
        )}
      </g>
    )
  }

  const renderPen = () => {
    if (!penSegs.length) return null
    const d = subPathToD({ segments: penSegs, closed: false })
    return (
      <g>
        <path d={d} fill="none" stroke="#0b5fff" strokeWidth={1.5 / k} strokeDasharray={`${5 / k} ${4 / k}`} />
        {penSegs.map((s, i) => (
          <rect key={i} x={s.p.x - 3.5 / k} y={s.p.y - 3.5 / k} width={7 / k} height={7 / k} fill="#0b5fff" />
        ))}
      </g>
    )
  }

  const selNames = scene.selectedIds
    .map((id) => scene.shapes.find((s) => s.id === id)?.name)
    .filter(Boolean) as string[]

  return (
    <div className="app">
      <header>
        路径布尔编辑器
        <span className="sub">React + TypeScript + SVG，几何运算由 Paper.js 提供</span>
      </header>
      <div className="main">
        <aside className="panel">
          <section>
            <h3>工具</h3>
            <div className="btn-row">
              <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>
                选择 / 节点
              </button>
              <button className={tool === 'rect' ? 'active' : ''} onClick={() => setTool('rect')}>
                矩形
              </button>
              <button className={tool === 'ellipse' ? 'active' : ''} onClick={() => setTool('ellipse')}>
                椭圆
              </button>
              <button className={tool === 'pen' ? 'active' : ''} onClick={() => { setTool('pen'); setPenSegs([]) }}>
                钢笔
              </button>
            </div>
            {tool === 'pen' && (
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button disabled={penSegs.length < 2} onClick={() => finishPen(true)}>
                  闭合
                </button>
                <button disabled={penSegs.length < 2} onClick={() => finishPen(false)}>
                  完成（开放）
                </button>
                <button className="danger" disabled={!penSegs.length} onClick={() => setPenSegs([])}>
                  取消
                </button>
              </div>
            )}
            <p className="hint">
              {tool === 'select' && '拖动对象移动；单选后可拖动锚点与曲线控制柄；Shift+点击加选。'}
              {tool === 'rect' && '在画布上拖出矩形。'}
              {tool === 'ellipse' && '在画布上拖出椭圆。'}
              {tool === 'pen' && '单击加角点，按下拖动出平滑点；点击起点闭合。'}
            </p>
          </section>

          <section>
            <h3>布尔运算</h3>
            {selNames.length === 2 ? (
              <p className="hint">
                选择顺序：1. {selNames[0]}（A） 2. {selNames[1]}（B）
              </p>
            ) : (
              <p className="hint">需选中两个对象（当前 {selNames.length} 个）。</p>
            )}
            <div className="btn-row">
              <button disabled={selNames.length !== 2} onClick={() => doBoolean('unite', false)}>
                并集
              </button>
              <button disabled={selNames.length !== 2} onClick={() => doBoolean('intersect', false)}>
                交集
              </button>
              <button disabled={selNames.length !== 2} onClick={() => doBoolean('subtract', false)}>
                相减 A−B
              </button>
              <button disabled={selNames.length !== 2} onClick={() => doBoolean('subtract', true)}>
                相减 B−A
              </button>
              <button disabled={selNames.length !== 2} onClick={() => doBoolean('exclude', false)}>
                排除重叠
              </button>
            </div>
          </section>

          <section>
            <h3>变换（围绕选区中心）</h3>
            <label className="field">
              <span>平移 dx</span>
              <input value={tf.dx} onChange={(e) => setTf({ ...tf, dx: e.target.value })} />
            </label>
            <label className="field">
              <span>平移 dy</span>
              <input value={tf.dy} onChange={(e) => setTf({ ...tf, dy: e.target.value })} />
            </label>
            <label className="field">
              <span>旋转 °</span>
              <input value={tf.rot} onChange={(e) => setTf({ ...tf, rot: e.target.value })} />
            </label>
            <label className="field">
              <span>缩放 sx</span>
              <input value={tf.sx} onChange={(e) => setTf({ ...tf, sx: e.target.value })} />
            </label>
            <label className="field">
              <span>缩放 sy</span>
              <input value={tf.sy} onChange={(e) => setTf({ ...tf, sy: e.target.value })} />
            </label>
            <div className="btn-row">
              <button disabled={!selNames.length} onClick={applyTransform}>
                应用变换
              </button>
            </div>
          </section>

          <section>
            <h3>显示</h3>
            <div className="btn-row">
              <button className={viewMode === 'both' ? 'active' : ''} onClick={() => setViewMode('both')}>
                填充+轮廓
              </button>
              <button className={viewMode === 'fill' ? 'active' : ''} onClick={() => setViewMode('fill')}>
                仅填充
              </button>
              <button className={viewMode === 'outline' ? 'active' : ''} onClick={() => setViewMode('outline')}>
                仅轮廓
              </button>
            </div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button onClick={() => setView((v) => ({ ...v, k: Math.min(64, v.k * 1.25) }))}>放大</button>
              <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.05, v.k / 1.25) }))}>缩小</button>
              <button onClick={() => setView({ x: 30, y: 30, k: 1 })}>复位</button>
            </div>
            <p className="hint">滚轮缩放（以光标为中心），中键拖动平移。</p>
          </section>

          <section>
            <h3>历史</h3>
            <div className="btn-row">
              <button disabled={!canUndo(history)} onClick={doUndo}>
                撤销 ⌘Z
              </button>
              <button disabled={!canRedo(history)} onClick={doRedo}>
                重做 ⇧⌘Z
              </button>
            </div>
          </section>

          <section>
            <h3>样例</h3>
            <label className="field">
              <select value={sampleKey} onChange={(e) => setSampleKey(e.target.value)}>
                {Object.entries(SAMPLES).map(([key, s]) => (
                  <option key={key} value={key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="btn-row">
              <button onClick={() => loadSample(sampleKey)}>载入样例</button>
              <button onClick={() => loadSample(sampleKey)}>恢复初始状态</button>
            </div>
          </section>

          <section>
            <h3>文件</h3>
            <div className="btn-row">
              <button onClick={saveProject}>保存工程</button>
              <button onClick={() => fileRef.current?.click()}>载入工程</button>
              <button onClick={exportSVG}>导出 SVG</button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) loadProject(f)
                e.target.value = ''
              }}
            />
          </section>
        </aside>

        <div className="canvas-wrap">
          <svg
            ref={svgRef}
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
            style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
          >
            <defs>
              <pattern id="grid" width={40 * k} height={40 * k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
                <path d={`M ${40 * k} 0 L 0 0 0 ${40 * k}`} fill="none" stroke="#eee" strokeWidth={1} />
              </pattern>
            </defs>
            <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" />
            <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
              {scene.shapes.map(renderShape)}
              {renderNodeOverlay()}
              {renderPen()}
            </g>
          </svg>
          <div className="status">
            {msg ? <span className={msg.kind === 'error' ? 'msg-error' : 'msg-info'}>{msg.text}</span> : <span className="hint">就绪</span>}
            <span className="meta">
              对象 {scene.shapes.length} 个 · 缩放 {(k * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function updateSegment(
  scene: Scene,
  shapeId: string,
  si: number,
  gi: number,
  fn: (seg: Segment) => Segment,
): Scene {
  return {
    ...scene,
    shapes: scene.shapes.map((s) =>
      s.id !== shapeId
        ? s
        : {
            ...s,
            subpaths: s.subpaths.map((sp, i) =>
              i !== si ? sp : { ...sp, segments: sp.segments.map((seg, j) => (j === gi ? fn(seg) : seg)) },
            ),
          },
    ),
  }
}

function bboxCenter(shapes: Shape[]): Pt {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of shapes) {
    for (const sp of s.subpaths) {
      for (const seg of sp.segments) {
        for (const q of [seg.p, seg.hi, seg.ho]) {
          minX = Math.min(minX, q.x)
          minY = Math.min(minY, q.y)
          maxX = Math.max(maxX, q.x)
          maxY = Math.max(maxY, q.y)
        }
      }
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0 }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}
