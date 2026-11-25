import type { OpCode } from './types.ts';

const KEY_PREFIX = 'library-cart-rules:programs:';

/** 按场景持久化玩家编辑过的指令，刷新后可重放同一串指令 */
export function loadPrograms(scenarioId: string): Record<string, OpCode[]> | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + scenarioId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, OpCode[]>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePrograms(scenarioId: string, programs: Record<string, OpCode[]>): void {
  try {
    localStorage.setItem(KEY_PREFIX + scenarioId, JSON.stringify(programs));
  } catch {
    // 隐私模式等情况下静默失败，不影响规则试玩
  }
}

export function clearPrograms(scenarioId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + scenarioId);
  } catch {
    // 同上
  }
}
