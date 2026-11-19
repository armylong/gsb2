import type { GameState, VariableCatalog, DialogueConfig } from './types';

export const EMPTY_STATE: GameState = { flags: {}, stats: {}, items: {} };

export function createInitialState(variables: VariableCatalog): GameState {
  const flags: Record<string, boolean> = {};
  const stats: Record<string, number> = {};
  const items: Record<string, number> = {};
  for (const flag of variables.flags) flags[flag.key] = flag.initial;
  for (const stat of variables.stats) stats[stat.key] = Math.trunc(stat.initial);
  for (const item of variables.items) items[item.key] = Math.max(0, Math.trunc(item.initial));
  return { flags, stats, items };
}

export function cloneState(state: GameState): GameState {
  return {
    flags: { ...state.flags },
    stats: { ...state.stats },
    items: { ...state.items },
  };
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getFlagLabel(catalog: VariableCatalog, key: string): string {
  return catalog.flags.find((entry) => entry.key === key)?.label ?? key;
}

export function getStatLabel(catalog: VariableCatalog, key: string): string {
  return catalog.stats.find((entry) => entry.key === key)?.label ?? key;
}

export function getItemLabel(catalog: VariableCatalog, key: string): string {
  return catalog.items.find((entry) => entry.key === key)?.label ?? key;
}

export function formatFlag(value: boolean): string {
  return value ? '是' : '否';
}

export function nodeById(config: DialogueConfig, id: string) {
  return config.nodes.find((node) => node.id === id);
}
