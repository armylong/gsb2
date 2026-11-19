import type { CompatibilityResult, SaveRecord } from '../engine/types';

interface SavePanelProps {
  saves: SaveRecord[];
  saveName: string;
  onSaveNameChange: (name: string) => void;
  onSave: () => void;
  onLoad: (save: SaveRecord) => void;
  onDelete: (save: SaveRecord) => void;
  compatibility: (save: SaveRecord) => CompatibilityResult;
  storageAvailable: boolean;
  message: { tone: 'ok' | 'warn' | 'error'; text: string } | null;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function SavePanel({
  saves,
  saveName,
  onSaveNameChange,
  onSave,
  onLoad,
  onDelete,
  compatibility,
  storageAvailable,
  message,
}: SavePanelProps) {
  return (
    <div className="save-panel" data-testid="save-panel">
      {!storageAvailable ? (
        <p className="notice notice--warn">
          浏览器本地存储不可用（隐私模式或禁用了 localStorage）。存档只在本次页面生命周期内有效，刷新后会丢失。
        </p>
      ) : null}

      <form
        className="save-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label className="field">
          <span>存档名称</span>
          <input
            value={saveName}
            onChange={(event) => onSaveNameChange(event.target.value)}
            placeholder="例如：拿到船票之后"
            maxLength={40}
          />
        </label>
        <button type="submit" className="primary-button">
          保存当前进度
        </button>
      </form>

      {message ? (
        <p className={`notice notice--${message.tone}`} role="status">
          {message.text}
        </p>
      ) : null}

      <ul className="save-list">
        {saves.map((save) => {
          const check = compatibility(save);
          return (
            <li key={save.id} className={`save ${check.ok ? '' : 'save--incompatible'}`}>
              <div className="save-head">
                <div>
                  <strong>{save.name}</strong>
                  <span className="save-time">{formatTime(save.savedAt)}</span>
                </div>
                <span className={`badge ${check.ok ? 'badge--ok' : 'badge--error'}`}>
                  {check.ok ? (check.configChanged ? '配置已变·可载入' : '兼容') : '不兼容'}
                </span>
              </div>
              <div className="save-meta">
                节点 <code>{save.snapshot.nodeId}</code> · 历史 {save.snapshot.history.length} 步
                {save.snapshot.abandonedBranches.length > 0
                  ? ` · 封存分支 ${save.snapshot.abandonedBranches.length} 条`
                  : ''}
              </div>
              {check.problems.length > 0 ? (
                <ul className="compat-problems">
                  {check.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              ) : null}
              {check.warnings.map((warning) => (
                <p key={warning} className="compat-warning">
                  {warning}
                </p>
              ))}
              <div className="save-actions">
                <button
                  type="button"
                  className="primary-button primary-button--sm"
                  disabled={!check.ok}
                  title={check.ok ? undefined : '存档引用的节点或选项已失效，已拒绝载入'}
                  onClick={() => onLoad(save)}
                >
                  {check.ok ? '载入' : '拒绝载入'}
                </button>
                <button type="button" className="ghost-button" onClick={() => onDelete(save)}>
                  删除
                </button>
              </div>
            </li>
          );
        })}
        {saves.length === 0 ? <li className="empty-note">还没有存档。</li> : null}
      </ul>
    </div>
  );
}
