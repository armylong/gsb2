import type { GameState, VariableCatalog } from './types';
import { getFlagLabel, getItemLabel, getStatLabel } from './state';

export interface StateDelta {
  kind: 'flag' | 'stat' | 'item';
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

function stringify(value: boolean | number | undefined, kind: 'flag' | 'stat' | 'item'): string {
  if (kind === 'flag') return value ? '是' : '否';
  return String(typeof value === 'number' ? value : 0);
}

export function diffStates(
  before: GameState,
  after: GameState,
  catalog: VariableCatalog,
): StateDelta[] {
  const deltas: StateDelta[] = [];
  for (const flag of catalog.flags) {
    const beforeValue = Boolean(before.flags[flag.key]);
    const afterValue = Boolean(after.flags[flag.key]);
    deltas.push({
      kind: 'flag',
      key: flag.key,
      label: getFlagLabel(catalog, flag.key),
      before: stringify(beforeValue, 'flag'),
      after: stringify(afterValue, 'flag'),
      changed: beforeValue !== afterValue,
    });
  }
  for (const stat of catalog.stats) {
    const beforeValue = before.stats[stat.key] ?? 0;
    const afterValue = after.stats[stat.key] ?? 0;
    deltas.push({
      kind: 'stat',
      key: stat.key,
      label: getStatLabel(catalog, stat.key),
      before: stringify(beforeValue, 'stat'),
      after: stringify(afterValue, 'stat'),
      changed: beforeValue !== afterValue,
    });
  }
  for (const item of catalog.items) {
    const beforeValue = before.items[item.key] ?? 0;
    const afterValue = after.items[item.key] ?? 0;
    deltas.push({
      kind: 'item',
      key: item.key,
      label: getItemLabel(catalog, item.key),
      before: stringify(beforeValue, 'item'),
      after: stringify(afterValue, 'item'),
      changed: beforeValue !== afterValue,
    });
  }
  return deltas;
}

export function changedDeltas(
  before: GameState,
  after: GameState,
  catalog: VariableCatalog,
): StateDelta[] {
  return diffStates(before, after, catalog).filter((delta) => delta.changed);
}
