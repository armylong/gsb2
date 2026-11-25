// 应用状态与撤销/重做。状态不可变更新, 每次提交压入历史栈。
import { Dir, Placement, Puzzle, Tile } from './types.js';
import { checkBoard, checkPlacement, Conflict } from './board.js';

export interface AppState {
  puzzle: Puzzle;
  /** 拖动预览(尚未落盘) */
  preview: {
    tileId: string;
    rot: Dir;
    x: number;
    y: number;
    /** 从盘面里已有的片拖起(移动)还是从托盘拖起(新放) */
    fromBoard: boolean;
  } | null;
  /** 最近一次求解/提示结果摘要, 供侧栏与高亮使用 */
  highlight:
    | { type: 'cell'; x: number; y: number }
    | { type: 'move'; tileId: string; x: number; y: number; rot: Dir }
    | { type: 'conflicts'; conflicts: Conflict[] }
    | null;
}

export interface Store {
  state: AppState;
  undoStack: AppState[];
  redoStack: AppState[];
  subscribe(fn: () => void): () => void;
  emit(): void;
  commit(next: AppState): void;
  undo(): void;
  redo(): void;
  resetHistory(): void;
}

export function createStore(initial: AppState): Store {
  const listeners = new Set<() => void>();
  const store: Store = {
    state: initial,
    undoStack: [],
    redoStack: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      listeners.forEach((fn) => fn());
    },
    commit(next) {
      store.undoStack.push(store.state);
      if (store.undoStack.length > 100) store.undoStack.shift();
      store.redoStack = [];
      store.state = next;
      store.emit();
    },
    undo() {
      const prev = store.undoStack.pop();
      if (!prev) return;
      store.redoStack.push(store.state);
      store.state = prev;
      store.emit();
    },
    redo() {
      const next = store.redoStack.pop();
      if (!next) return;
      store.undoStack.push(store.state);
      store.state = next;
      store.emit();
    },
    resetHistory() {
      store.undoStack = [];
      store.redoStack = [];
      store.emit();
    },
  };
  return store;
}

// ---- 纯状态变更(供 UI 与测试复用) ----

export function cloneState(s: AppState): AppState {
  return JSON.parse(JSON.stringify(s)) as AppState;
}

/** 落盘一个放置; 同 id 旧放置被替换(等于把那块片移过来, 原位置自动恢复为空) */
export function withPlacement(s: AppState, p: Placement): AppState {
  const next = cloneState(s);
  next.preview = null;
  next.puzzle.placements = next.puzzle.placements.filter((q) => q.tileId !== p.tileId);
  next.puzzle.placements.push({ ...p });
  return next;
}

export function withoutTile(s: AppState, tileId: string): AppState {
  const next = cloneState(s);
  next.preview = null;
  next.puzzle.placements = next.puzzle.placements.filter((q) => q.tileId !== tileId);
  return next;
}

export function withPreview(
  s: AppState,
  preview: AppState['preview'],
): AppState {
  const next = cloneState(s);
  next.preview = preview;
  return next;
}

export function withHighlight(s: AppState, highlight: AppState['highlight']): AppState {
  const next = cloneState(s);
  next.highlight = highlight;
  return next;
}

export function toggleLock(s: AppState, tileId: string): AppState {
  const next = cloneState(s);
  const p = next.puzzle.placements.find((q) => q.tileId === tileId);
  if (p) p.locked = !p.locked;
  return next;
}

export function rotatePlacement(s: AppState, tileId: string): AppState {
  const next = cloneState(s);
  const p = next.puzzle.placements.find((q) => q.tileId === tileId);
  if (p && !p.locked) p.rot = ((p.rot + 1) % 4) as Dir;
  return next;
}

export function replacePuzzle(puzzle: Puzzle): AppState {
  return { puzzle: JSON.parse(JSON.stringify(puzzle)), preview: null, highlight: null };
}

/** 托盘里的片 = 还没摆上盘面的片; 撤销放置后自动回到这里 */
export function trayTiles(s: AppState): Tile[] {
  const used = new Set(s.puzzle.placements.map((p) => p.tileId));
  return s.puzzle.tiles.filter((t) => !used.has(t.id));
}

export function boardConflicts(s: AppState): Conflict[] {
  return checkBoard(s.puzzle.board, s.puzzle.placements, s.puzzle.tiles);
}

/** 拖动预览与当前盘面的冲突(尊重已摆位置) */
export function previewConflicts(s: AppState): Conflict[] {
  const pv = s.preview;
  if (!pv) return [];
  const tile = s.puzzle.tiles.find((t) => t.id === pv.tileId);
  if (!tile) return [];
  // 从盘面拖起时, 把它自己的旧放置从参考盘面里剔除, 避免自己和自己冲突
  const placements = pv.fromBoard
    ? s.puzzle.placements.filter((p) => p.tileId !== pv.tileId)
    : s.puzzle.placements;
  return checkPlacement(
    s.puzzle.board,
    placements,
    s.puzzle.tiles,
    tile,
    pv.rot,
    pv.x,
    pv.y,
  );
}

/** 序列化/反序列化, 用于保存与读入 */
export function serialize(s: AppState): string {
  return JSON.stringify({ version: 1, puzzle: s.puzzle }, null, 2);
}

export function deserialize(text: string): Puzzle {
  const data = JSON.parse(text) as { version?: number; puzzle?: Puzzle };
  if (!data.puzzle || !data.puzzle.board || !Array.isArray(data.puzzle.tiles)) {
    throw new Error('文件结构不符合小题面格式(缺少 board 或 tiles)');
  }
  const p = data.puzzle;
  if (!Number.isInteger(p.board.width) || !Number.isInteger(p.board.height)) {
    throw new Error('board.width / board.height 必须是整数');
  }
  if (p.tiles.length < 6 || p.tiles.length > 12) {
    throw new Error(`木片数量需在 6~12 块之间, 当前 ${p.tiles.length} 块`);
  }
  const ids = new Set<string>();
  for (const t of p.tiles) {
    if (ids.has(t.id)) throw new Error(`木片 id 重复: ${t.id}`);
    ids.add(t.id);
    if (!Array.isArray(t.edges) || t.edges.length !== 4) {
      throw new Error(`木片 ${t.id} 的 edges 必须是 4 个纹路`);
    }
  }
  for (const pl of p.placements ?? []) {
    if (!ids.has(pl.tileId)) throw new Error(`放置引用了不存在的木片: ${pl.tileId}`);
    if (![0, 1, 2, 3].includes(pl.rot)) throw new Error(`木片 ${pl.tileId} 的 rot 非法`);
  }
  p.placements ??= [];
  p.board.holes ??= [];
  p.board.edgeConditions ??= {};
  return p;
}

export function tileById(s: AppState, id: string): Tile | undefined {
  return s.puzzle.tiles.find((t) => t.id === id);
}
