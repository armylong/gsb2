import type { WorldState } from './types';

/**
 * 撤销/重做历史。
 * 约定: past/present/future 保存深拷贝快照, 一次移动或一次交换 = 一个历史条目。
 * 取消拖动不调用 commit, 因此不会产生记录; 在新操作发生时旧重做分支被清空。
 */
export interface History {
  past: WorldState[];
  present: WorldState;
  future: WorldState[];
}

export function createHistory(initial: WorldState): History {
  return { past: [], present: structuredClone(initial), future: [] };
}

function sameWorld(a: WorldState, b: WorldState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 提交一个新状态; 与当前一致(no-op)时不生成历史, 并清空重做分支 */
export function commit(h: History, next: WorldState): History {
  if (sameWorld(h.present, next)) return h;
  return {
    past: [...h.past, structuredClone(h.present)],
    present: structuredClone(next),
    future: [],
  };
}

export function canUndo(h: History): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History): boolean {
  return h.future.length > 0;
}

export function undo(h: History): History {
  if (!canUndo(h)) return h;
  const previous = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present: structuredClone(previous),
    future: [structuredClone(h.present), ...h.future],
  };
}

export function redo(h: History): History {
  if (!canRedo(h)) return h;
  const next = h.future[0];
  return {
    past: [...h.past, structuredClone(h.present)],
    present: structuredClone(next),
    future: h.future.slice(1),
  };
}
