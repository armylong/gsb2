import type { Scene, Shape } from './types'
import { cloneScene, newId } from './types'
import { booleanOp, type BoolOp } from './paperBridge'

// 历史栈：每次操作提交一份完整场景快照（深拷贝），
// 因此撤销后对象顺序、选择状态与孔洞关系都能精确恢复；
// 新操作会清空 future，旧重做分支立即失效，且快照间无共享引用。

export interface History {
  past: Scene[]
  present: Scene
  future: Scene[]
}

export function initHistory(s: Scene): History {
  return { past: [], present: cloneScene(s), future: [] }
}

export function commit(h: History, next: Scene): History {
  return { past: [...h.past, cloneScene(h.present)], present: cloneScene(next), future: [] }
}

export function canUndo(h: History): boolean {
  return h.past.length > 0
}

export function canRedo(h: History): boolean {
  return h.future.length > 0
}

export function undo(h: History): History {
  if (!h.past.length) return h
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [cloneScene(h.present), ...h.future],
  }
}

export function redo(h: History): History {
  if (!h.future.length) return h
  return {
    past: [...h.past, cloneScene(h.present)],
    present: h.future[0],
    future: h.future.slice(1),
  }
}

export const OP_LABEL: Record<BoolOp, string> = {
  unite: '并集',
  intersect: '交集',
  subtract: '相减',
  exclude: '排除重叠',
}

export type BoolCmdResult =
  | { ok: true; scene: Scene; message: string }
  | { ok: false; message: string }

/**
 * 对当前选中的两个对象执行布尔运算。
 * reverse=false 时按选择顺序 A op B；相减的先后顺序由调用方明确指定。
 * 结果为空时移除两个源对象（可撤销恢复），不留下任何残留图形。
 */
export function booleanCommand(scene: Scene, op: BoolOp, reverse: boolean): BoolCmdResult {
  if (scene.selectedIds.length !== 2) {
    return { ok: false, message: '请先选择两个对象（点击选择，Shift+点击加选，选择顺序即运算顺序）' }
  }
  const [idA, idB] = scene.selectedIds
  const A = scene.shapes.find((s) => s.id === idA)
  const B = scene.shapes.find((s) => s.id === idB)
  if (!A || !B) return { ok: false, message: '选中的对象已不存在' }
  const [subj, tool] = reverse ? [B, A] : [A, B]
  let out
  try {
    out = booleanOp(subj, tool, op)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
  const label = OP_LABEL[op] + (op === 'subtract' ? `（${subj.name} − ${tool.name}）` : '')
  const rest = scene.shapes.filter((s) => s.id !== subj.id && s.id !== tool.id)
  if (!out) {
    return {
      ok: true,
      scene: { shapes: rest, selectedIds: [] },
      message: `${label}：结果为空，两个源对象已移除（可撤销恢复）`,
    }
  }
  const result: Shape = { id: newId(), name: label, fill: subj.fill, subpaths: out.subpaths }
  return {
    ok: true,
    scene: { shapes: [...rest, result], selectedIds: [result.id] },
    message: `${label} 完成，面积 ≈ ${out.area.toFixed(1)}`,
  }
}
