import type { AbandonedBranch, HistoryEntry, VariableCatalog } from '../engine/types';
import { changedDeltas } from '../engine/diff';

interface HistoryPanelProps {
  history: HistoryEntry[];
  branches: AbandonedBranch[];
  catalog: VariableCatalog;
  onRewind: (index: number) => void;
  onInspect: (index: number) => void;
  inspectingIndex: number | null;
  onInspectBranch: (branchId: string | null) => void;
  inspectedBranchId: string | null;
}

function DeltaLine({ entry, catalog }: { entry: HistoryEntry; catalog: VariableCatalog }) {
  const deltas = changedDeltas(entry.before, entry.after, catalog);
  if (deltas.length === 0) return <span className="delta-empty">变量无变化</span>;
  return (
    <span className="delta-line">
      {deltas.map((delta) => (
        <span
          key={`${delta.kind}-${delta.key}`}
          className={`delta delta--${delta.kind}`}
          data-delta={`${delta.kind}:${delta.key}`}
        >
          {delta.label} {delta.before}→{delta.after}
        </span>
      ))}
    </span>
  );
}

export function HistoryPanel({
  history,
  branches,
  catalog,
  onRewind,
  onInspect,
  inspectingIndex,
  onInspectBranch,
  inspectedBranchId,
}: HistoryPanelProps) {
  return (
    <div className="history" data-testid="history-panel">
      <div className="history-header">
        <h3 className="variable-heading">历史选择</h3>
        <p className="history-hint">每次选择都留下节点、选项、前后变量与实际去向</p>
      </div>
      {history.length === 0 ? (
        <p className="empty-note">还没有选择记录。每次选择都会在这里留下节点、选项与变量快照。</p>
      ) : (
        <ol className="history-list">
          {history.map((entry, index) => (
            <li key={entry.seq} className="history-entry" data-testid={`history-${entry.seq}`}>
              <div className="history-node">
                <span className="history-seq">#{entry.seq}</span>
                <div>
                  <strong>{entry.nodeTitle}</strong>
                  <span className="history-choice">「{entry.choiceLabel}」</span>
                </div>
              </div>
              <div className="history-target">
                → {entry.targetNodeTitle}
                <code>{entry.targetNodeId}</code>
              </div>
              <DeltaLine entry={entry} catalog={catalog} />
              <div className="history-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onInspect(index)}
                  aria-pressed={inspectingIndex === index}
                >
                  查看此步之前
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onRewind(index)}
                  title={`回到第 #${entry.seq} 次选择之前`}
                >
                  回到此选择之前
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="branches">
        <h3 className="variable-heading">已封存分支（只读）</h3>
        {branches.length === 0 ? (
          <p className="empty-note">回溯后会在这里保留旧分支，便于对比但不会混入当前状态。</p>
        ) : (
          <ul className="branch-list">
            {branches.map((branch) => {
              const expanded = inspectedBranchId === branch.id;
              return (
                <li key={branch.id} className="branch">
                  <button
                    type="button"
                    className="branch-head"
                    aria-expanded={expanded}
                    onClick={() => onInspectBranch(expanded ? null : branch.id)}
                  >
                    <span>
                      {branch.label}
                      <em>
                        {branch.entries.length} 步 · 停在 {branch.finalNodeTitle}
                      </em>
                    </span>
                    <span className="branch-id">{branch.id}</span>
                  </button>
                  {expanded ? (
                    <div className="branch-body" data-testid={`branch-body-${branch.id}`}>
                      <ol className="history-list history-list--compact">
                        {branch.entries.map((entry) => (
                          <li key={`${branch.id}-${entry.seq}`} className="history-entry">
                            <div className="history-node">
                              <span className="history-seq">#{entry.seq}</span>
                              <div>
                                <strong>{entry.nodeTitle}</strong>
                                <span className="history-choice">「{entry.choiceLabel}」</span>
                              </div>
                            </div>
                            <DeltaLine entry={entry} catalog={catalog} />
                          </li>
                        ))}
                      </ol>
                      <p className="branch-final">
                        分支终点变量快照：
                        {catalog.stats.map((stat) => (
                          <span key={stat.key}>
                            {stat.label} {branch.finalState.stats[stat.key] ?? 0}
                          </span>
                        ))}
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
