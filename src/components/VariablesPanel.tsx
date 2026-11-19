import type { GameState, VariableCatalog } from '../engine/types';
import { formatFlag } from '../engine/state';

interface VariablesPanelProps {
  catalog: VariableCatalog;
  state: GameState;
  previousState?: GameState;
}

function formatValue(value: boolean | number | undefined, kind: 'flag' | 'stat' | 'item'): string {
  if (kind === 'flag') return formatFlag(Boolean(value));
  return String(typeof value === 'number' ? value : 0);
}

export function VariablesPanel({ catalog, state, previousState }: VariablesPanelProps) {
  return (
    <div className="variables" data-testid="variables-panel">
      <div className="variable-group">
        <h3 className="variable-heading">布尔标记</h3>
        <ul className="variable-list">
          {catalog.flags.map((flag) => {
            const value = Boolean(state.flags[flag.key]);
            const previous = previousState ? Boolean(previousState.flags[flag.key]) : value;
            const changed = Boolean(previousState) && previous !== value;
            return (
              <li key={flag.key} className={changed ? 'variable variable--changed' : 'variable'}>
                <span className="variable-label" title={flag.key}>
                  {flag.label}
                </span>
                <span className={`pill ${value ? 'pill--on' : 'pill--off'}`}>
                  {formatValue(value, 'flag')}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="variable-group">
        <h3 className="variable-heading">整数好感</h3>
        <ul className="variable-list">
          {catalog.stats.map((stat) => {
            const value = state.stats[stat.key] ?? 0;
            const previous = previousState ? previousState.stats[stat.key] ?? 0 : value;
            const changed = Boolean(previousState) && previous !== value;
            return (
              <li key={stat.key} className={changed ? 'variable variable--changed' : 'variable'}>
                <span className="variable-label" title={stat.key}>
                  {stat.label}
                </span>
                <span className="numeric">
                  {previousState && changed ? <em>{previous} → </em> : null}
                  <strong title={stat.key}>{formatValue(value, 'stat')}</strong>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="variable-group">
        <h3 className="variable-heading">物品数量</h3>
        <ul className="variable-list">
          {catalog.items.map((item) => {
            const value = state.items[item.key] ?? 0;
            const previous = previousState ? previousState.items[item.key] ?? 0 : value;
            const changed = Boolean(previousState) && previous !== value;
            return (
              <li
                key={item.key}
                className={[
                  'variable',
                  changed ? 'variable--changed' : '',
                  value <= 0 ? 'variable--empty' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="variable-label" title={item.key}>
                  {item.label}
                </span>
                <span className="numeric">
                  {previousState && changed ? <em>{previous} → </em> : null}
                  <strong title={item.key}>{formatValue(value, 'item')}</strong>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
