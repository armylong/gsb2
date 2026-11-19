import type { Scenario } from '../scenarios';

/** 左侧紧凑的示例选择器；完整的示例说明在“示例库”页。 */
export function ScenarioPicker({
  scenarios,
  activeId,
  dirty,
  scenario,
  onLoad,
  onReset,
  onOpenGallery,
}: {
  scenarios: Scenario[];
  activeId: string;
  dirty: boolean;
  scenario: Scenario;
  onLoad: (id: string) => void;
  onReset: () => void;
  onOpenGallery: () => void;
}) {
  return (
    <div className="card picker-card">
      <div className="card-head">
        <h2>示例</h2>
        <button className="link" onClick={onOpenGallery}>
          示例库 →
        </button>
      </div>
      <select
        className="scenario-select"
        value={activeId}
        onChange={(event) => onLoad(event.target.value)}
        aria-label="选择可重置示例"
      >
        {scenarios.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <p className="scenario-summary">{scenario.summary}</p>
      <div className="scenario-focus">
        {scenario.focus.map((focus) => (
          <span key={focus} className="tag">
            {focus}
          </span>
        ))}
      </div>
      {dirty && (
        <button className="ghost small full" onClick={onReset}>
          ⟲ 重置为示例初始状态
        </button>
      )}
    </div>
  );
}
