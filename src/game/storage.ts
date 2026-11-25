import { PUZZLES } from '../game/plates';
import type { PersistState, PuzzleProgress } from '../game/types';

const STORAGE_KEY = 'wind-chime-detective:v1';

export function freshProgress(puzzleId: string): PuzzleProgress {
  return {
    puzzleId,
    records: [],
    fineCodes: {},
    excluded: [],
    selected: null,
    phase: 'playing',
    result: null,
    updatedAt: Date.now(),
  };
}

export function defaultState(): PersistState {
  const puzzles: Record<string, PuzzleProgress> = {};
  for (const p of PUZZLES) puzzles[p.id] = freshProgress(p.id);
  return { version: 1, currentPuzzleId: PUZZLES[0].id, puzzles };
}

/** 读取 localStorage；任何损坏 / 版本不符都回退到默认固定题状态。 */
export function loadState(): PersistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<PersistState>;
    if (parsed.version !== 1 || typeof parsed.puzzles !== 'object' || !parsed.puzzles) {
      return defaultState();
    }
    const base = defaultState();
    // 以题目定义为准补齐缺失题组 / 字段，保证旧存档也能运行
    for (const puzzle of PUZZLES) {
      const saved = parsed.puzzles[puzzle.id];
      if (saved && Array.isArray(saved.records)) {
        base.puzzles[puzzle.id] = {
          ...freshProgress(puzzle.id),
          ...saved,
          puzzleId: puzzle.id,
          fineCodes: saved.fineCodes ?? {},
          excluded: Array.isArray(saved.excluded) ? saved.excluded : [],
        };
      }
    }
    if (
      typeof parsed.currentPuzzleId === 'string' &&
      base.puzzles[parsed.currentPuzzleId]
    ) {
      base.currentPuzzleId = parsed.currentPuzzleId;
    }
    return base;
  } catch {
    return defaultState();
  }
}

export function saveState(state: PersistState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式 / 配额失败时游戏仍可在内存中进行
  }
}

export function resetAll(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
