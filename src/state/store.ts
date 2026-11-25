import { comboIdOf } from '../game/combos';
import { buildEvidence, compatibleComboIds } from '../game/evidence';
import { PLATE_MAP, PUZZLE_MAP } from '../game/plates';
import { freshProgress, loadState, saveState } from '../game/storage';
import type {
  ConditionKey,
  PersistState,
  PlateId,
  Position,
  PuzzleProgress,
  StrikeRecord,
} from '../game/types';

type Listener = () => void;

class Store {
  private state: PersistState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = loadState();
  }

  getState(): PersistState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(mutator: (draft: PersistState) => void): void {
    mutator(this.state);
    saveState(this.state);
    this.listeners.forEach((fn) => fn());
  }

  get currentPuzzle() {
    return PUZZLE_MAP[this.state.currentPuzzleId];
  }

  get progress(): PuzzleProgress {
    return this.state.puzzles[this.state.currentPuzzleId];
  }

  switchPuzzle(puzzleId: string): void {
    if (!PUZZLE_MAP[puzzleId]) return;
    this.commit((s) => {
      s.currentPuzzleId = puzzleId;
    });
  }

  /** 该条件是否还能作为“一次新敲击”使用。 */
  canStrike(key: ConditionKey): { ok: boolean; reason?: string } {
    const puzzle = this.currentPuzzle;
    const p = this.progress;
    if (p.phase !== 'playing') return { ok: false, reason: '本题已结束，可重玩或切换题组' };
    if (p.records.some((r) => r.key === key)) {
      return { ok: false, reason: '该条件已保留，直接点「回放」即可，不重复消耗次数' };
    }
    if (p.records.length >= puzzle.budget) {
      return { ok: false, reason: '敲击次数已用完，可回放记录或提交结论' };
    }
    return { ok: true };
  }

  /** 登记一次新敲击（声音由 UI 层负责播放），并计算声纹 / A-B 细指纹。 */
  registerStrike(key: ConditionKey): StrikeRecord | null {
    const check = this.canStrike(key);
    if (!check.ok) return null;
    const puzzle = this.currentPuzzle;

    let record: StrikeRecord | null = null;
    this.commit((s) => {
      const p = s.puzzles[s.currentPuzzleId];
      const truth = puzzle.truth;
      record = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        kind: key === 'all' ? { type: 'all' } : { type: 'mute', pos: Number(key[1]) as Position },
        key,
        at: Date.now(),
        analysis: {
          bandsByPos: truth.map((id) => {
            // 延迟引用避免循环；PLATE_MAP 在这里取
            return plateBand(id);
          }) as StrikeRecord['analysis']['bandsByPos'],
        },
      };
      p.records.push(record);
      p.updatedAt = Date.now();

      // 新完成的 全响↔压P 配对 => 提取该位置唯一细指纹
      const hasAll = p.records.some((r) => r.key === 'all');
      if (hasAll) {
        if (key === 'all') {
          for (const r of p.records) {
            if (r.key.startsWith('m')) {
              const pos = Number(r.key[1]) as Position;
              if (!p.fineCodes[pos]) p.fineCodes[pos] = plateFine(truth[pos]);
            }
          }
        } else {
          const pos = Number(key[1]) as Position;
          if (!p.fineCodes[pos]) p.fineCodes[pos] = plateFine(truth[pos]);
        }
      }
    });
    return record;
  }

  toggleExcluded(comboId: string): void {
    this.commit((s) => {
      const p = s.puzzles[s.currentPuzzleId];
      if (p.phase !== 'playing') return;
      const i = p.excluded.indexOf(comboId);
      if (i >= 0) p.excluded.splice(i, 1);
      else p.excluded.push(comboId);
      p.updatedAt = Date.now();
    });
  }

  selectCombo(comboId: string): void {
    this.commit((s) => {
      const p = s.puzzles[s.currentPuzzleId];
      if (p.phase !== 'playing') return;
      p.selected = p.selected === comboId ? null : comboId;
      p.updatedAt = Date.now();
    });
  }

  /** 提交。是否允许在证据不足时强提，由 UI 二次确认；这里只落结果。 */
  submit(): void {
    this.commit((s) => {
      const puzzle = PUZZLE_MAP[s.currentPuzzleId];
      const p = s.puzzles[s.currentPuzzleId];
      if (p.phase !== 'playing' || !p.selected) return;
      const ev = buildEvidence(p);
      const compatible = compatibleComboIds(ev);
      const truthCombo = comboIdOf([...puzzle.truth]);
      p.phase = 'submitted';
      p.result = {
        correct: p.selected === truthCombo,
        evidenceCompatibleCount: compatible.length,
        evidenceUnique: compatible.length === 1 && compatible[0] === p.selected,
        at: Date.now(),
      };
      p.updatedAt = Date.now();
    });
  }

  /** 不提交答案，直接结束并核对真实摆放。 */
  revealWithoutAnswer(): void {
    this.commit((s) => {
      const p = s.puzzles[s.currentPuzzleId];
      if (p.phase !== 'playing') return;
      const ev = buildEvidence(p);
      const compatible = compatibleComboIds(ev);
      p.phase = 'submitted';
      p.result = {
        correct: false,
        gaveUp: true,
        evidenceCompatibleCount: compatible.length,
        evidenceUnique: compatible.length === 1,
        at: Date.now(),
      };
      p.updatedAt = Date.now();
    });
  }

  /** 重置当前题组为全新固定题（真值不变）。 */
  resetCurrentPuzzle(): void {
    this.commit((s) => {
      s.puzzles[s.currentPuzzleId] = freshProgress(s.currentPuzzleId);
    });
  }
}

// 小辅助：铃片属性读取
function plateBand(id: PlateId) {
  return PLATE_MAP[id].band;
}
function plateFine(id: PlateId) {
  return PLATE_MAP[id].fineCode;
}

export const store = new Store();

/** 供调试 / 测试：当前题真值组合 id。 */
export function truthComboId(): string {
  return comboIdOf([...store.currentPuzzle.truth]);
}
