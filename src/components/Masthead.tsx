import type { LabAction, LabState } from '../state/reducer';
import { SCENARIOS } from '../game/scenarios';
import { normalizeSeedInput } from '../format';
import type { Viewer } from '../game/types';

interface Props {
  state: LabState;
  seedDraft: string;
  onSeedDraft: (value: string) => void;
  dispatch: (action: LabAction) => void;
}

const VIEWERS: Array<{ id: Viewer; label: string }> = [
  { id: 'observer', label: '旁观' },
  { id: 'red', label: '赤陶' },
  { id: 'blue', label: '青玉' },
  { id: 'gold', label: '鎏金' },
];

export function Masthead({ state, seedDraft, onSeedDraft, dispatch }: Props) {
  const { game, viewer } = state;
  const applySeed = () => {
    const seed = normalizeSeedInput(seedDraft, game.seed);
    onSeedDraft(String(seed));
    dispatch({ type: 'restart', seed });
  };
  return (
    <header className="masthead">
      <div className="brand">
        <span className="kicker">Specimen Draft Lab</span>
        <h1>标本轮选试验台</h1>
        <p className="tagline">
          三队同桌，首选相撞、备用递补、成套计分，全部在本地推演。
        </p>
      </div>

      <div className="masthead-controls">
        <div className="field">
          <label htmlFor="scenario-select">场景</label>
          <select
            id="scenario-select"
            value={game.scenarioId}
            onChange={(event) =>
              dispatch({ type: 'new-game', scenarioId: event.target.value })
            }
          >
            {SCENARIOS.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="seed-input">种子</label>
          <div className="seed-row">
            <input
              id="seed-input"
              value={seedDraft}
              inputMode="numeric"
              pattern="[0-9]*"
              onChange={(event) => onSeedDraft(event.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applySeed();
              }}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() => applySeed()}
            >
              应用
            </button>
          </div>
        </div>

        <div className="field">
          <span className="field-label">视角</span>
          <div className="viewer-switch" role="group" aria-label="切换视角">
            {VIEWERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={viewer === entry.id}
                onClick={() => dispatch({ type: 'set-viewer', viewer: entry.id })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
