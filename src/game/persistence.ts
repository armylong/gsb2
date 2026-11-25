import { validatePuzzle } from './board';
import { defaultState, getPuzzle } from './levels';
import type { GameState, Puzzle } from './types';
import { parseEdge, parseKey, vKey } from './geometry';

export const SAVE_VERSION = 1;
const STORAGE_PREFIX = 'ribbon-loom:save:';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SavedPayload {
  version: number;
  puzzleId: string;
  savedAt: string;
  state: GameState;
}

/** 存档前校验布局与题面是否自洽，拒绝把损坏数据写入存档。 */
export function validateStateAgainstPuzzle(
  puzzle: Puzzle,
  state: GameState,
): string[] {
  const errors: string[] = [];
  if (state.puzzleId !== puzzle.id) {
    errors.push(`存档属于题面 ${state.puzzleId}，与当前题面 ${puzzle.id} 不符`);
  }
  const colors = new Set(puzzle.ports.map((p) => p.color));
  const holeKeys = new Set(puzzle.holes.map(vKey));
  for (const [key, color] of Object.entries(state.edges)) {
    if (!colors.has(color)) {
      errors.push(`格边 ${key} 的颜色 ${color} 不属于本题面`);
      continue;
    }
    const [a, b] = parseEdge(key);
    const manhattan = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (manhattan !== 1) {
      errors.push(`格边 ${key} 不相邻`);
      continue;
    }
    for (const v of [a, b]) {
      if (
        v.x < 0 ||
        v.x > puzzle.width ||
        v.y < 0 ||
        v.y > puzzle.height
      ) {
        errors.push(`格边 ${key} 超出织框`);
      }
      if (holeKeys.has(vKey(v))) {
        errors.push(`格边 ${key} 经过禁用孔`);
      }
    }
    const port = puzzle.ports.find(
      (p) =>
        (vKey(p.vertex) === key.split('|')[0] ||
          vKey(p.vertex) === key.split('|')[1]) &&
        p.color !== color,
    );
    if (port) errors.push(`格边 ${key} 接错了端口颜色`);
  }
  for (const [key, color] of Object.entries(state.tops)) {
    const v = parseKey(key);
    if (
      v.x < 0 ||
      v.x > puzzle.width ||
      v.y < 0 ||
      v.y > puzzle.height
    ) {
      errors.push(`上下指定 ${key} 超出织框`);
    }
    if (!colors.has(color)) {
      errors.push(`上下指定 ${key} 的颜色 ${color} 不属于本题面`);
    }
  }
  return errors;
}

function keyFor(puzzleId: string): string {
  return `${STORAGE_PREFIX}${puzzleId}`;
}

export function saveLayout(
  puzzle: Puzzle,
  state: GameState,
  storage: StorageLike = localStorage,
): void {
  const errors = validateStateAgainstPuzzle(puzzle, state);
  if (errors.length) {
    throw new Error(`布局校验失败，未保存：${errors.join('；')}`);
  }
  const payload: SavedPayload = {
    version: SAVE_VERSION,
    puzzleId: puzzle.id,
    savedAt: new Date().toISOString(),
    state: {
      puzzleId: state.puzzleId,
      edges: { ...state.edges },
      tops: { ...state.tops },
    },
  };
  storage.setItem(keyFor(puzzle.id), JSON.stringify(payload));
}

export function hasSave(
  puzzleId: string,
  storage: StorageLike = localStorage,
): boolean {
  return storage.getItem(keyFor(puzzleId)) !== null;
}

export function loadLayout(
  puzzle: Puzzle,
  storage: StorageLike = localStorage,
): GameState | null {
  const raw = storage.getItem(keyFor(puzzle.id));
  if (raw === null) return null;
  let payload: SavedPayload;
  try {
    payload = JSON.parse(raw) as SavedPayload;
  } catch {
    throw new Error('存档解析失败，文件已损坏');
  }
  if (payload.version !== SAVE_VERSION) {
    throw new Error(`存档版本 ${payload.version} 不受支持（当前版本 ${SAVE_VERSION}）`);
  }
  if (payload.puzzleId !== puzzle.id) {
    throw new Error('存档与当前题面不匹配');
  }
  const state: GameState = {
    puzzleId: puzzle.id,
    edges: payload.state?.edges ?? {},
    tops: payload.state?.tops ?? {},
  };
  const errors = validateStateAgainstPuzzle(puzzle, state);
  if (errors.length) {
    throw new Error(`存档内容校验失败：${errors.join('；')}`);
  }
  return state;
}

export function clearSave(
  puzzleId: string,
  storage: StorageLike = localStorage,
): void {
  storage.removeItem(keyFor(puzzleId));
}

/** 重开：回到题面自带的初始布局（没有则为空盘）。 */
export function restart(puzzle: Puzzle): GameState {
  return defaultState(puzzle);
}

/** 题面包本身的静态校验，启动题库时调用一次。 */
export function validateAllPuzzles(puzzles: Puzzle[]): void {
  for (const puzzle of puzzles) {
    const errors = validatePuzzle(puzzle);
    if (errors.length) {
      throw new Error(`题面 ${puzzle.id} 不合法：${errors.join('；')}`);
    }
    if (puzzle.initial) {
      const stateErrors = validateStateAgainstPuzzle(puzzle, puzzle.initial);
      if (stateErrors.length) {
        throw new Error(
          `题面 ${puzzle.id} 的初始布局不合法：${stateErrors.join('；')}`,
        );
      }
    }
  }
}

export function getPuzzleOrThrow(id: string): Puzzle {
  return getPuzzle(id);
}
