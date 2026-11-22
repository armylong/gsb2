import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
// saved 与 state 同源：state 非空即有存档（hydrate 时即从 localStorage 读入）
import type { ReactNode } from 'react';
import {
  allocationsFromLog,
  buildGame,
  computeFingerprint,
  resolveRound,
  STATE_VERSION,
} from './engine.ts';
import type { GameState, ScenarioId, TeamId } from './types.ts';

const STORAGE_KEY = 'specimen-draft:save:v1';

type Action =
  | { type: 'loadScenario'; scenarioId: ScenarioId; seed?: number }
  | { type: 'setChoice'; teamId: TeamId; slot: 'primaryId' | 'backupId'; specimenId: string | null }
  | { type: 'confirm'; teamId: TeamId }
  | { type: 'unconfirm'; teamId: TeamId }
  | { type: 'reveal' }
  | { type: 'nextRound' }
  | { type: 'hydrate'; state: GameState }
  | { type: 'clearSave' };

function sameChoice(c: { primaryId: string | null; backupId: string | null }): boolean {
  return c.primaryId === c.backupId;
}

function reducer(prev: GameState | null, action: Action): GameState | null {
  switch (action.type) {
    case 'loadScenario':
      return buildGame(action.scenarioId, action.seed);

    case 'clearSave':
      return null;

    case 'hydrate':
      return action.state;

    case 'nextRound': {
      if (!prev) return prev;
      if (prev.currentRound + 1 >= prev.rounds.length) return prev;
      return { ...prev, currentRound: prev.currentRound + 1 };
    }

    default:
      break;
  }

  if (!prev) return prev;
  const round = prev.rounds[prev.currentRound];
  if (!round || round.log) return prev; // 已开牌的轮次只读

  const rounds = prev.rounds.map((r) =>
    r.index === round.index ? { ...r, choices: { A: { ...r.choices.A }, B: { ...r.choices.B }, C: { ...r.choices.C } } } : r,
  );
  const target = rounds[round.index];

  switch (action.type) {
    case 'setChoice': {
      const choice = target.choices[action.teamId];
      const next = { ...choice, [action.slot]: action.specimenId, confirmed: false };
      // 不允许首选与备用指向同一件
      if (sameChoice(next)) {
        const other: 'primaryId' | 'backupId' =
          action.slot === 'primaryId' ? 'backupId' : 'primaryId';
        next[other] = null;
      }
      target.choices[action.teamId] = next;
      return { ...prev, rounds };
    }
    case 'confirm': {
      const choice = target.choices[action.teamId];
      if (!choice.primaryId || sameChoice(choice)) return prev;
      target.choices[action.teamId] = { ...choice, confirmed: true };
      return { ...prev, rounds };
    }
    case 'unconfirm': {
      const choice = target.choices[action.teamId];
      target.choices[action.teamId] = { ...choice, confirmed: false };
      return { ...prev, rounds };
    }
    case 'reveal': {
      const allConfirmed = (Object.keys(target.choices) as TeamId[]).every(
        (id) => target.choices[id].confirmed,
      );
      if (!allConfirmed) return prev;
      const log = resolveRound(target);
      target.log = log;
      target.allocations = allocationsFromLog(log);
      return { ...prev, rounds, fingerprint: computeFingerprint(prev.seed, target, log) };
    }
    default:
      return prev;
  }
}

function loadSaved(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.rounds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface Store {
  state: GameState | null;
  saved: boolean;
  dispatch: React.Dispatch<Action>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadSaved);
  const saved = state !== null;

  // 每次状态变化即写入本地；清空时移除。恢复时按存档自身阶段决定可见信息。
  useEffect(() => {
    if (state) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [state]);

  const value = useMemo(() => ({ state, saved, dispatch }), [state, saved]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
